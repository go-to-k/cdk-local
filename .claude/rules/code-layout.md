# Code layout: the per-module walk

The directory-by-directory walk behind CLAUDE.md's "Architecture" section —
which file owns which behavior, with the issue history behind each decision.
Read this before adding, moving, or splitting a module under `src/`.
(Auto-referenced from `.claude/CLAUDE.md` → "Architecture".)

`src/` layout:

- `src/cli/` — Commander command factories (`createLocalInvokeCommand`,
  `createLocalInvokeAgentCoreCommand`, `createLocalStartApiCommand`,
  `createLocalRunTaskCommand`, `createLocalStartServiceCommand`,
  `createLocalStartAlbCommand`, `createLocalStartCloudFrontCommand`,
  `createLocalStartAgentCoreCommand`,
  `createLocalListCommand`,
  `createLocalStudioCommand`) + shared option
  helpers. `createLocalStartCloudFrontCommand` (`cdkl start-cloudfront`,
  issue go-to-k/cdk-local#363) is a thin, lean command (NOT through the ECS/Docker
  `runEcsServiceEmulator` — no Cloud Map): it synths, resolves one
  `AWS::CloudFront::Distribution` to an in-memory routing model, and
  serves its viewer-request -> origin -> viewer-response pipeline
  in-process. It is pure-local (no Docker) for an S3-origin
  distribution; a Lambda Function URL origin (issue go-to-k/cdk-local#376) boots one warm
  RIE container per backing function via `createFrontDoorLambdaRunner`
  (stopped on shutdown, boot-time only — not rebuilt on reload), with the
  container env resolved by the shared `resolveLambdaContainerEnv`
  (extracted from `local-invoke.ts` so `cdkl invoke` and the front-door
  Lambda path agree — issue go-to-k/cdk-local#380): `--from-cfn-stack [name]` /
  `--assume-role [arn]` / `--stack-region` give the Function URL Lambda the
  same env-var + deployed-state + execution-role injection as a direct
  `cdkl invoke`. `--watch`
  re-synths + swaps the routing model under the live socket; `--tls`
  reuses `front-door-tls`; `--from-cfn-stack` additionally promotes an S3
  origin with no local BucketDeployment source to a deployed-S3
  read-through origin served from real S3 on demand (issue go-to-k/cdk-local#405 —
  `resolveDeployedS3Origins` resolves the bucket name (state physical id /
  literal `DomainName` / `GetDistributionConfig`) +
  builds an `S3OriginReader` per origin, boot-time only, re-annotated on
  each `--watch` reload via `annotateDeployedS3Origins`; `--cache-origin`
  opts the reader into an in-memory read-through cache, cleared on reload);
  `--origin
  <id>=<dir>` is the local-directory escape hatch when neither resolves;
  `--no-pull` skips the Lambda
  origin image pull; `--kvs-file <key>=<file>` backs a CloudFront
  Function's KeyValueStore reads with a local JSON map (issue go-to-k/cdk-local#399; the
  `<key>` accepts the KeyValueStore logical id, construct path, or bare
  construct id — `normalizeKvsFileKeys` resolves it to the logical id, issue
  go-to-k/cdk-local#465; the deployed-store alternative is `--from-cfn-stack`).
  `start-service` and `start-alb` share one neutral orchestration
  in `commands/ecs-service-emulator.ts` (synth + shared docker network +
  Cloud Map + restart watcher + optional front-door); each command is a
  thin strategy over it (service targets vs ALB targets).
  `createLocalStartAgentCoreCommand` (`cdkl start-agentcore`)
  is the long-running serve counterpart of the single-shot
  `createLocalInvokeAgentCoreCommand`: it reuses that command's exported
  boot helpers (`resolveAgentCoreImage` / `buildContainerEnv` /
  `resolveInboundAuthorization` / `buildAgentCoreImageContext`) to boot the
  agent container once, then runs `startAgentCoreHttpServer` (a host HTTP
  server, issue go-to-k/cdk-local#454) in front of the warm container: it proxies the
  protocol's routes to the container (streaming request / response, SSE
  included) and, for HTTP / AGUI, delegates the `/ws` upgrade on the SAME
  port to the existing bridge (`attachAgentCoreWsBridge`, extracted from
  `startAgentCoreWsBridge`) so a header-less browser client can still hold
  an interactive session. All four protocols are served (slice 2):
  `resolveAgentCoreServePlan(protocol)` maps the runtime protocol to its warm
  serve plan — the published container port (8080 / 8000 / 9000), the
  forwarded routes (`POST /invocations` + `GET /ping` / `POST /mcp` /
  `POST /`), the `/ws`-attach flag (HTTP / AGUI only), and the readiness
  probe (`GET /ping` for HTTP / AGUI, an HTTP-response probe via
  `waitForAgentCoreHttpReady` for MCP / A2A, which have no `/ping`). Inbound
  auth is per-request (slice 4a): when the runtime declares a
  `customJwtAuthorizer` the boot wires a per-request `authCheck`
  (`buildAgentCoreServeAuthCheck`, the serve counterpart of `front-door-auth`'s
  ALB `AuthCheck`) into the HTTP server; `--sigv4` (no authorizer) wires a
  per-request `signRequest` that signs the buffered POST body via the shared
  `resolveAgentCoreSigV4Context` (extracted from invoke's
  `buildSigV4HeadersIfRequested` so both verbs resolve creds + region
  identically). New CLI
  options live in `addStartAgentCoreSpecificOptions` (`--port` / `--host` /
  `--session-id` / `--bearer-token` / `--no-verify-auth` / `--sigv4` /
  `--env-vars` / `--platform` / `--from-cfn-stack` / `--assume-role` / ...).
  `createLocalStudioCommand` (`cdkl studio`, issue go-to-k/cdk-local#282) is the
  interactive web console over the same target enumeration — a control
  plane that spawns the SAME `invoke` / `start-api` / `start-alb` /
  `start-service` runners as child processes. It is on the user-facing
  command surface (the unveil slice removed the `CDKL_STUDIO_PREVIEW`
  gate) and exported from `src/index.ts` for host CLIs. Issue go-to-k/cdk-local#301
  slice 1 added the session-global `--from-cfn-stack [name]` /
  `--assume-role <arn>` flags to `cdkl studio`: they bind the whole
  session and are forwarded verbatim to every spawned child (built in
  `src/local/studio-child-args.ts`). Issue go-to-k/cdk-local#301 slice 3 made the
  run-time bindings (`from-cfn-stack` / `assume-role`) editable from the
  UI Session bar: the `childConfig` the dispatcher + serve-manager read
  per-run is mutable, `GET /api/config` exposes it (with the read-only
  synth-time `profile` / `region` / `app`), and `PATCH /api/config`
  (`applyConfigPatch`) edits the bindings so the change applies to
  subsequent runs without a restart. A watch / assume-role toggle is
  otherwise silent (only a from-cfn-stack change logs, via its
  re-classification pass), so the patch handler logs a one-line
  confirmation on a real flip — `describeWatchToggle` /
  `describeAssumeRoleToggle` (both change-gated: a no-op re-send logs
  nothing) note the new binding + that it binds the NEXT run, not
  already-running serves. Issue go-to-k/cdk-local#301 slice 4 added
  `--stack <glob...>` (`filterStudioTargetGroups` in studio-server):
  a DISPLAY-only glob filter over the listed targets (a target id is
  `Stack/Construct`, so `dev/*` scopes to stack `dev`) — it does NOT
  scope synth (the whole app is still synthesized; gate synth with the
  app's own `-c` context / a committed `cdk.context.json`). Issue go-to-k/cdk-local#303
  made AgentCore runtimes runnable from the UI: an `agentcore` target
  gets the same single-shot [Invoke] composer a Lambda does (the
  dispatcher spawns `cdkl invoke-agentcore`), with per-run options
  `--ws` / `--sigv4` / `--bearer-token` / `--session-id` / `--env-vars`.
  Issue go-to-k/cdk-local#301 added `cdkl studio --watch`: serves started from the UI
  (`start-api` / `start-alb` / `start-service`) are spawned with
  `--watch` so they re-synth + rolling-reload on CDK source changes;
  it is an editable session mode (the Session bar `watch` toggle ->
  `PATCH /api/config`, applying to subsequently-started serves) and a
  no-op for single-shot invokes (each invoke re-synths anyway). The
  target list itself is not re-synthed (restart studio to pick up
  newly-added resources). Issue go-to-k/cdk-local#301 also classifies each servable ECS
  service at boot (`resolveEcsServiceTarget` + `isLocalCdkAssetImage`):
  a deployed-registry-pinned service is marked `pinned` so the UI offers
  an image-override Dockerfile picker, and the app dir is scanned once
  (`discoverDockerfiles`, only when something is pinned) for the picker's
  options. The picker threads `--image-override <target>=<dockerfile>`
  through `coerceRunRequest` (validated) + the serve manager. Issue go-to-k/cdk-local#354:
  when studio is booted with `--from-cfn-stack`, the boot pin
  classification threads the deployed-state image-resolution context per
  owning stack (`prepareEcsImageContexts` -> `buildEcsImageResolutionContext`
  -> `makePinClassifier` -> `resolveEcsServiceTarget(id, stacks, ctx)`), so a
  service pinned to an INTRINSIC ECR URI (only resolvable under
  `--from-cfn-stack`, e.g. `ContainerImage.fromEcrRepository(repo)`) is
  detected as pinned — matching `cdkl start-service --from-cfn-stack`; a
  service that cannot be classified now WARNs instead of silently going
  unmarked. When that classify failure happens WITHOUT `--from-cfn-stack`
  (the likely-INTRINSIC-ECR case), the service / task-def entry is also
  marked `pinUnresolved` (the classifiers' `onUnresolved` callback ->
  `classifyStudioTargets`), so the studio composer renders an in-UI hint
  pointing at the Session-bar `--from-cfn-stack` remedy — the terminal WARN
  alone never reaches a browser-only user. `pinUnresolved` is mutually
  exclusive with `pinned` (a resolved pin gets the Dockerfile picker, not the
  hint). Issue go-to-k/cdk-local#385 made this re-runnable: a Session-bar
  `--from-cfn-stack` change (`PATCH /api/config`) re-runs the classification
  (`classifyStudioTargets` against a fresh clone of the un-annotated base) and
  swaps the served target list under the live socket (`RunningStudioServer.
  setTargets`), so the image-override pickers appear / disappear under the new
  binding WITHOUT restarting studio (latest-wins on rapid patches; the UI
  re-fetches `/api/targets` after the binding change). The pin classification
  re-runs ONLY when `--from-cfn-stack` actually changes (a watch / assume-role
  toggle does not).
- `src/synthesis/` — thin wrapper over `@aws-cdk/toolkit-lib`
  (`Toolkit.fromCdkApp()` + context store threading) that returns
  `StackInfo[]` for downstream consumers.
- `src/local/` — runtime layer: docker-runner, container-pool, http-server,
  websocket-server, ecs-task-runner, ecs-service-runner, ecs-network,
  cloud-map-registry, lambda-resolver, ecs-task-resolver,
  route-discovery, authorizer-resolver, lambda-authorizer, cognito-jwt,
  sigv4-verify, credential-error (issues go-to-k/cdk-local#564 / go-to-k/cdk-local#570 / go-to-k/cdk-local#579 — how an AWS SDK
  failure is rendered into a line a third party can read at DEFAULT level —
  a log line, and since go-to-k/cdk-local#579 a served HTTP response body too:
  `describeAwsFailureForWarn` keeps a modeled service exception's message,
  since that message is the
  diagnosis, flattened to one line and length-capped, and withholds every
  other error — credential-chain failures above all, which can carry a
  `credential_process` command line — to a clamped class name plus a
  character count, emitting the full text at `debug`;
  `describeCredentialLoadFailure` is the unconditional-withhold form for a
  `catch` around credential resolution alone, which is what `sigv4-verify`
  uses. Both are re-exported from `src/internal.ts`. Which one a site wants
  is decided per occurrence on TWO axes — LEVEL (is the line default-level,
  and does it reach somewhere a third party reads, such as the studio log
  ring?) and RECONSTRUCTION (does the `catch` see only the credential chain,
  or also a service RESPONSE whose message is the diagnosis?) — never
  mechanically.
  SCOPE: issue go-to-k/cdk-local#570 covered `sigv4-verify` plus nine STS relays in
  `src/cli/commands/**`; issue go-to-k/cdk-local#579 extended the policy to the rest of the
  codebase, so it now also governs `cfn-local-state-provider`
  (`formatAwsErrorForWarn`, six callers, now a thin decoration over the
  shared helper that appends a range-guarded HTTP status),
  `ssm-parameter-resolver` (whose competing `formatSsmError` spelling was
  DELETED rather than fixed), `state-resolver`, `cloudfront-kvs-client`,
  `cloudfront-s3-origin`, `layer-arn-materializer`, `ecr-puller`,
  `ecs-secrets-resolver`, `httpv2-service-integration` and
  `local-studio`'s deployed-state image-context warn. go-to-k/cdk-local#579 also closed two
  NON-error leaks on those same lines: `cfn-local-state-provider` flattens the
  wire-derived `PhysicalResourceId` it interpolates into three warns, and
  `ecs-service-runner`'s exited-container log tail is emitted as ONE warn PER
  LINE (so every line carries the `WARN: ` prefix `studio-serve-manager`'s
  ready-line matcher skips) instead of one warn holding embedded newlines.
  Note that `httpv2-service-integration` is the one governed site whose output
  is an HTTP RESPONSE BODY rather than a log line — the widest reader of the
  set — which is why the axes are stated in terms of readers, not logs.
  DELIBERATELY OUTSIDE it, so the next sweep finds a decision rather than an
  oversight — and note the test is what a `catch` CAN SEE, never where it
  happens to sit: a `catch` around a purely LOCAL operation sees neither
  population, which covers `agentcore-s3-bundle`'s unzip `catch` (it wraps
  `unzipSync` and nothing else) and `layer-arn-materializer`'s presigned-URL
  download and unzip (the URL carries its own authorization, so no credential
  chain is resolved and no modeled service exception is parsed — though the
  download's `HTTP <status> <statusText>` throw does relay a wire-derived
  reason phrase, so it is FLATTENED even though it needs no withholding).
  Applying that test by LOCATION instead is exactly how the sweep first got
  `agentcore-s3-bundle`'s S3 GetObject wrong: it sits OUTSIDE the unzip `try`,
  which made it uncovered rather than out of scope — it had no `catch` at all,
  so the raw SDK error reached `formatError`'s
  `${error.name}: ${error.message}` at default level. It now has one.
  Genuinely outside, as a separate change: the role ARN has no LENGTH bound,
  which wants a shape check at the three RESOLUTION points rather than a
  log-line fix, since that also bounds the value SENT to
  `AssumeRoleCommand.RoleArn` — tracked in
  https://github.com/go-to-k/cdk-local/issues/607. Also still uncovered and
  named here rather than left implicit: `cloudfront-server.ts:129`'s
  catch-all `Request handling failed:` relay. Two calling
  conventions the policy imposes, both learned the hard way in go-to-k/cdk-local#579 — render
  each failure ONCE (the helper EMITS the `debug` line, so a second call
  prints it twice), and give cdk-local's OWN throws an identifiable class and
  re-raise them ABOVE the relay (the policy is defined positively, so it
  withholds anything that is not a parsed service response — including text
  cdk-local wrote itself)),
  rie-client, intrinsic-image, runtime-image, target-lister
  (`cdkl list` target enumeration), target-picker (interactive arrow-key
  target selection via `@clack/prompts` when a target is omitted in a TTY),
  agentcore-resolver (`AWS::BedrockAgentCore::Runtime` target resolution +
  container-URI extraction) + agentcore-client (the `/ping` + `/invocations`
  HTTP-contract client for `cdkl invoke-agentcore`) + agentcore-ws-client (the
  bidirectional `/ws` WebSocket client for `--ws` (`invokeAgentCoreWs`), plus
  the caller-driven relay primitive `bridgeAgentCoreWs` — which
  opens the container `/ws` with the session-id / Authorization headers
  injected and sends NO initial frame, so a caller drives every frame) +
  agentcore-ws-bridge (`startAgentCoreWsBridge`: a standalone host
  WebSocket server; accepts a header-less client
  (a browser, which cannot set the upgrade headers) and bridges each
  connection to the container `/ws` via `bridgeAgentCoreWs`, injecting a
  per-connection session-id UUID + optional Authorization. `attachAgentCoreWsBridge`
  extracts the `/ws` wiring so it can be attached to an existing
  `http.Server` — used by agentcore-http-server) + agentcore-http-server
  (`startAgentCoreHttpServer`, issue go-to-k/cdk-local#454 — the host HTTP serve behind
  `cdkl start-agentcore`, protocol-aware via a `routes` + `attachWs` config:
  one `http.Server` proxies the declared `{method, path}` routes to the warm
  container, streaming request / response (SSE included) and injecting the
  session-id (fresh per request unless pinned) + Authorization headers, and
  — for HTTP / AGUI (`attachWs`) — delegates the `/ws` upgrade on the same
  port to `attachAgentCoreWsBridge`. So one warm container serves the HTTP /
  AGUI contract (`POST /invocations` + `GET /ping` + `/ws`), the MCP contract
  (`POST /mcp`), or the A2A contract (`POST /`) repeatedly; MCP / A2A are
  pure pass-through with no `/ws`. Slice 4a added a per-request `authCheck`
  (gates each `POST` contract request — `GET /ping` is never gated — returning
  401 / 403 on deny, forwarding the verified Authorization on pass) + a
  per-request `signRequest` (buffers the POST body, signs it SigV4, injects the
  `Authorization` / `X-Amz-*` headers; drops the inbound chunked
  `transfer-encoding` since the body is now fixed-length). Slice 4b added
  `setContainerPort(port)` to the handle: the proxy reads `config.containerPort`
  live per request and the `/ws` bridge per upgrade (its `containerPort` is now a
  `number | (() => number)` getter), so a `--watch` rebuild re-points the serve
  at a new warm container without rebinding the listener) + agentcore-serve-auth
  (slice 4a — `buildAgentCoreServeAuthCheck`: the per-request inbound-JWT gate
  for the warm serve, the serve counterpart of `front-door-auth`'s ALB
  `AuthCheck`; reuses `cognito-jwt`'s `verifyJwtViaDiscovery` to verify the
  caller's token against the runtime's `customJwtAuthorizer` per request —
  401 missing / 403 invalid / pass, with `--bearer-token` the default and
  `--no-verify-auth` the off-switch) + agentcore-s3-bundle
  (downloads + extracts a fromS3 CodeConfiguration bundle for the from-source
  build), embed-config
  (embed-time branding overrides for host CLIs), ssm-parameter-resolver
  (resolves `AWS::SSM::Parameter::Value` template parameters via SSM under
  `--from-cfn-stack`), elb-front-door-resolver (resolves an ALB ->
  Listeners + ListenerRules across all six ALB condition fields
  (`path-pattern` / `host-header` / `http-header` / `http-request-method`
  / `query-string` / `source-ip`) -> forward / weighted-forward /
  redirect / fixed-response actions -> backing ECS Services or Lambda
  functions, into a per-listener routing table; the `start-alb` entry),
  alb-path-matcher (ALB `*` / `?` glob matcher for path / host / header /
  query-string rules + exact http-request-method + CIDR source-ip,
  priority ordered), alb-lambda-event (HTTP <-> ALB
  `requestContext.elb` Lambda event/response translation), front-door-pool
  (round-robin pool of live replica endpoints), front-door-lambda-runner
  (one warm RIE container per Lambda target; accepts an optional
  pre-resolved `containerEnv` overlay + `sensitiveEnvKeys` so the caller can
  inject a fully-resolved env via `resolveLambdaContainerEnv` — issue go-to-k/cdk-local#380 —
  instead of the default shell-creds-only forward), front-door-tls (resolves
  TLS materials for HTTPS listeners: `--tls-cert` / `--tls-key` pair or
  an auto-generated self-signed cert cached under XDG cache via openssl),
  front-door-auth (builds the per-action `AuthCheck` callback for
  authenticate-cognito / authenticate-oidc — reuses the cognito-jwt
  verifier for the Bearer-JWT path, plus an `AWSELBAuthSessionCookie-*`
  pass-through path), source-change-classifier (Phase 4 of go-to-k/cdk-local#214 —
  pure per-firing classifier the `--watch` reload pathway calls per
  target to decide `'rebuild'` vs `'soft-reload'`; defaults to
  rebuild on ambiguity, requires the asset hash to actually flip
  before returning soft-reload so a CDK construct edit that changed
  the task spec doesn't get silently soft-reloaded with the OLD
  spec), image-pin-detector (issue go-to-k/cdk-local#234 — classifies a booted ECS
  service's representative image as local CDK asset vs deployed-
  registry pin so the `--watch` emulator can WARN at boot and SKIP
  the no-op rolling primitive on each reload firing instead of
  re-pulling byte-identical content and surfacing `Reload complete.`
  as a silent no-op), image-override-engine (issue go-to-k/cdk-local#238 — parses
  the `--image-override` / `--image-build-arg` /
  `--image-build-secret` / `--image-target` flag family, fires the
  `@clack/prompts` multi-select picker for picker-form Dockerfile
  paths + the TTY boot prompt against still-uncovered pinned targets,
  and runs `docker build` once per covered target producing the
  deterministic local-only tag the boot path threads into each
  runner's `imageOverrideByContainer`), front-door-server (host HTTP / HTTPS reverse proxy
  that resolves a per-request RouteAction — weighted forward to a
  replica pool or a Lambda invoke, redirect, or fixed-response — behind
  the ALB listener port; HTTPS branch flips `X-Forwarded-Proto` and the
  redirect `#{protocol}` default to `https`; an `auth` guard on the
  action gates serving with a 401 + `WWW-Authenticate: Bearer` on deny;
  WebSocket `Upgrade` requests run through the same route + auth
  pipeline, then bridge the raw TCP socket to the picked ECS replica
  with `Upgrade` / `Sec-WebSocket-*` headers preserved),
  cloudfront-resolver (issue go-to-k/cdk-local#363 — resolves an
  `AWS::CloudFront::Distribution` to a `ResolvedDistribution`: behaviors
  (default + `CacheBehaviors[]`) -> path pattern + viewer-request /
  viewer-response CloudFront Functions + per-event-type Lambda@Edge
  associations (issue go-to-k/cdk-local#400 — each `LambdaFunctionAssociations[]` entry's
  `LambdaFunctionARN` resolved through its `AWS::Lambda::Version` to the
  backing `AWS::Lambda::Function` via `pickLambdaEdgeFunctionLogicalId`),
  origins (S3 origin -> local
  BucketDeployment source dir via the asset manifest, else an
  `s3-unresolved` origin the command promotes to `s3-deployed` real-S3
  read-through under `--from-cfn-stack`, issue go-to-k/cdk-local#405 — `describeS3OriginDomain`
  also detects an external/imported-bucket origin from its `DomainName`
  (`<bucket>.s3[.-]...amazonaws.com`, literal / `Fn::Sub` / `Fn::Join`) and
  parses the literal bucket name, marking a pure-intrinsic name
  `deployedConfigOnly`; a Lambda Function
  URL origin -> backing `AWS::Lambda::Function` via the
  `Fn::Select/Split/GetAtt` `DomainName` + `AWS::Lambda::Url`
  `TargetFunctionArn`, issue go-to-k/cdk-local#376; custom / unresolved origins flagged),
  per-behavior CORS (each behavior's `ResponseHeadersPolicyId` ->
  `AWS::CloudFront::ResponseHeadersPolicy` `CorsConfig`, via the cors-handler
  `resolveResponseHeadersPolicyCors` helper shared with the `start-api`
  CloudFront chain),
  and custom error responses; the `start-cloudfront` entry),
  cloudfront-function-runtime (compiles + runs an inline
  CloudFront Function in a `node:vm` sandbox, builds the
  viewer-request / viewer-response event from an HTTP request, and
  interprets the handler's return as continue-to-origin vs short-circuit
  response; `cloudFrontRuntimeGlobals` merges the CloudFront-Functions-2.0
  built-ins a bare vm context lacks — `Buffer` / `atob` / `btoa` /
  `TextEncoder` / `TextDecoder` + a `require` for `crypto` / `querystring` /
  `buffer`, issue go-to-k/cdk-local#410 — into both the compile probe and the invoke sandbox;
  `stripCloudFrontImport` strips the 2.0
  `import cf from 'cloudfront'` line at compile time so a KVS-reading
  function compiles as a plain `vm.Script`, and the resolved `cf` module is
  injected under the binding name at invoke time — issue go-to-k/cdk-local#399),
  cloudfront-kvs (issue go-to-k/cdk-local#399 — the binding-agnostic `cf` KeyValueStore shim:
  `cf.kvs(id?)` -> a handle with `get` / `exists` over a `KvsDataSource`, the
  local-file data source, and the unbound module that fails a read with an
  actionable error), cloudfront-kvs-client (issue go-to-k/cdk-local#399 — the AWS boundary:
  the deployed `GetKey` data source + `resolveDeployedKvsArnByName` which maps
  a store NAME to its ARN via the control-plane `ListKeyValueStores`; a
  side-effect `import '@aws-sdk/signature-v4a'` registers the SigV4A signer the
  `cloudfront-keyvaluestore` API requires), cloudfront-kvs-binding (issue go-to-k/cdk-local#399
  — `resolveKvsModulesForDistribution`: walks each KVS-reading function, builds
  its `cf` module from a `--kvs-file` map or the deployed-ARN callback, and
  attaches it to the compiled function; re-run on each `--watch` reload),
  cloudfront-static-origin (serves a URI from the resolved S3
  origin dir(s): default-root-object at `/`, path-traversal guard, MIME
  by extension, `CustomErrorResponses` SPA fallback; the
  `resolveErrorResponseCandidates` 403-then-404 priority helper is shared
  with the deployed-S3 reader),
  cloudfront-s3-origin (issue go-to-k/cdk-local#405 — the deployed-S3 read-through origin:
  `createS3OriginReader(bucketName)` serves an S3 origin that has no local
  BucketDeployment source by reading the DEPLOYED bucket from real S3 on
  demand — a request-time `GetObject` per touched key, reusing the
  static-origin URI->key / `DefaultRootObject` / `CustomErrorResponses`
  resolution; `classifyS3Error` maps a miss to the SPA fallback and an
  `AccessDenied` to an actionable `--origin` warning; the command promotes
  an `s3-unresolved` origin to `s3-deployed` under `--from-cfn-stack`),
  cloudfront-distribution-config (issue go-to-k/cdk-local#405 follow-up — the
  `GetDistributionConfig` boundary: `resolveDeployedOriginBucket` reads the
  DEPLOYED distribution's origin `DomainName` and parses the bucket name from
  it, the fallback for a deployed-S3 origin whose bucket name is a pure
  intrinsic (a `Ref` parameter / cross-stack import) not derivable from the
  local template or stack state; never throws — a read failure resolves to
  undefined so the command falls back to the `--origin` guidance),
  cloudfront-lambda-origin (issue go-to-k/cdk-local#376 — serves a Lambda Function URL
  origin: builds a Function URL payload-v2.0 event from the request
  (reusing `buildHttpApiV2Event` with a synthetic `$default` route),
  invokes the warm RIE container, and translates the v2 response
  (`translateLambdaResponse`) into the origin status / headers / body /
  cookies), cloudfront-edge-event (issue go-to-k/cdk-local#400 — the Lambda@Edge wire format:
  builds the `{ Records: [{ cf: { config, request, response } }] }` event for
  each of the four event types, translates HTTP headers to / from the
  `{ name: [{ key, value }] }` multi-map, and interprets a handler's return as
  a continue-with-rewritten-request, a generated-response short-circuit, or a
  modified response — `applyEdgeRequestResult` / `applyEdgeResponseResult` are
  the server-facing orchestration helpers), cloudfront-server
  (the local HTTP/HTTPS server behind `start-cloudfront`: per-request
  behavior match -> (a matched behavior's ResponseHeadersPolicy CORS
  preflight short-circuit via `matchPreflight`) -> viewer-request fn ->
  Lambda@Edge viewer-request / origin-request (issue go-to-k/cdk-local#400 — either may
  short-circuit or rewrite the request via the boot-time edge invoker map) ->
  origin (S3 static origin OR a deployed-S3 read-through origin via the
  boot-time `s3OriginReaders` map, issue go-to-k/cdk-local#405, OR a
  Lambda Function URL origin via the boot-time invoker map) ->
  Lambda@Edge origin-response -> viewer-response fn THEN Lambda@Edge
  viewer-response (both run, CloudFront Function first) -> the behavior's
  actual-response CORS headers
  (`applyCorsResponseHeadersFromConfig`), with a mutable distribution cell so
  `--watch` swaps the routing model under the live socket),
  studio-custom-resource-filter (issue go-to-k/cdk-local#323 —
  `isCustomResourceLambdaTarget` / `filterStudioCustomResources`:
  recognizes CDK custom-resource / provider-framework Lambdas by their
  construct path (provider-framework `framework-on*`, `LogRetention`,
  `BucketNotificationsHandler`, `AwsCustomResource`, CDK bucket
  deployment, the `AWS679...` singleton, plus a GENERIC `custom::`
  catch-all — issue go-to-k/cdk-local#359 — that covers any provider Lambda whose
  `aws:cdk:path` uses a `Custom::`-prefixed node the name-specific
  patterns miss) so `cdkl studio` hides them from the target list by
  default — `--include-custom-resources` opts back in),
  studio-events (issue go-to-k/cdk-local#282 — the typed in-process event bus every
  `cdkl studio` observation flows through (`invocation` / `log` /
  `serve` events); the studio HTTP server
  subscribes and forwards to the browser over SSE), studio-server
  (the localhost HTTP server behind `cdkl studio`: serves the embedded
  UI at `/`, the synthesized target list (+ the boot-discovered
  Dockerfiles + a `pinned` flag per ecs service — set by
  `annotatePinnedEcsTargets` — for the image-override picker, issue go-to-k/cdk-local#301;
  plus a `pinned` flag per `ecs-task` task definition — set by
  `annotateEcsTaskPinnedTargets`, issue go-to-k/cdk-local#388 — for the run-task image-override
  picker; plus `backingPinnedServices` per alb entry — set by
  `annotateAlbPinnedBackingServices`, issue go-to-k/cdk-local#384 — for the ALB's
  per-backing-service image-override picker;
  CDK custom-resource / provider-framework Lambdas are excluded by
  default via `filterStudioCustomResources`, issue go-to-k/cdk-local#323 — pass
  `cdkl studio --include-custom-resources` to surface them)
  at `/api/targets`, an SSE
  stream of the event bus at `/api/events` (which opens with a `hello`
  event carrying a per-boot `instanceId` and beats a JS-visible `ping`
  event every `SSE_HEARTBEAT_MS` so the UI can detect a dead / swapped
  server — see studio-ui's liveness watchdog), `POST /api/run` (single-shot
  invoke / serve start), `POST /api/stop` (serve stop),
  `GET /api/running` (running serve snapshot), `POST /api/request`
  (issue go-to-k/cdk-local#322 — relay a composed HTTP request to a running serve via
  `studio-request-relay` so the browser composer reaches the served port
  same-origin; api / alb go through the capture proxy and land on the
  timeline, an ecs serve hits the replica host URL directly — from an explicit
  `--host-port` or an auto-published replica port, issue go-to-k/cdk-local#392 — and that
  direct (un-proxied) ecs relay STILL lands on the timeline because the
  command emits the `invocation` start/end pair itself
  (`relayAndCaptureServeRequest`), so a Service request gets the same
  Request/Response timeline row + read-only detail an api / alb request does;
  an external curl straight to the host port is the one case not captured, no
  proxy intercepting it),
  `POST /api/reinvoke` (issue go-to-k/cdk-local#284 — re-run a past Lambda / AgentCore
  timeline row with an edited payload via `studio-reinvoke`, threading
  `reinvokeOf` so the new row links to its source; a served request is
  re-sent through the request composer instead),
  the slice-C3 store
  endpoints `GET /api/history` / `GET /api/logs?q=` (full-text log
  search) / `GET /api/invocations/<id>/logs` (per-request log binding),
  and the slice-3 session config `GET /api/config` (read-only synth
  context + editable bindings) / `PATCH /api/config` (edit the run-time
  bindings); collision-bumps the port),
  studio-ui (the framework-free web UI embedded as a string so it ships
  inside the npm package with no asset-copy build step; 3-pane: targets /
  workspace composer / timeline. The targets pane (issue go-to-k/cdk-local#301) groups
  targets into collapsible sections (collapsed by default so a big Lambda
  list does not push the APIs below the fold; a running serve auto-expands
  its group so its `:port` stays visible), zebra-stripes the rows, and has
  a full-text filter box (`applyTargetFilter`) beside the TARGETS heading.
  Within a kind group, each stack's shared `<stack>/` construct-path prefix
  is folded into a `.stack-sub` header (PER STACK — `stackSections` splits a
  group's already-stack-sorted entries on a stack-key change, so rows from
  different stacks never share a fold) and the row shows only the
  distinguishing tail; this keeps a deep construct path legible in a narrow
  pane where the shared prefix used to eat the width. The tail is a
  horizontal-scroll container (a two-finger trackpad swipe reveals the rest
  and scrolls back; `overscroll-behavior-x: contain` stops the swipe from
  triggering browser back-navigation, a right-edge mask is the "more ->"
  cue) instead of a hard ellipsis. The full id stays on the row `title`
  (hover tooltip) + `data-tid` (the filter key). Zebra is a JS-applied
  `.alt` class (continuous across sections) rather than `:nth-child`, which
  the interleaved sub-headers would offset.
  The Session bar applies on change (no Save button — `applyConfig` PATCHes
  `/api/config` immediately on a checkbox toggle / input change, issue
  go-to-k/cdk-local#301); Lambdas + AgentCore runtimes get an
  [Invoke] composer (`INVOKE_KINDS`), serve
  targets (api / alb / ecs / ecs-task / cloudfront / agentcore-ws) a
  [Start]/[Stop] control
  with a
  `running ● :port` indicator (ecs services + ecs-task runs show
  `running` with no port). The control surfaces transient in-progress states
  (issue go-to-k/cdk-local#394): a Stop in flight shows "Stopping..." (disabled) until the
  `stopped` / `error` serve event settles it (tracked in a client-side
  `stoppingIds` set, settled in `onServeEvent` via `settleStoppingTransient`
  with a `MIN_STOPPING_MS` floor so a near-instant teardown — a `start-api` /
  pure-S3 `cloudfront` serve with no warmed containers tears down in tens of
  ms — still shows the affordance instead of flipping straight back to Start;
  the floor is a no-op for `alb` / `ecs`, whose real Docker teardown already
  takes longer), and a still-booting serve shows
  "Starting..." (disabled) — both inert so a double-click cannot re-fire stop /
  cancel mid-boot. Issue go-to-k/cdk-local#352 lists ECS Services (the `ecs`
  serve kind) and ECS Task Definitions as SEPARATE target groups,
  matching `cdkl list`; issue go-to-k/cdk-local#366 makes the task-definitions group the
  `ecs-task` kind — a [Run] control (labeled Run, not Start) that runs
  `cdkl run-task` as a long-running run (a server task def streams logs
  until [Stop]; a batch task exits and the run flips to stopped). It
  flips to `running` on the run-task `Task running (family=...)`
  onReady banner (a streaming run has no listening-port line). Once a
  serve is Started the
  composer's per-run option inputs are replaced by the running view, so a
  read-only "Started with" summary (issue go-to-k/cdk-local#356 — `formatAppliedOptions`
  over the `serveApplied` map recorded at Start) surfaces the launch
  config the serve is running with (e.g. a chosen `--max-tasks` stays
  visible instead of silently vanishing). The session-global `--watch`
  is appended by the serve-manager from the mutable session config (not
  a per-run option), so `startServe` records the watch checkbox state at
  Start into `serveApplied.watch` and `formatAppliedOptions` surfaces a
  `--watch` line FIRST — so a serve started with watch ON shows it and
  one started before the toggle visibly does NOT (the visibility gap that
  made a watch-on serve look watch-off). A serve that FAILS — a boot
  failure (serve-manager emits status `error` with a message) or a crash
  AFTER it was running (status `stopped` WITH a message, vs a clean user
  stop which is `stopped` with NO message) — keeps that "Started with"
  summary, surfaces the failure reason (`StudioServeEvent.message`,
  threaded through `onServeEvent` -> `serveState` -> the workspace error
  banner), and offers a `Reconfigure` button, instead of silently
  reverting to a blank composer that reads as "my inputs vanished". When a
  stopped serve's composer is shown again (a Start -> Stop, or Reconfigure on
  a failed serve), it is re-rendered PRE-FILLED from the same `serveApplied`
  record (issue go-to-k/cdk-local#398 — `buildOptions(kind, applied.options, applied.rawArgs)` +
  the image-override pickers), so the bearer token / curated option inputs /
  raw extra args / Dockerfile picks survive a restart instead of resetting. A served
  API Gateway WebSocket API additionally gets a WebSocket console
  (`renderWsConsole` — connect / send-frame / received-frame log) wired
  straight to its ws:// endpoint, with the socket + frame log held in module
  state so a log-driven serve re-render never drops the connection (issue
  go-to-k/cdk-local#303); the SAME console renders for an `agentcore-ws` serve when the runtime
  exposes `/ws` (HTTP / AGUI). The two AgentCore groups are titled
  "AgentCore Runtimes (invoke)" (the `agentcore` invoke kind) and
  "AgentCore Runtimes (serve)" (the `agentcore-ws` serve kind, issue go-to-k/cdk-local#454 —
  start-agentcore serves the warm HTTP contract now, not just `/ws`); the serve
  group lists EVERY AgentCore runtime alongside its
  single-shot invoke entry — the same dual listing as the ecs / ecs-task split —
  because `cdkl start-agentcore` serves all four protocols warm (slices 1-2).
  Each serve renders the api/alb-style HTTP request composer against the warm
  container's contract endpoint, pre-filled with the protocol's `POST` path
  (`/invocations` for HTTP / AGUI, `/mcp` for MCP, `/` for A2A — carried on the
  target as `agentCoreContractPath`); HTTP / AGUI runtimes (`agentCoreHasWs`)
  ADDITIONALLY render the WebSocket console, since the bridge's `ws://` endpoint
  flows through the same un-proxied `endpoints` path while the http:// contract
  endpoint is fronted by the capture proxy so a relayed `/invocations` lands on
  the timeline; every composer (invoke + serve) carries a collapsed "All options"
  `<details>` (`buildAllOptions`) that AUTO-RENDERS a real control (checkbox for
  a boolean / negate flag, text input for a value flag, `<select>` for a
  `.choices()` flag) for every RENDERABLE catalog flag — i.e. every flag the
  underlying command accepts that is NEITHER curated (a rich control already
  exists in OPTION_SPECS) NOR studio-managed (`CATALOG_MANAGED_FLAGS`:
  `--event` / `--response-file` / `--host` / `--port` / `--watch` + the
  override-selection flags `--image-override` / `--no-interactive-overrides`
  / `--strict-overrides`, injected by studio itself — but NOT the build-input
  pass-throughs `--image-build-arg` / `--image-build-secret` / `--image-target`,
  which DO auto-render since the Dockerfile picker only threads
  `--image-override`), plus a raw extra-args input as the final escape hatch;
  the collected values
  (`collectCatalog` -> the `catalogArgs` map keyed by long flag) are built into
  argv by `buildCatalogArgs` and appended after the curated per-run args (before
  the raw args). So the curated controls handle common flags richly AND a user
  no longer has to hand-type `--flag value` for the long tail of simple flags
  (issue go-to-k/cdk-local#301 + the all-options-controls slice); a PINNED ecs
  service (deployed-registry image, marked `pinned` in the target list)
  additionally gets an image-override Dockerfile picker
  (`buildImageOverridePicker`) populated from the boot-scanned Dockerfiles,
  threading `--image-override <target>=<dockerfile>` (the explicit form —
  studio's child has no TTY, so the bare picker form would be skipped) onto
  the serve body so `start-service` rebuilds the pinned image from local
  source; a local-asset service (which already hot-reloads under `--watch`)
  gets no picker (issue go-to-k/cdk-local#301). A PINNED `ecs-task` task definition gets the
  SAME single picker (issue go-to-k/cdk-local#388): the `ecs-task` composer threads
  `--image-override <target>=<dockerfile>` onto the run body so the spawned
  `cdkl run-task` rebuilds the pinned task-def image from local source
  (`makeTaskPinClassifier` + `annotateEcsTaskPinnedTargets` mark a pinned task
  def at boot). An `alb` serve gets the SAME picker for its
  pinned BACKING services (issue go-to-k/cdk-local#384): `start-alb` boots the ALB's backing
  ECS services, so studio resolves each ALB (`resolveAlbFrontDoor`) to its
  backing services at boot, intersects them with the pinned `ecs` set
  (`annotateAlbPinnedBackingServices` + `makeAlbBackingPinnedResolver`), and
  the alb composer offers ONE Dockerfile picker per pinned backing service
  (`buildAlbImageOverridePicker`) — threading a per-service
  `imageOverrides` map (`{ Stack:LogicalId -> dockerfile }`, one
  `--image-override <service>=<dockerfile>` each, the service key being
  start-alb's own service-boot target) so a pinned service rebuilds from
  local source while running behind the ALB; the
  timeline carries both Lambda invocations and captured serve requests;
  clicking a past Lambda / AgentCore row reloads it into the composer
  pre-filled + wired to re-invoke (issue go-to-k/cdk-local#284, the [Re-invoke] button ->
  `POST /api/reinvoke`), a captured serve request opens a read-only
  Request/Response detail whose [Re-invoke] reuses that serve's request
  composer (pre-filled), and a re-invoked row is visually linked to its
  source; a log search box queries the store and a captured request's
  detail shows its bound logs. The LOGS panel + log search colour each
  line by its level (`fillLogPre` / `logLineClass`): a line whose text
  starts `WARN:` / `ERROR:` (optionally after a `[module]` tag) is
  rendered amber / red, so warn / error stand out even though the captured
  child output carries no ANSI colour (serve children run colourless under
  a pipe) — the text prefix is the only severity signal that survives, and
  the compact logger now emits it (see logger note below). The header
  `● live` / `● disconnected`
  indicator is driven by `connect()`'s liveness logic: it binds to the
  FIRST `/api/events` `hello` instanceId, flips to disconnected (latched,
  socket closed) when a reconnect lands on a DIFFERENT instanceId (a second
  `cdkl studio` that reused this port after the originating process exited),
  and a heartbeat watchdog flips to disconnected when no `ping` / event
  arrives within the liveness window — so a dead server is detected even
  when the dropped socket never surfaces an EventSource `error`),
  studio-reinvoke (issue go-to-k/cdk-local#284 — `reinvoke({invocationId, payload}, {store,
  dispatcher})`: resolves the source target from the recorded invocation
  and re-fires the edited payload through the SAME single-shot dispatcher
  `POST /api/run` uses, threading `reinvokeOf`. Lambda / AgentCore only; a
  served request is re-sent client-side through the request composer so
  the capture proxy still records it),
  studio-dispatch
  (issue go-to-k/cdk-local#282 / go-to-k/cdk-local#303 — the single-shot `POST /api/run` handler
  for the invoke kinds: runs a target from the studio UI by
  spawning the SAME headless command the CLI runs as a child process —
  `cdkl invoke` for a `lambda`, `cdkl invoke-agentcore` for an
  `agentcore` (`INVOKE_VERBS`) — studio being a control plane over the
  CLI — streaming its stdout/stderr to the event bus and returning the
  response. `extractResponse` recovers the response per kind: a Lambda's
  is read from the `--response-file` the dispatcher passes to
  `cdkl invoke` (go-to-k/cdk-local#291 — it writes ONLY the raw RIE response
  payload there, so a handler's own trailing `console.log(JSON)` can
  no longer be mistaken for the response), falling back to the LAST
  JSON-parseable stdout line when the file is absent (older `cdkl
  invoke` / a crash before the write); an AgentCore agent streams
  its WHOLE output to stdout (HTTP SSE / MCP-A2A JSON-RPC / `--ws`
  frames), so the entire stdout IS the response. The child is spawned with `CDKL_LOG_LEVEL=warn` so
  cdk-local's OWN synth / orchestration progress (toolkit "Successfully
  synthesized to ...", asset-bundling, info-level status — honored by
  `resolveConfiguredLogLevel` in `utils/logger.ts` + `CdklIoHost`) is
  silenced in the child; the studio LOGS panel then shows only the
  Lambda container's runtime logs, which stream straight from
  `docker logs` and are unaffected by the level, plus the response.
  `CDKL_LOG_STREAM` is PINNED to `stderr` on that spawn rather than
  inherited (issue go-to-k/cdk-local#608): the spawn spreads `process.env`, so an
  operator who exported `CDKL_LOG_STREAM=stdout` in their own shell
  would otherwise hand it to the child, and `emit()` then routes EVERY
  level — cdk-local's own warns included — to stdout, which on this
  path is the RESPONSE channel. For the `agentcore` kind
  `extractResponse` treats the WHOLE of stdout as the response, so
  those warns are folded INTO the response: measured live, an
  AgentCore invoke under `--from-cfn-stack` / `--assume-role` with the
  variable exported returns a string starting `WARN: --from-cfn-stack:
  STS GetCallerIdentity failed: ...` instead of the agent's parsed
  JSON. What it does NOT do is lose the lines: a `lambda` invoke's
  non-response stdout lines are emitted as `log` events, so binding
  survives either way — only live streaming is lost, since stderr
  reaches the bus line by line while stdout is replayed after close.
  This is the OPPOSITE of `studio-serve-manager`, which sets `stdout`
  deliberately (issue go-to-k/cdk-local#403) to unify a serve child's two pipes — safe
  there because a serve child has no response channel),
  studio-child-args (issue go-to-k/cdk-local#301 slice 1 — `buildSharedChildArgs`, the
  single place that turns studio's session-global config (`--app` /
  `--profile` / `--region` / `-c` / `--from-cfn-stack` / `--assume-role`)
  into the argv fragment both studio-dispatch and studio-serve-manager
  forward to their spawned child commands, so the two spawn sites cannot
  drift. The `omitStateBindings` option (issue go-to-k/cdk-local#367) suppresses
  `--from-cfn-stack` / `--assume-role` for a child that does not declare
  them; as of issue go-to-k/cdk-local#380 EVERY serve kind (incl. `cloudfront`, for its
  Function URL origin Lambda) declares those flags, so the serve-manager no
  longer sets `omitStateBindings` for any kind — the bindings are forwarded
  to all serves. The guard stays available for a future pure-local serve
  kind),
  studio-option-specs (issue go-to-k/cdk-local#301 slice 2 — the per-target run-option
  descriptor table (`OPTION_SPECS`) that is the single source the UI
  renders controls from (serialized into the page) AND the server builds
  + validates argv from (`buildPerRunArgs`): boolean -> checkbox, scalar
  -> input (with `showWhen` gating), repeat-pair -> add-row list (one
  `--flag left=right` per row), env-kv -> KV / JSON editor whose rows are
  materialized by `resolveEnvVars` into a SAM-shape `{ Parameters: {...} }`
  temp file passed as `--env-vars <file>`. Per-target options vary per
  invoke / serve, vs the session-global flags in studio-child-args; the
  `agentcore` kind (issue go-to-k/cdk-local#303) declares `--ws` / `--sigv4` (boolean),
  `--bearer-token` / `--session-id` (scalar), and `--env-vars` (env-kv);
  the `alb` / `ecs` serve kinds also declare `--env-vars` (env-kv, issue
  go-to-k/cdk-local#355) so a UI-started serve can overlay the backing ECS task container
  env; the `agentcore-ws` serve kind declares `--bearer-token` (scalar) /
  `--no-verify-auth` (boolean) / `--session-id` (scalar) / `--env-vars`
  (env-kv) — the serve-relevant subset of start-agentcore's flags, no
  `--ws` / `--sigv4`)),
  studio-option-catalog (issue go-to-k/cdk-local#301 — the AUTO-DERIVED full flag catalog
  that backs the composer's collapsed "All options" section.
  `buildFlagCatalog` introspects each runnable kind's Commander command
  factory (`createLocalInvoke*` / `createLocalStart*`) and emits every
  flag — its `flags` string + `description` PLUS the derived control
  metadata (`long` / `takesValue` / `negate` / `variadic` / `placeholder`
  parsed from the value token / `choices`) and a `renderable` flag — minus
  the session-global flags (`CATALOG_EXCLUDED_FLAGS`: `--from-cfn-stack` /
  `--assume-role` / `--app` / `--profile` / `--region` / `-c`, handled by
  the Session bar) and the auto-added `--help` / `--version`. A flag is
  `renderable` (the UI auto-renders an editable control for it) when it is
  NEITHER curated (in OPTION_SPECS — a rich control already exists) NOR
  studio-managed (`CATALOG_MANAGED_FLAGS`: `--event` / `--response-file` /
  `--host` / `--port` / `--watch` + the override-selection flags
  `--image-override` / `--no-interactive-overrides` / `--strict-overrides`,
  which studio injects itself; the build-input pass-throughs
  `--image-build-arg` / `--image-build-secret` / `--image-target` are NOT
  managed — they auto-render, since the picker only threads
  `--image-override`). `buildCatalogArgs(kind, catalogArgs)` is the
  counterpart of OPTION_SPECS' `buildPerRunArgs`: it validates the UI-posted
  `CatalogValues` (a `{ long-flag -> boolean|string }` map) against the
  kind's renderable catalog flags and builds the argv fragment (bare flag for
  a checked boolean, `flag value` otherwise) appended after the curated args
  by both studio-dispatch and studio-serve-manager — so the UI is never
  strictly less capable than the headless CLI AND the long-tail flags are
  click/type-able, not raw-string-only. Memoized; each factory is
  re-handed the active embed config so host branding survives + the
  derived descriptions reflect it. `tokenizeRawArgs` is the quote-aware
  splitter for the section's raw extra-args input — the tokens are
  appended verbatim (LAST, so they can override an earlier flag) to the
  spawned child argv; studio spawns children WITHOUT a shell, so there is no
  injection surface. `coerceRunRequest` validates BOTH the `catalogArgs` map
  (via `buildCatalogArgs`) and the `rawArgs` string (tokenized eagerly) at the
  `/api/run` boundary so an unknown / non-overridable flag or an unterminated
  quote is a clean 400)),
  studio-serve-manager (issue go-to-k/cdk-local#282 — the
  long-running serve lifecycle, parameterized by a per-kind
  `ServeKindSpec`: `api` (`start-api`) + `alb` (`start-alb`) +
  `cloudfront` (`start-cloudfront`, issue go-to-k/cdk-local#367) expose host
  HTTP endpoints each fronted by a studio-proxy so the `endpoints` handed
  to the UI are the proxy URLs (slice C2 capture), while `ecs`
  (`start-service`) is pure compute — no capture proxy, just the running
  replicas + their streamed logs. `agentcore-ws` (`start-agentcore`) resolves
  running on `Server listening on (<url>)` (`ws://` for HTTP / AGUI, `http://`
  for MCP / A2A) and has `capturesHttp: true`: a `ws://` endpoint passes
  straight through (the capture-proxy gate is `/^https?:/`) so the browser
  connects directly to the bridge for the WebSocket console, while an `http://`
  endpoint is fronted by the capture proxy so warm-contract requests land on the
  timeline (issue go-to-k/cdk-local#454). For HTTP / AGUI the `http://` contract endpoint arrives
  on a SECOND ready line (`HTTP contract served on http://...`) captured by the
  spec's `extraEndpointRe`, alongside the `ws://` listen line; MCP / A2A emit
  only the `http://` listen line. The `ecs` serve's `hostUrl` is set from an
  explicit `--host-port` OR (issue go-to-k/cdk-local#392) parsed from the child's
  `... published on <ip>:<port> ...` log line when start-service auto-publishes
  / auto-remaps a replica port (`parsePublishedHostEndpoint`, first endpoint
  wins, re-emitted if it arrives after the running event) — so the request
  composer can target an auto-published replica without an explicit
  `--host-port`. Resolves running on the kind's
  ready line (`Server listening on <url>` (shared by start-api and
  start-agentcore — the latter's is a `ws://` URL) / `ALB front-door: <url>` /
  `CloudFront distribution serving on <url>` /
  `Service(s) running:`), tracks the running set for `/api/running`, and
  SIGTERMs the child on `/api/stop` / studio shutdown with a generous
  grace so the serve command's OWN ECS-replica + docker-network teardown
  completes before any SIGKILL. Each serve child is spawned with
  `CDKL_LOG_STREAM=stdout` (issue go-to-k/cdk-local#403) so the logger unifies warn / error
  onto stdout: studio reads the child's stdout + stderr via two separate OS
  pipes with no cross-pipe order guarantee, so without unification a stderr
  WARN (e.g. the pinned-image boot warning) could surface in the studio LOG
  panel AFTER a later stdout line like `Press ^C to shut down.`. The serve
  path is safe to unify (ready-line detection greps stdout; error detection
  is via the child `error` / `close` events, not stderr content).
  Complementing this, the compact-mode logger (`utils/logger.ts`) prefixes
  warn / error lines with `WARN:` / `ERROR:` (info stays prefix-less) so the
  severity is legible even when ANSI colour is stripped — a piped /
  redirected CLI run, `NO_COLOR`, or the colourless studio child pipe; the
  studio LOGS panel re-colours each line off that prefix. Under
  `cdkl studio --watch` it appends
  `--watch` to each serve child — read off the mutable config per
  `start()`, so a Session-bar toggle applies to the next serve. Issue go-to-k/cdk-local#355
  added env-vars to the `alb` / `ecs` serve composers: `start()`
  materializes the env-kv option via `resolveEnvVars` into a SAM-shape
  temp file and appends `--env-vars <file>` so the override reaches the
  backing ECS task containers (`start-service` / `start-alb` overlay the
  `Parameters` map onto every container). The temp dir outlives the child
  (a `--watch` serve re-reads it on reload) and is removed on teardown via
  `closeProxies`),
  studio-proxy
  (issue go-to-k/cdk-local#282, slice C2 — a capturing reverse proxy in front of each
  HTTP serve endpoint: forwards every request verbatim to the upstream
  `start-api` child while emitting `invocation` start/end events
  (method / path / headers / bounded body + response status / headers /
  bounded body) onto the bus, so every request to the served port lands
  on the timeline regardless of source — browser / curl / pad alike
  (decision D4a); `Upgrade` (WebSocket) requests are raw-bridged without
  capture. The upstream it will front is bounded to LOOPBACK (issue go-to-k/cdk-local#578):
  studio learns a serve child's endpoint by regex-matching its stdout, so
  the URL is only ever as trustworthy as the line that carried it — an
  ordinary application log (`Server listening on http://0.0.0.0:3000` is
  what a web framework prints) or a warn relaying a wire-derived AWS SDK
  message could otherwise name any host, and every composer request,
  headers and body included, would be forwarded there. Three bounds, in
  `studio-serve-manager` and in `startStudioProxy` itself: a line carrying
  cdk-local's own `WARN: ` / `ERROR: ` prefix is never pattern-matched at
  all (`classifyChildLine` strips ANSI, the verbose `<ts> <LEVEL>` preamble
  and a `[module]` tag first, so anchoring survives `--verbose`); every
  ready pattern is anchored to the start of the line; and the resolved
  upstream must be loopback (`normalizeLocalUpstream`) or the serve is
  refused with a warn rather than flipped to running against a foreign
  host. A WILDCARD bind address (`0.0.0.0` / `::`) is REWRITTEN to
  `127.0.0.1` rather than refused — it is a bind address, not a
  destination, and `--container-host 0.0.0.0` is an ordinary value studio
  auto-renders. The same bound covers the `ecs` `hostUrl` that
  `parsePublishedHostEndpoint` derives from the replica publish banner,
  which the request composer targets DIRECTLY (un-proxied)), studio-store (issue go-to-k/cdk-local#282, slice C3 — the in-memory event
  store: subscribes to the bus and retains a bounded, newest-wins window
  of invocations + log lines so the server can answer history on
  (re)connect, full-text log search across the session, and
  per-invocation log binding at CloudWatch granularity (decision D5 — the
  single-shot invoke kinds (lambda + agentcore, issue go-to-k/cdk-local#309) bind strictly
  by container id; a captured serve request binds best-effort by target +
  time window). alb / ecs serve kinds still to
  come), etc.
- `src/assets/` — asset manifest loader + docker-build for container Lambdas.
- `src/utils/` — cross-cutting helpers, notably aws-proxy (issue go-to-k/cdk-local#634:
  `buildProxyClientConfig()` — the proxy-aware AWS SDK client seam. The SDK
  does not read `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` on its own, so
  EVERY AWS SDK client construction in `src/**` spreads this fragment —
  directly, or via `buildStsClientConfig`, which spreads it internally. It
  is `{}` when no proxy variable is set (zero behavior change); when one is
  set it carries a per-request-routing `requestHandler` plus a
  default-chain `credentials` provider whose `clientConfig` threads the
  handler into the SSO / SSOOIDC hops the service client's own handler
  never reaches. That routing is `resolveProxyForTarget`, which answers TWO
  questions per request: `NO_PROXY`, and the proxy's SCHEME — an `http(s):`
  proxy is used (a `CONNECT` tunnel for an https target, an absolute-form
  request line for an http one), and any other (a SOCKS `ALL_PROXY`, an ordinary
  spelling `getProxyForUrl` honours) falls back to a DIRECT connection with
  a one-time warn naming ONLY the scheme — or `(unrecognized)` when the value
  carries no LEADING `scheme://`, or one longer than 32 characters — since a
  proxy URL routinely carries
  `user:password@`, and a scheme match that did not require `://` would name
  the USERNAME of exactly such a value (`corp-user:s3cr3t@http://proxy:3128`
  comes back from `getProxyForUrl` VERBATIM, `://` and all, so "contains
  `://`" is not the test — "starts with `scheme://`" is). ONE site owns it because two did not: issue go-to-k/cdk-local#663
  was `proxyAwareFetch` having the scheme guard while this seam built an
  HTTP agent pointed at the SOCKS port, from the same environment. Falling
  back beats REFUSING because before either seam existed every one of these
  requests went direct, so refusing keeps an `ALL_PROXY=socks5://` user who
  has working direct egress broken with nothing left to configure — and the
  warn removes refusing's only argument, that a fallback is silent. An
  UNPARSABLE proxy value still throws: a typo has no working setup behind
  it. `tests/unit/utils/aws-proxy-client-audit.test.ts` fences
  the sweep repo-wide; both helpers are re-exported from `src/internal.ts`.
  Issue go-to-k/cdk-local#647 added the SECOND seam, `proxyAwareFetch(url)`: not every
  AWS-bound request is an SDK call, and the global `fetch` (undici) reads no
  proxy variable either, so the layer ZIP download from its presigned
  `Content.Location` (`layer-arn-materializer`) and the Cognito JWKS / OIDC
  discovery reads (`cognito-jwt`) connected DIRECT while every SDK call
  tunneled. It IS `globalThis.fetch` when no proxy variable is set, and
  otherwise GETs through the same `EnvRoutingProxyAgent` — the same
  per-request `NO_PROXY` decision — following redirects, decoding a
  `Content-Encoding` body `node:http` would otherwise leave compressed,
  bounding the request (`node:http` has NO default timeout, so an
  unresponsive proxy would otherwise hang `cdkl` forever), and naming no URL
  in any error it raises (a presigned URL carries `X-Amz-Signature` in its
  query string). GET-only by construction. A FRESH agent per redirect hop,
  because `http-proxy-agent` rewrites the request line to absolute form
  inside `connect()`, which a keep-alive agent skips when it reuses a pooled
  socket. The request bound is a STALL timer — re-armed on the response
  headers and on every body chunk, i.e. inactivity like undici's, not a
  wall-clock total that would abort a slow-but-progressing 250 MB layer ZIP —
  and it rejects DIRECTLY, not via `req.setTimeout` and not via
  `req.destroy(err)`: the socket timer arms only once a socket is assigned,
  and `https-proxy-agent` assigns one only after the CONNECT tunnel is up, so
  a proxy accepting TCP and never answering CONNECT — the production shape for
  an https JWKS or presigned URL — went unbounded, while `destroy(err)` with
  no socket assigned emits no `error` at all. The plain-http path is the one
  where the socket timer DOES work, which is how it looked correct while
  leaving the real case open. The JWKS / discovery reads pass a SHORTER bound
  than the 300 s default, because `agentcore-serve-auth` verifies per request
  with no discovery cache. `isLoopbackHost` normalises before comparing for
  the same class of reason: `URL.hostname` KEEPS an IPv6 literal's brackets
  (`http://[::1]/` -> `"[::1]"`), so bare `'::1'` comparisons were dead code
  and an IPv6-loopback issuer was proxied; it also treats the WILDCARD address
  (`0.0.0.0` / `::`) as this machine, matching `studio-proxy`'s
  `isWildcardHostname`. The proxy-SCHEME rule that once lived only on this
  seam — a proxy URL whose scheme is not `http(s):` (a SOCKS `ALL_PROXY`)
  falls back to a direct request rather than being spoken HTTP at — is now
  SHARED with `EnvRoutingProxyAgent` through `resolveProxyForTarget`, and
  warns once per scheme instead of falling back in silence (issue go-to-k/cdk-local#663).
  `tests/unit/utils/loopback-predicate-agreement.test.ts` fences this
  predicate against `studio-proxy`'s, which cannot share a module with it.
  A target the proxy environment does NOT cover — a `NO_PROXY` match,
  or any LOOPBACK host — is handed back to `globalThis.fetch` rather than run
  through the hand-rolled path, so every direct request keeps undici's
  semantics unchanged. The loopback rule is unconditional and is the one
  place this seam deliberately diverges from `EnvRoutingProxyAgent`: a
  forward proxy has no route to the caller's own loopback, and cdk-local's
  loopback reads include a JWT authorizer's local-IdP JWKS, whose
  unreachability does not deny requests but degrades the verifier to accept
  EVERY token. Private / RFC 1918 ranges are NOT exempted — a corporate proxy
  plausibly reaches those, so that stays `NO_PROXY`'s call.
  `tests/unit/utils/aws-proxy-fetch-audit.test.ts` fences it repo-wide and
  FAILS CLOSED on the two spellings it scans for — a bare `fetch(` call and
  a `globalThis.fetch` reference — each of which must be proxy-aware or
  carry a `// proxy-audit: ignore: <reason>` line. The reasoned exemptions
  are the loopback container clients (`agentcore-client`, `rie-client`), the
  emulated data path (`rest-v1-integrations`' `HTTP` / `HTTP_PROXY`
  integration forwarding to the user's own backend) — neither of which the
  deployed service would send through a developer's proxy — and
  `proxyAwareFetch`'s own no-proxy branch. Its BOUNDS are stated in the
  test's docstring rather than left implicit, and the load-bearing one is
  that an ALIASED binding (`options.fetchImpl ?? fetch`, the shape
  `agentcore-a2a-client` / `agentcore-mcp-client` / `studio-request-relay`
  use) is NOT in the population; all three target loopback, so the gap costs
  nothing today, but a remote-host caller written that way would escape. NOT re-exported from `src/internal.ts` — no
  host-side use case has come up, and `buildProxyClientConfig` covers the
  SDK surface a host CLI actually constructs).
- `src/types/` — shared interfaces (`StackState`, `ResourceState`,
  `CloudFormationTemplate`) — shaped as a strict subset of cdkd's state
  schema so host-side state can flow into cdk-local unchanged.

`tests/integration/local-*` — per-fixture real-Docker E2E tests
(`verify.sh` runs the CLI against a deployed-style fixture). cdk-local
itself does not invoke AWS; integration tests that need `--from-cfn-stack`
deploy via the upstream `cdk` CLI.
