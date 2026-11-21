import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { RouteDiscoveryError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { displayIdent, displayStackName } from '../utils/ident-display.js';
import { stringifyValue } from '../utils/stringify.js';
import { isFunctionUrlOacFronted } from './cors-handler.js';
import { resolveLambdaArnIntrinsic as resolveLambdaArnShared } from './intrinsic-lambda-arn.js';
import { pickRefLogicalId } from './intrinsic-utils.js';
import { getEmbedConfig } from './embed-config.js';
import { substituteAgainstState, type SubstitutionContext } from './state-resolver.js';

/**
 * Authorizer detection for `cdkl start-api` (PR 8b of #224).
 *
 * The route-discovery layer now collects an optional {@link AuthorizerInfo}
 * for each route whose `AuthorizationType` references an authorizer
 * resource in the same stack. The HTTP server consults this map at
 * request time and gates the route forwarding on the authorizer's
 * verdict.
 *
 * Supported authorizer kinds:
 *   - **Lambda TOKEN** (REST v1 only) — `AWS::ApiGateway::Authorizer.Type === 'TOKEN'`.
 *     Identity is the single header named in `IdentitySource` (default
 *     `method.request.header.Authorization`).
 *   - **Lambda REQUEST** — REST v1 (`Type === 'REQUEST'`) and HTTP v2
 *     (`AWS::ApiGatewayV2::Authorizer.AuthorizerType === 'REQUEST'`).
 *     Identity is a comma-separated list of `method.request.header.X` /
 *     `method.request.querystring.X` selectors (REST v1) or a list of
 *     `$request.header.X` / `$request.querystring.X` selectors (HTTP v2).
 *   - **Cognito User Pool** — REST v1 (`Type === 'COGNITO_USER_POOLS'`)
 *     extracts the JWT from `Authorization: Bearer <token>`.
 *   - **JWT** — HTTP v2 (`AuthorizerType === 'JWT'`). The `JwtConfiguration`
 *     names the `Issuer` and `Audience` for verification.
 *
 * Out of scope (hard-errored at discovery):
 *   - REST v1 Custom authorizers with non-Lambda backing.
 *   - mTLS / VPC Lambda authorizers (the latter is not a separate kind —
 *     its Lambda is just a VPC-config Lambda; we warn at startup but do
 *     not block).
 *
 * Supported with signature-verification-only semantics:
 *   - REST v1 IAM authorizers (`AuthorizationType === 'AWS_IAM'`, #447):
 *     the local server verifies SigV4 signatures against the dev's local
 *     credentials but does NOT evaluate IAM resource / action / condition
 *     policies. See `src/local/sigv4-verify.ts`.
 */

/**
 * A route auth setting (go-to-k/cdk-local#1011) that is either enforced with
 * its literal / state-resolved value, or still unresolved — an intrinsic that
 * no state source answered — in which case it is NOT enforced and
 * {@link warnUnenforcedRouteAuthSettings} warns for the route with `reason`.
 */
export type RouteAuthSetting<T> =
  | { state: 'enforced'; value: T }
  | { state: 'unresolved'; stackName: string; raw: unknown; reason: string };

export interface LambdaTokenAuthorizer {
  kind: 'lambda-token';
  /** `AWS::ApiGateway::Authorizer` logical ID. */
  logicalId: string;
  /** Lambda logical ID resolved from `AuthorizerUri`. */
  lambdaLogicalId: string;
  /**
   * The single header whose value is the token. AWS docs name this
   * `IdentitySource`, e.g. `method.request.header.Authorization`. cdk-local
   * stores the bare lowercased header name (`authorization`).
   */
  tokenHeader: string;
  /** TTL in seconds; 0 disables caching. Default 300, max 3600 (REST v1 cap). */
  resultTtlSeconds: number;
  /**
   * The authorizer's `IdentityValidationExpression`: a token header value
   * that does not match it is answered 401 without invoking the Lambda,
   * as the deployed API does. Absent when the authorizer declares none.
   */
  identityValidation?: RouteAuthSetting<string>;
  /** Diagnostic. */
  declaredAt: string;
}

export interface LambdaRequestAuthorizer {
  kind: 'lambda-request';
  logicalId: string;
  lambdaLogicalId: string;
  /** Identity-source selectors normalized to a stable shape. */
  identitySources: ReadonlyArray<IdentitySourceSelector>;
  /** TTL in seconds; HTTP v2 stores this on the route, REST v1 on the authorizer. */
  resultTtlSeconds: number;
  /** Discriminator: 'rest-v1' uses 401 on missing identity, 'http-v2' falls through. */
  apiVersion: 'v1' | 'v2';
  declaredAt: string;
}

/**
 * A single Cognito User Pool referenced by a REST v1
 * `AWS::ApiGateway::Authorizer.ProviderARNs[]` entry. cdk-local extracts the
 * `region` + `userPoolId` segments out of the ARN so the JWKS URL can be
 * built without an AWS API call.
 */
export interface CognitoPoolRef {
  /** Original ARN as declared in `ProviderARNs[]`. */
  userPoolArn: string;
  /** Region parsed from the user pool ARN — used to build the JWKS URL. */
  region: string;
  /** Pool id parsed from the ARN. */
  userPoolId: string;
  /**
   * Set on the unreachable stand-in for an intrinsic `ProviderARNs[]` entry
   * that did not resolve (#1010). When every pool is one, the verifier skips
   * the `iss` match so JWKS pass-through admits every token, a real one too.
   */
  placeholder?: true;
}

export interface CognitoUserPoolAuthorizer {
  kind: 'cognito';
  logicalId: string;
  /**
   * Every Cognito user pool declared on the authorizer. CFn allows
   * `ProviderARNs[]` to carry 1+ entries — multi-pool federation is a
   * supported pattern for multi-tenant SaaS where each tenant has its
   * own user pool but shares one API Gateway authorizer. At request
   * time, the JWT's `iss` claim is matched against this list and the
   * matching pool's JWKS is used for signature verification.
   *
   * The list is non-empty (discovery rejects an empty `ProviderARNs[]`).
   */
  pools: ReadonlyArray<CognitoPoolRef>;
  /**
   * Backwards-compatible alias for `pools[0].userPoolArn`. Pre-PR the
   * authorizer carried a single pool; this field is retained so any
   * downstream consumer reading `userPoolArn` keeps working. New code
   * should read {@link pools} instead.
   */
  userPoolArn: string;
  /** Backwards-compatible alias for `pools[0].region`. */
  region: string;
  /** Backwards-compatible alias for `pools[0].userPoolId`. */
  userPoolId: string;
  /**
   * Set when a `ProviderARNs[]` entry is an intrinsic: CDK's
   * `CognitoUserPoolsAuthorizer` always emits `Fn::GetAtt: [<Pool>, 'Arn']`.
   * Route discovery runs before any state source loads, so the raw entries
   * are recorded here (index-aligned with {@link pools}) and the intrinsic
   * ones are served as an unreachable placeholder pool meanwhile;
   * {@link resolveJwtAuthorizerIntrinsics} resolves them from state, or
   * warns per route that JWKS pass-through applies.
   */
  pending?: { stackName: string; providerArns: readonly unknown[] };
  /**
   * The REST v1 method's `AuthorizationScopes` (go-to-k/cdk-local#1011): the
   * token's `scope` claim must carry at least one of them. Absent when the
   * method declares none.
   */
  scopes?: RouteAuthSetting<readonly string[]>;
  /**
   * The authorizer's `IdentityValidationExpression` (#1011). On a
   * COGNITO_USER_POOLS authorizer API Gateway matches it against the token's
   * `aud` claim (measured: an access token, which has none, never matches).
   */
  identityValidation?: RouteAuthSetting<string>;
  // NOTE: there is intentionally no `audience` field on REST v1 Cognito
  // authorizers. The audience that JWT verification would check (`aud`
  // for ID tokens, `client_id` for access tokens) is the User Pool *App
  // Client ID*. CDK / CFn's `AWS::ApiGateway::Authorizer` only carries
  // the User Pool ARN(s) via `ProviderARNs`, not the client id, so
  // there's no template-time data for cdk-local to surface here.
  // `verifyCognitoJwt` therefore passes `expectedAudience: undefined`
  // and falls back to issuer / signature / expiry checks only — matches
  // the deployed REST v1 behavior. HTTP v2 JWT authorizers DO carry an
  // explicit audience allowlist via `JwtConfiguration.Audience`; see
  // {@link JwtAuthorizer.audience}.
  declaredAt: string;
}

export interface JwtAuthorizer {
  kind: 'jwt';
  logicalId: string;
  /** OIDC issuer URL (HTTP v2's `JwtConfiguration.Issuer`). */
  issuer: string;
  /**
   * Allowed audiences. JWT's `aud` claim must match one of these (or
   * `client_id` for non-Cognito tokens that omit `aud`).
   */
  audience: ReadonlyArray<string>;
  /**
   * For Cognito-issued JWTs the issuer URL embeds the user pool id and
   * we can derive the JWKS URL automatically. Other issuers also expose
   * `<issuer>/.well-known/jwks.json` so we use the same fetch path.
   */
  region?: string;
  userPoolId?: string;
  /**
   * Set when the template's `Issuer` or an `Audience` entry is an intrinsic
   * (#1001): `HttpUserPoolAuthorizer` always emits the issuer as a
   * `Fn::Join` over `Ref AWS::Region` + `Ref <UserPool>` and the audience as
   * `Ref <UserPoolClient>`. Route discovery runs before any state source
   * loads, so it records the raw values here and serves the unreachable
   * placeholder issuer meanwhile; {@link resolveJwtAuthorizerIntrinsics}
   * resolves them from state, or warns that JWKS pass-through applies.
   */
  pending?: { stackName: string; issuer: unknown; audience: readonly unknown[] };
  /**
   * The HTTP v2 route's `AuthorizationScopes` (go-to-k/cdk-local#1011): the
   * token's `scope` claim must carry at least one of them. Absent when the
   * route declares none.
   */
  scopes?: RouteAuthSetting<readonly string[]>;
  declaredAt: string;
}

/**
 * REST v1 `AuthorizationType: 'AWS_IAM'` (closes #447).
 *
 * Unlike the other authorizer kinds, AWS_IAM has NO `AWS::ApiGateway::Authorizer`
 * resource in the template — the method's `AuthorizationType` is the only
 * signal. The local server verifies the request's SigV4 signature against
 * the dev's local credentials (see `src/local/sigv4-verify.ts`). IAM
 * policy evaluation (resource / action / condition) is intentionally not
 * emulated — that requires the deployed IAM data plane.
 */
export interface IamAuthorizer {
  kind: 'iam';
  /** Synthetic logical id — there is no real `AWS::ApiGateway::Authorizer` resource. */
  logicalId: 'AWS_IAM';
  declaredAt: string;
  /**
   * Set only for Function URLs (`AWS::Lambda::Url`) fronted by a CloudFront
   * Origin Access Control that signs origin requests. In production
   * CloudFront re-signs the origin request with its own identity, so the
   * END client never signs as the IAM principal and no local client
   * signature can be verified. The HTTP server keeps SigV4 verification in
   * warn-and-pass mode for these routes even under `--strict-sigv4`. Never
   * set for REST v1 AWS_IAM (clients there genuinely sign with their own
   * credentials, so `--strict-sigv4` applies to them). See
   * {@link isFunctionUrlOacFronted}.
   */
  oacFronted?: boolean;
}

export type AuthorizerInfo =
  | LambdaTokenAuthorizer
  | LambdaRequestAuthorizer
  | CognitoUserPoolAuthorizer
  | JwtAuthorizer
  | IamAuthorizer;

export type IdentitySourceSelector =
  | { kind: 'header'; name: string }
  | { kind: 'query'; name: string }
  | { kind: 'context'; name: string }
  | { kind: 'stage-variable'; name: string };

/**
 * Resolve an `AWS::ApiGateway::Authorizer` referenced by a REST v1 method
 * to its {@link AuthorizerInfo} record. Returns `undefined` when the
 * authorizer is intentionally unsupported (the caller treats this as
 * "no authorizer", which is wrong but produces a warn line — see
 * `route-discovery.ts`).
 */
export function resolveRestV1Authorizer(
  authorizerLogicalId: string,
  template: CloudFormationTemplate,
  stackName: string,
  declaredAt: string
): AuthorizerInfo {
  const authResource = template.Resources?.[authorizerLogicalId];
  if (!authResource || authResource.Type !== 'AWS::ApiGateway::Authorizer') {
    throw new RouteDiscoveryError(
      `${displayStackName(declaredAt)}: AuthorizerId ${displayIdent(authorizerLogicalId)} does not point at an AWS::ApiGateway::Authorizer in stack ${displayStackName(stackName)}.`
    );
  }
  const props = authResource.Properties ?? {};
  const type = props['Type'];

  if (type === 'TOKEN') {
    const lambdaLogicalId = resolveLambdaArn(
      props['AuthorizerUri'],
      `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}.AuthorizerUri`
    );
    const identitySource =
      typeof props['IdentitySource'] === 'string'
        ? props['IdentitySource']
        : 'method.request.header.Authorization';
    const tokenHeader = parseRestV1HeaderSelector(identitySource, stackName, authorizerLogicalId);
    const ttl = parseTtl(props['AuthorizerResultTtlInSeconds'], 300, 3600);
    const identityValidation = parseIdentityValidationSetting(
      props['IdentityValidationExpression'],
      stackName
    );
    return {
      kind: 'lambda-token',
      logicalId: authorizerLogicalId,
      lambdaLogicalId,
      tokenHeader,
      resultTtlSeconds: ttl,
      ...(identityValidation && { identityValidation }),
      declaredAt,
    };
  }

  if (type === 'REQUEST') {
    const lambdaLogicalId = resolveLambdaArn(
      props['AuthorizerUri'],
      `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}.AuthorizerUri`
    );
    const identitySources = parseRestV1IdentitySources(
      typeof props['IdentitySource'] === 'string' ? props['IdentitySource'] : ''
    );
    const ttl = parseTtl(props['AuthorizerResultTtlInSeconds'], 300, 3600);
    return {
      kind: 'lambda-request',
      logicalId: authorizerLogicalId,
      lambdaLogicalId,
      identitySources,
      resultTtlSeconds: ttl,
      apiVersion: 'v1',
      declaredAt,
    };
  }

  if (type === 'COGNITO_USER_POOLS') {
    const arns = props['ProviderARNs'];
    if (!Array.isArray(arns) || arns.length === 0) {
      throw new RouteDiscoveryError(
        `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}: COGNITO_USER_POOLS authorizer is missing ProviderARNs.`
      );
    }
    // Walk every ProviderARNs[] entry — CFn allows 1+ for multi-pool
    // federation (multi-tenant SaaS with one pool per tenant). A single
    // malformed entry aborts the whole authorizer at discovery time so
    // the user sees the exact offending index, not a mid-request failure
    // for one tenant only. An intrinsic entry is served as a placeholder
    // pool until state resolves it (`pending`).
    let anyIntrinsic = false;
    const pools: CognitoPoolRef[] = arns.map((entry, idx) => {
      const location = `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}.ProviderARNs[${idx}]`;
      if (isIntrinsicObject(entry)) {
        anyIntrinsic = true;
        return cognitoPlaceholderPool(authorizerLogicalId);
      }
      if (typeof entry !== 'string') {
        throw new RouteDiscoveryError(
          `${location}: must be a literal string or an intrinsic (got ${shortJson(entry)}).`
        );
      }
      const parsed = parseCognitoUserPoolArn(entry, location);
      return { userPoolArn: entry, region: parsed.region, userPoolId: parsed.userPoolId };
    });
    const identityValidation = parseIdentityValidationSetting(
      props['IdentityValidationExpression'],
      stackName
    );
    return {
      ...buildCognitoAuthorizer(
        authorizerLogicalId,
        pools,
        declaredAt,
        anyIntrinsic ? { stackName, providerArns: arns } : undefined
      ),
      ...(identityValidation && { identityValidation }),
    };
  }

  // Unknown Type — surface a structured error that the route-discovery
  // layer wraps with offending route info. Note: AWS_IAM is detected at
  // the Method level (`AuthorizationType: 'AWS_IAM'`), not here — CDK
  // does not emit a companion `AWS::ApiGateway::Authorizer` resource
  // for IAM. mTLS lives on the `AWS::ApiGateway::DomainName` /
  // `AWS::ApiGatewayV2::DomainName` resource via `MutualTlsAuthentication`,
  // also not via Authorizer; cdk-local supports it via the `--mtls-truststore`
  // / `--mtls-cert` / `--mtls-key` CLI flags on `cdkl start-api`,
  // and the TLS handshake itself enforces the client-cert trust check,
  // orthogonal to (and composable with) TOKEN / REQUEST / COGNITO_USER_POOLS
  // authorizers.
  throw new RouteDiscoveryError(
    `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}: AWS::ApiGateway::Authorizer.Type ${displayIdent(stringifyValue(type))} is not supported by ${getEmbedConfig().cliName} start-api (only TOKEN / REQUEST / COGNITO_USER_POOLS are accepted at the Authorizer resource).`
  );
}

/**
 * Resolve an `AWS::ApiGatewayV2::Authorizer`. HTTP v2 has only `REQUEST`
 * and `JWT`; everything else is unsupported.
 */
export function resolveHttpApiAuthorizer(
  authorizerLogicalId: string,
  /** The route's raw `AuthorizationScopes`, enforced on a JWT authorizer (#1011). */
  routeAuthorizationScopes: unknown,
  template: CloudFormationTemplate,
  stackName: string,
  declaredAt: string
): AuthorizerInfo {
  const authResource = template.Resources?.[authorizerLogicalId];
  if (!authResource || authResource.Type !== 'AWS::ApiGatewayV2::Authorizer') {
    throw new RouteDiscoveryError(
      `${displayStackName(declaredAt)}: AuthorizerId ${displayIdent(authorizerLogicalId)} does not point at an AWS::ApiGatewayV2::Authorizer in stack ${displayStackName(stackName)}.`
    );
  }
  const props = authResource.Properties ?? {};
  const authType = props['AuthorizerType'];

  if (authType === 'REQUEST') {
    const lambdaLogicalId = resolveLambdaArn(
      props['AuthorizerUri'],
      `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}.AuthorizerUri`
    );
    const identitySources = parseHttpV2IdentitySources(props['IdentitySource']);
    const ttl = parseTtl(props['AuthorizerResultTtlInSeconds'], 0, 3600);
    return {
      kind: 'lambda-request',
      logicalId: authorizerLogicalId,
      lambdaLogicalId,
      identitySources,
      resultTtlSeconds: ttl,
      apiVersion: 'v2',
      declaredAt,
    };
  }

  if (authType === 'JWT') {
    const jwt = props['JwtConfiguration'];
    if (!jwt || typeof jwt !== 'object') {
      throw new RouteDiscoveryError(
        `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}: AWS::ApiGatewayV2::Authorizer.JwtConfiguration is required for AuthorizerType=JWT.`
      );
    }
    const obj = jwt as Record<string, unknown>;
    const rawIssuer = obj['Issuer'];
    const issuerIsIntrinsic = isIntrinsicObject(rawIssuer);
    if (!issuerIsIntrinsic && (typeof rawIssuer !== 'string' || rawIssuer.length === 0)) {
      throw new RouteDiscoveryError(
        `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}: JwtConfiguration.Issuer must be a string or an intrinsic.`
      );
    }
    const audienceRaw = obj['Audience'];
    const rawAudience: readonly unknown[] = Array.isArray(audienceRaw) ? audienceRaw : [];
    const audienceIsIntrinsic = rawAudience.some(isIntrinsicObject);
    const scopes = parseScopesSetting(routeAuthorizationScopes, stackName);
    if (issuerIsIntrinsic || audienceIsIntrinsic) {
      // Served as the unreachable placeholder until state resolves it.
      return {
        ...buildJwtAuthorizer(
          authorizerLogicalId,
          jwtPlaceholderIssuer(authorizerLogicalId),
          [],
          declaredAt
        ),
        pending: { stackName, issuer: rawIssuer, audience: rawAudience },
        ...(scopes && { scopes }),
      };
    }
    return {
      ...buildJwtAuthorizer(
        authorizerLogicalId,
        rawIssuer as string,
        rawAudience.filter((s): s is string => typeof s === 'string'),
        declaredAt
      ),
      ...(scopes && { scopes }),
    };
  }

  throw new RouteDiscoveryError(
    `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}: AWS::ApiGatewayV2::Authorizer.AuthorizerType ${displayIdent(stringifyValue(authType))} is not supported by ${getEmbedConfig().cliName} start-api (only REQUEST / JWT).`
  );
}

/**
 * Thrown by {@link resolveLambdaArn} when the authorizer's
 * `AuthorizerUri` intrinsic does not resolve to a same-template Lambda
 * (cross-stack reference, imported Lambda, hand-rolled `Fn::Sub` outside
 * the invoke-ARN wrapper).
 *
 * Caught by {@link attachAuthorizers} and converted into a per-route
 * `unsupported` flag — symmetric with how `route-discovery.ts` handles
 * an unresolvable `IntegrationUri`. The route appears in the route
 * table as `[501 Not Implemented]` and returns HTTP 501 + the
 * `reason` at request time. The alternative ("attach no authorizer,
 * leave route normal") would be **unsafe** — it would let a request
 * hit a user-protected route without any auth check just because the
 * authorizer Lambda lives in another stack.
 *
 * Private to this module: `attachAuthorizers` is the only legitimate
 * consumer.
 */
class AuthorizerLambdaUnresolvableError extends RouteDiscoveryError {
  // Extends RouteDiscoveryError so existing tests that catch the
  // generic `RouteDiscoveryError` (e.g. direct calls to
  // `resolveHttpApiAuthorizer` that bypass `attachAuthorizers`) keep
  // working unchanged. `attachAuthorizers` matches on the more
  // specific subclass first so the deferred-501 path takes priority
  // over the generic catch.
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'AuthorizerLambdaUnresolvableError';
    // The parent's constructor calls setPrototypeOf back to
    // RouteDiscoveryError.prototype (a well-known transpile-target
    // workaround for `extends Error`); re-apply ours so
    // `instanceof AuthorizerLambdaUnresolvableError` works in
    // `attachAuthorizers`'s catch.
    Object.setPrototypeOf(this, AuthorizerLambdaUnresolvableError.prototype);
  }
}

/**
 * Resolve a Lambda ARN intrinsic to its logical ID. Delegates to the
 * shared `resolveLambdaArnIntrinsic` in `intrinsic-lambda-arn.ts`
 * (extracted in issue #286 Gaps 3 / 4); accepts `Ref` /
 * `Fn::GetAtt: [..., 'Arn']` / the REST v1 invoke-ARN `Fn::Join` wrapper
 * (now also used by CDK 2.x's `HttpLambdaAuthorizer` for HTTP API v2 —
 * verified via real `cdk synth` 2026-05-12) / the `Fn::Sub` invoke-ARN
 * wrapper (both 1-arg and 2-arg forms).
 *
 * On an unresolvable intrinsic throws {@link AuthorizerLambdaUnresolvableError}
 * (caught by `attachAuthorizers` and converted into a per-route
 * deferred-501) instead of the generic `RouteDiscoveryError`, so
 * `cdkl start-api` can boot against an app with a cross-stack
 * authorizer Lambda — symmetric with the route-level `IntegrationUri`
 * unresolvable case (issue #431).
 */
// `location` here, in `parseCognitoUserPoolArn` and in `pickStringFromArn` is a
// DISPLAY string its caller built from already-rendered parts (#761), never a key.
function resolveLambdaArn(value: unknown, location: string): string {
  const outcome = resolveLambdaArnShared(value);
  if (outcome.kind === 'resolved' && outcome.streaming === true) {
    // The 2021-11-15 response-streaming wrapper (#922) is an integration
    // URI; API Gateway invokes authorizers with the plain Invoke API.
    throw new AuthorizerLambdaUnresolvableError(
      `${location}: the response-streaming Lambda URI ('2021-11-15/functions/<fn>/response-streaming-invocations') is only valid on a REST API Lambda proxy integration, not on an authorizer (got ${shortJson(value)}).`
    );
  }
  if (outcome.kind === 'resolved') return outcome.logicalId;
  throw new AuthorizerLambdaUnresolvableError(
    `${location}: ${outcome.detail} (got ${shortJson(value)}). Only { Ref }, { Fn::GetAtt: [..., 'Arn'] }, the REST v1 invoke-ARN Fn::Join wrapper, and the Fn::Sub invoke-ARN wrapper are supported.`
  );
}

/**
 * REST v1 IdentitySource for TOKEN authorizers must be exactly one
 * `method.request.header.<HeaderName>` reference. Returns the bare
 * lowercased header name.
 */
function parseRestV1HeaderSelector(
  identitySource: string,
  stackName: string,
  authorizerLogicalId: string
): string {
  const m = /^method\.request\.header\.([A-Za-z0-9-_]+)$/.exec(identitySource.trim());
  if (!m) {
    throw new RouteDiscoveryError(
      `${displayStackName(stackName)}/${displayIdent(authorizerLogicalId)}: TOKEN authorizer IdentitySource ${displayIdent(identitySource)} must be 'method.request.header.<HeaderName>'.`
    );
  }
  return m[1]!.toLowerCase();
}

/**
 * REST v1 IdentitySource for REQUEST authorizers is a comma-separated
 * list of selectors. Examples:
 *   - `method.request.header.X-Api-Key`
 *   - `method.request.querystring.token`
 *   - `context.identity.sourceIp` (rare)
 *   - `stageVariables.foo` (rare)
 *
 * Whitespace around commas is tolerated. Empty input returns `[]`.
 */
function parseRestV1IdentitySources(raw: string): IdentitySourceSelector[] {
  const out: IdentitySourceSelector[] = [];
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim();
    if (token.length === 0) continue;
    const headerMatch = /^method\.request\.header\.([A-Za-z0-9-_]+)$/.exec(token);
    if (headerMatch) {
      out.push({ kind: 'header', name: headerMatch[1]!.toLowerCase() });
      continue;
    }
    const queryMatch = /^method\.request\.querystring\.([A-Za-z0-9-_]+)$/.exec(token);
    if (queryMatch) {
      out.push({ kind: 'query', name: queryMatch[1]! });
      continue;
    }
    const contextMatch = /^context\.([A-Za-z0-9._-]+)$/.exec(token);
    if (contextMatch) {
      out.push({ kind: 'context', name: contextMatch[1]! });
      continue;
    }
    const stageMatch = /^stageVariables\.([A-Za-z0-9._-]+)$/.exec(token);
    if (stageMatch) {
      out.push({ kind: 'stage-variable', name: stageMatch[1]! });
      continue;
    }
    // Unknown form — keep it as a header selector defensively (matches
    // upstream's tolerant parsing); the cache key still hashes it.
    out.push({ kind: 'header', name: token.toLowerCase() });
  }
  return out;
}

/**
 * HTTP v2 IdentitySource is an array of `$request.header.X` /
 * `$request.querystring.X` selectors (CDK emits a list).
 */
function parseHttpV2IdentitySources(raw: unknown): IdentitySourceSelector[] {
  if (!Array.isArray(raw)) return [];
  const out: IdentitySourceSelector[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const headerMatch = /^\$request\.header\.([A-Za-z0-9-_]+)$/.exec(entry);
    if (headerMatch) {
      out.push({ kind: 'header', name: headerMatch[1]!.toLowerCase() });
      continue;
    }
    const queryMatch = /^\$request\.querystring\.([A-Za-z0-9-_]+)$/.exec(entry);
    if (queryMatch) {
      out.push({ kind: 'query', name: queryMatch[1]! });
      continue;
    }
    out.push({ kind: 'header', name: entry.toLowerCase() });
  }
  return out;
}

/**
 * Parse a Cognito User Pool ARN
 * `arn:aws:cognito-idp:<region>:<account>:userpool/<region>_<id>`
 * into its region and pool id.
 */
function parseCognitoUserPoolArn(
  arn: string,
  location: string
): { region: string; userPoolId: string } {
  const m = /^arn:aws[a-z0-9-]*:cognito-idp:([a-z0-9-]+):[0-9]+:userpool\/(.+)$/.exec(arn);
  if (!m) {
    throw new RouteDiscoveryError(
      `${location}: malformed Cognito User Pool ARN ${displayUntrustedValue(arn)}. Expected 'arn:aws:cognito-idp:<region>:<account>:userpool/<id>'.`
    );
  }
  return { region: m[1]!, userPoolId: m[2]! };
}

/**
 * Detect Cognito-issued JWT issuer URLs and pluck the region + pool id
 * out for the JWKS fetcher. Issuer URLs look like
 * `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` — non-Cognito
 * URLs return undefined and the JWKS fetcher uses the OIDC discovery
 * convention (`<issuer>/.well-known/jwks.json`) instead.
 */
function parseCognitoIssuer(issuer: string): { region: string; userPoolId: string } | undefined {
  const m = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([^/]+)\/?$/.exec(issuer);
  if (!m) return undefined;
  return { region: m[1]!, userPoolId: m[2]! };
}

function isIntrinsicObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const NO_STATE_REASON = 'no state source is loaded for the stack';

/**
 * Read a route's `AuthorizationScopes` (#1011). A list of literal strings is
 * enforced; one carrying an intrinsic (CDK's `OAuthScope.resourceServer`
 * emits `Fn::Join` over `Ref <ResourceServer>`) waits for state. An empty
 * list declares nothing.
 */
function parseScopesSetting(
  raw: unknown,
  stackName: string
): RouteAuthSetting<readonly string[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined;
    if (raw.every((s): s is string => typeof s === 'string')) {
      return { state: 'enforced', value: raw };
    }
  }
  return { state: 'unresolved', stackName, raw, reason: NO_STATE_REASON };
}

/**
 * Read a TOKEN authorizer's `IdentityValidationExpression` (#1011). A literal
 * pattern is enforced once it compiles; an intrinsic waits for state.
 */
function parseIdentityValidationSetting(
  raw: unknown,
  stackName: string
): RouteAuthSetting<string> | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'string') return identityValidationFromString(raw, stackName, raw);
  return { state: 'unresolved', stackName, raw, reason: NO_STATE_REASON };
}

function identityValidationFromString(
  pattern: string,
  stackName: string,
  raw: unknown
): RouteAuthSetting<string> {
  try {
    compileIdentityValidation(pattern);
  } catch (err) {
    // The engine's message echoes the pattern; keep only its verdict, so the
    // warning carries one rendered copy of the template value.
    const detail = (err instanceof Error ? err.message : String(err)).replace(
      /^Invalid regular expression: \/.*\/[a-z]*: /s,
      ''
    );
    return {
      state: 'unresolved',
      stackName,
      raw,
      reason: `${displayUntrustedValue(pattern)} is not a pattern ${getEmbedConfig().cliName} start-api can evaluate (${detail})`,
    };
  }
  return { state: 'enforced', value: pattern };
}

const compiledIdentityValidation = new Map<string, RegExp>();

/**
 * Compile an `IdentityValidationExpression`. API Gateway evaluates it as a
 * Java regular expression against the WHOLE value (measured), so the pattern
 * is anchored at both ends. It is compiled on its own first, so a pattern
 * that would unbalance the anchoring group (`a)|(b`) throws instead of
 * losing an anchor, and with the `u` flag, so Java-only syntax JavaScript
 * would otherwise read differently (`\p{Alpha}`, `\A`, `\Z`) throws into the
 * "cannot evaluate" warning rather than enforcing a different pattern.
 */
export function compileIdentityValidation(pattern: string): RegExp {
  let re = compiledIdentityValidation.get(pattern);
  if (!re) {
    new RegExp(pattern, 'u');
    re = new RegExp(`^(?:${pattern})$`, 'u');
    compiledIdentityValidation.set(pattern, re);
  }
  return re;
}

/**
 * Whether a token's scope claims carry at least one of the route's
 * `AuthorizationScopes` (#1011) — the any-of rule API Gateway applies for
 * both a REST v1 Cognito authorizer and an HTTP v2 JWT authorizer. Each
 * claim value is an OAuth space-separated string or a string array; an HTTP
 * v2 JWT authorizer reads `scope` or `scp` (AWS docs), a Cognito token
 * carries `scope` only.
 */
export function tokenHasAnyScope(
  scopeClaims: readonly unknown[],
  scopes: readonly string[]
): boolean {
  const granted = new Set<string>();
  for (const claim of scopeClaims) {
    const values = typeof claim === 'string' ? claim.split(' ') : Array.isArray(claim) ? claim : [];
    for (const v of values) if (typeof v === 'string' && v.length > 0) granted.add(v);
  }
  return scopes.some((s) => granted.has(s));
}

/**
 * The issuer an HTTP v2 JWT authorizer is served with while its template
 * issuer is an unresolved intrinsic: a Cognito-shaped URL naming a pool that
 * does not exist, so the JWKS fetch fails into the documented pass-through
 * mode — the same placeholder the REST v1 `Fn::GetAtt` ARN case uses. Also
 * the issuer of a `start-alb` authenticate-* guard that cannot be resolved
 * (#1004).
 */
export function jwtPlaceholderIssuer(logicalId: string): string {
  return `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_${getEmbedConfig().binaryName}placeholder${logicalId}`;
}

/**
 * The pool a REST v1 `COGNITO_USER_POOLS` authorizer is served with while a
 * `ProviderARNs[]` entry is an unresolved intrinsic: a pool id that does not
 * exist, so the JWKS fetch fails into the documented pass-through mode. The
 * id is namespaced with the authorizer's logical id so a warning greps back
 * to it.
 */
function cognitoPlaceholderPool(logicalId: string): CognitoPoolRef {
  const userPoolId = `us-east-1_${getEmbedConfig().binaryName}placeholder${logicalId}`;
  return {
    userPoolArn: `arn:aws:cognito-idp:us-east-1:000000000000:userpool/${userPoolId}`,
    region: 'us-east-1',
    userPoolId,
    placeholder: true,
  };
}

function buildCognitoAuthorizer(
  logicalId: string,
  pools: CognitoPoolRef[],
  declaredAt: string,
  pending: CognitoUserPoolAuthorizer['pending']
): CognitoUserPoolAuthorizer {
  const first = pools[0]!;
  return {
    kind: 'cognito',
    logicalId,
    pools,
    userPoolArn: first.userPoolArn,
    region: first.region,
    userPoolId: first.userPoolId,
    ...(pending && { pending }),
    declaredAt,
  };
}

const COGNITO_USERPOOL_TYPE = 'AWS::Cognito::UserPool';
const COGNITO_USERPOOL_ID = /^([a-z]{2}(?:-[a-z]+)+-\d+)_[0-9A-Za-z]+$/;

/**
 * The deployed ARN behind `Fn::GetAtt: [<UserPool>, 'Arn']` when the state
 * record carries no `Arn` attribute (the `--from-cfn-stack` provider records
 * physical ids only): a Cognito user pool's physical id is its pool id, whose
 * `<region>_` prefix names the region. Only the region and the pool id are
 * read back out of the ARN, so the account falls back to a filler.
 * `undefined` when the value is not that shape or the record cannot derive
 * it; the caller then substitutes against state as usual.
 */
export function userPoolArnFromState(
  raw: unknown,
  context: SubstitutionContext
): string | undefined {
  if (!isIntrinsicObject(raw)) return undefined;
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

/** A route as a warning names it: its method and path. */
export function describeRouteForWarning(route: { method: string; pathPattern: string }): string {
  return `route ${displayIdent(route.method)} ${displayIdent(route.pathPattern)}`;
}

function buildJwtAuthorizer(
  logicalId: string,
  issuer: string,
  audience: ReadonlyArray<string>,
  declaredAt: string
): JwtAuthorizer {
  // Cognito-issued JWTs encode the user pool id in the issuer URL; we
  // detect that shape so the JWKS fetcher can use the canonical
  // `cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json`
  // URL even when the user-supplied issuer omits the trailing slash.
  const cognito = parseCognitoIssuer(issuer);
  return {
    kind: 'jwt',
    logicalId,
    issuer,
    audience,
    ...(cognito && { region: cognito.region, userPoolId: cognito.userPoolId }),
    declaredAt,
  };
}

/**
 * Resolve every authorizer whose template settings are intrinsics against the
 * routed stack's state, once a state source has loaded. `contextFor` returns
 * the stack's substitution context, or `undefined` when it has no state.
 *
 * HTTP v2 JWT (`Issuer` / `Audience`, #1001):
 * - Issuer and every audience entry resolve: the authorizer verifies exactly
 *   as one with literal values would.
 * - Issuer resolves, an audience entry does not: signature, issuer and expiry
 *   are verified and the audience is NOT checked (warned), which is stricter
 *   than pass-through and never rejects a token the deployed API accepts.
 * - Issuer does not resolve (no state source, or no record): the placeholder
 *   stays, so JWKS pass-through admits every token (warned).
 *
 * REST v1 `COGNITO_USER_POOLS` (`ProviderARNs[]`, go-to-k/cdk-local#1010):
 * every intrinsic entry that resolves to a user pool ARN is verified against
 * that pool's real JWKS; one that does not stays the placeholder pool
 * (warned) — with a single pool, JWKS pass-through admits every token.
 *
 * Every warning names the route it applies to and the unresolved setting, so
 * nothing a route declares goes unenforced without a word. `warned` dedups
 * them; a caller re-running this on every `--watch` reload passes one set
 * that outlives the reloads.
 */
export function resolveJwtAuthorizerIntrinsics(
  routes: readonly RouteWithAuth[],
  contextFor: (stackName: string) => SubstitutionContext | undefined,
  warned: Set<string> = new Set<string>()
): RouteWithAuth[] {
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    getLogger().warn(message);
  };
  const cli = getEmbedConfig().cliName;
  const hint =
    'Deploy the stack and pass --from-state (or --from-cfn-stack) for real signature verification.';
  const resolveIssuerAndPools = (entry: RouteWithAuth): RouteWithAuth => {
    const auth = entry.authorizer;
    if (!auth || (auth.kind !== 'jwt' && auth.kind !== 'cognito') || !auth.pending) return entry;
    const { stackName } = auth.pending;
    const label = `${displayStackName(stackName)}/${displayIdent(auth.logicalId)}`;
    const routeLabel = describeRouteForWarning(entry.route);
    const routeKey = `${entry.route.declaredAt}\0${entry.route.method}\0${entry.route.pathPattern}`;
    const context = contextFor(stackName);
    const resolveString = (value: unknown): { value: string } | { reason: string } => {
      if (typeof value === 'string') return { value };
      if (!context) return { reason: 'no state source is loaded for the stack' };
      const result = substituteAgainstState(value, context);
      if (
        result.kind === 'literal' &&
        typeof result.value === 'string' &&
        result.value.length > 0
      ) {
        return { value: result.value };
      }
      return { reason: result.kind === 'unresolved' ? result.reason : 'resolved to a non-string' };
    };

    if (auth.kind === 'cognito') {
      const providerArns = auth.pending.providerArns;
      // Resolve every intrinsic entry first; the warning's effect depends on
      // whether any real pool is left.
      const outcomes = auth.pools.map((pool, idx) => {
        const raw = providerArns[idx];
        if (!isIntrinsicObject(raw)) return { pool, real: true as const };
        const derived = context ? userPoolArnFromState(raw, context) : undefined;
        const r = derived !== undefined ? { value: derived } : resolveString(raw);
        if ('value' in r) {
          const m = /^arn:aws[a-z0-9-]*:cognito-idp:([a-z0-9-]+):[0-9]+:userpool\/(.+)$/.exec(
            r.value
          );
          if (m) {
            return {
              pool: { userPoolArn: r.value, region: m[1]!, userPoolId: m[2]! },
              real: true as const,
            };
          }
          return {
            pool,
            real: false as const,
            idx,
            reason: 'it resolved to a value that is not a Cognito user pool ARN',
          };
        }
        return { pool, real: false as const, idx, reason: r.reason };
      });
      const realPools = outcomes.filter((o) => o.real).map((o) => o.pool);
      for (const o of outcomes) {
        if (o.real) continue;
        // With a real pool beside it, the placeholder is DROPPED: its issuer is
        // predictable, so keeping it would admit any token naming it.
        const effect =
          realPools.length > 0
            ? `a token from that pool is rejected on ${routeLabel} (the other pools are verified for real)`
            : `JWKS pass-through admits every Bearer token on ${routeLabel}`;
        warnOnce(
          `${routeKey}\0${stackName}\0${auth.logicalId}\0provider${o.idx}`,
          `${label}.ProviderARNs[${o.idx}] is an intrinsic ${cli} start-api could not resolve (${o.reason}), so ${effect}. ${hint}`
        );
      }
      const allResolved = realPools.length === auth.pools.length;
      // `pending` stays only while the pools are still index-aligned with it
      // (nothing resolved), so a re-run resolves the same entries again.
      return {
        ...entry,
        authorizer: {
          ...buildCognitoAuthorizer(
            auth.logicalId,
            realPools.length > 0 ? realPools : outcomes.map((o) => o.pool),
            auth.declaredAt,
            allResolved || realPools.length > 0 ? undefined : auth.pending
          ),
          ...(auth.scopes && { scopes: auth.scopes }),
          ...(auth.identityValidation && { identityValidation: auth.identityValidation }),
        },
      };
    }

    const { issuer, audience } = auth.pending;
    const issuerResult = resolveString(issuer);
    if (!('value' in issuerResult)) {
      warnOnce(
        `${routeKey}\0${stackName}\0${auth.logicalId}\0issuer`,
        `${label}: JwtConfiguration.Issuer is an intrinsic ${cli} start-api could not resolve ` +
          `(${issuerResult.reason}), so JWKS pass-through admits every token on ${routeLabel}. ${hint}`
      );
      return entry;
    }
    const resolvedAudience: string[] = [];
    const unresolvedAudience: number[] = [];
    let firstReason: string | undefined;
    audience.forEach((value, idx) => {
      // A non-string literal is dropped, as on the all-literal path.
      if (typeof value !== 'string' && !isIntrinsicObject(value)) return;
      const r = resolveString(value);
      if ('value' in r) {
        resolvedAudience.push(r.value);
      } else {
        unresolvedAudience.push(idx);
        firstReason ??= r.reason;
      }
    });
    if (unresolvedAudience.length > 0) {
      warnOnce(
        `${routeKey}\0${stackName}\0${auth.logicalId}\0audience`,
        `${label}: JwtConfiguration.Audience ${unresolvedAudience.map((i) => `[${i}]`).join(', ')} could not be resolved ` +
          `(${firstReason}), so the token audience is not checked on ${routeLabel} (signature, issuer and expiry still are).`
      );
    }
    return {
      ...entry,
      authorizer: {
        ...buildJwtAuthorizer(
          auth.logicalId,
          issuerResult.value,
          unresolvedAudience.length > 0 ? [] : resolvedAudience,
          auth.declaredAt
        ),
        ...(auth.scopes && { scopes: auth.scopes }),
      },
    };
  };
  return routes.map((entry) => resolveRouteAuthSettings(resolveIssuerAndPools(entry), contextFor));
}

/**
 * Resolve a route's intrinsic `AuthorizationScopes` and a TOKEN authorizer's
 * intrinsic `IdentityValidationExpression` (#1011) against state. A setting
 * that resolves is enforced; one that does not keeps its reason, and
 * {@link warnUnenforcedRouteAuthSettings} warns for the route. Scopes resolve
 * all-or-nothing: enforcing only the resolved entries would reject a token
 * carrying just an unresolved one, which the deployed API accepts.
 */
function resolveRouteAuthSettings(
  entry: RouteWithAuth,
  contextFor: (stackName: string) => SubstitutionContext | undefined
): RouteWithAuth {
  let auth = entry.authorizer;
  if (!auth) return entry;
  if ((auth.kind === 'jwt' || auth.kind === 'cognito') && auth.scopes?.state === 'unresolved') {
    auth = {
      ...auth,
      scopes: resolveScopesFromState(auth.scopes, contextFor(auth.scopes.stackName)),
    };
  }
  if (
    (auth.kind === 'lambda-token' || auth.kind === 'cognito') &&
    auth.identityValidation?.state === 'unresolved'
  ) {
    auth = {
      ...auth,
      identityValidation: resolveIdentityValidationFromState(
        auth.identityValidation,
        contextFor(auth.identityValidation.stackName)
      ),
    };
  }
  return auth === entry.authorizer ? entry : { ...entry, authorizer: auth };
}

function resolveIdentityValidationFromState(
  setting: Extract<RouteAuthSetting<string>, { state: 'unresolved' }>,
  context: SubstitutionContext | undefined
): RouteAuthSetting<string> {
  // A literal that did not compile stays as it is: state cannot change it.
  if (typeof setting.raw === 'string' || !context) return setting;
  const result = substituteAgainstState(setting.raw, context);
  if (result.kind === 'literal' && typeof result.value === 'string' && result.value.length > 0) {
    return identityValidationFromString(result.value, setting.stackName, setting.raw);
  }
  return {
    ...setting,
    reason: result.kind === 'unresolved' ? result.reason : 'it resolved to a non-string',
  };
}

function resolveScopesFromState(
  setting: Extract<RouteAuthSetting<readonly string[]>, { state: 'unresolved' }>,
  context: SubstitutionContext | undefined
): RouteAuthSetting<readonly string[]> {
  if (!context) return setting;
  const unresolved = (reason: string): RouteAuthSetting<readonly string[]> => ({
    ...setting,
    reason,
  });
  if (!Array.isArray(setting.raw)) {
    // The whole list is one intrinsic (a `Fn::Split`, a list parameter); the
    // state substituter answers scalars only.
    return unresolved(
      isIntrinsicObject(setting.raw) ? 'the list itself is an intrinsic' : 'it is not a list'
    );
  }
  const value: string[] = [];
  for (const item of setting.raw) {
    if (typeof item === 'string') {
      value.push(item);
      continue;
    }
    const result = substituteAgainstState(item, context);
    if (result.kind !== 'literal') return unresolved(result.reason);
    if (typeof result.value !== 'string' || result.value.length === 0) {
      return unresolved('an entry resolved to a non-string');
    }
    value.push(result.value);
  }
  return { state: 'enforced', value };
}

/**
 * Warn, once per route, about every auth setting a served route declares that
 * `start-api` does not enforce locally (go-to-k/cdk-local#1010), so no setting
 * is dropped silently:
 *
 * - REST v1 method `ApiKeyRequired`: API keys live in the deployed API.
 * - REST v1 method / HTTP v2 route `AuthorizationScopes` on an authorizer kind
 *   that does not check them, or that stayed an unresolved intrinsic (#1011).
 * - REST v1 TOKEN / COGNITO_USER_POOLS authorizer `IdentityValidationExpression` that stayed an
 *   unresolved intrinsic or is not a pattern the local server can evaluate.
 * - REST v1 `AWS::ApiGateway::RestApi.Policy` (a resource policy).
 *
 * The route is still served. `warned` dedups across `--watch` reloads.
 */
export function warnUnenforcedRouteAuthSettings(
  stacks: readonly StackInfo[],
  routes: readonly RouteWithAuth[],
  warned: Set<string> = new Set<string>()
): void {
  const cli = getEmbedConfig().cliName;
  const byName = new Map(stacks.map((st) => [st.stackName, st] as const));
  for (const { route, authorizer } of routes) {
    if (route.unsupported || route.mockCors) continue;
    const slash = route.declaredAt.indexOf('/');
    if (slash < 0) continue;
    const stackName = route.declaredAt.slice(0, slash);
    const logicalId = route.declaredAt.slice(slash + 1);
    const stack = byName.get(stackName);
    const resource = stack?.template.Resources?.[logicalId];
    if (!stack || !resource) continue;
    const props = resource.Properties ?? {};
    const routeLabel = describeRouteForWarning(route);
    const where = `${displayStackName(stackName)}/${displayIdent(logicalId)}`;
    const warnOnce = (field: string, message: string): void => {
      const key = `${route.declaredAt}\0${route.method}\0${route.pathPattern}\0${field}`;
      if (warned.has(key)) return;
      warned.add(key);
      getLogger().warn(message);
    };
    const isRest = resource.Type === 'AWS::ApiGateway::Method';
    const isHttp = resource.Type === 'AWS::ApiGatewayV2::Route';
    if (!isRest && !isHttp) continue;

    const apiKeyRequired = props['ApiKeyRequired'];
    if (
      isRest &&
      apiKeyRequired !== undefined &&
      apiKeyRequired !== false &&
      apiKeyRequired !== 'false'
    ) {
      warnOnce(
        'ApiKeyRequired',
        `${where}: ApiKeyRequired is not enforced by ${cli} start-api (API keys live in the deployed API), ` +
          `so ${routeLabel} is served without an x-api-key check.`
      );
    }
    const scopes = props['AuthorizationScopes'];
    if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 0)) {
      // Enforced on the authorizer kind API Gateway checks them for (#1011).
      const enforcing =
        (isRest && authorizer?.kind === 'cognito') || (isHttp && authorizer?.kind === 'jwt');
      if (!enforcing) {
        warnOnce(
          'AuthorizationScopes',
          `${where}: AuthorizationScopes ${displayIdent(shortJson(scopes))} are not checked by ${cli} start-api ` +
            `(they apply to a ${isRest ? 'COGNITO_USER_POOLS' : 'JWT'} authorizer only), ` +
            `so ${routeLabel} accepts any token its authorizer accepts, whatever its scope claim.`
        );
      } else if (authorizer.scopes?.state === 'unresolved') {
        warnOnce(
          'AuthorizationScopes',
          `${where}: AuthorizationScopes ${displayIdent(shortJson(scopes))} could not be resolved by ${cli} start-api ` +
            `(${authorizer.scopes.reason}), so ${routeLabel} accepts any token its authorizer accepts, whatever its scope claim.`
        );
      }
    }
    if (
      (authorizer?.kind === 'lambda-token' || authorizer?.kind === 'cognito') &&
      authorizer.identityValidation?.state === 'unresolved'
    ) {
      warnOnce(
        'IdentityValidationExpression',
        `${displayStackName(stackName)}/${displayIdent(authorizer.logicalId)}: IdentityValidationExpression could not be applied by ` +
          `${cli} start-api (${authorizer.identityValidation.reason}), so on ${routeLabel} ` +
          (authorizer.kind === 'lambda-token'
            ? 'every token reaches the authorizer Lambda.'
            : "a token's aud claim is not matched against it.")
      );
    }
    if (isRest && route.apiLogicalId) {
      const api = stack.template.Resources?.[route.apiLogicalId];
      if (
        api?.Type === 'AWS::ApiGateway::RestApi' &&
        (api.Properties ?? {})['Policy'] !== undefined
      ) {
        warnOnce(
          'Policy',
          `${displayStackName(stackName)}/${displayIdent(route.apiLogicalId)}: the RestApi resource Policy is not evaluated by ` +
            `${cli} start-api, so ${routeLabel} is served whatever the policy allows or denies.`
        );
      }
    }
  }
}

/**
 * Parse and clamp a TTL value to `[0, max]` with a default fallback.
 * The TTL field is optional — undefined / non-number / negative → default.
 */
function parseTtl(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.trunc(raw), max);
}

/**
 * Stable cache key for a `(authorizer, identity)` pair. Used by
 * {@link AuthorizerCache}; declared here so the resolver and the cache
 * agree on the hash semantics.
 *
 * For TOKEN authorizers the identity-hash is the token itself. For
 * REQUEST authorizers we concatenate every identity-source selector's
 * resolved value with `\u0000` as the separator — control chars cannot
 * appear in HTTP header values so collision-by-substring is impossible.
 */
export function buildIdentityHash(parts: ReadonlyArray<string | undefined>): string {
  return parts.map((p) => p ?? '').join('\u0000');
}

/**
 * Walk every stack and route, attaching an {@link AuthorizerInfo} to each
 * route whose `AuthorizationType` references one. Routes without an
 * authorizer keep `authorizer: undefined`. Routes that reference an
 * intentionally-unsupported authorizer kind (IAM, etc.) hard-fail via
 * {@link RouteDiscoveryError}.
 *
 * **Pure-functional** — does not mutate `routes`. Returns a parallel
 * array of `{route, authorizer}` records that the http-server consumes.
 */
export interface RouteWithAuth {
  route: import('./route-discovery.js').DiscoveredRoute;
  authorizer?: AuthorizerInfo;
}

export function attachAuthorizers(
  stacks: readonly StackInfo[],
  routes: readonly import('./route-discovery.js').DiscoveredRoute[]
): RouteWithAuth[] {
  // Build a per-stack lookup so we don't re-scan stacks per route.
  const stackByRoute = new Map<string, StackInfo>();
  for (const stack of stacks) {
    const prefix = `${stack.stackName}/`;
    for (const route of routes) {
      if (route.declaredAt.startsWith(prefix)) stackByRoute.set(route.declaredAt, stack);
    }
  }

  const out: RouteWithAuth[] = [];
  const errors: string[] = [];

  for (const route of routes) {
    // Skip deferred-error / mockCors routes — neither reaches the
    // authorizer pass at request time (the http-server short-circuits
    // before it). Service-integration routes DO get the authorizer
    // attached (closes #502): the http-server runs the authorizer
    // pass before dispatching to the SDK adapter, so an auth-protected
    // SQS / EventBridge / etc. route rejects unauthenticated requests
    // the same way Lambda routes do.
    if (route.unsupported || route.mockCors) {
      out.push({ route });
      continue;
    }
    const stack = stackByRoute.get(route.declaredAt);
    if (!stack) {
      // This shouldn't happen — every route's declaredAt has a stack
      // prefix — but defensive: pass the route through with no authorizer.
      out.push({ route });
      continue;
    }
    try {
      const authorizer = detectAuthorizer(route, stack);
      out.push({ route, ...(authorizer && { authorizer }) });
    } catch (err) {
      // Authorizer Lambda Arn unresolvable (cross-stack / imported /
      // unsupported intrinsic shape): flip the route to `unsupported`
      // with the resolver's reason instead of aborting boot. Mirrors
      // route-discovery.ts's treatment of an unresolvable
      // `IntegrationUri` so authorizer-protected routes degrade to
      // HTTP 501 + reason at request time rather than blocking every
      // other route on the API (issue #431). The alternative — leave
      // the route normal with no authorizer attached — would silently
      // expose a user-protected route, so we err on the safe side.
      if (err instanceof AuthorizerLambdaUnresolvableError) {
        out.push({
          route: {
            ...route,
            unsupported: {
              reason: `${displayStackName(route.declaredAt)}: authorizer Lambda Arn unresolvable — ${err.reason}`,
            },
          },
        });
        continue;
      }
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    throw new RouteDiscoveryError(
      `${getEmbedConfig().cliName} start-api: ${errors.length} authorizer error(s):\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return out;
}

/**
 * Detect the authorizer (if any) attached to a discovered route.
 * Walks the original CFn resource for the route in `stack.template`.
 */
function detectAuthorizer(
  route: import('./route-discovery.js').DiscoveredRoute,
  stack: StackInfo
): AuthorizerInfo | undefined {
  // declaredAt looks like `<stackName>/<logicalId>` — peel the logical id
  // back out so we can find the originating CFn resource.
  const slash = route.declaredAt.indexOf('/');
  if (slash < 0) return undefined;
  const logicalId = route.declaredAt.slice(slash + 1);
  const resource = stack.template.Resources?.[logicalId];
  if (!resource) return undefined;

  if (resource.Type === 'AWS::ApiGateway::Method') {
    return detectRestV1Authorizer(resource, logicalId, stack);
  }
  if (resource.Type === 'AWS::ApiGatewayV2::Route') {
    return detectHttpApiAuthorizer(resource, logicalId, stack);
  }
  if (resource.Type === 'AWS::Lambda::Url') {
    return detectFunctionUrlAuthorizer(resource, logicalId, stack);
  }
  return undefined;
}

/**
 * Function URL (`AWS::Lambda::Url`) authorizer detection (issue #621).
 *
 * `AuthType: 'AWS_IAM'` uses the same SigV4 mechanism REST v1 ships
 * (PR #447), so we route through the same `IamAuthorizer` descriptor and
 * let the HTTP server's existing `if (authorizer.kind === 'iam')`
 * request-time branch run `verifySigV4`. Like REST v1 AWS_IAM, no IAM
 * policy emulation — signature verification only.
 *
 * `AuthType: 'NONE'` (and any non-AWS_IAM AuthType that
 * `route-discovery.ts` already flipped to `unsupported`) returns
 * `undefined` so the route runs without an authorizer pass.
 */
function detectFunctionUrlAuthorizer(
  urlResource: TemplateResource,
  urlLogicalId: string,
  stack: StackInfo
): AuthorizerInfo | undefined {
  const props = urlResource.Properties ?? {};
  const authType = props['AuthType'];
  if (authType !== 'AWS_IAM') return undefined;
  return {
    kind: 'iam',
    logicalId: 'AWS_IAM',
    declaredAt: `${stack.stackName}/${urlLogicalId}`,
    // OAC-fronted Function URLs are signed by CloudFront in production; the
    // local server never sees that signature, so relax verification rather
    // than denying every request. See `isFunctionUrlOacFronted`.
    ...(isFunctionUrlOacFronted(stack.template, urlLogicalId) && { oacFronted: true }),
  };
}

function detectRestV1Authorizer(
  methodResource: TemplateResource,
  methodLogicalId: string,
  stack: StackInfo
): AuthorizerInfo | undefined {
  const props = methodResource.Properties ?? {};
  const authType = props['AuthorizationType'];
  if (authType === undefined || authType === 'NONE') return undefined;

  // AWS_IAM has no companion `AWS::ApiGateway::Authorizer` resource —
  // the AuthorizationType alone is the signal. SigV4 signatures are
  // verified at request time by `src/local/sigv4-verify.ts` (#447).
  if (authType === 'AWS_IAM') {
    return {
      kind: 'iam',
      logicalId: 'AWS_IAM',
      declaredAt: `${stack.stackName}/${methodLogicalId}`,
    };
  }

  const authorizerId = props['AuthorizerId'];
  const refLogicalId = pickRefLogicalId(authorizerId);

  // CUSTOM / COGNITO_USER_POOLS / etc. all need an AuthorizerId Ref.
  if (!refLogicalId) {
    throw new RouteDiscoveryError(
      `${displayStackName(stack.stackName)}/${displayIdent(methodLogicalId)}: AuthorizationType=${displayIdent(stringifyValue(authType))} but AuthorizerId is missing or not a {Ref:...}.`
    );
  }

  const authorizer = resolveRestV1Authorizer(
    refLogicalId,
    stack.template,
    stack.stackName,
    `${stack.stackName}/${methodLogicalId}`
  );
  // A method's AuthorizationScopes apply to a COGNITO_USER_POOLS authorizer
  // only (#1011); for the others the deployed API ignores them.
  if (authorizer.kind === 'cognito') {
    const scopes = parseScopesSetting(props['AuthorizationScopes'], stack.stackName);
    if (scopes) return { ...authorizer, scopes };
  }
  return authorizer;
}

function detectHttpApiAuthorizer(
  routeResource: TemplateResource,
  routeLogicalId: string,
  stack: StackInfo
): AuthorizerInfo | undefined {
  const props = routeResource.Properties ?? {};
  const authType = props['AuthorizationType'];
  if (authType === undefined || authType === 'NONE') return undefined;

  const authorizerId = props['AuthorizerId'];
  const refLogicalId = pickRefLogicalId(authorizerId);
  if (!refLogicalId) {
    throw new RouteDiscoveryError(
      `${displayStackName(stack.stackName)}/${displayIdent(routeLogicalId)}: AuthorizationType=${displayIdent(stringifyValue(authType))} but AuthorizerId is missing or not a {Ref:...}.`
    );
  }
  return resolveHttpApiAuthorizer(
    refLogicalId,
    props['AuthorizationScopes'],
    stack.template,
    stack.stackName,
    `${stack.stackName}/${routeLogicalId}`
  );
}

function shortJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return stringifyValue(value);
  }
}
