/**
 * cdk-local — public API surface.
 *
 * Hosts embedding `cdk-local` (e.g. cdkd, which injects its own
 * S3-backed `LocalStateProvider` via `extraStateProviders`) consume the
 * four Commander factories below + the supporting types and helpers.
 */

export {
  createLocalInvokeCommand,
  type CreateLocalInvokeCommandOptions,
} from './cli/commands/local-invoke.js';
export {
  createLocalStartApiCommand,
  type CreateLocalStartApiCommandOptions,
} from './cli/commands/local-start-api.js';
export {
  createLocalRunTaskCommand,
  type CreateLocalRunTaskCommandOptions,
} from './cli/commands/local-run-task.js';
export {
  createLocalStartServiceCommand,
  type CreateLocalStartServiceCommandOptions,
} from './cli/commands/local-start-service.js';

export {
  createLocalStateProvider,
  isCfnFlagPresent,
  rejectExplicitCfnStackWithMultipleStacks,
  resolveCfnRegion,
  resolveCfnFallbackRegion,
  resolveCfnStackName,
  LocalStateSourceError,
  type ExtraStateProviders,
  type LocalStateProviderFactory,
  type LocalStateSourceOptions,
} from './cli/commands/local-state-source.js';

export type { CdkLocalEmbedConfig } from './local/embed-config.js';

export type { LocalStateProvider, LocalStateRecord } from './local/local-state-provider.js';
export type { CrossStackResolver, SubstitutionContext } from './local/state-resolver.js';

export {
  CfnLocalStateProvider,
  type CfnLocalStateProviderOptions,
} from './local/cfn-local-state-provider.js';

/**
 * Low-level local-execution building blocks re-exported for hosts that
 * shim cdk-local's `src/local/**` modules verbatim (e.g. cdkd). These
 * are pure, dependency-free helpers — intrinsic resolution, parameter
 * mapping, response translation, and container network inspection —
 * that a host re-exports 1:1 instead of carrying its own byte-identical
 * copy. Exposed only as the consuming host's `import` statements require
 * them.
 */
export { pickRefLogicalId } from './local/intrinsic-utils.js';
export {
  resolveLambdaArnIntrinsic,
  type LambdaArnResolveOutcome,
} from './local/intrinsic-lambda-arn.js';
export {
  resolveServiceIntegrationParameters,
  resolveSelectionExpression,
  type RequestParameterContext,
  type ResolveParametersOutcome,
} from './local/parameter-mapping.js';
export {
  translateLambdaResponse,
  type TranslatedHttpResponse,
} from './local/api-gateway-response.js';
export { getContainerNetworkIp } from './local/docker-inspect.js';

/**
 * `start-api` route-resolution layer, re-exported for hosts that shim
 * cdk-local's `src/local/**` modules verbatim (e.g. cdkd). These turn a
 * synthesized Cloud Assembly into discovered API routes, match an
 * incoming request to a route, and build the API Gateway event shapes —
 * the building blocks the local HTTP server runs on. Exposed only as the
 * consuming host's `import` statements require them.
 */
export {
  discoverRoutes,
  type DiscoveredRoute,
  type RestV1IntegrationConfig,
} from './local/route-discovery.js';
export { matchRoute, type RouteMatchResult } from './local/route-matcher.js';
export {
  buildHttpApiV2Event,
  buildRestV1Event,
  applyAuthorizerOverlay,
  type HttpRequestSnapshot,
  type MatchedRouteContext,
  type AuthorizerEventOverlay,
} from './local/api-gateway-event.js';
export {
  discoverWebSocketApis,
  discoverWebSocketApisOrThrow,
  parseSelectionExpressionPath,
  type DiscoveredWebSocketApi,
  type WebSocketRouteEntry,
} from './local/websocket-route-discovery.js';

/**
 * `start-api` authorizer primitives — the TTL-aware authorizer-result
 * cache, Cognito User Pool / JWT verification, and Lambda (TOKEN / REQUEST)
 * authorizer invocation. Exposed only as the consuming host's `import`
 * statements require them.
 */
export {
  createAuthorizerCache,
  type AuthorizerCache,
  type CachedAuthorizerResult,
} from './local/authorizer-cache.js';
export {
  createJwksCache,
  buildCognitoJwksUrl,
  buildJwksUrlFromIssuer,
  verifyCognitoJwt,
  verifyJwtAuthorizer,
  type JwksCache,
} from './local/cognito-jwt.js';
export {
  buildMethodArn,
  computeRequestIdentityHash,
  evaluateCachedLambdaPolicy,
  invokeRequestAuthorizer,
  invokeTokenAuthorizer,
} from './local/lambda-authorizer.js';
