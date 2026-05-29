import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';

/**
 * Resolve an `AWS::ElasticLoadBalancingV2::LoadBalancer` (an ALB) into the
 * backing ECS service(s) and the host listener port(s) a local front-door
 * should expose. This is the `cdkl start-alb` entry: you name the ALB, and
 * cdk-local discovers the services behind it (mirroring how `start-api` names
 * the API and discovers the backing Lambdas).
 *
 * The synthesized linkage (confirmed against real `cdk synth` of
 * `ApplicationLoadBalancedFargateService` + an `addAction` path rule):
 *
 * ```
 * ElasticLoadBalancingV2::LoadBalancer  (the ALB you name)
 * ElasticLoadBalancingV2::Listener      : { LoadBalancerArn:{Ref:<ALB>}, Port, Protocol,
 *     DefaultActions:[{ Type:"forward", TargetGroupArn:{Ref:<TG>} }] }
 * ElasticLoadBalancingV2::ListenerRule  : { ListenerArn:{Ref:<Listener>}, Priority,
 *     Conditions:[{ Field:"path-pattern", PathPatternConfig:{ Values:["/api/*"] } }],
 *     Actions:[{ Type:"forward", TargetGroupArn:{Ref:<TG>} }] }
 * ElasticLoadBalancingV2::TargetGroup   : { Port, Protocol, TargetType:"ip" }
 * ECS::Service.LoadBalancers[]          -> { ContainerName, ContainerPort, TargetGroupArn:{Ref:<TG>} }
 * ```
 *
 * Resolution walks ALB -> listeners (by `LoadBalancerArn` Ref) -> their default
 * `forward` action AND any `path-pattern` ListenerRules -> the ECS Service whose
 * `LoadBalancers[]` references each target group (a reverse scan; there is no
 * direct TG -> service pointer). Output is a per-listener routing table: a
 * default forward target (when the default action is a resolvable forward) plus
 * the ordered path-pattern rules.
 *
 * Scope: HTTP listeners, `path-pattern` conditions, single-target `forward`
 * actions to ECS services. Skipped with a warning: HTTPS/TLS listeners,
 * `TargetType:"lambda"` target groups, weighted (multi-target) forwards, rules
 * with non-`path-pattern` conditions (host-header / http-header / query-string
 * / etc.), and `redirect` / `fixed-response` / `authenticate-*` actions. Those
 * remaining listener-rule features are tracked in #123.
 */

const ALB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const LISTENER_RULE_TYPE = 'AWS::ElasticLoadBalancingV2::ListenerRule';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const SERVICE_TYPE = 'AWS::ECS::Service';

/** The backing (service, container) a listener action forwards to. */
export interface FrontDoorForwardTarget {
  /** Logical id of the `AWS::ECS::Service` behind the target group. */
  serviceLogicalId: string;
  /** Container the action forwards to (`LoadBalancers[].ContainerName`). */
  targetContainerName: string;
  /** Container port the target group targets (`LoadBalancers[].ContainerPort`). */
  targetContainerPort: number;
  /** Logical id of the resolved target group (diagnostics). */
  targetGroupLogicalId: string;
}

/** One resolved path-pattern routing rule on a listener. */
export interface ResolvedListenerRule {
  /** ALB rule priority (lower = evaluated first). */
  priority: number;
  /** The rule's `path-pattern` condition values (OR-matched). */
  pathPatterns: string[];
  /** The backing forward target this rule routes to. */
  target: FrontDoorForwardTarget;
}

/** A resolved listener front-door: one host port, an optional default target + path rules. */
export interface ResolvedListenerFrontDoor {
  /** Listener port declared on the ALB (the stable host endpoint port). */
  listenerPort: number;
  /** Listener protocol — always `HTTP` here (HTTPS is skipped upstream). */
  listenerProtocol: 'HTTP';
  /** Logical id of the listener (diagnostics). */
  listenerLogicalId: string;
  /**
   * Default-action forward target. Present when the listener's `DefaultActions`
   * is a resolvable single `forward` to an ECS service; absent when the default
   * is a `fixed-response` / `redirect` (a rules-only listener) — unmatched
   * requests then get a 404 from the front-door.
   */
  defaultTarget?: FrontDoorForwardTarget;
  /** Path-pattern rules (unordered here; the matcher evaluates by priority). */
  rules: ResolvedListenerRule[];
}

export interface AlbFrontDoorResolution {
  /** Front-door listeners discovered on the ALB, each with its routing table. */
  listeners: ResolvedListenerFrontDoor[];
  /** Non-fatal warnings (the CLI surfaces these and proceeds). */
  warnings: string[];
}

/**
 * Resolve an ALB into its front-door listeners + routing tables. Pure — reads
 * only the supplied stack template. Returns an empty `listeners` array (with
 * warnings) when the ALB fronts nothing cdk-local can serve locally.
 */
export function resolveAlbFrontDoor(
  stack: StackInfo,
  albLogicalId: string
): AlbFrontDoorResolution {
  const warnings: string[] = [];
  const resources = stack.template.Resources ?? {};
  const stackName = stack.stackName;

  // TG logical id -> backing ECS service (reverse of Service.LoadBalancers[]).
  const tgToService = indexTargetGroupToService(resources);
  // Listener logical id -> its ListenerRules.
  const rulesByListener = indexRulesByListener(resources);

  const listeners: ResolvedListenerFrontDoor[] = [];

  for (const [listenerLogicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== LISTENER_TYPE) continue;
    const props = (resource.Properties ?? {}) as Record<string, unknown>;
    if (refOf(props['LoadBalancerArn']) !== albLogicalId) continue;

    const port = parsePort(props['Port']);
    if (port === undefined) continue;
    const protocol = typeof props['Protocol'] === 'string' ? props['Protocol'] : 'HTTP';
    if (protocol !== 'HTTP') {
      warnings.push(
        `Listener '${listenerLogicalId}' on port ${port} uses protocol ${protocol}; the local ` +
          'ALB front-door supports HTTP listeners only (TLS termination is deferred). Skipping it.'
      );
      continue;
    }

    const defaultTarget = resolveForwardTarget(
      props['DefaultActions'],
      resources,
      tgToService,
      stackName,
      `Listener '${listenerLogicalId}' (port ${port}) default action`,
      warnings
    );

    const rules: ResolvedListenerRule[] = [];
    for (const { ruleLogicalId, ruleProps } of rulesByListener.get(listenerLogicalId) ?? []) {
      const priority = parsePriority(ruleProps['Priority']);
      const ruleLabel = `Listener rule '${ruleLogicalId}' (priority ${priority})`;
      const { patterns, unsupported } = parseRulePathPatterns(ruleProps['Conditions']);
      if (unsupported.length > 0) {
        warnings.push(
          `${ruleLabel} uses unsupported condition(s): ${unsupported.join(', ')}. The local ALB ` +
            'front-door supports path-pattern conditions only (host-header / http-header / ' +
            'query-string / http-request-method / source-ip deferred). Skipping it.'
        );
        continue;
      }
      if (patterns.length === 0) continue; // no path-pattern values to route on
      const target = resolveForwardTarget(
        ruleProps['Actions'],
        resources,
        tgToService,
        stackName,
        `${ruleLabel} action`,
        warnings
      );
      if (!target) continue; // resolveForwardTarget already warned
      rules.push({ priority, pathPatterns: patterns, target });
    }

    if (!defaultTarget && rules.length === 0) {
      // The listener forwards to nothing cdk-local can serve (e.g. a
      // redirect-only listener, or every action was skipped above).
      continue;
    }

    listeners.push({
      listenerPort: port,
      listenerProtocol: 'HTTP',
      listenerLogicalId,
      ...(defaultTarget ? { defaultTarget } : {}),
      rules,
    });
  }

  return { listeners, warnings };
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
 * Resolve a listener / rule `Actions` (or `DefaultActions`) array to a single
 * ECS-service forward target, or `undefined` when it is not a resolvable
 * single forward (warning emitted for the cases worth surfacing).
 */
function resolveForwardTarget(
  actions: unknown,
  resources: Record<string, TemplateResource>,
  tgToService: Map<string, BackingServiceRef>,
  stackName: string,
  label: string,
  warnings: string[]
): FrontDoorForwardTarget | undefined {
  const tgRefs = collectForwardTargetGroupRefs(actions);
  if (tgRefs.size === 0) {
    // No forward at all (redirect / fixed-response — silent) or a non-Ref
    // forward we cannot resolve to an in-stack target group (worth a warning).
    if (hasUnresolvableForward(actions)) {
      warnings.push(
        `${label} forwards to a non-Ref TargetGroupArn (literal / cross-stack / imported); the ` +
          'local front-door only supports in-stack target groups. Skipping it.'
      );
    }
    return undefined;
  }
  if (tgRefs.size > 1) {
    warnings.push(
      `${label} is a weighted forward (multiple target groups); the local front-door supports a ` +
        'single target group per action (weighted routing deferred). Skipping it.'
    );
    return undefined;
  }
  const tgRef = [...tgRefs][0]!;
  const tg = resources[tgRef];
  if (!tg || tg.Type !== TARGET_GROUP_TYPE) {
    warnings.push(
      `${label} forwards to target group '${tgRef}', but no ${TARGET_GROUP_TYPE} with that logical ` +
        `id exists in ${stackName}. Skipping it.`
    );
    return undefined;
  }
  const tgType = (tg.Properties as Record<string, unknown> | undefined)?.['TargetType'];
  if (tgType === 'lambda') {
    warnings.push(
      `${label} forwards to a Lambda target group '${tgRef}' (TargetType: lambda). The local ALB ` +
        'front-door supports ECS targets only; Lambda targets are deferred. Skipping it.'
    );
    return undefined;
  }
  const backing = tgToService.get(tgRef);
  if (!backing) {
    warnings.push(
      `${label} forwards to target group '${tgRef}', which is not referenced by any ` +
        `${SERVICE_TYPE}.LoadBalancers[] in ${stackName}; cdk-local has no ECS service to front ` +
        'behind it. Skipping it.'
    );
    return undefined;
  }
  return {
    serviceLogicalId: backing.serviceLogicalId,
    targetContainerName: backing.containerName,
    targetContainerPort: backing.containerPort,
    targetGroupLogicalId: tgRef,
  };
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

/** Group every `AWS::ElasticLoadBalancingV2::ListenerRule` by the listener it references. */
function indexRulesByListener(
  resources: Record<string, TemplateResource>
): Map<string, Array<{ ruleLogicalId: string; ruleProps: Record<string, unknown> }>> {
  const index = new Map<
    string,
    Array<{ ruleLogicalId: string; ruleProps: Record<string, unknown> }>
  >();
  for (const [ruleLogicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== LISTENER_RULE_TYPE) continue;
    const ruleProps = (resource.Properties ?? {}) as Record<string, unknown>;
    const listenerRef = refOf(ruleProps['ListenerArn']);
    if (!listenerRef) continue;
    const list = index.get(listenerRef) ?? [];
    list.push({ ruleLogicalId, ruleProps });
    index.set(listenerRef, list);
  }
  return index;
}

/**
 * Parse a ListenerRule's `Conditions` into its `path-pattern` values plus the
 * field names of any non-`path-pattern` conditions (which make the rule
 * unsupported in this version). A rule is only usable when every condition is a
 * `path-pattern` — ALB ANDs conditions together, and we cannot honor the others
 * locally yet.
 */
function parseRulePathPatterns(conditions: unknown): { patterns: string[]; unsupported: string[] } {
  const patterns: string[] = [];
  const unsupported: string[] = [];
  if (!Array.isArray(conditions)) return { patterns, unsupported };
  for (const cond of conditions) {
    if (!cond || typeof cond !== 'object') continue;
    const c = cond as Record<string, unknown>;
    const field = typeof c['Field'] === 'string' ? c['Field'] : '(unknown)';
    if (field !== 'path-pattern') {
      unsupported.push(field);
      continue;
    }
    const cfg = c['PathPatternConfig'];
    const values =
      cfg && typeof cfg === 'object' && Array.isArray((cfg as Record<string, unknown>)['Values'])
        ? ((cfg as Record<string, unknown>)['Values'] as unknown[])
        : Array.isArray(c['Values'])
          ? (c['Values'] as unknown[])
          : [];
    for (const v of values) if (typeof v === 'string') patterns.push(v);
  }
  return { patterns, unsupported };
}

function collectForwardTargetGroupRefs(actions: unknown): Set<string> {
  const refs = new Set<string>();
  if (!Array.isArray(actions)) return refs;
  for (const action of actions) {
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
 * True when `actions` has at least one `forward` action that references a target
 * group via a NON-`Ref` arn (literal / `Fn::GetAtt` / cross-stack) — i.e. a
 * forward we could not resolve to an in-stack target group. Used to warn rather
 * than silently skip such a listener / rule.
 */
function hasUnresolvableForward(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  for (const action of actions) {
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

/**
 * Parse a ListenerRule `Priority` (ALB priorities are 1-50000, lower = higher
 * precedence). A missing / unparseable priority sorts last so an explicitly
 * prioritized rule always wins over it.
 */
function parsePriority(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return Number.MAX_SAFE_INTEGER;
}
