# Code layout: the per-module walk

Which file under `src/` owns which behavior, plus the invariants a change must
not break. Read before adding, moving or splitting a module.

## `src/cli/`

Commander command factories — `createLocalInvokeCommand`,
`createLocalInvokeAgentCoreCommand`, `createLocalStartApiCommand`,
`createLocalRunTaskCommand`, `createLocalStartServiceCommand`,
`createLocalStartAlbCommand`, `createLocalStartCloudFrontCommand`,
`createLocalStartAgentCoreCommand`, `createLocalListCommand`,
`createLocalStudioCommand` — plus shared option helpers.

- **`start-cloudfront`** bypasses the ECS/Docker `runEcsServiceEmulator` (no
  Cloud Map): synth, resolve one distribution into an in-memory routing model,
  serve in-process. Pure-local for an S3-origin distribution; a Function URL
  origin boots ONE warm RIE container per backing function via
  `createFrontDoorLambdaRunner`, at boot only — NOT rebuilt on reload. Under
  `--from-cfn-stack`, `resolveDeployedS3Origins` promotes a source-less S3 origin
  to a deployed-S3 read-through origin at boot; `annotateDeployedS3Origins`
  re-annotates per `--watch` reload.
- **`start-service` and `start-alb` share one orchestration** in
  `commands/ecs-service-emulator.ts` (synth + shared docker network + Cloud Map +
  restart watcher + optional front-door); each is a thin strategy over it. Do not
  fork it.
- **`start-agentcore`** REUSES single-shot `invoke-agentcore`'s exported boot
  helpers (`resolveAgentCoreImage` / `buildContainerEnv` /
  `resolveInboundAuthorization` / `buildAgentCoreImageContext`), then runs
  `startAgentCoreHttpServer` in front of the warm container.
  `resolveAgentCoreServePlan(protocol)` gives container port (8080 / 8000 /
  9000), forwarded routes, the `/ws`-attach flag (HTTP / AGUI only) and the
  readiness probe (`GET /ping`, or `waitForAgentCoreHttpReady` for MCP / A2A,
  which have none). `--sigv4` shares `resolveAgentCoreSigV4Context` with invoke,
  so both verbs agree.
- **`cdkl studio`** is a CONTROL PLANE, not a second implementation: it spawns
  the same `invoke` / `start-api` / `start-alb` / `start-service` commands as
  children. Exported from `src/index.ts` for host CLIs.
  - Session-global `--from-cfn-stack` / `--assume-role` bind the whole session,
    forwarded verbatim to every child, EDITABLE at run time
    (`PATCH /api/config` -> `applyConfigPatch`) and applying to SUBSEQUENT runs,
    not running serves; the handler logs a change-gated one-liner.
  - `--stack <glob...>` (`filterStudioTargetGroups`) is DISPLAY-only; it does NOT
    scope synth — gate synth with the app's own `-c` context.
  - Boot pin classification marks a deployed-registry-pinned service `pinned`, so
    the UI offers a Dockerfile picker; under `--from-cfn-stack` deployed-state
    context is threaded per owning stack, detecting an INTRINSIC ECR URI.
    Otherwise the service is `pinUnresolved`, rendering an in-UI hint a
    browser-only user sees. **`pinUnresolved` and `pinned` are mutually
    exclusive.** Classification re-runs on a `--from-cfn-stack` change ONLY,
    swapping the target list under the live socket
    (`RunningStudioServer.setTargets`).
  - The target list is not re-synthed; restart studio for new resources.

## `src/synthesis/`

Thin wrapper over `@aws-cdk/toolkit-lib` (`Toolkit.fromCdkApp()` + context-store
threading) returning `StackInfo[]`.

## `src/local/` — runtime layer

Core runtime: docker-runner, container-pool, http-server, websocket-server,
ecs-task-runner, ecs-service-runner, ecs-network, cloud-map-registry,
lambda-resolver, ecs-task-resolver, route-discovery, authorizer-resolver,
lambda-authorizer, cognito-jwt, sigv4-verify, rie-client, intrinsic-image,
runtime-image, target-lister (`cdkl list`), target-picker (TTY selection),
embed-config (host-CLI branding), ssm-parameter-resolver.

- **layer-tree-copy** — `copyLayerTreeLastWins`, the ONE layer-merge copy both
  `invoke` and `start-api` call: an explicit walk recursing only into real
  directories, copying files one at a time, recreating symlinks with their own
  target strings, last layer winning. Its doc comment records why
  `verbatimSymlinks: true` and a recursive `readdirSync` were wrong.
- **`resolveLambdaContainerEnv`** (from `local-invoke.ts`) is the one
  container-env resolver `cdkl invoke` and every front-door Lambda path share.

Per-subsystem invariants for the runtime layer — the `credential-error`
security boundary, AgentCore, the ALB front door, reload classification,
CloudFront and Studio — are in
[.claude/rules/code-layout-local.md](.claude/rules/code-layout-local.md).

## `src/assets/`

Asset manifest loader + docker-build for container Lambdas.

- **Every directory an asset manifest names goes through
  `resolveAssetSourcePath` (`asset-source-path.ts`)**, bounded by the app
  outdir (`assetPathDirs(stack).assetOutdir`, or `outputAssetBound` for a
  `--watch` reader whose base is `--output`), never the manifest directory.
  Its `absolute` mode must match how the reader joins the value (`'fold'` for
  concatenation / `path.join`, `'honour'` for `path.resolve`), and the reader
  must open the RETURNED path, not re-join the raw value (#745).
- `buildDockerImage` refuses an escaping context itself; every caller passes
  `assetOutdir`, or a cdk.Stage image is refused. BuildKit passthroughs only
  WARN (`buildkit-passthrough-warnings.ts`), judging the RENDERED argv
  string — `cacheOptionToFlag` (`docker-cache-option.ts`) is shared with the
  argv builder so the two cannot disagree.

## `src/utils/`

Cross-cutting helpers. The logger prefixes warn / error lines with `WARN:` /
`ERROR:` in compact mode (info stays prefix-less), so severity survives a
stripped-ANSI pipe; `resolveConfiguredLogLevel` + `CdklIoHost` honor
`CDKL_LOG_LEVEL`.

**aws-proxy — two seams, both mandatory.** Neither the AWS SDK nor the global
`fetch` reads `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.

- `buildProxyClientConfig()` — EVERY AWS SDK client construction in `src/**`
  spreads this fragment, directly or via `buildStsClientConfig`. It is `{}` with
  no proxy variable set; otherwise a routing `requestHandler` plus a
  default-chain `credentials` provider whose `clientConfig` threads the handler
  into the SSO / SSOOIDC hops the service client's own handler never reaches.
- `proxyAwareFetch(url)` — the non-SDK seam (the presigned layer-ZIP download,
  the Cognito JWKS / OIDC discovery reads). GET-only. It IS `globalThis.fetch`
  with no proxy set; otherwise it GETs through the same `EnvRoutingProxyAgent`,
  following redirects, decoding a body `node:http` would leave compressed,
  bounding the request, and naming NO URL in any error (a presigned URL carries
  `X-Amz-Signature`). A FRESH agent per redirect hop, or `http-proxy-agent`'s
  absolute-form request-line rewrite inside `connect()` is skipped on a pooled
  keep-alive socket. The bound is a STALL timer (re-armed on response headers and
  every chunk, so a slow but progressing large download is not aborted) rejecting
  DIRECTLY — not `req.setTimeout` (its socket timer arms only once a socket is
  assigned, leaving a proxy that accepts TCP and never answers CONNECT
  unbounded), not `req.destroy(err)` (no `error` with no socket assigned). The
  JWKS / discovery reads pass a SHORTER bound: `agentcore-serve-auth` verifies
  per request with no discovery cache.
- `resolveProxyForTarget` answers two questions per request: `NO_PROXY`, and the
  proxy SCHEME. An `http(s):` proxy is used; anything else (a SOCKS `ALL_PROXY`)
  falls back to a DIRECT connection with a one-time warn naming ONLY the scheme —
  or `(unrecognized)` when the value has no LEADING `scheme://`, or one over 32
  characters. `getProxyForUrl` returns a `user:password@` proxy URL verbatim, so
  the test is "starts with `scheme://`", never "contains `://`", or the warn
  names the USERNAME. Fall back rather than REFUSE, or a SOCKS user with working
  direct egress is broken with nothing left to configure. An UNPARSABLE proxy
  value still THROWS.
- `isLoopbackHost` normalises first: `URL.hostname` KEEPS an IPv6 literal's
  brackets (`http://[::1]/` -> `"[::1]"`), so bare `'::1'` comparisons are dead
  code; it treats the wildcard address as this machine. A target the proxy
  environment does not cover — a `NO_PROXY` match or ANY loopback host — goes back
  to `globalThis.fetch`, keeping undici's semantics. The loopback rule is
  unconditional, deliberately diverging from `EnvRoutingProxyAgent`: a forward
  proxy has no route to the caller's loopback, and an unreachable local-IdP JWKS
  degrades a JWT authorizer to accept EVERY token. Private / RFC 1918 ranges are
  NOT exempted — that stays `NO_PROXY`'s call.
- Fences: `aws-proxy-client-audit.test.ts` (SDK seam, repo-wide),
  `aws-proxy-fetch-audit.test.ts` (fetch seam, FAILS CLOSED on a bare `fetch(`
  call and a `globalThis.fetch` reference — each must be proxy-aware or carry
  `// proxy-audit: ignore: <reason>`), `loopback-predicate-agreement.test.ts`
  (against `studio-proxy`'s predicate, which cannot share a module). Reasoned
  exemptions: the loopback container clients and the emulated data path
  (`rest-v1-integrations` forwarding to the user's own backend). Known bound: an
  ALIASED binding (`options.fetchImpl ?? fetch`) is NOT in the population.
  `buildProxyClientConfig` and the credential-error helpers are re-exported from
  `src/internal.ts`; `proxyAwareFetch` is NOT.

## `src/types/`

Shared interfaces (`StackState`, `ResourceState`, `CloudFormationTemplate`),
shaped as a strict SUBSET of cdkd's state schema so host-side state flows into
cdk-local unchanged.

## `tests/integration/local-*`

Per-fixture real-Docker E2E tests (`verify.sh` runs the CLI against a
deployed-style fixture). cdk-local itself does not invoke AWS; fixtures needing
`--from-cfn-stack` deploy via the upstream `cdk` CLI.

A `verify.sh` NEVER reads the CLI with `V=$(cmd 2>/dev/null | tail -1)`: under
`set -euo pipefail` a non-zero exit aborts AT the assignment with stderr already
gone. Use the `capture` helper, byte-identical to `CANONICAL_CAPTURE` in
`tests/unit/integ-verify-capture-shape.test.ts` (which fences the shape
tree-wide; its stderr file is trap-held because `local-invoke` asserts on it): on
a non-zero exit it logs the status, the last stdout line and the stderr tail and
emits NOTHING, so a good-looking response never passes a failed invoke.
