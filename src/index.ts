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
  createLocalListCommand,
  formatTargetListing,
  type CreateLocalListCommandOptions,
  type FormatTargetListingOptions,
} from './cli/commands/local-list.js';

/**
 * Target enumeration — turns a synthesized Cloud Assembly into the
 * runnable targets each `cdkl` command accepts, grouped by command.
 * Backs `cdkl list` and is reusable for interactive target pickers.
 */
export {
  listTargets,
  countTargets,
  type TargetEntry,
  type TargetListing,
} from './local/target-lister.js';

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
/**
 * Embed-config setter / getter / reset. A host that does NOT use cdk-local's
 * Commander factories (which install the config themselves) but DOES re-export
 * cdk-local's leaf modules as shims must call `setEmbedConfig(...)` once at
 * startup so those bundled modules render the host's branding (`cliName` /
 * `resourceNamePrefix` / etc.) instead of cdk-local's `cdkl` defaults.
 * `getEmbedConfig` reads the resolved config; `resetEmbedConfig` restores the
 * defaults (test isolation).
 */
export { getEmbedConfig, resetEmbedConfig, setEmbedConfig } from './local/embed-config.js';

export type { LocalStateProvider, LocalStateRecord } from './local/local-state-provider.js';
export {
  substituteAgainstState,
  substituteAgainstStateAsync,
  substituteEnvVarsFromState,
  substituteEnvVarsFromStateAsync,
  type CrossStackResolver,
  type SubstitutionContext,
  type StateEnvSubstitutionAudit,
  type PseudoParameters,
} from './local/state-resolver.js';

export {
  CfnLocalStateProvider,
  type CfnLocalStateProviderOptions,
} from './local/cfn-local-state-provider.js';

export {
  collectSsmParameterRefs,
  resolveSsmParameters,
  type SsmParameterRef,
} from './local/ssm-parameter-resolver.js';

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

/**
 * `invoke` / `start-api` Lambda env-var resolution — merges template-literal
 * env vars with SAM-shape `--env-vars` overrides (intrinsic-valued entries
 * warn-and-drop unless `--from-*` substituted them upstream). Exposed only as
 * the consuming host's `import` statements require them.
 */
export { resolveEnvVars, type EnvOverrideFile } from './local/env-resolver.js';

/**
 * `start-api` per-API Stage selection — builds the stage map and attaches
 * stage context (populating `event.stageVariables`) to discovered routes.
 */
export { attachStageContext, buildStageMap, type ResolvedStage } from './local/stage-resolver.js';

/**
 * `start-service` in-process Cloud Map service registry — peers reach each
 * other by IP / network alias on the shared service network without docker
 * `network connect` choreography. `RegistrationHandle` is the handle returned
 * by `register()` for symmetric unregister; a still-local host sibling (e.g.
 * the service runner) imports it as a type alongside the class.
 */
export { CloudMapRegistry, type RegistrationHandle } from './local/cloud-map-registry.js';

/**
 * `invoke` / `start-api` Lambda runtime → ECR base-image + source-file
 * extension + in-container code-mount-path resolution. Exposed only as the
 * consuming host's `import` statements require them (the host's runtime-image
 * shim re-exports exactly these three).
 */
export {
  resolveRuntimeCodeMountPath,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
} from './local/runtime-image.js';

/**
 * `start-api` WebSocket API event-shape builders — synthesize the
 * `$connect` / `$disconnect` / message Lambda event payloads for a local
 * WebSocket handshake.
 */
export {
  buildConnectEvent,
  buildDisconnectEvent,
  buildMessageEvent,
  type WebSocketHandshakeSnapshot,
  type WebSocketLambdaEvent,
} from './local/websocket-event.js';

/**
 * `start-api` WebSocket `@connections` management API — in-process
 * connection registry + the local management-endpoint HTTP handler
 * (POST / GET / DELETE `/@connections/{connectionId}`).
 */
export {
  ConnectionRegistry,
  type ConnectionRegistryEntry,
  buildMgmtEndpointEnvUrl,
  handleConnectionsRequest,
  parseConnectionsPath,
} from './local/websocket-mgmt-api.js';

/**
 * `start-api` WebSocket frame-body codec — converts a ws-emitted message
 * buffer into the AWS-canonical `{ body, isBase64Encoded }` shape (text
 * frames pass through as UTF-8, binary frames are base64-encoded). Exposed
 * only as the consuming host's `import` statements require it.
 */
export { bufferToBody } from './local/websocket-body.js';

/**
 * `start-api` Docker host-gateway version probe — gates the
 * `--add-host=...:host-gateway` mapping WebSocket Lambda containers need to
 * reach the host server on Linux native dockerd. Exposed only as the
 * consuming host's `import` statements require them.
 */
export { HOST_GATEWAY_MIN_VERSION, probeHostGatewaySupport } from './local/docker-version.js';

/**
 * `start-api` API-server grouping — splits a flat discovered-route list into
 * one group per local HTTP server (one per RestApi / HTTP API / Function URL),
 * filters the route list to a single API (`filterRoutesByApiIdentifier`) or to
 * the UNION of several identifiers (`filterRoutesByApiIdentifiers`, the
 * variadic `start-api <target...>` subset shape). Exposed only as the
 * consuming host's `import` statements require them.
 */
export {
  availableApiIdentifiers,
  filterRoutesByApiIdentifier,
  filterRoutesByApiIdentifiers,
  groupRoutesByServer,
  type ApiServerGroup,
} from './local/api-server-grouping.js';

/**
 * `start-api` target-subset resolver — the pure core behind the variadic
 * `start-api <target...>` path. Filters routes to the union of the supplied
 * identifiers (throwing on a bare logical id in a multi-stack app or an empty
 * union) and reports the identifiers that matched nothing for one-shot
 * "ignored" warnings. Exposed for host CLIs that drive the subset selection
 * themselves.
 */
export { resolveApiTargetSubset, type ApiTargetSubset } from './cli/commands/local-start-api.js';

/**
 * `invoke` / `start-api` literal-ARN Lambda Layer materializer — downloads a
 * layer version's ZIP (optionally via an assumed role), unzips it to a host
 * tmpdir, and returns the path for `/opt` bind-mounting alongside same-stack
 * layers. Exposed only as the consuming host's `import` statement requires it.
 */
export { materializeLayerFromArn } from './local/layer-arn-materializer.js';

/**
 * `start-api` CORS handling — parses CFn `CorsConfiguration` (and the CloudFront
 * distribution chain) into a per-API CORS config and answers OPTIONS preflight
 * for HTTP API v2. `isFunctionUrlOacFronted` reports whether a Function URL is
 * fronted by a CloudFront Origin Access Control distribution (the AWS_IAM
 * authorizer relaxes SigV4 verification for such routes). Exposed only as the
 * consuming host's `import` statements require them.
 */
export {
  applyCorsResponseHeaders,
  buildCorsConfigByApiId,
  buildCorsConfigFromCloudFrontChain,
  isFunctionUrlOacFronted,
  matchPreflight,
  type CorsConfig,
} from './local/cors-handler.js';

/**
 * `invoke` / `start-api` / `run-task` container-image intrinsic resolver —
 * resolves the canonical CDK 2.x `Fn::Join` shape for ECR image URIs
 * (`lambda.DockerImageCode.fromEcr` / ECS `ContainerImage.fromEcrRepository`)
 * and the same-stack ECR `Fn::GetAtt` Arn / RepositoryUri synthesis. Exposed
 * only as the consuming host's `import` statements require them.
 */
export {
  derivePseudoParametersFromRegion,
  substituteImagePlaceholders,
  tryResolveImageFnJoin,
  type ImageResolutionContext,
} from './local/intrinsic-image.js';

/**
 * `start-api` local HTTP server — boots the per-API Node HTTP(S) server that
 * routes requests to Lambda / VTL integrations, and reads the optional mTLS
 * client-cert materials off disk. `ServerState` / `StartedApiServer` /
 * `MtlsServerConfig` are the server-lifecycle types. Exposed only as the
 * consuming host's `import` statements require them.
 */
export {
  startApiServer,
  readMtlsMaterialsFromDisk,
  type ServerState,
  type StartedApiServer,
  type MtlsServerConfig,
} from './local/http-server.js';

/**
 * `start-api` authorizer wiring — attaches the discovered authorizers (Lambda
 * TOKEN / REQUEST, Cognito JWT, AWS_IAM SigV4) to the route list. `AuthorizerInfo`
 * is the per-route resolved-authorizer descriptor; `RouteWithAuth` is a route
 * paired with its authorizer. Exposed only as the consuming host's `import`
 * statements require them.
 */
export {
  attachAuthorizers,
  type AuthorizerInfo,
  type RouteWithAuth,
} from './local/authorizer-resolver.js';

/**
 * `start-api` AWS_IAM SigV4 verification — the default local-credential loader
 * the verifier reproduces signing keys from. `CredentialsLoader` is the loader
 * factory signature a host can override. Exposed only as the consuming host's
 * `import` statements require them.
 */
export { defaultCredentialsLoader, type CredentialsLoader } from './local/sigv4-verify.js';

/**
 * `start-service` Cloud Map service-discovery index — parses the
 * `AWS::ServiceDiscovery::PrivateDnsNamespace` / `::Service` resources in a
 * synthesized stack into the namespace / service lookup maps the local ECS
 * service runner resolves peers against. Exposed only as the consuming host's
 * `import` statements require them.
 */
export { buildCloudMapIndex, type CloudMapIndex } from './local/cloud-map-resolver.js';

/**
 * `run-task` / `start-service` ECS target-resolution error. Exposed so a
 * consuming host that shims `cloud-map-resolver` (which throws it) can re-export
 * the SAME class identity from its still-local ECS engine modules — otherwise a
 * host-side `instanceof` / `toThrow(EcsTaskResolutionError)` against the shimmed
 * resolver's throw would compare two distinct class objects and fail.
 */
export { EcsTaskResolutionError } from './local/ecs-task-resolver.js';

/**
 * `start-api` REST API v1 `IntegrationResponses[]` selection — picks the
 * matching integration response by `SelectionPattern` regex, evaluates
 * `ResponseParameters` header mappings, and selects the response template by
 * `Accept`. Exposed only as the consuming host's `import` statements require
 * them.
 */
export {
  evaluateResponseParameters,
  pickResponseTemplate,
  selectIntegrationResponse,
  tryParseStatus,
  type IntegrationResponseEntry,
} from './local/integration-response-selector.js';

/**
 * `start-api` VTL evaluation error. Exposed so a consuming host that shims
 * `integration-response-selector` (which throws it) can re-export the SAME
 * class identity from its still-local `vtl-engine` — otherwise a host-side
 * `instanceof VtlEvaluationError` (e.g. the REST v1 dispatcher's catch) against
 * the shimmed selector's throw would compare two distinct class objects and
 * fail.
 */
export { VtlEvaluationError } from './local/vtl-engine.js';
