import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import type { AlbHttpHeaderCondition, AlbQueryStringCondition } from './alb-path-matcher.js';
import { displayIdent, displayStackName } from '../utils/ident-display.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from './embed-config.js';
import { jwtPlaceholderIssuer } from './authorizer-resolver.js';
import { substituteAgainstState, type SubstitutionContext } from './state-resolver.js';

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
 * A declared guard is never dropped (#1004): an intrinsic `UserPoolArn` /
 * `UserPoolClientId` / `Issuer` / `ClientId` is recorded as `pending` and
 * resolved from the state source at boot
 * ({@link resolveFrontDoorAuthGuardIntrinsics}); a config that cannot be
 * resolved keeps a placeholder guard that still refuses a request without a
 * Bearer token (any Bearer token is admitted, warned).
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
  /**
   * Allowed JWT `aud` value (Cognito `UserPoolClientId` or OIDC `ClientId`).
   * Absent when that field could not be resolved (#1004): signature, `iss`
   * and `exp` are still verified, the audience is not.
   */
  audience?: string;
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
  /**
   * Set while a required config field is an intrinsic (#1004). The guard
   * meanwhile carries the unresolved placeholder (a token is required, and
   * not verified); {@link resolveFrontDoorAuthGuardIntrinsics} replaces it
   * once the state source has loaded.
   */
  pending?: FrontDoorAuthGuardPending;
}

/** The raw template values of an authenticate-* guard awaiting state (#1004). */
export interface FrontDoorAuthGuardPending {
  /** Stack whose state the intrinsics resolve against. */
  stackName: string;
  /** Logical id of the listener / rule declaring the action (warn-once key). */
  siteLogicalId: string;
  /** Diagnostic location, e.g. `Listener X (port 80) default action`. */
  location: string;
  /** Raw `UserPoolArn` (cognito) or `Issuer` (oidc). */
  primary: unknown;
  /** Raw `UserPoolClientId` (cognito) or `ClientId` (oidc). */
  audience: unknown;
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
   * forward / redirect / fixed-response. Absent when the default action was a
   * bare authenticate-* with no terminal action, or has an action whose Type
   * is not a literal string (fail closed) — unmatched requests then get a 404
   * from the front-door.
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
 *
 * An authenticate-* guard whose config is an intrinsic comes back as the
 * placeholder guard carrying `pending` (#1004). A host that SERVES the result
 * must pass the listeners through {@link resolveFrontDoorAuthGuardIntrinsics}
 * (with the stack's state, or `undefined` for none) before building the
 * front-door; otherwise every such route stays on the placeholder (a Bearer
 * token is required but never verified). A host that only inspects routes
 * (targets, paths) can ignore `pending`.
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
        `Listener ${displayIdent(listenerLogicalId)} on port ${port} uses protocol ${displayIdent(protocol)}; the local ` +
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
        `Listener ${displayIdent(listenerLogicalId)} on port ${port} declares ACM Certificates which are not ` +
          'retrievable locally. The front-door terminates TLS with --tls-cert/--tls-key or an ' +
          'auto-generated self-signed cert.'
      );
    }

    const defaultLabel = `Listener ${displayIdent(listenerLogicalId)} (port ${port}) default action`;
    const defaultOutcome = resolveAction(
      props['DefaultActions'],
      resources,
      tgToService,
      stackName,
      listenerLogicalId,
      defaultLabel,
      warnings
    );
    let defaultResolved: ResolvedActionOutcome | undefined;
    if (defaultOutcome && 'deny' in defaultOutcome) {
      // No lower-priority fallback exists below the default: leaving it unset
      // already refuses unmatched requests (404, or no listener at all).
      warnings.push(
        `${defaultLabel} ${defaultOutcome.deny.warning}, so the default action is not served ` +
          'locally (fail closed): a request no rule matches is refused.'
      );
    } else {
      defaultResolved = defaultOutcome;
    }

    const rules: ResolvedListenerRule[] = [];
    for (const { ruleLogicalId, ruleProps } of rulesByListener.get(listenerLogicalId) ?? []) {
      const priority = parsePriority(ruleProps['Priority']);
      const ruleLabel = `Listener rule ${displayIdent(ruleLogicalId)} (priority ${priority})`;
      const guarded = actionsMayCarryGuard(ruleProps['Actions']);
      const parsed = parseRuleConditions(
        ruleProps['Conditions'],
        albLogicalId,
        ruleLabel,
        warnings,
        guarded
      );
      if (!parsed) {
        // parseRuleConditions warned about an unsupported / malformed condition
        // on a rule with no authenticate-* guard to lose.
        continue;
      }
      const {
        partial,
        pathPatterns,
        hostPatterns,
        httpHeaderConditions,
        httpRequestMethods,
        queryStringConditions,
        sourceIpCidrs,
      } = parsed;
      const conditions = {
        pathPatterns,
        hostPatterns,
        httpHeaderConditions,
        httpRequestMethods,
        queryStringConditions,
        sourceIpCidrs,
      };
      const hasAnyCondition =
        pathPatterns.length > 0 ||
        hostPatterns.length > 0 ||
        httpHeaderConditions.length > 0 ||
        httpRequestMethods.length > 0 ||
        queryStringConditions.length > 0 ||
        sourceIpCidrs.length > 0;
      if (partial) {
        // A guarded rule with a condition cdk-local cannot evaluate: skipping it
        // would let its requests fall through unguarded, so it stays at its
        // priority as a deny over its supported conditions (a superset).
        warnings.push(
          `${ruleLabel} carries an authenticate-* action (or an action whose Type may be one), so ` +
            'instead of being skipped it is kept at its priority as a local 503 deny (fail closed) ' +
            (hasAnyCondition
              ? 'over its remaining supported conditions'
              : 'over every request that reaches its priority (no supported condition is left)') +
            '. Dropping the unsupported condition only widens what it denies, and its requests ' +
            'cannot fall through to a lower-priority rule or the listener default.'
        );
        rules.push({
          priority,
          ...conditions,
          action: denyAction(
            'the rule has an authenticate-* guard on a condition cdk-local cannot evaluate'
          ),
        });
        continue;
      }
      if (!hasAnyCondition) {
        // No supported condition to route on (an empty / catch-all rule).
        continue;
      }
      const ruleLabelAction = `${ruleLabel} action`;
      const ruleResolved = resolveAction(
        ruleProps['Actions'],
        resources,
        tgToService,
        stackName,
        ruleLogicalId,
        ruleLabelAction,
        warnings
      );
      if (!ruleResolved) continue; // resolveAction already warned (no guard to lose)
      if ('deny' in ruleResolved) {
        // Dropping the rule would let its requests fall through to a
        // lower-priority rule or the listener default without the guard.
        warnings.push(
          `${ruleLabelAction} ${ruleResolved.deny.warning}, so the rule is kept at its priority as ` +
            'a local 503 deny (fail closed): its requests are refused rather than falling through ' +
            'to a lower-priority rule or the listener default.'
        );
        rules.push({ priority, ...conditions, action: denyAction(ruleResolved.deny.body) });
        continue;
      }
      rules.push({
        priority,
        ...conditions,
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
 * The authenticate-* entry (the last one if multiple) becomes the
 * returned `authGuard`; the terminal action becomes `action`. Returns
 * `undefined` when no terminal action is resolvable and no guard is at stake,
 * and `{ deny }` when the actions carry (or may carry) an authenticate-* guard
 * that cannot be served: the caller must refuse the route, never drop it.
 */
function resolveAction(
  actions: unknown,
  resources: Record<string, TemplateResource>,
  tgToService: Map<string, BackingServiceRef>,
  stackName: string,
  siteLogicalId: string,
  label: string,
  warnings: string[]
): ResolvedActionOutcome | { deny: ActionDeny } | undefined {
  if (!Array.isArray(actions)) return undefined;

  // Fail closed on an action whose Type is not a literal string (an `Fn::If`
  // choosing between an authenticate-* and a forward, or a whole action entry
  // wrapped in an intrinsic): skipping just that entry could serve the
  // terminal action without the guard it may stand for.
  if (actions.some(hasNonLiteralType)) {
    return {
      deny: {
        warning:
          'has an action whose Type is not a literal string (for example an Fn::If, or a whole ' +
          'action wrapped in an intrinsic). It may be an authenticate-* guard',
        body: 'an action Type is not a literal string, so its authenticate-* guard cannot be determined',
      },
    };
  }

  let authGuard: FrontDoorAuthGuard | undefined;
  let sawAuthenticate = false;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const a = action as Record<string, unknown>;
    const type = a['Type'];

    if (type === 'authenticate-cognito' || type === 'authenticate-oidc') {
      sawAuthenticate = true;
      // A declared guard is never dropped (#1004): an unresolvable config
      // yields a guard that still requires a token.
      authGuard = parseAuthenticateAction(a, type, stackName, siteLogicalId, label, warnings);
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
        `${label} uses an unsupported action type ${displayIdent(type)}. The local ALB front-door supports ` +
          'forward / redirect / fixed-response actions only. Skipping it.'
      );
    }
    if (terminal) {
      return authGuard ? { action: terminal, authGuard } : { action: terminal };
    }
  }

  if (sawAuthenticate) {
    return {
      deny: {
        warning: 'is an authenticate-* action with no local-servable terminal action',
        body: 'its authenticate-* action has no locally servable terminal action',
      },
    };
  }
  return undefined;
}

/** A resolved action: the terminal action plus the guard in front of it, if any. */
type ResolvedActionOutcome = { action: ResolvedListenerAction; authGuard?: FrontDoorAuthGuard };

/** Why a guarded action cannot be served: warning text (after the label) + 503 body reason. */
interface ActionDeny {
  warning: string;
  body: string;
}

/** True for an action entry whose `Type` is not a literal string (it may be an authenticate-*). */
function hasNonLiteralType(action: unknown): boolean {
  return (
    action !== null &&
    typeof action === 'object' &&
    typeof (action as Record<string, unknown>)['Type'] !== 'string'
  );
}

/** True when an `Actions` array carries, or may carry, an authenticate-* guard. */
function actionsMayCarryGuard(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some((action) => {
    if (hasNonLiteralType(action)) return true;
    if (!action || typeof action !== 'object') return false;
    const type = (action as Record<string, unknown>)['Type'];
    return type === 'authenticate-cognito' || type === 'authenticate-oidc';
  });
}

/**
 * The terminal a guarded rule that cannot be served is replaced with: a 503
 * fixed-response with no guard, so the rule still claims its requests at its
 * priority instead of letting them reach a lower-priority rule unguarded.
 */
function denyAction(reason: string): FrontDoorFixedResponseAction {
  return {
    kind: 'fixed-response',
    statusCode: 503,
    contentType: 'text/plain',
    messageBody: `cdk-local: this ALB listener rule is denied locally because ${reason}.\n`,
  };
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
        `${label} forwards to target group ${displayIdent(tgRef)}, but no ${TARGET_GROUP_TYPE} with that ` +
          `logical id exists in ${displayStackName(stackName)}. Skipping that target group.`
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
        `${label} forwards to target group ${displayIdent(tgRef)}, which is not referenced by any ` +
          `${SERVICE_TYPE}.LoadBalancers[] in ${displayStackName(stackName)}; cdk-local has no ECS service to front ` +
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
      `${label} forwards to a Lambda target group ${displayIdent(tgRef)}, but its Targets[].Id is not an ` +
        'in-stack { "Fn::GetAtt": [<FnLogicalId>, "Arn"] } reference; the local ALB front-door ' +
        'supports an in-stack Lambda target only (literal / imported ARNs deferred). Skipping that target group.'
    );
    return undefined;
  }
  const lambda = resources[lambdaLogicalId];
  if (!lambda || lambda.Type !== LAMBDA_FUNCTION_TYPE) {
    warnings.push(
      `${label} forwards to Lambda target group ${displayIdent(tgRef)}, whose target resolves to ` +
        `${displayIdent(lambdaLogicalId)}, but no ${LAMBDA_FUNCTION_TYPE} with that logical id exists in ` +
        `${displayStackName(stackName)}. Skipping that target group.`
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
 * For a `guarded` rule (one whose actions carry, or may carry, an
 * authenticate-* guard) skipping is not safe: its requests would fall through
 * to a lower-priority rule or the listener default without the guard. Such a
 * rule instead returns its supported conditions with every unsupported field
 * dropped whole and `partial: true`; the caller turns it into a 503 deny.
 * Dropping a field (ANDed with the others) only widens the matched set, so the
 * deny over-denies locally but never under-guards.
 *
 * Multiple `http-header` conditions on different names are kept (they AND).
 * Multiple `path-pattern` / `host-header` / `http-request-method` /
 * `query-string` / `source-ip` conditions on the same field merge their
 * values (each field OR-matches). A `source-ip` value that does not parse as
 * a CIDR makes the whole rule unsupported (the rule's authoring intent was
 * specific; dropping the invalid range would silently widen the allow list).
 * Likewise a value that is not a literal string skips the rule, except a
 * `host-header` value naming this ALB's own `DNSName` (match-all locally).
 */
function parseRuleConditions(
  conditions: unknown,
  albLogicalId: string,
  ruleLabel: string,
  warnings: string[],
  guarded: boolean
): (ParsedRuleConditions & { partial?: true }) | undefined {
  const out: ParsedRuleConditions = {
    pathPatterns: [],
    hostPatterns: [],
    httpHeaderConditions: [],
    httpRequestMethods: [],
    queryStringConditions: [],
    sourceIpCidrs: [],
  };
  if (!Array.isArray(conditions)) return out;
  const tail = guarded ? 'the rule is kept as a local 503 deny instead' : 'skipping the rule';
  const failedFields = new Set<string>();
  // Record one unsupported condition. True = stop and skip the rule (unguarded).
  const fail = (field: string, message: string): boolean => {
    warnings.push(message);
    failedFields.add(field);
    return !guarded;
  };
  for (const cond of conditions) {
    if (!cond || typeof cond !== 'object') continue;
    const c = cond as Record<string, unknown>;
    const field = typeof c['Field'] === 'string' ? c['Field'] : '(unknown)';
    if (field === 'path-pattern') {
      const values = conditionValues(c, 'PathPatternConfig');
      if (!values) {
        if (fail(field, unresolvableConditionWarning(ruleLabel, field, tail))) return undefined;
        continue;
      }
      out.pathPatterns.push(...values);
    } else if (field === 'host-header') {
      const values = hostHeaderConditionValues(c, albLogicalId);
      if (!values) {
        if (fail(field, unresolvableConditionWarning(ruleLabel, field, tail))) return undefined;
        continue;
      }
      out.hostPatterns.push(...values);
    } else if (field === 'http-header') {
      const parsed = parseHttpHeaderCondition(c);
      if (!parsed) {
        const message =
          `${ruleLabel} has an http-header condition with no HttpHeaderName / Values, or a value ` +
          `that is not a literal string; ${tail}.`;
        if (fail(field, message)) return undefined;
        continue;
      }
      out.httpHeaderConditions.push(parsed);
    } else if (field === 'http-request-method') {
      const values = conditionValues(c, 'HttpRequestMethodConfig');
      if (!values) {
        if (fail(field, unresolvableConditionWarning(ruleLabel, field, tail))) return undefined;
        continue;
      }
      out.httpRequestMethods.push(...values);
    } else if (field === 'query-string') {
      const qs = parseQueryStringConditionValues(c);
      if (!qs) {
        if (fail(field, unresolvableConditionWarning(ruleLabel, field, tail))) return undefined;
        continue;
      }
      const { parsed, hadEntries } = qs;
      if (hadEntries && parsed.length === 0) {
        const message =
          `${ruleLabel} query-string condition has no parseable { Key?, Value } entries; ` +
          `${tail}.`;
        if (fail(field, message)) return undefined;
        continue;
      }
      out.queryStringConditions.push(...parsed);
    } else if (field === 'source-ip') {
      const values = conditionValues(c, 'SourceIpConfig');
      if (!values) {
        if (fail(field, unresolvableConditionWarning(ruleLabel, field, tail))) return undefined;
        continue;
      }
      const invalid = values.filter((v) => !isValidCidr(v));
      if (invalid.length > 0) {
        const message =
          `${ruleLabel} source-ip condition has unparseable CIDR(s): ${invalid.join(', ')}. ` +
          `The local ALB front-door requires valid IPv4 / IPv6 CIDRs; ${tail}.`;
        if (fail(field, message)) return undefined;
        continue;
      }
      out.sourceIpCidrs.push(...values);
    } else {
      const message =
        `${ruleLabel} uses unsupported condition field ${displayIdent(field)}. ` +
        `${tail.charAt(0).toUpperCase()}${tail.slice(1)}.`;
      if (fail(field, message)) return undefined;
    }
  }
  if (failedFields.size === 0) return out;
  // Guarded rule: drop every failed field whole (a partially kept field could
  // narrow its OR-set; a dropped field only widens the deny).
  if (failedFields.has('path-pattern')) out.pathPatterns = [];
  if (failedFields.has('host-header')) out.hostPatterns = [];
  if (failedFields.has('http-header')) out.httpHeaderConditions = [];
  if (failedFields.has('http-request-method')) out.httpRequestMethods = [];
  if (failedFields.has('query-string')) out.queryStringConditions = [];
  if (failedFields.has('source-ip')) out.sourceIpCidrs = [];
  return { ...out, partial: true };
}

/**
 * Parse an `http-header` condition into its `{ name, values }` form. Returns
 * `undefined` when `HttpHeaderName` is missing / non-string or `Values` is
 * empty or holds a non-literal value (each makes the rule's authoring intent
 * unrecoverable).
 */
function parseHttpHeaderCondition(
  cond: Record<string, unknown>
): AlbHttpHeaderCondition | undefined {
  const cfg = cond['HttpHeaderConfig'];
  if (!cfg || typeof cfg !== 'object') return undefined;
  const c = cfg as Record<string, unknown>;
  const name = c['HttpHeaderName'];
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const values = Array.isArray(c['Values']) ? (c['Values'] as unknown[]) : [];
  if (values.length === 0 || !values.every((v): v is string => typeof v === 'string')) {
    return undefined;
  }
  return { name, values };
}

/**
 * Parse a `query-string` condition's `Values` into `{ key?, value }` pairs.
 * ALB accepts either object entries (`{ Key?, Value }`) or bare strings
 * (legacy v1 shape: a string is treated as `{ value }`). An entry with no
 * string `Value` (or a non-string `Key`) is dropped. Returns `undefined` when
 * the list or any `Key` / `Value` is an intrinsic — the caller skips the rule.
 * Returns
 * `hadEntries` so the caller can distinguish an absent / empty `Values` array
 * (drop the field silently) from one whose entries were all unparseable
 * (warn + skip the whole rule — silently dropping would widen routing).
 */
function parseQueryStringConditionValues(cond: Record<string, unknown>):
  | {
      parsed: AlbQueryStringCondition[];
      hadEntries: boolean;
    }
  | undefined {
  const rawValues = rawConditionValues(cond, 'QueryStringConfig');
  if (!rawValues) return undefined;
  const parsed: AlbQueryStringCondition[] = [];
  for (const v of rawValues) {
    if (typeof v === 'string') {
      parsed.push({ value: v });
    } else if (v && typeof v === 'object') {
      const e = v as Record<string, unknown>;
      if (isIntrinsic(e)) return undefined;
      const value = e['Value'];
      const key = e['Key'];
      // An intrinsic Key / Value cannot be resolved locally; dropping the
      // Key would match the Value under ANY key (widening the rule).
      if ((value && typeof value === 'object') || (key && typeof key === 'object')) {
        return undefined;
      }
      // Any other malformed entry is dropped (all dropped -> the caller skips).
      if (typeof value !== 'string' || (key !== undefined && typeof key !== 'string')) continue;
      parsed.push(key !== undefined ? { key, value } : { value });
    }
  }
  return { parsed, hadEntries: rawValues.length > 0 };
}

function isIntrinsic(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => k === 'Ref' || k.startsWith('Fn::'));
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
 * Extract a condition's raw values from either the typed `<Field>Config`
 * sub-object's `Values` or the legacy top-level `Values` array. Returns
 * `undefined` when the list itself is not a literal array (`Values` is an
 * intrinsic such as `Fn::Split` over a CommaDelimitedList parameter, or the
 * whole config is an intrinsic): reading it as empty would drop the field.
 */
function rawConditionValues(
  cond: Record<string, unknown>,
  configKey: string
): unknown[] | undefined {
  const cfg = cond[configKey];
  if (cfg !== undefined) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined;
    const c = cfg as Record<string, unknown>;
    if (isIntrinsic(c)) return undefined;
    if (Array.isArray(c['Values'])) return c['Values'] as unknown[];
    if (c['Values'] !== undefined) return undefined;
  }
  if (Array.isArray(cond['Values'])) return cond['Values'] as unknown[];
  return cond['Values'] === undefined ? [] : undefined;
}

/**
 * Extract a condition's string values. Returns `undefined` when any value is
 * not a literal string (an intrinsic such as `Ref` / `Fn::GetAtt` /
 * `Fn::Join` / `Fn::ImportValue` that cannot be resolved locally): dropping
 * that value would leave the field emptier than authored — an empty field is
 * no constraint at all — so the caller must skip the rule instead.
 */
function conditionValues(cond: Record<string, unknown>, configKey: string): string[] | undefined {
  const raw = rawConditionValues(cond, configKey);
  return raw?.every((v): v is string => typeof v === 'string') ? raw : undefined;
}

/**
 * Extract a `host-header` condition's values. `Fn::GetAtt [<Alb>, DNSName]` of
 * the ALB the listener belongs to means "addressed to this load balancer";
 * every request that reaches the local front door is addressed to it, so the
 * value becomes the match-all `*`. Any other non-literal value makes the
 * result `undefined` (see {@link conditionValues}).
 */
function hostHeaderConditionValues(
  cond: Record<string, unknown>,
  albLogicalId: string
): string[] | undefined {
  const raw = rawConditionValues(cond, 'HostHeaderConfig');
  if (!raw) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string') out.push(v);
    else if (isOwnDnsNameGetAtt(v, albLogicalId)) out.push('*');
    else return undefined;
  }
  return out;
}

function isOwnDnsNameGetAtt(raw: unknown, albLogicalId: string): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const getAtt = (raw as Record<string, unknown>)['Fn::GetAtt'];
  const parts = typeof getAtt === 'string' ? getAtt.split('.') : getAtt;
  return (
    Array.isArray(parts) &&
    parts.length === 2 &&
    parts[0] === albLogicalId &&
    parts[1] === 'DNSName'
  );
}

function unresolvableConditionWarning(ruleLabel: string, field: string, tail: string): string {
  return (
    `${ruleLabel} has a ${field} condition value that is not a literal string (an intrinsic ` +
    'such as Ref / Fn::GetAtt / Fn::Join / Fn::ImportValue that cannot be resolved locally); ' +
    `${tail}.`
  );
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
 * `userpool/` segment is robust. The region is restricted to `[a-z0-9-]` because
 * it is spliced into the JWKS host (`cognito-idp.<region>.amazonaws.com`): a
 * value such as `evil.example/x` must not steer that fetch to another host.
 */
const COGNITO_USERPOOL_ARN = /^arn:[^:]+:cognito-idp:([a-z0-9-]+):[^:]+:userpool\/([^/]+)$/;

/** A Cognito user pool id (`<region>_<suffix>`), which is the pool's physical id. */
const COGNITO_USERPOOL_ID = /^([a-z]{2}(?:-[a-z]+)+-\d+)_[0-9A-Za-z]+$/;

const COGNITO_USERPOOL_TYPE = 'AWS::Cognito::UserPool';

type GuardKind = FrontDoorAuthGuard['kind'];

/**
 * One config field's value, or why it has none. `stateSourceActive` marks an
 * intrinsic that a state source was asked to resolve (loaded or failed), so
 * the warning does not tell the user to pass one.
 */
type FieldResult =
  | { value: string }
  | { reason: string; intrinsic: boolean; stateSourceActive?: boolean };

/**
 * A stack's substitution context for {@link resolveFrontDoorAuthGuardIntrinsics}:
 * the loaded state, `{ loadError }` when a state source was active but the
 * stack's state did not load, or `undefined` when no state source is active.
 */
export type AuthGuardStateContext = SubstitutionContext | { loadError: string } | undefined;

/** The two required config fields of each authenticate-* kind. */
function fieldNames(kind: GuardKind): { primary: string; audience: string; config: string } {
  return kind === 'authenticate-cognito'
    ? { primary: 'UserPoolArn', audience: 'UserPoolClientId', config: 'AuthenticateCognitoConfig' }
    : { primary: 'Issuer', audience: 'ClientId', config: 'AuthenticateOidcConfig' };
}

function isIntrinsicValue(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A literal field value: a non-empty string, or why it is not one. */
function literalField(raw: unknown): FieldResult {
  if (typeof raw === 'string') {
    return raw === '' ? { reason: 'it is an empty string', intrinsic: false } : { value: raw };
  }
  return { reason: 'it is missing or not a string', intrinsic: false };
}

/**
 * The placeholder guard an unresolvable authenticate-* config is served with
 * (#1004): a Cognito-shaped issuer naming a pool that does not exist, so the
 * JWKS fetch fails into the documented pass-through mode. A request without a
 * Bearer token is refused (401); any Bearer token is admitted, warned.
 */
function placeholderGuard(
  kind: GuardKind,
  siteLogicalId: string,
  sessionCookieName: string,
  pending?: FrontDoorAuthGuardPending
): FrontDoorAuthGuard {
  // The id lands in the JWKS URL path; keep it to URL-safe characters.
  const issuer = jwtPlaceholderIssuer(siteLogicalId.replace(/[^A-Za-z0-9]/g, ''));
  return {
    kind,
    issuer,
    region: 'us-east-1',
    userPoolId: issuer.slice(issuer.lastIndexOf('/') + 1),
    sessionCookieName,
    label: `${kind} (unresolved)`,
    ...(pending && { pending }),
  };
}

/**
 * An OIDC `Issuer` the guard verifies against: any `http://` or `https://`
 * URL. ALB itself requires `https://` and rejects a plain-`http://` issuer at
 * deploy time, so an `http://` value is only ever a local test IdP; it is
 * still verified, as it was before #1004. A non-http(s), unparseable or empty
 * value is unresolved.
 */
function isUsableOidcIssuer(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
}

/**
 * The one builder every guard goes through — literal template values and
 * values resolved from state alike (#1004). The primary field (Cognito
 * `UserPoolArn` / OIDC `Issuer`) must be a Cognito user pool ARN / an
 * `http(s)://` URL; otherwise the placeholder guard is returned. An audience
 * that has no value leaves the audience unchecked. Every shortfall is
 * reported through `warn`, keyed by the field it concerns.
 */
function materializeGuard(
  kind: GuardKind,
  primary: FieldResult,
  audience: FieldResult,
  sessionCookieName: string,
  siteLogicalId: string,
  location: string,
  warn: (field: string, message: string) => void
): FrontDoorAuthGuard {
  const names = fieldNames(kind);
  const cli = `${getEmbedConfig().cliName} start-alb`;
  const unguardedTail =
    'The route still requires a Bearer token, but does not verify it (JWKS pass-through admits any token).';
  const restartTail = `Restart ${cli} after deploying: --watch does not rebuild the front-door.`;
  const intrinsicHint =
    'Deploy the stack and pass --from-cfn-stack (or another state source) for real verification, ' +
    `or --no-verify-auth to disable the guard. ${restartTail}`;
  const activeSourceHint =
    'Check that the stack is deployed and its state source can read it, ' +
    `or pass --no-verify-auth to disable the guard. ${restartTail}`;
  const literalHint = 'Fix the template value, or pass --no-verify-auth to disable the guard.';

  const unresolved = (
    reason: string,
    intrinsic: boolean,
    stateSourceActive = false
  ): FrontDoorAuthGuard => {
    const hint = !intrinsic ? literalHint : stateSourceActive ? activeSourceHint : intrinsicHint;
    warn(
      names.primary,
      `${location}: ${kind} ${names.primary} ${intrinsic ? `is an intrinsic ${cli} could not resolve` : 'is unusable'} ` +
        `(${reason}). ${unguardedTail} ${hint}`
    );
    return placeholderGuard(kind, siteLogicalId, sessionCookieName);
  };

  if (!('value' in primary)) {
    return unresolved(primary.reason, primary.intrinsic, primary.stateSourceActive);
  }

  let base: Pick<FrontDoorAuthGuard, 'issuer' | 'region' | 'userPoolId' | 'label'>;
  if (kind === 'authenticate-cognito') {
    const match = COGNITO_USERPOOL_ARN.exec(primary.value);
    if (!match) {
      return unresolved(
        `${displayUntrustedValue(primary.value)} is not in the expected ` +
          'arn:...:cognito-idp:<region>:<account>:userpool/<pool-id> shape',
        false
      );
    }
    const region = match[1]!;
    const userPoolId = match[2]!;
    base = {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      region,
      userPoolId,
      label: `authenticate-cognito (UserPool=${userPoolId})`,
    };
  } else {
    if (!isUsableOidcIssuer(primary.value)) {
      return unresolved(
        `${displayUntrustedValue(primary.value)} is not an http:// or https:// URL`,
        false
      );
    }
    base = {
      issuer: primary.value.replace(/\/+$/, ''),
      label: `authenticate-oidc (Issuer=${primary.value})`,
    };
  }

  if (!('value' in audience)) {
    warn(
      names.audience,
      `${location}: ${kind} ${names.audience} could not be resolved (${audience.reason}), so the token ` +
        'audience is not checked (signature, issuer and expiry still are).' +
        (audience.intrinsic && !audience.stateSourceActive
          ? ' Pass --from-cfn-stack (or another state source) to check it.'
          : '')
    );
  }
  return {
    kind,
    issuer: base.issuer,
    ...('value' in audience && { audience: audience.value }),
    ...(base.region !== undefined && { region: base.region }),
    ...(base.userPoolId !== undefined && { userPoolId: base.userPoolId }),
    sessionCookieName,
    label: base.label,
  };
}

/**
 * Parse an `authenticate-cognito` / `authenticate-oidc` ALB action into a
 * {@link FrontDoorAuthGuard}. A declared guard is never dropped (#1004):
 *
 * - every required field is a usable literal: the real guard;
 * - a required field is an intrinsic: the placeholder guard carrying
 *   `pending`, resolved by {@link resolveFrontDoorAuthGuardIntrinsics} once
 *   the state source has loaded;
 * - the config block is missing, or a literal is unusable (a malformed
 *   UserPoolArn, a non-https Issuer, an empty string): the placeholder guard,
 *   warned — a request without a Bearer token is refused.
 */
function parseAuthenticateAction(
  action: Record<string, unknown>,
  type: GuardKind,
  stackName: string,
  siteLogicalId: string,
  label: string,
  warnings: string[]
): FrontDoorAuthGuard {
  const names = fieldNames(type);
  const cfg = action[names.config];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    warnings.push(
      `${label}: ${type} is missing ${names.config}. The route still requires a Bearer token, but does not ` +
        'verify it (JWKS pass-through admits any token). Fix the template, or pass --no-verify-auth to disable the guard.'
    );
    return placeholderGuard(type, siteLogicalId, DEFAULT_ALB_SESSION_COOKIE);
  }
  const c = cfg as Record<string, unknown>;
  const sessionCookieName =
    typeof c['SessionCookieName'] === 'string' && c['SessionCookieName'] !== ''
      ? c['SessionCookieName']
      : DEFAULT_ALB_SESSION_COOKIE;
  const rawPrimary = c[names.primary];
  const rawAudience = c[names.audience];
  if (isIntrinsicValue(rawPrimary) || isIntrinsicValue(rawAudience)) {
    return placeholderGuard(type, siteLogicalId, sessionCookieName, {
      stackName,
      siteLogicalId,
      location: label,
      primary: rawPrimary,
      audience: rawAudience,
    });
  }
  return materializeGuard(
    type,
    literalField(rawPrimary),
    literalField(rawAudience),
    sessionCookieName,
    siteLogicalId,
    label,
    (_field, message) => warnings.push(message)
  );
}

/**
 * The deployed ARN behind `Fn::GetAtt: [<UserPool>, 'Arn']` when the state
 * record carries no `Arn` attribute (the `--from-cfn-stack` provider records
 * physical ids only): a Cognito user pool's physical id is its pool id, whose
 * `<region>_` prefix names the region. Only the region and the pool id are
 * read back out of the ARN, so the account falls back to a filler.
 */
function userPoolArnFromState(raw: unknown, context: SubstitutionContext): string | undefined {
  if (!isIntrinsicValue(raw)) return undefined;
  const getAtt = (raw as Record<string, unknown>)['Fn::GetAtt'];
  let logicalId: string | undefined;
  if (Array.isArray(getAtt) && getAtt.length === 2 && getAtt[1] === 'Arn') {
    logicalId = typeof getAtt[0] === 'string' ? getAtt[0] : undefined;
  } else if (typeof getAtt === 'string' && getAtt.endsWith('.Arn')) {
    logicalId = getAtt.slice(0, -'.Arn'.length);
  }
  if (logicalId === undefined) return undefined;
  const record = context.resources[logicalId];
  if (!record || record.resourceType !== COGNITO_USERPOOL_TYPE) return undefined;
  if (record.attributes?.['Arn'] !== undefined) return undefined; // the substituter reads it
  const match = COGNITO_USERPOOL_ID.exec(record.physicalId);
  if (!match) return undefined;
  const partition = context.pseudoParameters?.partition ?? 'aws';
  const account = context.pseudoParameters?.accountId ?? '000000000000';
  return `arn:${partition}:cognito-idp:${match[1]}:${account}:userpool/${record.physicalId}`;
}

/** Resolve one raw config field against a stack's state. */
function resolveField(
  raw: unknown,
  context: AuthGuardStateContext,
  isUserPoolArn: boolean
): FieldResult {
  if (!isIntrinsicValue(raw)) return literalField(raw);
  if (!context) return { reason: 'no state source is active', intrinsic: true };
  if ('loadError' in context) {
    return {
      reason: `the stack's deployed state did not load: ${context.loadError}`,
      intrinsic: true,
      stateSourceActive: true,
    };
  }
  if (isUserPoolArn) {
    const derived = userPoolArnFromState(raw, context);
    if (derived !== undefined) return { value: derived };
  }
  const result = substituteAgainstState(raw, context);
  if (result.kind === 'literal' && typeof result.value === 'string' && result.value !== '') {
    return { value: result.value };
  }
  return {
    reason: result.kind === 'unresolved' ? result.reason : 'it resolved to a non-string',
    intrinsic: true,
    stateSourceActive: true,
  };
}

/**
 * Resolve one guard's pending intrinsics; a guard without `pending` is
 * returned as-is. See {@link resolveFrontDoorAuthGuardIntrinsics}.
 */
function resolvePendingGuard(
  guard: FrontDoorAuthGuard,
  contextFor: (stackName: string) => AuthGuardStateContext,
  warnOnce: (key: string, message: string) => void
): FrontDoorAuthGuard {
  const pending = guard.pending;
  if (!pending) return guard;
  const context = contextFor(pending.stackName);
  return materializeGuard(
    guard.kind,
    resolveField(pending.primary, context, guard.kind === 'authenticate-cognito'),
    resolveField(pending.audience, context, false),
    guard.sessionCookieName,
    pending.siteLogicalId,
    `${displayStackName(pending.stackName)}: ${pending.location}`,
    (field, message) =>
      warnOnce(`${pending.stackName}\0${pending.siteLogicalId}\0${guard.kind}\0${field}`, message)
  );
}

/**
 * Resolve every `start-alb` authenticate-* guard whose template config is an
 * intrinsic (#1004) — the listener default guard and every rule guard —
 * against its stack's state, once a state source has loaded. `contextFor`
 * returns the stack's substitution context, `{ loadError }` when a state
 * source was active but the stack's state did not load (the cause lands in
 * the warning), or `undefined` when no state source is active. Pure: returns new listeners, leaving the input untouched.
 *
 * - Every field resolves to a usable value: the real guard, exactly as with
 *   literal values.
 * - The primary field (`UserPoolArn` / `Issuer`) does not resolve, or
 *   resolves to an unusable value: the placeholder guard stays — a request
 *   without a Bearer token gets 401, any Bearer token is admitted (warned).
 * - Only the audience does not resolve: signature, issuer and expiry are
 *   verified, the audience is not (warned).
 *
 * `warned` dedups the warnings by stack + logical id + field.
 */
export function resolveFrontDoorAuthGuardIntrinsics<
  L extends {
    defaultAuthGuard?: FrontDoorAuthGuard;
    rules: ReadonlyArray<{ authGuard?: FrontDoorAuthGuard }>;
  },
>(
  listeners: readonly L[],
  contextFor: (stackName: string) => AuthGuardStateContext,
  warned: Set<string> = new Set<string>()
): L[] {
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    getLogger().warn(message);
  };
  return listeners.map((listener) => ({
    ...listener,
    ...(listener.defaultAuthGuard && {
      defaultAuthGuard: resolvePendingGuard(listener.defaultAuthGuard, contextFor, warnOnce),
    }),
    rules: listener.rules.map((rule) =>
      rule.authGuard
        ? { ...rule, authGuard: resolvePendingGuard(rule.authGuard, contextFor, warnOnce) }
        : rule
    ),
  }));
}

/** The stacks owning a guard that awaits state (#1004), deduplicated. */
export function pendingAuthGuardStackNames(
  listeners: ReadonlyArray<{
    defaultAuthGuard?: FrontDoorAuthGuard;
    rules: ReadonlyArray<{ authGuard?: FrontDoorAuthGuard }>;
  }>
): string[] {
  const names = new Set<string>();
  for (const listener of listeners) {
    const guards = [listener.defaultAuthGuard, ...listener.rules.map((r) => r.authGuard)];
    for (const guard of guards) {
      if (guard?.pending) names.add(guard.pending.stackName);
    }
  }
  return [...names];
}
