import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import type { AlbHttpHeaderCondition, AlbQueryStringCondition } from './alb-path-matcher.js';

/**
 * Resolve an `AWS::ElasticLoadBalancingV2::LoadBalancer` (an ALB) into the
 * backing ECS service(s) and the host listener port(s) a local front-door
 * should expose. This is the `cdkl start-alb` entry: you name the ALB, and
 * cdk-local discovers the services behind it (mirroring how `start-api` names
 * the API and discovers the backing Lambdas).
 *
 * The synthesized linkage (confirmed against real `cdk synth` of an
 * `ApplicationLoadBalancer` + `addAction` rules):
 *
 * ```
 * ElasticLoadBalancingV2::LoadBalancer  (the ALB you name)
 * ElasticLoadBalancingV2::Listener      : { LoadBalancerArn:{Ref:<ALB>}, Port, Protocol,
 *     DefaultActions:[ <action> ] }
 * ElasticLoadBalancingV2::ListenerRule  : { ListenerArn:{Ref:<Listener>}, Priority,
 *     Conditions:[{ Field:"path-pattern", PathPatternConfig:{ Values:["/api/*"] } },
 *                 { Field:"host-header",  HostHeaderConfig:{ Values:["api.example.com"] } },
 *                 { Field:"http-header",  HttpHeaderConfig:{ HttpHeaderName:"X-API", Values:["*"] } },
 *                 { Field:"http-request-method", HttpRequestMethodConfig:{ Values:["POST"] } },
 *                 { Field:"query-string", QueryStringConfig:{ Values:[{ Key:"v", Value:"1" }] } },
 *                 { Field:"source-ip",    SourceIpConfig:{ Values:["10.0.0.0/8"] } }],
 *     Actions:[ <action> ] }
 * ElasticLoadBalancingV2::TargetGroup   : { Port, Protocol, TargetType:"ip" }
 * ECS::Service.LoadBalancers[]          -> { ContainerName, ContainerPort, TargetGroupArn:{Ref:<TG>} }
 * ```
 *
 * Each `<action>` is one of:
 *   - `forward` — `{ Type:"forward", TargetGroupArn:{Ref} }` (single target) OR
 *     `{ Type:"forward", ForwardConfig:{ TargetGroups:[{ TargetGroupArn:{Ref}, Weight }] } }`
 *     (one or more weighted targets);
 *   - `redirect` — `{ Type:"redirect", RedirectConfig:{ Protocol/Host/Port/Path/Query/StatusCode } }`;
 *   - `fixed-response` — `{ Type:"fixed-response", FixedResponseConfig:{ StatusCode/ContentType/MessageBody } }`.
 *
 * Resolution walks ALB -> listeners (by `LoadBalancerArn` Ref) -> their default
 * action AND any ListenerRules -> for each `forward`, the ECS Service whose
 * `LoadBalancers[]` references each target group (a reverse scan; there is no
 * direct TG -> service pointer). Output is a per-listener routing table: a
 * default action plus the ordered rules, each carrying its resolved action and
 * its full set of routing conditions.
 *
 * Scope: HTTP listeners; all six ALB rule-condition fields (`path-pattern`,
 * `host-header`, `http-header`, `http-request-method`, `query-string`,
 * `source-ip`); `forward` (single or weighted) to ECS services AND/OR Lambda
 * functions (`TargetType:"lambda"` target groups — #123: the TG -> backing
 * `AWS::Lambda::Function` is resolved and the front-door invokes it locally per
 * request); `redirect` / `fixed-response` actions. A single weighted forward may
 * mix ECS and Lambda targets. HTTPS listeners are served — local TLS
 * termination uses a user-supplied or auto-generated self-signed cert/key
 * pair (the deployed `Listener.Certificates[]` ACM ARNs are not fetched,
 * because ACM private keys are not retrievable by design).
 *
 * `authenticate-cognito` / `authenticate-oidc` actions ARE served — they are
 * lifted from the `Actions[]` array into an `authGuard` attached to the
 * terminal action they wrap. The front-door enforces a Bearer-JWT check
 * locally (signature + `iss` + `exp` + `aud`) using the existing JWKS-cached
 * verifier; missing / invalid token -> 401 with `WWW-Authenticate: Bearer`.
 * Out of scope: the full OAuth roundtrip (authorize-endpoint redirect +
 * callback). The local-dev parity is "I have a JWT, let me through" — the
 * `--bearer-token <jwt>` flag is the convenience escape hatch; the
 * `--no-verify-auth` flag disables the guard entirely.
 *
 * Skipped with a warning: TLS listeners (NLB-style, not ALB).
 */

const ALB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
const LISTENER_RULE_TYPE = 'AWS::ElasticLoadBalancingV2::ListenerRule';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const SERVICE_TYPE = 'AWS::ECS::Service';
const LAMBDA_FUNCTION_TYPE = 'AWS::Lambda::Function';

/**
 * The backing target one forward target group routes to, plus its weight. A
 * discriminated union: either an ECS service (the original `start-alb` path) or
 * a Lambda function (`TargetType: lambda` target groups, #123). A single
 * weighted forward may mix both. The front-door dispatches an ECS target to a
 * replica pool and a Lambda target to a locally-invoked RIE container.
 */
export type FrontDoorForwardTarget = FrontDoorEcsTarget | FrontDoorLambdaTarget;

/** A weighted forward target backed by an ECS service behind the target group. */
export interface FrontDoorEcsTarget {
  kind: 'ecs';
  /** Logical id of the `AWS::ECS::Service` behind the target group. */
  serviceLogicalId: string;
  /** Container the action forwards to (`LoadBalancers[].ContainerName`). */
  targetContainerName: string;
  /** Container port the target group targets (`LoadBalancers[].ContainerPort`). */
  targetContainerPort: number;
  /** Logical id of the resolved target group (diagnostics). */
  targetGroupLogicalId: string;
  /**
   * Forward weight for weighted routing. A single-target forward defaults to 1;
   * a `ForwardConfig.TargetGroups[]` entry carries its declared `Weight`
   * (weight 0 means "never routed", per ALB semantics).
   */
  weight: number;
}

/**
 * A weighted forward target backed by a Lambda function (a `TargetType: lambda`
 * target group, #123). The synthesized linkage:
 *
 * ```
 * ElasticLoadBalancingV2::TargetGroup : { TargetType:"lambda",
 *     Targets:[{ Id:{ "Fn::GetAtt":[<FnLogicalId>, "Arn"] } }],
 *     TargetGroupAttributes?:[{ Key:"lambda.multi_value_headers.enabled", Value:"true" }] }
 * Lambda::Permission                  : grants elasticloadbalancing principal invoke
 * ```
 *
 * The backing function is read from `Targets[0].Id.Fn::GetAtt[0]`.
 */
export interface FrontDoorLambdaTarget {
  kind: 'lambda';
  /** Logical id of the backing `AWS::Lambda::Function`. */
  lambdaLogicalId: string;
  /** Logical id of the resolved target group (diagnostics + `requestContext.elb`). */
  targetGroupLogicalId: string;
  /**
   * `lambda.multi_value_headers.enabled` target-group attribute. `true` ->
   * the ALB event uses `multiValueHeaders` / `multiValueQueryStringParameters`;
   * `false` (default) -> single-value `headers` / `queryStringParameters`.
   */
  multiValueHeaders: boolean;
  /**
   * Forward weight for weighted routing. A single-target forward defaults to 1;
   * a `ForwardConfig.TargetGroups[]` entry carries its declared `Weight`
   * (weight 0 means "never routed", per ALB semantics).
   */
  weight: number;
}

/** A resolved `redirect` action (ALB builds a `Location` from these + request placeholders). */
export interface FrontDoorRedirectAction {
  kind: 'redirect';
  /** HTTP status (301 permanent / 302 found). ALB emits `HTTP_301` / `HTTP_302`. */
  statusCode: 301 | 302;
  /** `#{protocol}` (default) / `HTTP` / `HTTPS`. */
  protocol?: string;
  /** `#{host}` (default) or a literal host. */
  host?: string;
  /** `#{port}` (default) or a literal port. */
  port?: string;
  /** `/#{path}` (default) or a literal path; ALB requires a leading `/`. */
  path?: string;
  /** `#{query}` (default) or a literal query (without the leading `?`). */
  query?: string;
}

/** A resolved `fixed-response` action (ALB synthesizes the whole response). */
export interface FrontDoorFixedResponseAction {
  kind: 'fixed-response';
  /** HTTP status code (ALB stores it as a numeric string, e.g. `"404"`). */
  statusCode: number;
  /** Response `Content-Type` (defaults to `text/plain` when absent). */
  contentType?: string;
  /** Response body (empty when absent). */
  messageBody?: string;
}

/** A resolved `forward` action: one or more weighted ECS-service targets. */
export interface FrontDoorForwardAction {
  kind: 'forward';
  /** The weighted forward targets (length >= 1; single-target forward = one entry, weight 1). */
  targets: FrontDoorForwardTarget[];
}

/**
 * The local-enforced ALB authenticate-* guard. An `authenticate-cognito` /
 * `authenticate-oidc` action in `Actions[]` is parsed into one of these and
 * attached to the terminal action it wraps. The front-door evaluates the
 * guard before serving the action; the cloud-side OAuth roundtrip is NOT
 * reproduced (see module jsdoc).
 *
 * Cognito vs OIDC are mostly the same shape — both end up checking a Bearer
 * JWT's `iss` + `aud` + signature. The `kind` is retained for logs / docs and
 * for the Cognito-direct JWKS optimization (`region` + `userPoolId`).
 */
export interface FrontDoorAuthGuard {
  kind: 'authenticate-cognito' | 'authenticate-oidc';
  /** Expected JWT `iss` (Cognito issuer URL or the OIDC `Issuer`). */
  issuer: string;
  /** Allowed JWT `aud` value (Cognito `UserPoolClientId` or OIDC `ClientId`). */
  audience: string;
  /** Cognito-only: enables the direct JWKS URL fast path. */
  region?: string;
  /** Cognito-only: enables the direct JWKS URL fast path. */
  userPoolId?: string;
  /**
   * Cookie name prefix that ALB issues on a successful sign-in. The presence
   * of any cookie matching `<prefix>-N` short-circuits the guard (the user is
   * acting as if already signed in via the deployed ALB; local-dev parity).
   * Defaults to `AWSELBAuthSessionCookie` per ALB.
   */
  sessionCookieName: string;
  /** Diagnostic label for log lines + the 401 `WWW-Authenticate` realm. */
  label: string;
}

/** Any resolved listener / rule action the local front-door can serve. */
export type ResolvedListenerAction =
  | FrontDoorForwardAction
  | FrontDoorRedirectAction
  | FrontDoorFixedResponseAction;

/** One resolved routing rule on a listener — all six ALB condition fields + an action. */
export interface ResolvedListenerRule {
  /** ALB rule priority (lower = evaluated first). */
  priority: number;
  /** The rule's `path-pattern` condition values (OR-matched; empty = no path constraint). */
  pathPatterns: string[];
  /** The rule's `host-header` condition values (OR-matched; empty = no host constraint). */
  hostPatterns: string[];
  /** The rule's `http-header` conditions (each AND'd; values within OR; empty = no header constraint). */
  httpHeaderConditions: AlbHttpHeaderCondition[];
  /** The rule's `http-request-method` values (OR-matched, exact; empty = no method constraint). */
  httpRequestMethods: string[];
  /** The rule's `query-string` `{ Key?, Value }` pairs (OR-matched; empty = no query-string constraint). */
  queryStringConditions: AlbQueryStringCondition[];
  /** The rule's `source-ip` CIDR values (OR-matched; empty = no source-IP constraint). */
  sourceIpCidrs: string[];
  /** The action this rule performs when its conditions match. */
  action: ResolvedListenerAction;
  /**
   * When the rule's `Actions[]` declared an `authenticate-cognito` /
   * `authenticate-oidc` action before the terminal action, this carries the
   * resolved guard. The front-door enforces it before serving `action`.
   */
  authGuard?: FrontDoorAuthGuard;
}

/** A resolved listener front-door: one host port, an optional default action + rules. */
export interface ResolvedListenerFrontDoor {
  /** Listener port declared on the ALB (the stable host endpoint port). */
  listenerPort: number;
  /** Listener protocol — `HTTP` or `HTTPS`. */
  listenerProtocol: 'HTTP' | 'HTTPS';
  /** Logical id of the listener (diagnostics). */
  listenerLogicalId: string;
  /**
   * Default action. Present when the listener's `DefaultActions` is a resolvable
   * forward / redirect / fixed-response. Absent only when the default action
   * was a bare authenticate-* with no terminal action — unmatched requests then
   * get a 404 from the front-door.
   */
  defaultAction?: ResolvedListenerAction;
  /**
   * Auth guard for the default action (when `DefaultActions[]` started with
   * an `authenticate-cognito` / `authenticate-oidc` entry).
   */
  defaultAuthGuard?: FrontDoorAuthGuard;
  /** Rules (unordered here; the matcher evaluates by priority). */
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
    if (protocol !== 'HTTP' && protocol !== 'HTTPS') {
      warnings.push(
        `Listener '${listenerLogicalId}' on port ${port} uses protocol ${protocol}; the local ` +
          'ALB front-door supports HTTP and HTTPS listeners only (TLS / NLB-style listeners are ' +
          'not served). Skipping it.'
      );
      continue;
    }
    if (
      protocol === 'HTTPS' &&
      Array.isArray(props['Certificates']) &&
      props['Certificates'].length > 0
    ) {
      // The deployed Listener's ACM-backed Certificates[] is not fetched: ACM
      // private keys are not retrievable, by design. The local front-door
      // terminates TLS with a user-supplied or auto-generated self-signed
      // cert instead.
      warnings.push(
        `Listener '${listenerLogicalId}' on port ${port} declares ACM Certificates which are not ` +
          'retrievable locally. The front-door terminates TLS with --tls-cert/--tls-key or an ' +
          'auto-generated self-signed cert.'
      );
    }

    const defaultResolved = resolveAction(
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
      const parsed = parseRuleConditions(ruleProps['Conditions'], ruleLabel, warnings);
      if (!parsed) {
        // parseRuleConditions warned about an unsupported / malformed condition.
        continue;
      }
      const {
        pathPatterns,
        hostPatterns,
        httpHeaderConditions,
        httpRequestMethods,
        queryStringConditions,
        sourceIpCidrs,
      } = parsed;
      const hasAnyCondition =
        pathPatterns.length > 0 ||
        hostPatterns.length > 0 ||
        httpHeaderConditions.length > 0 ||
        httpRequestMethods.length > 0 ||
        queryStringConditions.length > 0 ||
        sourceIpCidrs.length > 0;
      if (!hasAnyCondition) {
        // No supported condition to route on (an empty / catch-all rule).
        continue;
      }
      const ruleResolved = resolveAction(
        ruleProps['Actions'],
        resources,
        tgToService,
        stackName,
        `${ruleLabel} action`,
        warnings
      );
      if (!ruleResolved) continue; // resolveAction already warned (or it was a bare authenticate-*)
      rules.push({
        priority,
        pathPatterns,
        hostPatterns,
        httpHeaderConditions,
        httpRequestMethods,
        queryStringConditions,
        sourceIpCidrs,
        action: ruleResolved.action,
        ...(ruleResolved.authGuard ? { authGuard: ruleResolved.authGuard } : {}),
      });
    }

    if (!defaultResolved && rules.length === 0) {
      // The listener serves nothing cdk-local can route (e.g. a bare authenticate-*
      // default and every rule skipped above).
      continue;
    }

    listeners.push({
      listenerPort: port,
      listenerProtocol: protocol,
      listenerLogicalId,
      ...(defaultResolved ? { defaultAction: defaultResolved.action } : {}),
      ...(defaultResolved?.authGuard ? { defaultAuthGuard: defaultResolved.authGuard } : {}),
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
 * Resolve a listener / rule `Actions` (or `DefaultActions`) array. ALB allows
 * any number of `authenticate-cognito` / `authenticate-oidc` entries followed
 * by exactly one terminal action (`forward` / `redirect` / `fixed-response`).
 * The first parseable authenticate-* (last wins if multiple) becomes the
 * returned `authGuard`; the terminal action becomes `action`. Returns
 * `undefined` when no terminal action is resolvable.
 */
function resolveAction(
  actions: unknown,
  resources: Record<string, TemplateResource>,
  tgToService: Map<string, BackingServiceRef>,
  stackName: string,
  label: string,
  warnings: string[]
): { action: ResolvedListenerAction; authGuard?: FrontDoorAuthGuard } | undefined {
  if (!Array.isArray(actions)) return undefined;

  let authGuard: FrontDoorAuthGuard | undefined;
  let sawAuthenticate = false;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    const type = a['Type'];

    if (type === 'authenticate-cognito' || type === 'authenticate-oidc') {
      sawAuthenticate = true;
      const parsed = parseAuthenticateAction(a, type, label, warnings);
      if (parsed) authGuard = parsed;
      continue;
    }
    let terminal: ResolvedListenerAction | undefined;
    if (type === 'forward') {
      terminal = resolveForwardAction(a, resources, tgToService, stackName, label, warnings);
    } else if (type === 'redirect') {
      terminal = resolveRedirectAction(a, label, warnings);
    } else if (type === 'fixed-response') {
      terminal = resolveFixedResponseAction(a);
    } else if (typeof type === 'string') {
      warnings.push(
        `${label} uses an unsupported action type '${type}'. The local ALB front-door supports ` +
          'forward / redirect / fixed-response actions only. Skipping it.'
      );
    }
    if (terminal) {
      return authGuard ? { action: terminal, authGuard } : { action: terminal };
    }
  }

  if (sawAuthenticate) {
    warnings.push(
      `${label} is an authenticate-* action with no local-servable terminal action; skipping it.`
    );
  }
  return undefined;
}

/**
 * Resolve a `forward` action into one or more weighted targets. Each target
 * group is either an ECS service (the original `start-alb` path) or a
 * `TargetType: lambda` group backed by an in-stack Lambda (#123); a single
 * weighted forward may mix both.
 */
function resolveForwardAction(
  action: Record<string, unknown>,
  resources: Record<string, TemplateResource>,
  tgToService: Map<string, BackingServiceRef>,
  stackName: string,
  label: string,
  warnings: string[]
): FrontDoorForwardAction | undefined {
  const refs = collectForwardTargetGroupRefs(action);
  if (refs.length === 0) {
    if (hasUnresolvableForward(action)) {
      warnings.push(
        `${label} forwards to a non-Ref TargetGroupArn (literal / cross-stack / imported); the ` +
          'local front-door only supports in-stack target groups. Skipping it.'
      );
    }
    return undefined;
  }

  const targets: FrontDoorForwardTarget[] = [];
  for (const { tgRef, weight } of refs) {
    const tg = resources[tgRef];
    if (!tg || tg.Type !== TARGET_GROUP_TYPE) {
      warnings.push(
        `${label} forwards to target group '${tgRef}', but no ${TARGET_GROUP_TYPE} with that ` +
          `logical id exists in ${stackName}. Skipping that target group.`
      );
      continue;
    }
    const tgProps = (tg.Properties as Record<string, unknown> | undefined) ?? {};
    const tgType = tgProps['TargetType'];
    if (tgType === 'lambda') {
      // #123 Lambda-target slice: resolve the TG -> backing Lambda function.
      const lambdaTarget = resolveLambdaForwardTarget(
        tgProps,
        tgRef,
        resources,
        stackName,
        label,
        warnings
      );
      if (lambdaTarget) targets.push({ ...lambdaTarget, weight });
      continue;
    }
    const backing = tgToService.get(tgRef);
    if (!backing) {
      warnings.push(
        `${label} forwards to target group '${tgRef}', which is not referenced by any ` +
          `${SERVICE_TYPE}.LoadBalancers[] in ${stackName}; cdk-local has no ECS service to front ` +
          'behind it. Skipping that target group.'
      );
      continue;
    }
    targets.push({
      kind: 'ecs',
      serviceLogicalId: backing.serviceLogicalId,
      targetContainerName: backing.containerName,
      targetContainerPort: backing.containerPort,
      targetGroupLogicalId: tgRef,
      weight,
    });
  }

  if (targets.length === 0) return undefined; // every target group was skipped (already warned)
  return { kind: 'forward', targets };
}

/**
 * Resolve a `TargetType: lambda` target group into its `FrontDoorLambdaTarget`
 * (weight applied by the caller), or `undefined` (with a warning) when the
 * backing function is not an in-stack `AWS::Lambda::Function` reference.
 */
function resolveLambdaForwardTarget(
  tgProps: Record<string, unknown>,
  tgRef: string,
  resources: Record<string, TemplateResource>,
  stackName: string,
  label: string,
  warnings: string[]
): Omit<FrontDoorLambdaTarget, 'weight'> | undefined {
  const lambdaLogicalId = resolveLambdaTargetLogicalId(tgProps['Targets']);
  if (!lambdaLogicalId) {
    warnings.push(
      `${label} forwards to a Lambda target group '${tgRef}', but its Targets[].Id is not an ` +
        'in-stack { "Fn::GetAtt": [<FnLogicalId>, "Arn"] } reference; the local ALB front-door ' +
        'supports an in-stack Lambda target only (literal / imported ARNs deferred). Skipping that target group.'
    );
    return undefined;
  }
  const lambda = resources[lambdaLogicalId];
  if (!lambda || lambda.Type !== LAMBDA_FUNCTION_TYPE) {
    warnings.push(
      `${label} forwards to Lambda target group '${tgRef}', whose target resolves to ` +
        `'${lambdaLogicalId}', but no ${LAMBDA_FUNCTION_TYPE} with that logical id exists in ` +
        `${stackName}. Skipping that target group.`
    );
    return undefined;
  }
  return {
    kind: 'lambda',
    lambdaLogicalId,
    targetGroupLogicalId: tgRef,
    multiValueHeaders: readMultiValueHeadersAttribute(tgProps['TargetGroupAttributes']),
  };
}

/** Resolve a `redirect` action into its `Location`-template fields + status code. */
function resolveRedirectAction(
  action: Record<string, unknown>,
  label: string,
  warnings: string[]
): FrontDoorRedirectAction | undefined {
  const cfg = action['RedirectConfig'];
  if (!cfg || typeof cfg !== 'object') {
    warnings.push(`${label} is a redirect with no RedirectConfig; skipping it.`);
    return undefined;
  }
  const c = cfg as Record<string, unknown>;
  const statusCode = parseRedirectStatusCode(c['StatusCode']);
  const out: FrontDoorRedirectAction = { kind: 'redirect', statusCode };
  if (typeof c['Protocol'] === 'string') out.protocol = c['Protocol'];
  if (typeof c['Host'] === 'string') out.host = c['Host'];
  if (typeof c['Port'] === 'string') out.port = c['Port'];
  if (typeof c['Path'] === 'string') out.path = c['Path'];
  if (typeof c['Query'] === 'string') out.query = c['Query'];
  return out;
}

/** Resolve a `fixed-response` action into its status / content-type / body. */
function resolveFixedResponseAction(
  action: Record<string, unknown>
): FrontDoorFixedResponseAction | undefined {
  const cfg = action['FixedResponseConfig'];
  const c = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
  const statusCode = parseFixedResponseStatusCode(c['StatusCode']);
  const out: FrontDoorFixedResponseAction = { kind: 'fixed-response', statusCode };
  if (typeof c['ContentType'] === 'string') out.contentType = c['ContentType'];
  if (typeof c['MessageBody'] === 'string') out.messageBody = c['MessageBody'];
  return out;
}

/**
 * Resolve a `TargetType: lambda` target group's backing Lambda logical id from
 * its `Targets[].Id`. CDK synthesizes the registration as
 * `Targets: [{ Id: { "Fn::GetAtt": [<FnLogicalId>, "Arn"] } }]`; a `Ref` to the
 * function (its name) is also accepted. Returns the logical id, or `undefined`
 * when the target is a literal / imported ARN (not an in-stack reference).
 */
function resolveLambdaTargetLogicalId(targets: unknown): string | undefined {
  if (!Array.isArray(targets) || targets.length === 0) return undefined;
  const first = targets[0];
  if (!first || typeof first !== 'object') return undefined;
  const id = (first as Record<string, unknown>)['Id'];
  if (!id || typeof id !== 'object' || Array.isArray(id)) return undefined;
  const idObj = id as Record<string, unknown>;
  const getAtt = idObj['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string' && getAtt[0].length > 0) {
    return getAtt[0];
  }
  const ref = idObj['Ref'];
  if (typeof ref === 'string' && ref.length > 0) return ref;
  return undefined;
}

/**
 * Read the `lambda.multi_value_headers.enabled` target-group attribute (a
 * string `"true"` / `"false"` in CFn). Defaults to `false` when absent.
 */
function readMultiValueHeadersAttribute(attributes: unknown): boolean {
  if (!Array.isArray(attributes)) return false;
  for (const attr of attributes) {
    if (!attr || typeof attr !== 'object') continue;
    const a = attr as Record<string, unknown>;
    if (a['Key'] === 'lambda.multi_value_headers.enabled') {
      return String(a['Value']).toLowerCase() === 'true';
    }
  }
  return false;
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

interface ParsedRuleConditions {
  pathPatterns: string[];
  hostPatterns: string[];
  httpHeaderConditions: AlbHttpHeaderCondition[];
  httpRequestMethods: string[];
  queryStringConditions: AlbQueryStringCondition[];
  sourceIpCidrs: string[];
}

/**
 * Parse a ListenerRule's `Conditions` into the six supported fields. Returns
 * `undefined` when an unknown field is encountered or a known field is
 * malformed enough that honoring the rule would silently drop a constraint
 * — both surface a warning and skip the whole rule (ALB ANDs conditions of
 * different fields, so dropping any condition would route requests it should
 * not).
 *
 * Multiple `http-header` conditions on different names are kept (they AND).
 * Multiple `path-pattern` / `host-header` / `http-request-method` /
 * `query-string` / `source-ip` conditions on the same field merge their
 * values (each field OR-matches). A `source-ip` value that does not parse as
 * a CIDR makes the whole rule unsupported (the rule's authoring intent was
 * specific; dropping the invalid range would silently widen the allow list).
 */
function parseRuleConditions(
  conditions: unknown,
  ruleLabel: string,
  warnings: string[]
): ParsedRuleConditions | undefined {
  const out: ParsedRuleConditions = {
    pathPatterns: [],
    hostPatterns: [],
    httpHeaderConditions: [],
    httpRequestMethods: [],
    queryStringConditions: [],
    sourceIpCidrs: [],
  };
  if (!Array.isArray(conditions)) return out;
  for (const cond of conditions) {
    if (!cond || typeof cond !== 'object') continue;
    const c = cond as Record<string, unknown>;
    const field = typeof c['Field'] === 'string' ? c['Field'] : '(unknown)';
    if (field === 'path-pattern') {
      out.pathPatterns.push(...conditionValues(c, 'PathPatternConfig'));
    } else if (field === 'host-header') {
      out.hostPatterns.push(...conditionValues(c, 'HostHeaderConfig'));
    } else if (field === 'http-header') {
      const parsed = parseHttpHeaderCondition(c);
      if (!parsed) {
        warnings.push(
          `${ruleLabel} has an http-header condition with no HttpHeaderName / Values; skipping ` +
            'the rule.'
        );
        return undefined;
      }
      out.httpHeaderConditions.push(parsed);
    } else if (field === 'http-request-method') {
      out.httpRequestMethods.push(...conditionValues(c, 'HttpRequestMethodConfig'));
    } else if (field === 'query-string') {
      const { parsed, hadEntries } = parseQueryStringConditionValues(c);
      if (hadEntries && parsed.length === 0) {
        warnings.push(
          `${ruleLabel} query-string condition has no parseable { Key?, Value } entries; skipping ` +
            'the rule.'
        );
        return undefined;
      }
      out.queryStringConditions.push(...parsed);
    } else if (field === 'source-ip') {
      const values = conditionValues(c, 'SourceIpConfig');
      const invalid = values.filter((v) => !isValidCidr(v));
      if (invalid.length > 0) {
        warnings.push(
          `${ruleLabel} source-ip condition has unparseable CIDR(s): ${invalid.join(', ')}. ` +
            'The local ALB front-door requires valid IPv4 / IPv6 CIDRs; skipping the rule.'
        );
        return undefined;
      }
      out.sourceIpCidrs.push(...values);
    } else {
      warnings.push(`${ruleLabel} uses unsupported condition field '${field}'. Skipping the rule.`);
      return undefined;
    }
  }
  return out;
}

/**
 * Parse an `http-header` condition into its `{ name, values }` form. Returns
 * `undefined` when `HttpHeaderName` is missing / non-string or `Values` is
 * empty (either makes the rule's authoring intent unrecoverable).
 */
function parseHttpHeaderCondition(
  cond: Record<string, unknown>
): AlbHttpHeaderCondition | undefined {
  const cfg = cond['HttpHeaderConfig'];
  if (!cfg || typeof cfg !== 'object') return undefined;
  const c = cfg as Record<string, unknown>;
  const name = c['HttpHeaderName'];
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const rawValues = Array.isArray(c['Values']) ? (c['Values'] as unknown[]) : [];
  const values = rawValues.filter((v): v is string => typeof v === 'string');
  if (values.length === 0) return undefined;
  return { name, values };
}

/**
 * Parse a `query-string` condition's `Values` into `{ key?, value }` pairs.
 * ALB accepts either object entries (`{ Key?, Value }`) or bare strings
 * (legacy v1 shape: a string is treated as `{ value }`). Non-string `Key` /
 * `Value` fields are dropped; an entry with no `Value` is dropped. Returns
 * `hadEntries` so the caller can distinguish an absent / empty `Values` array
 * (drop the field silently) from one whose entries were all unparseable
 * (warn + skip the whole rule — silently dropping would widen routing).
 */
function parseQueryStringConditionValues(cond: Record<string, unknown>): {
  parsed: AlbQueryStringCondition[];
  hadEntries: boolean;
} {
  const cfg = cond['QueryStringConfig'];
  const rawValues =
    cfg && typeof cfg === 'object' && Array.isArray((cfg as Record<string, unknown>)['Values'])
      ? ((cfg as Record<string, unknown>)['Values'] as unknown[])
      : Array.isArray(cond['Values'])
        ? (cond['Values'] as unknown[])
        : [];
  const parsed: AlbQueryStringCondition[] = [];
  for (const v of rawValues) {
    if (typeof v === 'string') {
      parsed.push({ value: v });
    } else if (v && typeof v === 'object') {
      const e = v as Record<string, unknown>;
      const value = e['Value'];
      if (typeof value !== 'string') continue;
      const key = e['Key'];
      parsed.push(typeof key === 'string' ? { key, value } : { value });
    }
  }
  return { parsed, hadEntries: rawValues.length > 0 };
}

/**
 * Cheap CIDR validity check used at parse time. Mirrors the more permissive
 * matcher (`albCidrMatches`) but only confirms shape; we do not need to
 * remember the parsed bytes here.
 */
function isValidCidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const addr = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const prefixLen = parseInt(prefix, 10);
  if (addr.includes('.') && !addr.includes(':')) {
    const parts = addr.split('.');
    if (parts.length !== 4) return false;
    if (!parts.every((p) => /^\d+$/.test(p) && parseInt(p, 10) <= 255)) return false;
    return prefixLen >= 0 && prefixLen <= 32;
  }
  if (addr.includes(':')) {
    return prefixLen >= 0 && prefixLen <= 128;
  }
  return false;
}

/**
 * Extract a condition's string values from either the typed `<Field>Config`
 * sub-object's `Values` or the legacy top-level `Values` array.
 */
function conditionValues(cond: Record<string, unknown>, configKey: string): string[] {
  const cfg = cond[configKey];
  const raw =
    cfg && typeof cfg === 'object' && Array.isArray((cfg as Record<string, unknown>)['Values'])
      ? ((cfg as Record<string, unknown>)['Values'] as unknown[])
      : Array.isArray(cond['Values'])
        ? (cond['Values'] as unknown[])
        : [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/** Collect a forward action's `(targetGroupRef, weight)` pairs (single + ForwardConfig forms). */
function collectForwardTargetGroupRefs(
  action: Record<string, unknown>
): Array<{ tgRef: string; weight: number }> {
  const out: Array<{ tgRef: string; weight: number }> = [];
  const direct = refOf(action['TargetGroupArn']);
  if (direct) out.push({ tgRef: direct, weight: 1 });
  const forwardConfig = action['ForwardConfig'];
  if (forwardConfig && typeof forwardConfig === 'object') {
    const groups = (forwardConfig as Record<string, unknown>)['TargetGroups'];
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        const gObj = g as Record<string, unknown>;
        const ref = refOf(gObj['TargetGroupArn']);
        if (ref) out.push({ tgRef: ref, weight: parseWeight(gObj['Weight']) });
      }
    }
  }
  return out;
}

/**
 * True when `action` is a `forward` that references a target group via a
 * NON-`Ref` arn (literal / `Fn::GetAtt` / cross-stack) — i.e. a forward we
 * could not resolve to an in-stack target group. Used to warn rather than
 * silently skip.
 */
function hasUnresolvableForward(action: Record<string, unknown>): boolean {
  if (action['TargetGroupArn'] !== undefined && refOf(action['TargetGroupArn']) === undefined) {
    return true;
  }
  const forwardConfig = action['ForwardConfig'];
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
 * Parse a `ForwardConfig.TargetGroups[].Weight`. ALB weights are 0-999; a
 * missing weight defaults to 1 (CDK's `weightedForward` always emits one, but
 * a hand-rolled template may omit it). Negative / non-numeric clamps to 0.
 */
function parseWeight(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 0 ? 0 : raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return 1;
}

/** ALB emits redirect status as `HTTP_301` / `HTTP_302`; default to 302 when absent / unknown. */
function parseRedirectStatusCode(raw: unknown): 301 | 302 {
  if (raw === 'HTTP_301' || raw === '301' || raw === 301) return 301;
  return 302;
}

/** Parse a `FixedResponseConfig.StatusCode` (a numeric string); default 200 when absent. */
function parseFixedResponseStatusCode(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return 200;
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

/** ALB's default session cookie name prefix (suffixed `-0` / `-1` / ... by ALB). */
const DEFAULT_ALB_SESSION_COOKIE = 'AWSELBAuthSessionCookie';

/**
 * Cognito User Pool ARN shape:
 *   `arn:aws:cognito-idp:<region>:<account>:userpool/<pool-id>`
 * The pool id itself contains a `_`, but never a `/`, so anchoring on the
 * `userpool/` segment is robust.
 */
const COGNITO_USERPOOL_ARN = /^arn:[^:]+:cognito-idp:([^:]+):[^:]+:userpool\/([^/]+)$/;

/**
 * Parse an `authenticate-cognito` / `authenticate-oidc` ALB action into a
 * resolvable {@link FrontDoorAuthGuard}, or `undefined` when the config is
 * unresolvable (a Ref / intrinsic in a required field, a malformed
 * UserPoolArn, etc.) — a warning is emitted in that case so the user knows
 * the guard was dropped (the terminal action will still serve unguarded).
 */
function parseAuthenticateAction(
  action: Record<string, unknown>,
  type: 'authenticate-cognito' | 'authenticate-oidc',
  label: string,
  warnings: string[]
): FrontDoorAuthGuard | undefined {
  if (type === 'authenticate-cognito') {
    const cfg = action['AuthenticateCognitoConfig'];
    if (!cfg || typeof cfg !== 'object') {
      warnings.push(
        `${label}: authenticate-cognito missing AuthenticateCognitoConfig; skipping guard.`
      );
      return undefined;
    }
    const c = cfg as Record<string, unknown>;
    const userPoolArn = c['UserPoolArn'];
    const userPoolClientId = c['UserPoolClientId'];
    if (typeof userPoolArn !== 'string' || typeof userPoolClientId !== 'string') {
      warnings.push(
        `${label}: authenticate-cognito UserPoolArn / UserPoolClientId must be literal strings ` +
          '(Ref / intrinsics cannot be resolved by the local front-door); skipping guard.'
      );
      return undefined;
    }
    const match = COGNITO_USERPOOL_ARN.exec(userPoolArn);
    if (!match) {
      warnings.push(
        `${label}: authenticate-cognito UserPoolArn '${userPoolArn}' is not in the expected ` +
          'arn:...:cognito-idp:<region>:<account>:userpool/<pool-id> shape; skipping guard.'
      );
      return undefined;
    }
    const region = match[1]!;
    const userPoolId = match[2]!;
    const sessionCookieName =
      typeof c['SessionCookieName'] === 'string' && c['SessionCookieName'] !== ''
        ? c['SessionCookieName']
        : DEFAULT_ALB_SESSION_COOKIE;
    return {
      kind: 'authenticate-cognito',
      issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      audience: userPoolClientId,
      region,
      userPoolId,
      sessionCookieName,
      label: `authenticate-cognito (UserPool=${userPoolId})`,
    };
  }

  // authenticate-oidc
  const cfg = action['AuthenticateOidcConfig'];
  if (!cfg || typeof cfg !== 'object') {
    warnings.push(`${label}: authenticate-oidc missing AuthenticateOidcConfig; skipping guard.`);
    return undefined;
  }
  const c = cfg as Record<string, unknown>;
  const issuer = c['Issuer'];
  const clientId = c['ClientId'];
  if (typeof issuer !== 'string' || typeof clientId !== 'string') {
    warnings.push(
      `${label}: authenticate-oidc Issuer / ClientId must be literal strings ` +
        '(Ref / intrinsics cannot be resolved by the local front-door); skipping guard.'
    );
    return undefined;
  }
  const sessionCookieName =
    typeof c['SessionCookieName'] === 'string' && c['SessionCookieName'] !== ''
      ? c['SessionCookieName']
      : DEFAULT_ALB_SESSION_COOKIE;
  return {
    kind: 'authenticate-oidc',
    issuer: issuer.replace(/\/+$/, ''),
    audience: clientId,
    sessionCookieName,
    label: `authenticate-oidc (Issuer=${issuer})`,
  };
}
