import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';

/**
 * Issue #86 v1 — resolve an `AWS::ElasticLoadBalancingV2::LoadBalancer` (an
 * ALB) into the backing ECS service(s) and the host listener port(s) a local
 * front-door should expose for each. This is the `cdkl start-alb` entry: you
 * name the ALB, and cdk-local discovers the services behind it (mirroring how
 * `start-api` names the API and discovers the backing Lambdas).
 *
 * The synthesized linkage (confirmed against real `cdk synth` of
 * `ApplicationLoadBalancedFargateService`):
 *
 * ```
 * ElasticLoadBalancingV2::LoadBalancer  (the ALB you name)
 * ElasticLoadBalancingV2::Listener      : { LoadBalancerArn:{Ref:<ALB>}, Port, Protocol,
 *     DefaultActions:[{ Type:"forward", TargetGroupArn:{Ref:<TG>} }] }
 * ElasticLoadBalancingV2::TargetGroup   : { Port, Protocol, TargetType:"ip" }
 * ECS::Service.LoadBalancers[]          -> { ContainerName, ContainerPort, TargetGroupArn:{Ref:<TG>} }
 * ```
 *
 * Resolution walks ALB -> listeners (by `LoadBalancerArn` Ref) -> default
 * `forward` target groups -> the ECS Service whose `LoadBalancers[]` references
 * that target group (a reverse scan; there is no direct TG -> service pointer).
 *
 * v1 scope (single forward): only listener `DefaultActions` are honored.
 * `AWS::ElasticLoadBalancingV2::ListenerRule` (path / host / weighted routing)
 * is ignored — tracked in #123. HTTPS / TLS listeners and `TargetType:"lambda"`
 * target groups are skipped with a warning.
 */

const ALB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const SERVICE_TYPE = 'AWS::ECS::Service';

/** One resolved host front-door: a listener port forwarding to a service's replica pool. */
export interface ResolvedFrontDoorTarget {
  /** Listener port declared on the ALB (the stable host endpoint port). */
  listenerPort: number;
  /** Listener protocol — always `HTTP` in v1 (HTTPS is skipped upstream). */
  listenerProtocol: 'HTTP';
  /** Container the listener forwards to (`LoadBalancers[].ContainerName`). */
  targetContainerName: string;
  /** Container port the target group targets (`LoadBalancers[].ContainerPort`). */
  targetContainerPort: number;
  /** Logical id of the resolved target group (diagnostics). */
  targetGroupLogicalId: string;
  /** Logical id of the fronting listener (diagnostics). */
  listenerLogicalId: string;
}

/** A backing ECS service behind the ALB, plus the listener(s) that front it. */
export interface AlbBackingService {
  /** Logical id of the `AWS::ECS::Service` (a `Stack:LogicalId` target). */
  serviceLogicalId: string;
  /** The listener -> container front-door bindings that target this service. */
  targets: ResolvedFrontDoorTarget[];
}

export interface AlbFrontDoorResolution {
  /** Backing services discovered behind the ALB, each with its front-door targets. */
  services: AlbBackingService[];
  /** Non-fatal warnings (the CLI surfaces these and proceeds). */
  warnings: string[];
}

/**
 * Resolve an ALB into its backing services + front-door targets. Pure — reads
 * only the supplied stack template. Returns an empty `services` array (with
 * warnings) when the ALB fronts nothing cdk-local can serve locally.
 */
export function resolveAlbFrontDoor(
  stack: StackInfo,
  albLogicalId: string
): AlbFrontDoorResolution {
  const warnings: string[] = [];
  const resources = stack.template.Resources ?? {};

  // TG logical id -> backing ECS service (reverse of Service.LoadBalancers[]).
  const tgToService = indexTargetGroupToService(resources);

  // Per-service accumulation, keyed by service logical id. A service fronted by
  // multiple listeners gets multiple targets.
  const byService = new Map<string, ResolvedFrontDoorTarget[]>();
  const seenPortsByService = new Map<string, Set<number>>();

  for (const [listenerLogicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== LISTENER_TYPE) continue;
    const props = (resource.Properties ?? {}) as Record<string, unknown>;
    if (refOf(props['LoadBalancerArn']) !== albLogicalId) continue;

    const port = parsePort(props['Port']);
    if (port === undefined) continue;
    const protocol = typeof props['Protocol'] === 'string' ? props['Protocol'] : 'HTTP';
    const tgRefs = collectForwardTargetGroupRefs(props['DefaultActions']);
    if (tgRefs.size === 0) {
      // A forward action whose TargetGroupArn is a literal / cross-stack /
      // imported (non-Ref) arn can't be resolved locally — warn so it isn't a
      // silent no-op. Listeners with no forward action at all (e.g. a
      // redirect-only HTTP->HTTPS listener) are skipped silently.
      if (hasUnresolvableForward(props['DefaultActions'])) {
        warnings.push(
          `Listener '${listenerLogicalId}' on port ${port} forwards to a non-Ref TargetGroupArn ` +
            '(literal / cross-stack / imported); the local front-door only supports in-stack ' +
            'target groups. Skipping it.'
        );
      }
      continue;
    }

    if (protocol !== 'HTTP') {
      warnings.push(
        `Listener '${listenerLogicalId}' on port ${port} uses protocol ${protocol}; the local ` +
          'ALB front-door supports HTTP listeners only in v1 (TLS termination is deferred). ' +
          'Skipping it.'
      );
      continue;
    }

    for (const tgRef of tgRefs) {
      const tg = resources[tgRef];
      if (!tg || tg.Type !== TARGET_GROUP_TYPE) {
        warnings.push(
          `Listener '${listenerLogicalId}' forwards to target group '${tgRef}', but no ` +
            `${TARGET_GROUP_TYPE} with that logical id exists in ${stack.stackName}. Skipping it.`
        );
        continue;
      }
      const tgType = (tg.Properties as Record<string, unknown> | undefined)?.['TargetType'];
      if (tgType === 'lambda') {
        warnings.push(
          `Target group '${tgRef}' is a Lambda target (TargetType: lambda). The local ALB ` +
            'front-door supports ECS targets only in v1; Lambda targets are deferred to a ' +
            'follow-up. Skipping it.'
        );
        continue;
      }
      const backing = tgToService.get(tgRef);
      if (!backing) {
        warnings.push(
          `Target group '${tgRef}' (listener '${listenerLogicalId}', port ${port}) is not ` +
            `referenced by any ${SERVICE_TYPE}.LoadBalancers[] in ${stack.stackName}; cdk-local ` +
            'has no ECS service to front behind it. Skipping it.'
        );
        continue;
      }

      const seenPorts = seenPortsByService.get(backing.serviceLogicalId) ?? new Set<number>();
      if (seenPorts.has(port)) {
        warnings.push(
          `Service '${backing.serviceLogicalId}' is fronted by more than one listener on host ` +
            `port ${port}; the local front-door fronts only the first.`
        );
        continue;
      }
      seenPorts.add(port);
      seenPortsByService.set(backing.serviceLogicalId, seenPorts);

      const targets = byService.get(backing.serviceLogicalId) ?? [];
      targets.push({
        listenerPort: port,
        listenerProtocol: 'HTTP',
        targetContainerName: backing.containerName,
        targetContainerPort: backing.containerPort,
        targetGroupLogicalId: tgRef,
        listenerLogicalId,
      });
      byService.set(backing.serviceLogicalId, targets);
    }
  }

  const services: AlbBackingService[] = [...byService.entries()].map(
    ([serviceLogicalId, targets]) => ({
      serviceLogicalId,
      targets,
    })
  );
  return { services, warnings };
}

/** True when the resource is an application Load Balancer (the `start-alb` target type). */
export function isApplicationLoadBalancer(resource: TemplateResource): boolean {
  if (resource.Type !== ALB_TYPE) return false;
  const type = (resource.Properties as Record<string, unknown> | undefined)?.['Type'];
  // CDK / CFn default for ELBv2 LoadBalancer.Type is `application`.
  return type === undefined || type === 'application';
}

interface BackingServiceRef {
  serviceLogicalId: string;
  containerName: string;
  containerPort: number;
}

/**
 * Build a `targetGroupLogicalId -> backing ECS service` index by scanning every
 * `AWS::ECS::Service.LoadBalancers[]`. First service wins on a shared target
 * group (unusual; would only happen with a hand-rolled template).
 */
function indexTargetGroupToService(
  resources: Record<string, TemplateResource>
): Map<string, BackingServiceRef> {
  const index = new Map<string, BackingServiceRef>();
  for (const [serviceLogicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== SERVICE_TYPE) continue;
    const lbs = (resource.Properties as Record<string, unknown> | undefined)?.['LoadBalancers'];
    if (!Array.isArray(lbs)) continue;
    for (const entry of lbs) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const tgRef = refOf(e['TargetGroupArn']);
      const containerName = typeof e['ContainerName'] === 'string' ? e['ContainerName'] : undefined;
      const containerPort = parseContainerPort(e['ContainerPort']);
      if (!tgRef || !containerName || containerPort === undefined) continue;
      if (!index.has(tgRef)) index.set(tgRef, { serviceLogicalId, containerName, containerPort });
    }
  }
  return index;
}

function collectForwardTargetGroupRefs(defaultActions: unknown): Set<string> {
  const refs = new Set<string>();
  if (!Array.isArray(defaultActions)) return refs;
  for (const action of defaultActions) {
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    if (a['Type'] !== 'forward') continue;
    const direct = refOf(a['TargetGroupArn']);
    if (direct) refs.add(direct);
    const forwardConfig = a['ForwardConfig'];
    if (forwardConfig && typeof forwardConfig === 'object') {
      const groups = (forwardConfig as Record<string, unknown>)['TargetGroups'];
      if (Array.isArray(groups)) {
        for (const g of groups) {
          if (!g || typeof g !== 'object') continue;
          const ref = refOf((g as Record<string, unknown>)['TargetGroupArn']);
          if (ref) refs.add(ref);
        }
      }
    }
  }
  return refs;
}

/**
 * True when `DefaultActions` has at least one `forward` action that references
 * a target group via a NON-`Ref` arn (literal / `Fn::GetAtt` / cross-stack) —
 * i.e. a forward we could not resolve to an in-stack target group. Used to warn
 * rather than silently skip such a listener.
 */
function hasUnresolvableForward(defaultActions: unknown): boolean {
  if (!Array.isArray(defaultActions)) return false;
  for (const action of defaultActions) {
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    if (a['Type'] !== 'forward') continue;
    if (a['TargetGroupArn'] !== undefined && refOf(a['TargetGroupArn']) === undefined) return true;
    const forwardConfig = a['ForwardConfig'];
    if (forwardConfig && typeof forwardConfig === 'object') {
      const groups = (forwardConfig as Record<string, unknown>)['TargetGroups'];
      if (Array.isArray(groups)) {
        for (const g of groups) {
          if (!g || typeof g !== 'object') continue;
          const arn = (g as Record<string, unknown>)['TargetGroupArn'];
          if (arn !== undefined && refOf(arn) === undefined) return true;
        }
      }
    }
  }
  return false;
}

function refOf(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const ref = (raw as Record<string, unknown>)['Ref'];
    if (typeof ref === 'string' && ref.length > 0) return ref;
  }
  return undefined;
}

function parsePort(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 65535) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= 65535) return n;
  }
  return undefined;
}

function parseContainerPort(raw: unknown): number | undefined {
  return parsePort(raw);
}
