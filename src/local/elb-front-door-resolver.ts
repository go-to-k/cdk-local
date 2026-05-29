import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import type { ResolvedServiceLoadBalancer } from './ecs-service-resolver.js';

/**
 * Issue #86 v1 — resolve an ECS service's `LoadBalancers[]` entries into the
 * host listener port(s) a local ALB front-door should expose.
 *
 * The synthesized linkage (confirmed against real `cdk synth` of
 * `ApplicationLoadBalancedFargateService`):
 *
 * ```
 * ECS::Service.LoadBalancers[] -> { ContainerName, ContainerPort, TargetGroupArn:{Ref:<TG>} }
 * ElasticLoadBalancingV2::TargetGroup  : { Port, Protocol, TargetType:"ip" }
 * ElasticLoadBalancingV2::Listener     : { Port, Protocol,
 *     DefaultActions:[{ Type:"forward", TargetGroupArn:{Ref:<TG>} }] }
 * ```
 *
 * The Listener references the TargetGroup; there is no back-pointer from the
 * TargetGroup to the Listener, so we scan every
 * `AWS::ElasticLoadBalancingV2::Listener` for a default `forward` action whose
 * target group `Ref` matches the service's, then read that listener's `Port` /
 * `Protocol`. The forward target is the service's `LoadBalancers[].ContainerName`
 * / `ContainerPort`.
 *
 * v1 scope (single forward): only the listener's `DefaultActions` are honored.
 * `AWS::ElasticLoadBalancingV2::ListenerRule` (path / host / weighted routing)
 * is ignored — tracked in #123. HTTPS / TLS listeners and `TargetType:"lambda"`
 * target groups are skipped with a warning.
 */

const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';

/** One resolved host front-door: a listener port forwarding to a replica pool. */
export interface ResolvedFrontDoorTarget {
  /** Listener port declared on the ALB (the stable host endpoint port). */
  listenerPort: number;
  /** Listener protocol — always `HTTP` in v1 (HTTPS is skipped upstream). */
  listenerProtocol: 'HTTP';
  /** Container the listener forwards to (`LoadBalancers[].ContainerName`). */
  targetContainerName: string;
  /** Container port the target group targets (`LoadBalancers[].ContainerPort`). */
  targetContainerPort: number;
  /** Logical id of the resolved target group (diagnostics / dedup). */
  targetGroupLogicalId: string;
  /** Logical id of the fronting listener (diagnostics). */
  listenerLogicalId: string;
}

export interface FrontDoorResolution {
  targets: ResolvedFrontDoorTarget[];
  warnings: string[];
}

/**
 * Resolve a service's load-balancer entries into front-door targets. Pure —
 * reads only the supplied stack template, returns the resolved targets plus
 * any non-fatal warnings (the CLI surfaces these and proceeds). Returns an
 * empty `targets` array when the service has no load balancer attached.
 */
export function resolveFrontDoorTargets(
  stack: StackInfo,
  loadBalancers: ReadonlyArray<ResolvedServiceLoadBalancer>
): FrontDoorResolution {
  const warnings: string[] = [];
  const targets: ResolvedFrontDoorTarget[] = [];
  if (loadBalancers.length === 0) return { targets, warnings };

  const resources = stack.template.Resources ?? {};
  const listeners = collectForwardingListeners(resources);

  // Dedup by listener port: two LB entries fronted by the same listener port
  // would collide on a single host server. Keep the first and warn.
  const seenPorts = new Set<number>();

  for (const lb of loadBalancers) {
    if (!lb.targetGroupLogicalId) {
      warnings.push(
        `ECS Service load balancer for container '${lb.containerName}:${lb.containerPort}' uses a ` +
          'non-Ref TargetGroupArn (literal / cross-stack / imported); the local front-door only ' +
          'supports in-stack target groups. Skipping it.'
      );
      continue;
    }
    const tg = resources[lb.targetGroupLogicalId];
    if (!tg || tg.Type !== TARGET_GROUP_TYPE) {
      warnings.push(
        `ECS Service load balancer references target group '${lb.targetGroupLogicalId}', but no ` +
          `${TARGET_GROUP_TYPE} with that logical id exists in ${stack.stackName}. Skipping it.`
      );
      continue;
    }
    const tgProps = (tg.Properties ?? {}) as Record<string, unknown>;
    const targetType =
      typeof tgProps['TargetType'] === 'string' ? tgProps['TargetType'] : undefined;
    if (targetType === 'lambda') {
      warnings.push(
        `Target group '${lb.targetGroupLogicalId}' is a Lambda target (TargetType: lambda). The ` +
          'local ALB front-door supports ECS targets only in v1; Lambda targets are deferred to a ' +
          'follow-up. Skipping it.'
      );
      continue;
    }

    const matchingListeners = listeners.filter((l) =>
      l.targetGroupRefs.has(lb.targetGroupLogicalId!)
    );
    if (matchingListeners.length === 0) {
      warnings.push(
        `Target group '${lb.targetGroupLogicalId}' (container '${lb.containerName}:${lb.containerPort}') ` +
          'has no default-forward listener in the synthesized template. cdk-local cannot determine a ' +
          'listener port to front it. Skipping it.'
      );
      continue;
    }

    for (const listener of matchingListeners) {
      if (listener.protocol !== 'HTTP') {
        warnings.push(
          `Listener '${listener.logicalId}' on port ${listener.port} uses protocol ` +
            `${listener.protocol}; the local ALB front-door supports HTTP listeners only in v1 ` +
            '(TLS termination is deferred). Skipping it.'
        );
        continue;
      }
      if (seenPorts.has(listener.port)) {
        warnings.push(
          `Multiple load-balancer targets resolve to host listener port ${listener.port}; ` +
            'the local front-door fronts only the first. Refine the service if you need distinct ' +
            'endpoints.'
        );
        continue;
      }
      seenPorts.add(listener.port);
      targets.push({
        listenerPort: listener.port,
        listenerProtocol: 'HTTP',
        targetContainerName: lb.containerName,
        targetContainerPort: lb.containerPort,
        targetGroupLogicalId: lb.targetGroupLogicalId,
        listenerLogicalId: listener.logicalId,
      });
    }
  }

  return { targets, warnings };
}

interface ForwardingListener {
  logicalId: string;
  port: number;
  protocol: string;
  /** Logical ids of every target group this listener default-forwards to. */
  targetGroupRefs: Set<string>;
}

/**
 * Index every listener that has a default `forward` action, mapping it to the
 * set of target-group logical ids it forwards to. Handles both the direct
 * `TargetGroupArn` shape and the `ForwardConfig.TargetGroups[]` (weighted)
 * shape — v1 only cares whether OUR target group is among them.
 */
function collectForwardingListeners(
  resources: Record<string, TemplateResource>
): ForwardingListener[] {
  const out: ForwardingListener[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== LISTENER_TYPE) continue;
    const props = (resource.Properties ?? {}) as Record<string, unknown>;
    const port = parsePort(props['Port']);
    if (port === undefined) continue;
    const protocol = typeof props['Protocol'] === 'string' ? props['Protocol'] : 'HTTP';
    const refs = collectForwardTargetGroupRefs(props['DefaultActions']);
    if (refs.size === 0) continue;
    out.push({ logicalId, port, protocol, targetGroupRefs: refs });
  }
  return out;
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
