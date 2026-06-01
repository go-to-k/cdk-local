/**
 * cdk-local — unstable internal surface (`cdk-local/internal`).
 *
 * Low-level local-execution building blocks re-exported for hosts that
 * shim cdk-local's `src/local/**` modules verbatim (e.g. cdkd). These
 * are pure, dependency-free helpers — intrinsic resolution, parameter
 * mapping, response translation, and container network inspection —
 * that a host re-exports 1:1 instead of carrying its own byte-identical
 * copy. Exposed only as the consuming host's `import` statements require
 * them.
 *
 * NO SEMVER GUARANTEE. These symbols are implementation detail of the
 * `cdkl` CLI and may change or be removed without a major version bump.
 * The stable, semver-covered public API lives at the `cdk-local` main
 * entry (`src/index.ts`); import from there unless you are a shim host.
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
  verifyJwtViaDiscovery,
  type JwksCache,
  type DiscoveryJwtAuthorizer,
  type JwtCustomClaim,
  type WarnedAt,
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
  formatStateRemedy,
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
 * `invoke-agentcore` Bedrock AgentCore Runtime resolution + protocol clients.
 * `resolveAgentCoreTarget` maps a target argument to a runnable container
 * runtime; `waitForAgentCorePing` / `invokeAgentCore` speak the HTTP
 * `GET /ping` + `POST /invocations` contract; `mcpInvokeOnce` speaks the MCP
 * Streamable-HTTP `POST /mcp` contract. Exposed only as the consuming host's
 * `import` statements require them.
 */
export {
  resolveAgentCoreTarget,
  pickAgentCoreCandidateStack,
  AgentCoreResolutionError,
  AGENTCORE_RUNTIME_TYPE,
  AGENTCORE_HTTP_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_AGUI_PROTOCOL,
  type ResolvedAgentCoreRuntime,
  type AgentCoreJwtAuthorizer,
  type AgentCoreCustomClaim,
  type AgentCoreCodeArtifact,
} from './local/agentcore-resolver.js';
export {
  buildAgentCoreCodeImage,
  renderCodeDockerfile,
  toCmdArgv,
  computeCodeImageTag,
  SUPPORTED_CODE_RUNTIMES,
  type BuildAgentCoreCodeImageOptions,
} from './local/agentcore-code-build.js';
export {
  waitForAgentCorePing,
  invokeAgentCore,
  AGENTCORE_SESSION_ID_HEADER,
  type AgentCoreInvokeResult,
  type InvokeAgentCoreOptions,
} from './local/agentcore-client.js';
export {
  mcpInvokeOnce,
  parseSseForJsonRpc,
  MCP_CONTAINER_PORT,
  MCP_PATH,
  MCP_PROTOCOL_VERSION,
  type McpInvokeResult,
  type McpInvokeOptions,
  type McpJsonRpcRequest,
} from './local/agentcore-mcp-client.js';
export {
  invokeAgentCoreWs,
  type InvokeAgentCoreWsOptions,
  type AgentCoreWsResult,
} from './local/agentcore-ws-client.js';
export {
  a2aInvokeOnce,
  A2A_CONTAINER_PORT,
  A2A_PATH,
  type A2aInvokeResult,
  type A2aInvokeOptions,
  type A2aJsonRpcRequest,
} from './local/agentcore-a2a-client.js';
export {
  downloadAndExtractS3Bundle,
  type S3BundleLocation,
  type S3BundleCredentials,
  type DownloadS3BundleOptions,
  type ExtractedS3Bundle,
} from './local/agentcore-s3-bundle.js';
export {
  signAgentCoreInvocation,
  AGENTCORE_SIGV4_SERVICE,
  type SigV4Credentials,
  type SignAgentCoreInvocationOptions,
  type SignedAgentCoreHeaders,
} from './local/agentcore-sigv4-sign.js';

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

/**
 * `invoke` local container-Lambda build — `buildContainerImage` builds a
 * `DockerImageCode.fromImageAsset` Lambda image locally (via the shared docker
 * build helper) and `architectureToPlatform` maps the Lambda architecture to a
 * `--platform` value. Exposed only as the consuming host's `import` statements
 * require them.
 */
export {
  buildContainerImage,
  architectureToPlatform,
  type BuildContainerImageOptions,
} from './local/docker-image-builder.js';

/**
 * `invoke` local container-Lambda build error. Exposed so a consuming host that
 * shims `docker-image-builder` can catch it at the shim boundary and re-throw
 * its OWN error class — the host's error base differs
 * from cdk-local's `CdkLocalError`, so the host's top-level error handler /
 * `instanceof` checks need the host's class identity, which a boundary
 * translation in the shim provides.
 */
export { LocalInvokeBuildError } from './utils/error-handler.js';

/**
 * `start-api --watch` source-tree file watcher + the watch-target predicates
 * and `cdk.json` `watch` config resolution. `createFileWatcher` debounces
 * chokidar events; `createWatchPredicates` derives the watch root + the
 * `ignored` / `shouldTrigger` filters that exclude `cdk.out` / `node_modules` /
 * `.git` and honor `cdk.json` `watch.include` / `watch.exclude`;
 * `resolveWatchConfig` reads that block from the cwd's `cdk.json`. Exposed so a
 * consuming host whose `start-api` command adopts the watch-source model can
 * wire its watcher to the app SOURCE tree (re-synth on edit) the same way.
 */
export {
  createFileWatcher,
  type FileWatcher,
  type FileWatcherOptions,
} from './local/file-watcher.js';

/**
 * Phase 4 of issue #214 — `cdkl start-service --watch` / `cdkl start-alb
 * --watch` source-change classifier. Takes the chokidar-reported set of
 * paths that fired in one debounce window plus a per-target asset
 * context (post-synth asset hash + staged source directory + Dockerfile
 * basename) and returns a verdict the rolling-reload pathway dispatches
 * on: `'rebuild'` runs the Phase 2/3 shadow-boot rolling primitive,
 * `'soft-reload'` runs the Phase 4 `docker cp` + `docker restart`
 * bind-mount fast path. Defaults to `'rebuild'` on any ambiguity —
 * slow-but-correct is strictly better than fast-but-stale. Pure +
 * synchronous; exposed so a consuming host that wraps the engine can
 * re-use the same classification rules instead of re-implementing them.
 */
export {
  classifySourceChange,
  type ReloadAssetContext,
  type ReloadVerdict,
} from './local/source-change-classifier.js';

/**
 * Phase 4 of issue #214 — completion-log suffix the soft-reload
 * primitive emits after the per-replica `Soft-reloaded replica r<i>
 * (gen <g>): ` prefix. Exposed so host CLIs (cdkd) that wrap
 * `runEcsServiceEmulator` and own their own integ scripts can grep
 * against the canonical constant instead of hand-copying the
 * wording. A future re-wording of the runner's emit stays detectable
 * via the symbol import.
 */
export { SOFT_RELOAD_COMPLETION_LOG_SUFFIX } from './local/ecs-service-runner.js';

/**
 * Issue #265 — shadow-replica TCP-ready probe budget for the
 * `--watch` rolling primitive. Host CLIs (cdkd) that wrap
 * `runEcsServiceEmulator` and expose their own `--shadow-ready-timeout`
 * flag / `${envPrefix}_SHADOW_READY_TIMEOUT_MS` env var resolve
 * precedence locally and then call {@link setShadowReadyTimeoutMs}
 * to stamp the value onto the runner before booting. The
 * {@link DEFAULT_SHADOW_READY_TIMEOUT_MS} constant is the canonical
 * fallback when neither flag nor env is supplied.
 */
export {
  DEFAULT_SHADOW_READY_TIMEOUT_MS,
  setShadowReadyTimeoutMs,
} from './local/ecs-service-runner.js';
export { createWatchPredicates, type WatchPredicates } from './cli/commands/local-start-api.js';

/**
 * Issue #234 — per-target image-kind classifier the
 * `cdkl start-service --watch` / `cdkl start-alb --watch` reload
 * pathway consults to detect "the deployed image is pinned to a
 * registry, so a local source edit can't possibly take effect"
 * upfront (boot-time WARN) and to skip a no-op rolling primitive on
 * each reload firing. Host CLIs (cdkd) that wrap
 * `runEcsServiceEmulator` reuse the same helpers so their `--watch`
 * UX matches cdk-local's instead of silently inheriting the
 * "Reload complete." disguised-no-op symptom.
 */
export {
  isLocalCdkAssetImage,
  describePinnedImageUri,
  listPinnedTargets,
  type PinnedTargetEntry,
} from './local/image-pin-detector.js';
export { resolveWatchConfig, type CdkWatchConfig } from './cli/config-loader.js';

/**
 * Target picker — interactive `clack`-backed selector for an omitted positional
 * target. `resolveSingleTarget` returns the user-provided value as-is, prompts
 * in a TTY when omitted, or calls `onMissing()` (the command's required-arg
 * error) when no TTY is available. Exposed for hosts that own their command
 * tree but want cdk-local's picker UX for missing targets — e.g. cdkd's
 * `local-invoke-agentcore` port.
 */
export { resolveSingleTarget } from './local/target-picker.js';

/**
 * `start-service` + `start-alb` shared ECS service emulator engine — the
 * core orchestrator that boots ECS replicas on docker, attaches the per-stack
 * Cloud Map / Service Connect overlay, optionally fronts the replicas with
 * the local ALB front-door HTTP(S) server (`--alb-listener`), and tears
 * down on SIGINT. `runEcsServiceEmulator` is the entry point both CLI
 * commands wrap. `addCommonEcsServiceOptions` is the shared option-block
 * factory both commands compose. `parseMaxTasks` / `parseRestartPolicy`
 * are the option-parser helpers. `resolveSharedSidecarCredentials` and
 * `buildEcsImageResolutionContext` are pre-boot helpers exposed for hosts
 * that wrap the engine for their own test setup. `MAX_TASKS_SUBNET_RANGE_CAP`
 * documents the per-network replica cap. The `Planned*` / `ServiceBoot`
 * / `EmulatorStrategy` / `FrontDoorPlan` types describe the engine's
 * pre-boot plan + strategy hook surface for shim hosts (e.g. cdkd) that
 * port the CLI commands themselves but reuse the engine. Exposed only as
 * the consuming host's `import` statements require them.
 */
export {
  addCommonEcsServiceOptions,
  addImageOverrideOptions,
  runEcsServiceEmulator,
  parseMaxTasks,
  parseRestartPolicy,
  resolveSharedSidecarCredentials,
  buildEcsImageResolutionContext,
  MAX_TASKS_SUBNET_RANGE_CAP,
  type EcsServiceEmulatorOptions,
  type EmulatorStrategy,
  type ServiceBoot,
  type FrontDoorPlan,
  type PlannedAction,
  type PlannedForwardAction,
  type PlannedRedirectAction,
  type PlannedFixedResponseAction,
  type PlannedForwardTarget,
  type PlannedEcsForwardTarget,
  type PlannedLambdaForwardTarget,
  type PlannedFrontDoorListener,
} from './cli/commands/ecs-service-emulator.js';

/**
 * Issue #238 / #240 — `cdkl start-service` / `cdkl start-alb`
 * `--image-override` family engine. `parseImageOverrideFlags` is the
 * pure flag parser; `resolveImageOverrides` walks the picker + boot
 * prompt against the pinned target set; `runImageOverrideBuilds`
 * runs the `docker build` pass per covered Dockerfile and returns
 * the deterministic local tag per target. `buildImageOverrideTag` is
 * exposed so a host CLI can reproduce the same tag-naming convention
 * if it wraps the engine for a custom build orchestration.
 *
 * Issue #240 additions: `enforceImageOverrideOrphans` is the
 * orphan-validation pass that fires after Stage 3 (boot prompt) — a
 * per-service flag (`<svc>:KEY=VAL` etc.) naming a service the
 * resolved override map does NOT cover throws `LocalStartServiceError`.
 * `mergeForService` produces the effective build inputs for one
 * service target by layering its per-service overlay on top of the
 * globals (per-service wins on key collision); host CLIs reuse it
 * when they bypass `resolveImageOverrides` and assemble entries
 * directly. `PerServiceBuildInputs` is the per-service overlay type
 * referenced from `RawImageOverrideFlags.perService`.
 *
 * Re-exported via `cdk-local/internal` so host CLIs (e.g. cdkd)
 * inherit the same override pipeline without a byte-identical copy.
 */
export {
  parseImageOverrideFlags,
  resolveImageOverrides,
  runImageOverrideBuilds,
  buildImageOverrideTag,
  enforceImageOverrideOrphans,
  mergeForService,
  ImageOverrideError,
  type ImageOverrideEntry,
  type ImageOverrideMap,
  type ImageOverrideGlobals,
  type PerServiceBuildInputs,
  type RawImageOverrideFlags,
} from './local/image-override-engine.js';

/**
 * `start-alb` front-door target resolver — maps an ALB target string to a
 * `ResolvedFrontDoor` (listener-by-listener forwarded targets, listener-rule
 * conditions, redirect / fixed-response actions, plus `default_action`).
 * `resolveAlbFrontDoor` is the entry point; `isApplicationLoadBalancer`
 * is the type-narrowing predicate the resolver uses for ApplicationLoadBalancer
 * vs NetworkLoadBalancer disambiguation. Exposed only as the consuming
 * host's `import` statements require them.
 */
export {
  resolveAlbFrontDoor,
  isApplicationLoadBalancer,
  type ResolvedListenerAction,
  type FrontDoorForwardTarget,
} from './local/elb-front-door-resolver.js';

/**
 * `start-alb` ALB-specific option block + strategy entry points. The flags
 * `addAlbSpecificOptions` registers (`--lb-port`, `--tls`, `--tls-cert`,
 * `--tls-key`, `--no-verify-auth`, `--bearer-token`, `--watch`) are the
 * ones that only apply to an ALB-fronted local emulator and sit on top of
 * {@link addCommonEcsServiceOptions}. Sharing the block keeps host CLIs
 * (e.g. cdkd's `local start-alb`) auto-inheriting any new ALB-only flag the
 * upstream cdk-local CLI adds — no manual `.addOption(...)` duplication.
 * `albStrategy` / `resolveAlbTarget` / `parseLbPortOverrides` are the
 * matching strategy + target-resolution helpers a host wrapping
 * `runEcsServiceEmulator` calls directly.
 */
export {
  addAlbSpecificOptions,
  albStrategy,
  resolveAlbTarget,
  parseLbPortOverrides,
} from './cli/commands/local-start-alb.js';

/**
 * Per-command "specific" option blocks for the remaining `cdkl` commands —
 * extracted so host CLIs (e.g. cdkd) that wrap the same factories can
 * compose `add<Cmd>SpecificOptions(cmd)` and auto-inherit every new
 * per-command flag the upstream cdk-local CLI adds, without a manual
 * `.addOption(...)` duplication on the host side. Each helper sits ON TOP
 * of the shared `commonOptions` / `appOptions` / `contextOptions` /
 * `regionOption` block (which the matching `create<Cmd>Command`
 * factory still composes around the helper). Mirrors the shape of
 * {@link addAlbSpecificOptions}.
 *
 * `addListSpecificOptions` is intentionally minimal (only `-l, --long`) so
 * the surface-contract test pattern (helper + common == factory output)
 * is uniform across every command, even when the per-command block is a
 * single flag.
 */
/**
 * `run-task` / `start-service` / `start-alb` per-container `docker logs
 * -f` streamer — pipes a docker container's stdout / stderr to the host
 * `process.stdout` / `process.stderr` with a caller-supplied line prefix
 * and returns a stop function for the caller's `finally`. Exposed for
 * host CLIs (e.g. cdkd) whose still-local task / service runners attach
 * the same foreground log surface — they import this helper instead of
 * carrying a byte-identical copy.
 */
export { attachContainerLogStreamer } from './local/container-log-streamer.js';

export { addListSpecificOptions } from './cli/commands/local-list.js';
export { addRunTaskSpecificOptions } from './cli/commands/local-run-task.js';
export { addInvokeSpecificOptions } from './cli/commands/local-invoke.js';
export { addInvokeAgentCoreSpecificOptions } from './cli/commands/local-invoke-agentcore.js';
export { addStartApiSpecificOptions } from './cli/commands/local-start-api.js';
export {
  addStartServiceSpecificOptions,
  serviceStrategy,
} from './cli/commands/local-start-service.js';

/**
 * Shared `--profile` plumbing helpers (issue #245). Every STS-touching
 * call site across `cdkl` commands now goes through these two helpers
 * so a host CLI (e.g. cdkd) wrapping the same factories inherits the
 * same `--profile` precedence — both for credentials AND region —
 * without having to re-implement it. `resolveProfileCredentials`
 * returns the credential triple + the profile's configured region;
 * `buildStsClientConfig` returns the `STSClient` constructor config
 * that omits empty `region` / `profile` fields, matching the inline
 * `{ ...(region && { region }) }` shape callers used to write by hand.
 */
export { resolveProfileCredentials, buildStsClientConfig } from './utils/profile-resolver.js';
