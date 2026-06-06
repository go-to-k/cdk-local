# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

**cdk-local** is a CDK-native local execution CLI. Bin name: `cdkl`, npm
package: `cdk-local`. Read your CDK app's `cdk.json`, synth it, and run the
synthesized Lambda functions / API Gateway routes / ECS tasks locally in
Docker — using real `public.ecr.aws/lambda/*` base images via the Lambda
Runtime Interface Emulator (RIE).

cdk-local is a **library + CLI** consumed by cdkd (and any other host that
wants CDK-app-aware local execution). The dependency direction is
**cdkd -> cdk-local** — cdk-local does NOT depend on cdkd.

## Scope: what runs locally, what doesn't

cdk-local runs your **application compute** locally; it does NOT emulate
AWS managed services.

### Runs locally (application compute)

- Lambda functions — your code in a real `public.ecr.aws/lambda/*`
  container via the Lambda Runtime Interface Emulator
- API Gateway routing — REST v1 / HTTP v2 / Function URL / WebSocket
  served by a local HTTP server
- ECS tasks and services — real Docker containers with awsvpc /
  Service Connect / Cloud Map registry. `start-service` runs a service's
  replicas only (pure compute, no load balancer). `start-service --watch`
  and `start-alb --watch` re-synth + per-replica roll every booted ECS
  service when the CDK source changes. A per-firing classifier picks
  the per-replica primitive — Phase 4 of issue #214 added a bind-mount
  source FAST PATH for source-only edits, on top of the Phase 1-3
  rebuild rolling primitive. Source-only edits (interpreted-language
  handler — Node / Python / Ruby / shell — no Dockerfile, no
  dependency manifest, no compiled-language source) `docker cp` the
  freshly-synthed asset directory's contents into each replica's
  WORKDIR + `docker restart`: no `docker build`, no shadow boot. The
  container's docker network IP and host port are preserved across
  the restart, so the pre-restart drain of Cloud Map handles + the
  front-door pool entry and the post-TCP-ready re-publish under the
  SAME per-replica owner key are a no-op at the end-state contract
  level — but the drain-then-republish round trip is what preserves
  the multi-replica zero-connection-refusal guarantee while the
  SIGTERM'd container is restarting. Reload log surfaces
  `verdict=soft-reload (...)` and per-replica `Soft-reloaded replica
  ... restart + TCP-ready probe complete; Cloud Map + front-door
  re-published`. Typical end-to-end latency well under a second.
  Dockerfile / dependency manifest / compiled-language source
  / ambiguous edits fall through to the rebuild path — boot a shadow
  replica under a bumped generation suffix, atomically swap Cloud Map
  / front-door pool registrations off the dying replica (after a
  pre-swap TCP-ready probe on the shadow's container port confirms
  it's accepting), then retire the old container. Reload log surfaces
  `verdict=rebuild (...)` naming the trigger.
  Single replica => start one, swap or restart, stop one (rebuild
  path) or restart-in-place (soft-reload path); multi-replica =>
  sequential per-replica roll so the service stays available across
  the reload, and an external request stream against the ALB listener
  port observes zero connection refusals across the reload (Phase 1 +
  Phase 2 + Phase 3 of issue #214; the soft-reload path is similarly
  per-replica sequenced). The classifier defaults to rebuild on
  any ambiguity (asset manifest unreadable, unrecognized change) —
  slow-but-correct beats fast-but-stale. The one ambiguity-default
  the reload pathway pre-empts is "target image is not a CDK docker-
  image asset" (deployed-registry pin under `--from-cfn-stack`
  against `ContainerImage.fromEcrRepository(...)`, or a public-
  registry pin): the rolling primitive would re-pull byte-identical
  content and surface `Reload complete.` as a silent no-op, so the
  reload SKIPS the roll for that target with a `Reload skipped for
  '<target>' (no-op): image pinned to deployed registry; no local
  rebuild possible.` log, and the same configuration triggers a
  loud boot-time WARN per affected target so the user knows local
  source edits will not take effect before they spend time saving
  files (issue #234; #238 broadened the WARN to fire on any cold
  start when an ECR pin is detected, not just under `--watch`).
  Issue #238 also added the `--image-override` flag family to
  `cdkl start-service` / `cdkl start-alb` (`--image-override
  <svc>=<dockerfile>` or bare `<dockerfile>` for picker form,
  `--image-build-arg` / `--image-build-secret` / `--image-target`
  as build-input pass-throughs, `--no-interactive-overrides`
  to suppress the TTY boot prompt + multi-select picker, and
  `--strict-overrides` to fail fast when any pinned target remains
  uncovered): a covered pinned target is rebuilt locally from the
  supplied Dockerfile (deterministic local-only tag
  `cdkl-override-<svc>-<hash>:local`) and threaded through the
  rebuild rolling primitive on `--watch` reload — the engine module
  lives in `src/local/image-override-engine.ts`. Issue #262 retained
  the post-Stage-3 `ImageOverrideMap` so every `--watch` reload firing
  re-invokes `runImageOverrideBuilds` per covered target (no Stage 1
  picker re-fire, no Stage 3 prompt re-fire, no orphan re-validation
  — those are boot-time-only); a source edit under the covered
  Dockerfile's context flips the content-addressed tag and the
  rolling primitive boots a shadow against the freshly-built image
  (per-target rebuild failure logs a warn + keeps the old replica
  serving + lets sibling targets continue rolling). Issue #240 added
  per-service variants of the three build-input flags
  (`<svc>:KEY=VAL` for build-arg / build-secret, `<svc>=stage` for
  target); the per-service form overrides the global per-key on the
  named target, and an orphan validator
  (`enforceImageOverrideOrphans`) fails the boot when a per-service
  flag names a service the resolved override map does NOT cover
  (typo / forgotten `--image-override` mapping). Issue #388 extended
  the SAME `--image-override` flag family to `cdkl run-task`: a pinned
  (deployed-registry) task-definition container image is rebuilt from
  the supplied Dockerfile and threaded into the run via
  `imageOverrideByContainer` (a task def has ONE override target — its
  representative essential container — so the picker / boot-prompt forms
  map to that single target; `resolveRunTaskImageOverride` reuses the
  shared engine primitives, and a pinned-but-uncovered image WARNs that
  local source edits will not take effect).
  The host front-door (TLS materials, JWKS cache,
  Lambda-target RIE containers, listener sockets) is built once at
  boot and is NOT recreated on reload — only the per-service replica
  pool entries rotate. Lambda target groups behind the ALB are a
  no-op on `--watch` reload (the warm RIE container keeps its
  boot-time image; Lambda hot-reload is the start-api path's
  concern). `start-alb` is the ALB
  counterpart of `start-api`: name the ALB, and it boots the ECS
  service(s) behind it plus a local front-door that round-robins each
  listener port across the replicas and routes the listener rules across
  the backing services. HTTP **and HTTPS** listeners are served — a
  cloud-HTTPS listener is served over plain HTTP locally by default
  (with `X-Forwarded-Proto: https` preserved + redirect `#{protocol}`
  resolving to `https`, so the upstream app still sees the deployed
  listener protocol; the degradation is logged per-listener so it is
  never silent). `--tls` (or `--tls-cert` / `--tls-key`, which imply
  `--tls`) opts in to real TLS termination, using the user-supplied
  PEM pair or an auto-generated self-signed cert (cached under
  `$XDG_CACHE_HOME/cdk-local/alb-https/`, default
  `~/.cache/cdk-local/alb-https/`; `openssl` invoked once on cache
  miss). The deployed Listener `Certificates[]` ACM ARNs are not
  fetched because ACM private keys are not retrievable by design. All six ALB
  rule-condition fields are honored (`path-pattern`, `host-header`,
  `http-header`, `http-request-method`, `query-string`, `source-ip`),
  along with weighted forwards and `redirect` / `fixed-response` actions.
  `authenticate-cognito` / `authenticate-oidc` actions are enforced
  locally with a Bearer-JWT check (signature + `iss` + `aud` + `exp`
  against the same JWKS / OIDC discovery URL the deployed ALB would) or
  an `AWSELBAuthSessionCookie-*` pass-through; `--bearer-token <jwt>`
  injects a default token, `--no-verify-auth` disables the guard. The
  full OAuth roundtrip (redirect to the IdP's authorize endpoint +
  callback + cookie issuance) is NOT reproduced. **WebSocket Upgrade**
  is proxied for ECS forward targets — the upgrade request goes through
  the same listener-rule matching + auth-gate pipeline as a regular
  HTTP request, then the client's raw TCP socket is bridged to the
  picked replica with `Upgrade` / `Sec-WebSocket-*` headers preserved
  (Lambda target groups refuse the upgrade with a 502, mirroring ALB
  itself). A `TargetType: lambda` target group is served by invoking
  the backing Lambda locally (HTTP request -> `requestContext.elb`
  event -> RIE -> response), so a forward can mix ECS and Lambda
  targets. Each Lambda target's container gets the SAME env as a direct
  `cdkl invoke` (issue #380): its declared `Environment.Variables`,
  `--from-cfn-stack` intrinsic substitution, and `--assume-role` STS /
  `--profile`-resolved creds are injected via the shared
  `resolveLambdaContainerEnv` (resolved once per unique backing Lambda at boot
  — boot-time only, like the rest of the front-door). As with
  start-cloudfront's front-door Lambda path, the resolved creds ride the
  container env overlay (so the standard SDK credential chain resolves them);
  the named-profile credentials-FILE mount `cdkl invoke` adds is not
  reproduced, so a handler reading creds via an explicit `fromIni({ profile })`
  is the one `--profile` case not covered. `--env-vars` overlays the same
  SAM-shape `Parameters` it overlays onto the ECS task containers
- Bedrock AgentCore Runtime agents — the agent served over its protocol
  contract, invoked once locally (`cdkl invoke-agentcore`); covers both the
  container artifact and the CodeConfiguration managed-runtime artifact
  (`fromCodeAsset` AND `fromS3` — Python 3.10-3.14 / Node 22, built from source:
  a generated Dockerfile runs the EntryPoint AS-IS — no dependency install,
  matching the managed runtime, which resolves deps vendored into the bundle at
  deploy time, NOT a runtime `pip install` — so a bundle that forgot to vendor
  its deps fails locally the same way it fails deployed; a dependency manifest
  (`requirements.txt` / `pyproject.toml`) present without vendored deps WARNs
  with the `uv pip install --target` vendoring recipe), which self-serves the
  contract; a `fromS3` bundle's ZIP is downloaded from S3
  and extracted first — `Code.S3.Bucket` may be a literal or, under
  `--from-cfn-stack`, a `Ref` / `Fn::ImportValue` / `Fn::GetStackOutput`
  intrinsic resolved against state) on the HTTP and MCP protocols. HTTP runs the
  `POST /invocations` + `GET /ping` contract on 8080: an inbound
  `customJwtAuthorizer` is enforced locally (`--bearer-token` verified against
  the runtime's OIDC discovery URL before the container starts — signature +
  issuer + expiry + audience + `allowedScopes` + `customClaims` — and forwarded
  to `/invocations`; `--sigv4` is an opt-in alternative that signs the
  `/invocations` POST with AWS SigV4 — service `bedrock-agentcore` — when no
  customJwtAuthorizer is declared, forwarding the same `Authorization` /
  `X-Amz-*` headers the cloud receives), and a streaming SSE (`text/event-stream`) response is printed
  to stdout incrementally. `--ws` instead streams over the agent's bidirectional
  `/ws` WebSocket endpoint on the same 8080 container — the event is sent as the
  first frame and received frames are printed to stdout until the agent closes.
  MCP runs the Streamable-HTTP `POST /mcp` contract on
  8000: the session handshake (initialize -> notifications/initialized) then one
  JSON-RPC request (`tools/list` by default, or the method/params from
  `--event`). `--from-cfn-stack` deepens to parity with `cdkl invoke` /
  `run-task`: a same-stack ECR ContainerUri resolves to the deployed image,
  `AWS::SSM::Parameter::Value` env values resolve (decrypted `SecureString`
  values kept off the `docker run` argv), and bare `--assume-role` resolves an
  intrinsic `RoleArn` from state. Issue #255 added `--watch` on the
  long-running `--ws` session path: the
  per-firing classifier shared with `start-service` / `start-alb`
  (Phase 4 of issue #214) decides `'rebuild'` vs `'soft-reload'`;
  source-only edits on an interpreted-language handler `docker cp` +
  `docker restart` the running container, Dockerfile / dependency /
  compiled-source / ambiguous edits SIGTERM the old container and
  rebuild from scratch. The active `/ws` socket is closed cleanly on
  every reload firing (AgentCore has no protocol-defined mid-session
  container handoff) so the next session connects to the rebuilt
  container — the honest local-dev semantic. `--watch` on the
  single-shot HTTP `POST /invocations`, MCP `POST /mcp`, and A2A
  `POST /` paths logs a one-line WARN and proceeds single-shot.
  `cdkl start-agentcore` is the long-running serve counterpart of the
  single-shot `invoke-agentcore`: it boots the agent
  container ONCE (same image / env / `--from-cfn-stack` / `--assume-role`
  / `--bearer-token` resolution as `invoke-agentcore`) and keeps it warm,
  serving its native HTTP contract on one host port until `^C` — so a
  client can hit `POST /invocations` (+ `GET /ping`) **repeatedly against
  the SAME warm container** (issue #454), mirroring AgentCore's deployed
  model where many `InvokeAgentRuntime` calls on one `runtimeSessionId`
  reuse one warm microVM (vs single-shot `invoke-agentcore`, which boots +
  tears down per call). The request body is streamed up and the response —
  JSON or an SSE `text/event-stream` — streamed back. The boot-resolved
  `Authorization` (a `--bearer-token` validated once under a
  `customJwtAuthorizer`, or the `--sigv4` header set) is injected on every
  forwarded request; per-request inbound JWT verification is a follow-up.
  For HTTP / AGUI runtimes, on the SAME port it also serves the
  bidirectional `/ws` endpoint behind a host WebSocket BRIDGE so a
  header-less client — a browser `WebSocket`, which cannot set the
  `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` (or `Authorization`)
  upgrade header — can hold an interactive multi-frame session. The bridge
  accepts the header-less client on the serve `--port` (default 0) and opens
  a `ws` connection to the container `/ws` with those headers injected (a
  fresh session-id UUID per inbound connection / per forwarded HTTP request,
  unless `--session-id` pins one), piping frames both ways. All four
  protocols are served (issue #454, slice 2 dropped the MCP / A2A reject):
  HTTP / AGUI on 8080 (`POST /invocations` + `GET /ping` + `/ws`), MCP on
  8000 (`POST /mcp`), and A2A on 9000 (`POST /`). The proxy is
  protocol-agnostic — only the routing table, the `/ws`-attach decision, and
  the readiness probe differ per protocol (MCP / A2A have no `GET /ping`, so
  readiness is an HTTP response to the protocol path; they are pure
  request/response pass-through with no `/ws`, the client driving the
  handshake). HTTP / AGUI print a `Server listening on ws://...` ready line
  (kept verbatim for studio's agentcore-ws serve) plus an `HTTP contract
  served on http://...` line; MCP / A2A print a `Server listening on
  http://...` line plus a `<PROTOCOL> contract served on http://...<path>`
  line. Runs until `^C` (`--watch` is a follow-up). The `cdkl
  invoke-agentcore` terminal path (interactive over stdin in a TTY) is
  unchanged
- API Gateway authorizers — Lambda authorizers, Cognito User Pool JWT
  verification, IAM SigV4 verification
- CloudFront distributions — the `viewer-request` -> S3 origin ->
  `viewer-response` pipeline served locally (`cdkl start-cloudfront`,
  issue #363). The distribution's `AWS::CloudFront::Function`s (inline
  rewrite JS — URL rewrites, trailing-slash normalization, SPA fallback,
  header tweaks) are your own application compute and run in-process in a
  `node:vm` sandbox (`cloudfront-js-1.0` / `2.0`, async handlers awaited).
  The sandbox reproduces the CloudFront-Functions-2.0 runtime built-ins a
  bare vm context lacks (issue #410): the `Buffer`, `atob` / `btoa`,
  `TextEncoder` / `TextDecoder` globals + a `require` for the `crypto`
  (`createHash` / `createHmac`) / `querystring` / `buffer` modules — backed
  by the Node equivalents (a superset of the documented 2.0 subset), so a
  function using `Buffer.from(...).toString('base64')` for a Basic-Auth check
  runs locally instead of failing with `Buffer is not defined`. `fs` /
  `process` / timers / network / `eval` are not provided as globals (a
  `ReferenceError`, matching the restricted runtime); the vm is a fidelity
  sandbox, not a security boundary (moot — the function code is the user's own).
  The S3 origin content is the BucketDeployment source asset resolved out
  of the cloud assembly (walk the origin's bucket -> its
  `Custom::CDKBucketDeployment` -> `SourceObjectKeys` -> the staged asset
  dir), served with `DefaultRootObject` (root only — sub-paths are NOT
  auto-indexed, matching CloudFront) and `CustomErrorResponses` (the SPA
  fallback). When an S3 origin has NO local BucketDeployment source — the
  front/back-split case where the CDK repo defines the distribution +
  bucket but the static files are uploaded out of band by a separate
  frontend repo / pipeline — `--from-cfn-stack` resolves the deployed
  bucket NAME and serves it by reading from **real S3 on demand** (issue
  #405): a request-time `GetObject` per touched key (no pre-sync, so a CDN
  bucket with 100k objects is fine — a test touches a handful), reusing the
  same URI->key / `DefaultRootObject` / `CustomErrorResponses` resolution
  (`cloudfront-s3-origin`). The bucket name is resolved in priority order
  (issue #405 + follow-up): a same-stack CDK bucket's physical id from
  `ListStackResources`; else a literal bucket name parsed from the origin's
  `DomainName` (an external / imported-by-name bucket); else — when the name
  is a pure intrinsic (a `Ref` parameter / cross-stack import) — from the
  deployed distribution via `cloudfront:GetDistributionConfig`
  (`cloudfront-distribution-config`). The choice is automatic per origin (local
  BucketDeployment source -> real-S3 under `--from-cfn-stack` ->
  `--origin <id>=<dir>` override), logged per origin, gated only by the
  existing `--from-cfn-stack` flag; an `AccessDenied` (OAC-locked bucket
  the dev creds cannot read) warns with the `--origin` escape hatch.
  `--cache-origin` opts into an in-memory read-through cache of fetched
  objects for the session (cleared on each `--watch` reload; off by default
  so every request re-reads / is always current). Reads use
  the `--profile` / default credential chain. Path patterns route across
  `DefaultCacheBehavior` +
  `CacheBehaviors[]` (the existing ALB `*`/`?` glob matcher). A
  viewer-request function returning a `statusCode` short-circuits with a
  generated response (redirect / fixed body); otherwise the rewritten
  request continues to the origin, then the viewer-response function runs
  over the origin response. A behavior's
  **`AWS::CloudFront::ResponseHeadersPolicy` CORS** (`CorsConfig`, attached
  via `ResponseHeadersPolicyId`) is reproduced at the edge per behavior: a
  matching `OPTIONS` preflight is answered with the canonical `204` + CORS
  headers before the origin is hit, and an actual response gets
  `Access-Control-Allow-Origin` (+ `Vary: Origin` / `Allow-Credentials` /
  `Expose-Headers`) added last (mirroring `CorsConfig.OriginOverride`).
  Origin matching is literal-or-`*` (a wildcard-subdomain entry like
  `https://*.example.com` is not matched; an AWS-managed policy id literal is
  not fetchable so its CORS is skipped). The CORS headers are always applied
  last (the policy wins), so `CorsConfig.OriginOverride: false` is not
  distinguished from `true` — an origin that emits its own
  `Access-Control-Allow-Origin` is still overridden locally. The non-CORS
  parts of a response headers policy (`SecurityHeadersConfig` /
  `CustomHeadersConfig` / `RemoveHeadersConfig` / `ServerTimingHeadersConfig`)
  are not applied. A
  **Lambda Function URL origin**
  (`origins.FunctionUrlOrigin`) is also served (issue #376): the origin's
  `DomainName` (`Fn::Select[2, Fn::Split['/', GetAtt[Url, 'FunctionUrl']]]`)
  resolves to the `AWS::Lambda::Url` -> its `TargetFunctionArn` -> the
  backing `AWS::Lambda::Function`, which is booted once in a warm RIE
  container; a request routed there is invoked as a Function URL (payload
  v2.0) event and its response (status / headers / body / `cookies`)
  becomes the origin response (the viewer-response function still runs over
  it). So start-cloudfront is pure-local (no Docker) for a pure-S3
  distribution, and boots a Lambda container ONLY when the distribution has
  a Function URL origin. That Lambda gets the SAME container env as a direct
  `cdkl invoke` (issue #380): its declared `Environment.Variables` are
  injected, `--from-cfn-stack [name]` substitutes intrinsic env values
  against a deployed stack (SSM / cross-stack / deployed-env fallback), and
  `--assume-role [arn]` (bare auto-resolves the execution role from state)
  injects STS creds into the container — via the shared
  `resolveLambdaContainerEnv` the front-door Lambda boot path now calls.
  `--profile` / `--region` shape the creds / region; without a state flag
  the dev shell's creds are forwarded and intrinsic env values are dropped
  (warn-per-key), matching `cdkl invoke`. AWS_IAM auth on the Function URL is
  still not enforced; response streaming is buffered. `--watch`
  re-synths + atomically swaps the in-memory routing model under the live
  socket (the viewer functions + S3 origins reload; a Function URL origin's
  warm container is boot-time only, NOT rebuilt on reload — restart to pick
  up a new one). `--tls` terminates real HTTPS (reusing the ALB front-door's
  self-signed cert path); `--origin <id>=<dir>` points an origin at a local
  directory when BucketDeployment resolution cannot AND the deployed-S3
  read-through is not wanted (content uploaded out of band, non-CDK bucket);
  `--no-pull` skips the docker pull for a Function
  URL origin's base image. A CloudFront Function's **KeyValueStore**
  reads (`import cf from 'cloudfront'; cf.kvs().get(key)`) are reproduced
  (issue #399): the `import cf from 'cloudfront'` line is stripped and a `cf`
  module is injected into the `node:vm` sandbox whose `cf.kvs().get` /
  `exists` are backed by either the deployed store (`--from-cfn-stack` resolves
  the `AWS::CloudFront::KeyValueStore` ARN from state — the physical id is the
  store NAME, looked up to its ARN via the control-plane `ListKeyValueStores` —
  and reads it through the real `cloudfront-keyvaluestore` `GetKey` data-plane
  API, SigV4A-signed) or a local JSON map (`--kvs-file <kvsLogicalId>=<file>`,
  the AWS-free escape hatch symmetric with `--origin`). A KVS read with no
  binding fails with an actionable error naming both flags; `cf.kvs().meta()` /
  `count()` and KVS writes are not reproduced. A behavior's
  **Lambda@Edge** functions (`LambdaFunctionAssociations`) ARE run (issue
  #400): each is real Lambda code, booted once in a warm RIE container (the
  same machinery as a Function URL origin, with the same `cdkl invoke`
  container env), and invoked at its event point with the Lambda@Edge event
  shape (`{ Records: [{ cf: { config, request, response } }] }`). All four
  event types are wired into the pipeline — `viewer-request` /
  `origin-request` (before the origin fetch; either may short-circuit with a
  generated response or rewrite the request) -> origin -> `origin-response` /
  `viewer-response` (modify the response). `IncludeBody` surfaces the request
  body (base64); the `request.origin` rewrite block + the edge size/timeout
  tiers are out of scope. S3 + Lambda Function URL
  origins ONLY: a generic custom (non-S3, non-Function-URL) origin and the
  2.0 `cf.fetch` origin API are WARN-and-skip (custom / unresolved origins
  return 502).
  Single distribution per invocation (interactive picker when the target
  is omitted in a TTY). Also runnable from `cdkl studio` as the
  `cloudfront` serve kind (issue #367) — a [Start]/[Stop] control with a
  capture proxy, like `api` / `alb`; the session-global
  `--from-cfn-stack` / `--assume-role` bindings ARE forwarded to the studio
  cloudfront serve (issue #380, since start-cloudfront declares those flags
  for its Function URL origin Lambda), same as every other serve kind

### Calls real AWS (managed services)

- DynamoDB / S3 / Secrets Manager / SSM Parameter Store / Cognito user
  pool / SNS / SQS / Kinesis / EventBridge / Step Functions / etc.
- Your Lambda code talks to real AWS via:
  - `--assume-role <arn>` to inject IAM role credentials into the
    container
  - `--from-cfn-stack <stack>` to bind to a deployed CloudFormation
    stack and inject its real ARNs / Secret values into Lambda env
- cdk-local does NOT bundle a managed-service emulator.

When writing committed artifacts (README, docs, commit messages, PR
bodies, JSDoc), keep to this scope. Do NOT name, recommend, or compare
against any third-party product — no side-by-side tables, no
"pair with" / "use alongside" recommendations, no parenthetical
mentions, no examples. State cdk-local's scope on its own terms.
The only sanctioned tool comparison is to `sam local` (same
compute-locally category for Lambda + API Gateway).

## Architecture

`src/` layout:

- `src/cli/` — Commander command factories (`createLocalInvokeCommand`,
  `createLocalInvokeAgentCoreCommand`, `createLocalStartApiCommand`,
  `createLocalRunTaskCommand`, `createLocalStartServiceCommand`,
  `createLocalStartAlbCommand`, `createLocalStartCloudFrontCommand`,
  `createLocalStartAgentCoreCommand`,
  `createLocalListCommand`,
  `createLocalStudioCommand`) + shared option
  helpers. `createLocalStartCloudFrontCommand` (`cdkl start-cloudfront`,
  issue #363) is a thin, lean command (NOT through the ECS/Docker
  `runEcsServiceEmulator` — no Cloud Map): it synths, resolves one
  `AWS::CloudFront::Distribution` to an in-memory routing model, and
  serves its viewer-request -> origin -> viewer-response pipeline
  in-process. It is pure-local (no Docker) for an S3-origin
  distribution; a Lambda Function URL origin (issue #376) boots one warm
  RIE container per backing function via `createFrontDoorLambdaRunner`
  (stopped on shutdown, boot-time only — not rebuilt on reload), with the
  container env resolved by the shared `resolveLambdaContainerEnv`
  (extracted from `local-invoke.ts` so `cdkl invoke` and the front-door
  Lambda path agree — issue #380): `--from-cfn-stack [name]` /
  `--assume-role [arn]` / `--stack-region` give the Function URL Lambda the
  same env-var + deployed-state + execution-role injection as a direct
  `cdkl invoke`. `--watch`
  re-synths + swaps the routing model under the live socket; `--tls`
  reuses `front-door-tls`; `--from-cfn-stack` additionally promotes an S3
  origin with no local BucketDeployment source to a deployed-S3
  read-through origin served from real S3 on demand (issue #405 —
  `resolveDeployedS3Origins` resolves the bucket name (state physical id /
  literal `DomainName` / `GetDistributionConfig`) +
  builds an `S3OriginReader` per origin, boot-time only, re-annotated on
  each `--watch` reload via `annotateDeployedS3Origins`; `--cache-origin`
  opts the reader into an in-memory read-through cache, cleared on reload);
  `--origin
  <id>=<dir>` is the local-directory escape hatch when neither resolves;
  `--no-pull` skips the Lambda
  origin image pull; `--kvs-file <kvsLogicalId>=<file>` backs a CloudFront
  Function's KeyValueStore reads with a local JSON map (issue #399; the
  deployed-store alternative is `--from-cfn-stack`).
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
  server, issue #454) in front of the warm container: it proxies the
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
  `waitForAgentCoreHttpReady` for MCP / A2A, which have no `/ping`). New CLI
  options live in `addStartAgentCoreSpecificOptions` (`--port` / `--host` /
  `--session-id` / `--bearer-token` / `--no-verify-auth` / `--env-vars` /
  `--platform` / `--from-cfn-stack` / `--assume-role` / ...).
  `createLocalStudioCommand` (`cdkl studio`, issue #282) is the
  interactive web console over the same target enumeration — a control
  plane that spawns the SAME `invoke` / `start-api` / `start-alb` /
  `start-service` runners as child processes. It is on the user-facing
  command surface (the unveil slice removed the `CDKL_STUDIO_PREVIEW`
  gate) and exported from `src/index.ts` for host CLIs. Issue #301
  slice 1 added the session-global `--from-cfn-stack [name]` /
  `--assume-role <arn>` flags to `cdkl studio`: they bind the whole
  session and are forwarded verbatim to every spawned child (built in
  `src/local/studio-child-args.ts`). Issue #301 slice 3 made the
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
  already-running serves. Issue #301 slice 4 added
  `--stack <glob...>` (`filterStudioTargetGroups` in studio-server):
  a DISPLAY-only glob filter over the listed targets (a target id is
  `Stack/Construct`, so `dev/*` scopes to stack `dev`) — it does NOT
  scope synth (the whole app is still synthesized; gate synth with the
  app's own `-c` context / a committed `cdk.context.json`). Issue #303
  made AgentCore runtimes runnable from the UI: an `agentcore` target
  gets the same single-shot [Invoke] composer a Lambda does (the
  dispatcher spawns `cdkl invoke-agentcore`), with per-run options
  `--ws` / `--sigv4` / `--bearer-token` / `--session-id` / `--env-vars`.
  Issue #301 added `cdkl studio --watch`: serves started from the UI
  (`start-api` / `start-alb` / `start-service`) are spawned with
  `--watch` so they re-synth + rolling-reload on CDK source changes;
  it is an editable session mode (the Session bar `watch` toggle ->
  `PATCH /api/config`, applying to subsequently-started serves) and a
  no-op for single-shot invokes (each invoke re-synths anyway). The
  target list itself is not re-synthed (restart studio to pick up
  newly-added resources). Issue #301 also classifies each servable ECS
  service at boot (`resolveEcsServiceTarget` + `isLocalCdkAssetImage`):
  a deployed-registry-pinned service is marked `pinned` so the UI offers
  an image-override Dockerfile picker, and the app dir is scanned once
  (`discoverDockerfiles`, only when something is pinned) for the picker's
  options. The picker threads `--image-override <target>=<dockerfile>`
  through `coerceRunRequest` (validated) + the serve manager. Issue #354:
  when studio is booted with `--from-cfn-stack`, the boot pin
  classification threads the deployed-state image-resolution context per
  owning stack (`prepareEcsImageContexts` -> `buildEcsImageResolutionContext`
  -> `makePinClassifier` -> `resolveEcsServiceTarget(id, stacks, ctx)`), so a
  service pinned to an INTRINSIC ECR URI (only resolvable under
  `--from-cfn-stack`, e.g. `ContainerImage.fromEcrRepository(repo)`) is
  detected as pinned — matching `cdkl start-service --from-cfn-stack`; a
  service that cannot be classified now WARNs instead of silently going
  unmarked. Issue #385 made this re-runnable: a Session-bar
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
  sigv4-verify, rie-client, intrinsic-image, runtime-image, target-lister
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
  (`startAgentCoreHttpServer`, issue #454 — the host HTTP serve behind
  `cdkl start-agentcore`, protocol-aware via a `routes` + `attachWs` config:
  one `http.Server` proxies the declared `{method, path}` routes to the warm
  container, streaming request / response (SSE included) and injecting the
  session-id (fresh per request unless pinned) + Authorization headers, and
  — for HTTP / AGUI (`attachWs`) — delegates the `/ws` upgrade on the same
  port to `attachAgentCoreWsBridge`. So one warm container serves the HTTP /
  AGUI contract (`POST /invocations` + `GET /ping` + `/ws`), the MCP contract
  (`POST /mcp`), or the A2A contract (`POST /`) repeatedly; MCP / A2A are
  pure pass-through with no `/ws`) + agentcore-s3-bundle
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
  inject a fully-resolved env via `resolveLambdaContainerEnv` — issue #380 —
  instead of the default shell-creds-only forward), front-door-tls (resolves
  TLS materials for HTTPS listeners: `--tls-cert` / `--tls-key` pair or
  an auto-generated self-signed cert cached under XDG cache via openssl),
  front-door-auth (builds the per-action `AuthCheck` callback for
  authenticate-cognito / authenticate-oidc — reuses the cognito-jwt
  verifier for the Bearer-JWT path, plus an `AWSELBAuthSessionCookie-*`
  pass-through path), source-change-classifier (Phase 4 of #214 —
  pure per-firing classifier the `--watch` reload pathway calls per
  target to decide `'rebuild'` vs `'soft-reload'`; defaults to
  rebuild on ambiguity, requires the asset hash to actually flip
  before returning soft-reload so a CDK construct edit that changed
  the task spec doesn't get silently soft-reloaded with the OLD
  spec), image-pin-detector (issue #234 — classifies a booted ECS
  service's representative image as local CDK asset vs deployed-
  registry pin so the `--watch` emulator can WARN at boot and SKIP
  the no-op rolling primitive on each reload firing instead of
  re-pulling byte-identical content and surfacing `Reload complete.`
  as a silent no-op), image-override-engine (issue #238 — parses
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
  cloudfront-resolver (issue #363 — resolves an
  `AWS::CloudFront::Distribution` to a `ResolvedDistribution`: behaviors
  (default + `CacheBehaviors[]`) -> path pattern + viewer-request /
  viewer-response CloudFront Functions + per-event-type Lambda@Edge
  associations (issue #400 — each `LambdaFunctionAssociations[]` entry's
  `LambdaFunctionARN` resolved through its `AWS::Lambda::Version` to the
  backing `AWS::Lambda::Function` via `pickLambdaEdgeFunctionLogicalId`),
  origins (S3 origin -> local
  BucketDeployment source dir via the asset manifest, else an
  `s3-unresolved` origin the command promotes to `s3-deployed` real-S3
  read-through under `--from-cfn-stack`, issue #405 — `describeS3OriginDomain`
  also detects an external/imported-bucket origin from its `DomainName`
  (`<bucket>.s3[.-]...amazonaws.com`, literal / `Fn::Sub` / `Fn::Join`) and
  parses the literal bucket name, marking a pure-intrinsic name
  `deployedConfigOnly`; a Lambda Function
  URL origin -> backing `AWS::Lambda::Function` via the
  `Fn::Select/Split/GetAtt` `DomainName` + `AWS::Lambda::Url`
  `TargetFunctionArn`, issue #376; custom / unresolved origins flagged),
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
  `buffer`, issue #410 — into both the compile probe and the invoke sandbox;
  `stripCloudFrontImport` strips the 2.0
  `import cf from 'cloudfront'` line at compile time so a KVS-reading
  function compiles as a plain `vm.Script`, and the resolved `cf` module is
  injected under the binding name at invoke time — issue #399),
  cloudfront-kvs (issue #399 — the binding-agnostic `cf` KeyValueStore shim:
  `cf.kvs(id?)` -> a handle with `get` / `exists` over a `KvsDataSource`, the
  local-file data source, and the unbound module that fails a read with an
  actionable error), cloudfront-kvs-client (issue #399 — the AWS boundary:
  the deployed `GetKey` data source + `resolveDeployedKvsArnByName` which maps
  a store NAME to its ARN via the control-plane `ListKeyValueStores`; a
  side-effect `import '@aws-sdk/signature-v4a'` registers the SigV4A signer the
  `cloudfront-keyvaluestore` API requires), cloudfront-kvs-binding (issue #399
  — `resolveKvsModulesForDistribution`: walks each KVS-reading function, builds
  its `cf` module from a `--kvs-file` map or the deployed-ARN callback, and
  attaches it to the compiled function; re-run on each `--watch` reload),
  cloudfront-static-origin (serves a URI from the resolved S3
  origin dir(s): default-root-object at `/`, path-traversal guard, MIME
  by extension, `CustomErrorResponses` SPA fallback; the
  `resolveErrorResponseCandidates` 403-then-404 priority helper is shared
  with the deployed-S3 reader),
  cloudfront-s3-origin (issue #405 — the deployed-S3 read-through origin:
  `createS3OriginReader(bucketName)` serves an S3 origin that has no local
  BucketDeployment source by reading the DEPLOYED bucket from real S3 on
  demand — a request-time `GetObject` per touched key, reusing the
  static-origin URI->key / `DefaultRootObject` / `CustomErrorResponses`
  resolution; `classifyS3Error` maps a miss to the SPA fallback and an
  `AccessDenied` to an actionable `--origin` warning; the command promotes
  an `s3-unresolved` origin to `s3-deployed` under `--from-cfn-stack`),
  cloudfront-distribution-config (issue #405 follow-up — the
  `GetDistributionConfig` boundary: `resolveDeployedOriginBucket` reads the
  DEPLOYED distribution's origin `DomainName` and parses the bucket name from
  it, the fallback for a deployed-S3 origin whose bucket name is a pure
  intrinsic (a `Ref` parameter / cross-stack import) not derivable from the
  local template or stack state; never throws — a read failure resolves to
  undefined so the command falls back to the `--origin` guidance),
  cloudfront-lambda-origin (issue #376 — serves a Lambda Function URL
  origin: builds a Function URL payload-v2.0 event from the request
  (reusing `buildHttpApiV2Event` with a synthetic `$default` route),
  invokes the warm RIE container, and translates the v2 response
  (`translateLambdaResponse`) into the origin status / headers / body /
  cookies), cloudfront-edge-event (issue #400 — the Lambda@Edge wire format:
  builds the `{ Records: [{ cf: { config, request, response } }] }` event for
  each of the four event types, translates HTTP headers to / from the
  `{ name: [{ key, value }] }` multi-map, and interprets a handler's return as
  a continue-with-rewritten-request, a generated-response short-circuit, or a
  modified response — `applyEdgeRequestResult` / `applyEdgeResponseResult` are
  the server-facing orchestration helpers), cloudfront-server
  (the local HTTP/HTTPS server behind `start-cloudfront`: per-request
  behavior match -> (a matched behavior's ResponseHeadersPolicy CORS
  preflight short-circuit via `matchPreflight`) -> viewer-request fn ->
  Lambda@Edge viewer-request / origin-request (issue #400 — either may
  short-circuit or rewrite the request via the boot-time edge invoker map) ->
  origin (S3 static origin OR a deployed-S3 read-through origin via the
  boot-time `s3OriginReaders` map, issue #405, OR a
  Lambda Function URL origin via the boot-time invoker map) ->
  Lambda@Edge origin-response -> viewer-response fn THEN Lambda@Edge
  viewer-response (both run, CloudFront Function first) -> the behavior's
  actual-response CORS headers
  (`applyCorsResponseHeadersFromConfig`), with a mutable distribution cell so
  `--watch` swaps the routing model under the live socket),
  studio-custom-resource-filter (issue #323 —
  `isCustomResourceLambdaTarget` / `filterStudioCustomResources`:
  recognizes CDK custom-resource / provider-framework Lambdas by their
  construct path (provider-framework `framework-on*`, `LogRetention`,
  `BucketNotificationsHandler`, `AwsCustomResource`, CDK bucket
  deployment, the `AWS679...` singleton, plus a GENERIC `custom::`
  catch-all — issue #359 — that covers any provider Lambda whose
  `aws:cdk:path` uses a `Custom::`-prefixed node the name-specific
  patterns miss) so `cdkl studio` hides them from the target list by
  default — `--include-custom-resources` opts back in),
  studio-events (issue #282 — the typed in-process event bus every
  `cdkl studio` observation flows through (`invocation` / `log` /
  `serve` events); the studio HTTP server
  subscribes and forwards to the browser over SSE), studio-server
  (the localhost HTTP server behind `cdkl studio`: serves the embedded
  UI at `/`, the synthesized target list (+ the boot-discovered
  Dockerfiles + a `pinned` flag per ecs service — set by
  `annotatePinnedEcsTargets` — for the image-override picker, issue #301;
  plus a `pinned` flag per `ecs-task` task definition — set by
  `annotateEcsTaskPinnedTargets`, issue #388 — for the run-task image-override
  picker; plus `backingPinnedServices` per alb entry — set by
  `annotateAlbPinnedBackingServices`, issue #384 — for the ALB's
  per-backing-service image-override picker;
  CDK custom-resource / provider-framework Lambdas are excluded by
  default via `filterStudioCustomResources`, issue #323 — pass
  `cdkl studio --include-custom-resources` to surface them)
  at `/api/targets`, an SSE
  stream of the event bus at `/api/events` (which opens with a `hello`
  event carrying a per-boot `instanceId` and beats a JS-visible `ping`
  event every `SSE_HEARTBEAT_MS` so the UI can detect a dead / swapped
  server — see studio-ui's liveness watchdog), `POST /api/run` (single-shot
  invoke / serve start), `POST /api/stop` (serve stop),
  `GET /api/running` (running serve snapshot), `POST /api/request`
  (issue #322 — relay a composed HTTP request to a running serve via
  `studio-request-relay` so the browser composer reaches the served port
  same-origin; api / alb go through the capture proxy and land on the
  timeline, an ecs serve hits the replica host URL directly — from an explicit
  `--host-port` or an auto-published replica port, issue #392 — and that
  direct (un-proxied) ecs relay STILL lands on the timeline because the
  command emits the `invocation` start/end pair itself
  (`relayAndCaptureServeRequest`), so a Service request gets the same
  Request/Response timeline row + read-only detail an api / alb request does;
  an external curl straight to the host port is the one case not captured, no
  proxy intercepting it),
  `POST /api/reinvoke` (issue #284 — re-run a past Lambda / AgentCore
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
  workspace composer / timeline. The targets pane (issue #301) groups
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
  #301); Lambdas + AgentCore runtimes get an
  [Invoke] composer (`INVOKE_KINDS`), serve
  targets (api / alb / ecs / ecs-task / cloudfront / agentcore-ws) a
  [Start]/[Stop] control
  with a
  `running ● :port` indicator (ecs services + ecs-task runs show
  `running` with no port). The control surfaces transient in-progress states
  (issue #394): a Stop in flight shows "Stopping..." (disabled) until the
  `stopped` / `error` serve event settles it (tracked in a client-side
  `stoppingIds` set, settled in `onServeEvent` via `settleStoppingTransient`
  with a `MIN_STOPPING_MS` floor so a near-instant teardown — a `start-api` /
  pure-S3 `cloudfront` serve with no warmed containers tears down in tens of
  ms — still shows the affordance instead of flipping straight back to Start;
  the floor is a no-op for `alb` / `ecs`, whose real Docker teardown already
  takes longer), and a still-booting serve shows
  "Starting..." (disabled) — both inert so a double-click cannot re-fire stop /
  cancel mid-boot. Issue #352 lists ECS Services (the `ecs`
  serve kind) and ECS Task Definitions as SEPARATE target groups,
  matching `cdkl list`; issue #366 makes the task-definitions group the
  `ecs-task` kind — a [Run] control (labeled Run, not Start) that runs
  `cdkl run-task` as a long-running run (a server task def streams logs
  until [Stop]; a batch task exits and the run flips to stopped). It
  flips to `running` on the run-task `Task running (family=...)`
  onReady banner (a streaming run has no listening-port line). Once a
  serve is Started the
  composer's per-run option inputs are replaced by the running view, so a
  read-only "Started with" summary (issue #356 — `formatAppliedOptions`
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
  record (issue #398 — `buildOptions(kind, applied.options, applied.rawArgs)` +
  the image-override pickers), so the bearer token / curated option inputs /
  raw extra args / Dockerfile picks survive a restart instead of resetting. A served
  API Gateway WebSocket API additionally gets a WebSocket console
  (`renderWsConsole` — connect / send-frame / received-frame log) wired
  straight to its ws:// endpoint, with the socket + frame log held in module
  state so a log-driven serve re-render never drops the connection (issue
  #303); the SAME console renders for an `agentcore-ws` serve (an HTTP / AGUI
  AgentCore runtime's `/ws` endpoint served by `cdkl start-agentcore` behind a
  host bridge — the runtime is listed in a second "AgentCore WebSocket" group
  alongside its single-shot invoke entry, the same dual listing as the
  ecs / ecs-task split; only HTTP / AGUI runtimes appear there since MCP / A2A
  have no `/ws`), because the bridge's `ws://` endpoint flows through the same
  un-proxied `endpoints` path; every composer (invoke + serve) carries a collapsed "All options"
  `<details>` (`buildAllOptions`) with a raw extra-args input + the
  read-only auto-derived flag catalog from studio-option-catalog, so the
  curated controls handle common flags richly while every other flag the
  underlying command accepts stays reachable (issue #301); a PINNED ecs
  service (deployed-registry image, marked `pinned` in the target list)
  additionally gets an image-override Dockerfile picker
  (`buildImageOverridePicker`) populated from the boot-scanned Dockerfiles,
  threading `--image-override <target>=<dockerfile>` (the explicit form —
  studio's child has no TTY, so the bare picker form would be skipped) onto
  the serve body so `start-service` rebuilds the pinned image from local
  source; a local-asset service (which already hot-reloads under `--watch`)
  gets no picker (issue #301). A PINNED `ecs-task` task definition gets the
  SAME single picker (issue #388): the `ecs-task` composer threads
  `--image-override <target>=<dockerfile>` onto the run body so the spawned
  `cdkl run-task` rebuilds the pinned task-def image from local source
  (`makeTaskPinClassifier` + `annotateEcsTaskPinnedTargets` mark a pinned task
  def at boot). An `alb` serve gets the SAME picker for its
  pinned BACKING services (issue #384): `start-alb` boots the ALB's backing
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
  pre-filled + wired to re-invoke (issue #284, the [Re-invoke] button ->
  `POST /api/reinvoke`), a captured serve request opens a read-only
  Request/Response detail whose [Re-invoke] reuses that serve's request
  composer (pre-filled), and a re-invoked row is visually linked to its
  source; a log search box queries the store and a captured request's
  detail shows its bound logs. The header `● live` / `● disconnected`
  indicator is driven by `connect()`'s liveness logic: it binds to the
  FIRST `/api/events` `hello` instanceId, flips to disconnected (latched,
  socket closed) when a reconnect lands on a DIFFERENT instanceId (a second
  `cdkl studio` that reused this port after the originating process exited),
  and a heartbeat watchdog flips to disconnected when no `ping` / event
  arrives within the liveness window — so a dead server is detected even
  when the dropped socket never surfaces an EventSource `error`),
  studio-reinvoke (issue #284 — `reinvoke({invocationId, payload}, {store,
  dispatcher})`: resolves the source target from the recorded invocation
  and re-fires the edited payload through the SAME single-shot dispatcher
  `POST /api/run` uses, threading `reinvokeOf`. Lambda / AgentCore only; a
  served request is re-sent client-side through the request composer so
  the capture proxy still records it),
  studio-dispatch
  (issue #282 / #303 — the single-shot `POST /api/run` handler
  for the invoke kinds: runs a target from the studio UI by
  spawning the SAME headless command the CLI runs as a child process —
  `cdkl invoke` for a `lambda`, `cdkl invoke-agentcore` for an
  `agentcore` (`INVOKE_VERBS`) — studio being a control plane over the
  CLI — streaming its stdout/stderr to the event bus and returning the
  response. `extractResponse` recovers the response per kind: a Lambda's
  is read from the `--response-file` the dispatcher passes to `cdkl
  invoke` (issue #291 — `cdkl invoke` writes ONLY the raw RIE response
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
  `docker logs` and are unaffected by the level, plus the response),
  studio-child-args (issue #301 slice 1 — `buildSharedChildArgs`, the
  single place that turns studio's session-global config (`--app` /
  `--profile` / `--region` / `-c` / `--from-cfn-stack` / `--assume-role`)
  into the argv fragment both studio-dispatch and studio-serve-manager
  forward to their spawned child commands, so the two spawn sites cannot
  drift. The `omitStateBindings` option (issue #367) suppresses
  `--from-cfn-stack` / `--assume-role` for a child that does not declare
  them; as of issue #380 EVERY serve kind (incl. `cloudfront`, for its
  Function URL origin Lambda) declares those flags, so the serve-manager no
  longer sets `omitStateBindings` for any kind — the bindings are forwarded
  to all serves. The guard stays available for a future pure-local serve
  kind),
  studio-option-specs (issue #301 slice 2 — the per-target run-option
  descriptor table (`OPTION_SPECS`) that is the single source the UI
  renders controls from (serialized into the page) AND the server builds
  + validates argv from (`buildPerRunArgs`): boolean -> checkbox, scalar
  -> input (with `showWhen` gating), repeat-pair -> add-row list (one
  `--flag left=right` per row), env-kv -> KV / JSON editor whose rows are
  materialized by `resolveEnvVars` into a SAM-shape `{ Parameters: {...} }`
  temp file passed as `--env-vars <file>`. Per-target options vary per
  invoke / serve, vs the session-global flags in studio-child-args; the
  `agentcore` kind (issue #303) declares `--ws` / `--sigv4` (boolean),
  `--bearer-token` / `--session-id` (scalar), and `--env-vars` (env-kv);
  the `alb` / `ecs` serve kinds also declare `--env-vars` (env-kv, issue
  #355) so a UI-started serve can overlay the backing ECS task container
  env; the `agentcore-ws` serve kind declares `--bearer-token` (scalar) /
  `--no-verify-auth` (boolean) / `--session-id` (scalar) / `--env-vars`
  (env-kv) — the serve-relevant subset of start-agentcore's flags, no
  `--ws` / `--sigv4`)),
  studio-option-catalog (issue #301 — the AUTO-DERIVED full flag catalog
  that backs the composer's collapsed "All options" section.
  `buildFlagCatalog` introspects each runnable kind's Commander command
  factory (`createLocalInvoke*` / `createLocalStart*`) and emits every
  flag (name + description), minus the session-global flags
  (`CATALOG_EXCLUDED_FLAGS`: `--from-cfn-stack` / `--assume-role` /
  `--app` / `--profile` / `--region` / `-c`, handled by the Session bar)
  and the auto-added `--help` / `--version`; the curated OPTION_SPECS is a
  rich-control subset, this is the complete reference so the UI is never
  strictly less capable than the headless CLI. Memoized; each factory is
  re-handed the active embed config so host branding survives + the
  derived descriptions reflect it. `tokenizeRawArgs` is the quote-aware
  splitter for the section's raw extra-args input — the tokens are
  appended verbatim (LAST, so they can override a curated flag) to the
  spawned child argv by both studio-dispatch and studio-serve-manager;
  studio spawns children WITHOUT a shell, so there is no injection
  surface. `coerceRunRequest` validates the `rawArgs` string at the
  `/api/run` boundary (tokenized eagerly so an unterminated quote is a
  clean 400)),
  studio-serve-manager (issue #282 — the
  long-running serve lifecycle, parameterized by a per-kind
  `ServeKindSpec`: `api` (`start-api`) + `alb` (`start-alb`) +
  `cloudfront` (`start-cloudfront`, issue #367) expose host
  HTTP endpoints each fronted by a studio-proxy so the `endpoints` handed
  to the UI are the proxy URLs (slice C2 capture), while `ecs`
  (`start-service`) is pure compute — no capture proxy, just the running
  replicas + their streamed logs. `agentcore-ws` (`start-agentcore`) resolves
  running on `Server listening on (ws://...)`; its `ws://` endpoint is NOT
  proxied (the capture-proxy gate is `/^https?:/`), so the browser connects
  straight to the bridge and the UI renders the WebSocket console. The `ecs` serve's `hostUrl` is set from an
  explicit `--host-port` OR (issue #392) parsed from the child's
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
  `CDKL_LOG_STREAM=stdout` (issue #403) so the logger unifies warn / error
  onto stdout: studio reads the child's stdout + stderr via two separate OS
  pipes with no cross-pipe order guarantee, so without unification a stderr
  WARN (e.g. the pinned-image boot warning) could surface in the studio LOG
  panel AFTER a later stdout line like `Press ^C to shut down.`. The serve
  path is safe to unify (ready-line detection greps stdout; error detection
  is via the child `error` / `close` events, not stderr content). Under
  `cdkl studio --watch` it appends
  `--watch` to each serve child — read off the mutable config per
  `start()`, so a Session-bar toggle applies to the next serve. Issue #355
  added env-vars to the `alb` / `ecs` serve composers: `start()`
  materializes the env-kv option via `resolveEnvVars` into a SAM-shape
  temp file and appends `--env-vars <file>` so the override reaches the
  backing ECS task containers (`start-service` / `start-alb` overlay the
  `Parameters` map onto every container). The temp dir outlives the child
  (a `--watch` serve re-reads it on reload) and is removed on teardown via
  `closeProxies`),
  studio-proxy
  (issue #282, slice C2 — a capturing reverse proxy in front of each
  HTTP serve endpoint: forwards every request verbatim to the upstream
  `start-api` child while emitting `invocation` start/end events
  (method / path / headers / bounded body + response status / headers /
  bounded body) onto the bus, so every request to the served port lands
  on the timeline regardless of source — browser / curl / pad alike
  (decision D4a); `Upgrade` (WebSocket) requests are raw-bridged without
  capture), studio-store (issue #282, slice C3 — the in-memory event
  store: subscribes to the bus and retains a bounded, newest-wins window
  of invocations + log lines so the server can answer history on
  (re)connect, full-text log search across the session, and
  per-invocation log binding at CloudWatch granularity (decision D5 — the
  single-shot invoke kinds (lambda + agentcore, issue #309) bind strictly
  by container id; a captured serve request binds best-effort by target +
  time window). alb / ecs serve kinds still to
  come), etc.
- `src/assets/` — asset manifest loader + docker-build for container Lambdas.
- `src/types/` — shared interfaces (`StackState`, `ResourceState`,
  `CloudFormationTemplate`) — shaped as a strict subset of cdkd's state
  schema so host-side state can flow into cdk-local unchanged.

`tests/integration/local-*` — per-fixture real-Docker E2E tests
(`verify.sh` runs the CLI against a deployed-style fixture). cdk-local
itself does not invoke AWS; integration tests that need `--from-cfn-stack`
deploy via the upstream `cdk` CLI.

## Build and test commands

```bash
# Install (pnpm + vite-plus)
pnpm install

# Build (tsdown via vp pack)
vp run build

# Watch
vp run dev

# Typecheck
vp run typecheck

# Lint / format
vp run lint
vp run lint:fix
vp run format
vp run format:check

# Unified check (typecheck + lint + format-check)
vp run check

# Unit tests (vitest)
vp run test
vp run test:watch
vp run test:coverage

# verify = check + test + build
vp run verify

# Build artifact smoke test
vp run runtime:smoke
```

## Important implementation details

- **ESM Modules**: `package.json` declares `"type": "module"`. All imports
  must carry the `.js` extension even in TypeScript source:

  ```typescript
  import { foo } from './bar.js';  // OK
  import { foo } from './bar';     // wrong
  ```

- **Library + CLI dual entry**: `src/index.ts` (stable public library
  exports), `src/internal.ts` (unstable low-level building blocks for
  shim hosts, reachable ONLY via the `cdk-local/internal` subpath — NO
  semver guarantee; the main entry does NOT re-export them), and
  `src/cli/index.ts` (binary entrypoint). `vp pack` produces
  `dist/index.js` (library), `dist/internal.js` (internal), and
  `dist/cli.js` (CLI).

- **Toolkit-lib integration**: `src/synthesis/assembly-reader.ts`
  delegates synthesis to `@aws-cdk/toolkit-lib`'s `Toolkit.fromCdkApp()`.
  CLI `-c key=value` overrides land in a `CdkAppMultiContext(workingDir,
  context)` so `cdk.json` / `cdk.context.json` / `~/.cdk.json` remain
  the base layer and overrides only win for keys they touch.

- **Node version**: `.node-version` pins to 24.x for dev / CI. `vp pack`
  targets `node20` for the shipped runtime — `package.json` engines
  declares `>=20`.

## Workflow rules

- **English only for committed files**: source, scripts, hook messages,
  configs (`.claude/settings.json`, `vite.config.ts`), docs, comments,
  commit messages, PR titles/bodies/comments, GitHub issue text. No
  Japanese characters (hiragana / katakana / kanji) in any committed
  artifact. Chat in the orchestrating session may be Japanese — this rule
  applies only to files / GitHub artifacts that land in the repo.

- **Never commit / push directly to `main`**: all changes via a feature
  branch + PR. Feature branches live under
  `.claude/worktrees/<branch>/`; use
  `git worktree add .claude/worktrees/<branch> -b <branch> origin/main`
  rather than branching in the main worktree (shared state across
  parallel agents).

- **Squash merge only**: prefer `gh pr merge <N> --squash --delete-branch`.
  PR #1 was squash-merged; keep the history flat.

- **Always add unit tests for new functionality**: don't wait to be
  asked. `tests/unit/**` mirrors `src/**`. Mock external boundaries
  (toolkit-lib, docker CLI, AWS SDK) with `vi.mock` / `vi.hoisted`.

- **After source changes**: run `vp run build` before reporting "ready
  to test" — users invoke cdk-local via `node dist/cli.js` (or the
  `cdkl` bin), so source changes without a build have no runtime
  effect.

- **Before opening a PR**: run `vp run verify` (= check + test + build).
  This is what CI runs; failing locally is faster feedback than failing
  in GitHub Actions.

- **Before every commit**: `check-gate.sh` blocks `git commit` unless
  both the `check` and `docs` markgate markers are fresh. Run
  `/check` and/or `/check-docs` proactively based on what your diff
  touches (a tests-only commit needs `/check`; a docs-only commit
  needs `/check-docs`; a src edit needs both; changes outside both
  scopes need neither). `/verify-pr` refreshes both in one shot.
  Per-gate scopes, error-message decoding, and other details:
  [.claude/rules/hooks.md](.claude/rules/hooks.md). Install `vp` +
  `markgate` via `mise install` at the repo root.

- **Before opening or merging any PR**: `verify-pr-gate.sh` blocks
  `gh pr create` / `gh pr merge` unless the `verify-pr` marker
  (declared `requires: [check, docs]`) is fresh. The marker is set
  ONLY by `/verify-pr`, which walks the full checklist: typecheck /
  lint / build / tests, CI status, working tree, docs consistency,
  Docker + integ marker check, code review (incl. shared-utility
  caller verification), live-test, retrospective + rule proposals,
  residual review-nit sweep + auto-close audit, and PR title + body
  freshness. Opening or merging a PR whose live behavior was never
  exercised is physically blocked.
  Details: [.claude/rules/hooks.md](.claude/rules/hooks.md).

- **Before merging large / security-sensitive PRs**: `pr-review-gate.sh`
  blocks `gh pr merge` for PRs whose size + bias factors trigger
  `/review-pr`'s `1-reviewer` or `3-axis` recommendation, unless the
  sha-bound `pr-review` marker is fresh. `inline`-tier PRs always
  pass through; `gh pr create` is NOT gated.
  Heuristic + trigger lists: [.claude/skills/review-pr/SKILL.md](.claude/skills/review-pr/SKILL.md)
  + [.claude/rules/hooks.md](.claude/rules/hooks.md).

- **PR review pattern**: 3 read-only review sub-agents are codified at
  `.claude/agents/pr-{spec,code,test}-reviewer.md`. The orchestrator
  dispatches the recommended count (0 / 1 / 3) in parallel via the
  `Agent` tool and synthesizes the findings before merge. The 3 axes
  (spec compliance / code quality / test adequacy) catch different
  classes of issues. Sub-agents have read-only tools (Read / Glob /
  Grep / Bash) so they can never accidentally edit.

- **Never defer integration tests to a later PR**: when a feature is
  built incrementally across multiple PRs (slices), every slice that
  lands on `main` MUST carry its own integration coverage green before
  merge — NEVER ship code-then-integ-later. A slice that adds a runtime
  code path without exercising it end-to-end (Docker / fixture) can
  release with a latent bug behind a working-looking unit suite; that
  is unacceptable. Each PR is a self-contained vertical: unit + integ
  for exactly the behavior it adds. A "final integ pass" slice is a
  design smell — fold the integ into the slice that introduces the
  behavior. (If a slice's behavior is genuinely not yet user-reachable,
  gate it so it cannot ship enabled — but still integ-test the real
  code path it adds, e.g. via the gated entrypoint.)

- **Creating a NEW integ fixture**: use `/create-integ <name>`. It
  scaffolds the fixture (`package.json` pinned with `packageManager` so
  `vp install` is a no-op — never re-dirties on the first run, `bin` /
  `lib` / `cdk.json` / `tsconfig` / a `verify.sh` harness), has you fill
  in the stack + assertions, RUNS it via `/run-integ`, and sets the
  `create-integ` marker on a clean green run. A NEW command factory
  (a new `src/cli/commands/local-<verb>.ts` declaring a
  `createLocal*Command`) is brand-new behavior with no existing fixture,
  so `create-integ-gate.sh` blocks `gh pr create` until that marker is
  fresh. It fires only on a new factory file — NOT on a new non-factory
  helper module under `src/cli/commands/`, and NOT on a new flag on an
  EXISTING command (extend that command's fixture instead). Details:
  [.claude/skills/create-integ/SKILL.md](.claude/skills/create-integ/SKILL.md),
  [.claude/rules/hooks.md](.claude/rules/hooks.md).

- **When running integration tests**: use `/run-integ <test-name>`
  (e.g., `/run-integ local-invoke`). Never bypass by shelling into
  the fixture's `verify.sh` directly — the skill encodes Docker
  pre-flight + verify.sh + post-run orphan sweep + (for
  `*-from-cfn-stack` tests) AWS stack orphan check in one block.
  Skipping any step risks setting the `integ` marker on incomplete
  verification. The `integ-gate.sh` hook blocks
  `gh pr merge` when `src/**` or `tests/integration/**` is touched
  and the marker is stale.

- **After running integration tests**: verify no leftover Docker
  containers / networks remain (`docker ps --filter name=cdkl-`,
  `docker network ls --filter name=cdkl-task-` / `cdkl-svc-`). For
  `*-from-cfn-stack` tests, also verify no orphan CloudFormation
  stacks remain. If the run failed or left orphans, clean them up
  immediately via direct Docker / `cdk destroy` / `aws
  cloudformation` calls — leaving orphan resources after an integ
  run is never acceptable.

- **cdkd parity** (host-CLI library-surface drift):
  `cdkd-parity-gate.sh` blocks `gh pr create` when the `cdkd-parity`
  marker is stale AND the diff touches the cdk-local library surface
  — defined as any change under `src/cli/commands/**` /
  `src/internal.ts` / `src/index.ts`, OR a NEW `.ts` file added under
  `src/local/**` (`--diff-filter=A`; the new-file branch catches
  helpers that may need to be re-exported from `src/internal.ts`,
  while edits to existing `src/local/**` files are excluded so
  internal refactors don't trigger noise). The marker is set ONLY by `/check-cdkd-parity`, which walks
  the four host-impacting categories:
  - **New subcommand factory** — exported from `src/index.ts`? cdkd
    tracking issue filed (cat 1, REQUIRED)?
  - **New CLI option** — added inside the relevant
    `add<Cmd>SpecificOptions` helper (not inline in
    `create<Cmd>Command`)? contract test still green? cdkd tracking
    issue filed (cat 2, REQUIRED)?
  - **New public helper / type in `src/local/**`** — exported from
    `src/internal.ts`? JSDoc names the host-side use case? cdkd
    tracking issue filed (cat 3, "optional — cdkd decides")?
  - **Behavior change** — cdkd tracking issue filed (cat 4, REQUIRED)?
    migration note in PR body?

  The skill AUTO-FILES the cdkd tracking issue (`gh issue create --repo
  go-to-k/cdkd`, idempotent via the per-worktree `.cdkd-parity-issue`
  sentinel) for every applicable category, labeling each with its host
  action (wrap / inherit / optional-adopt / adapt) so the cdkd agent can
  follow by working its issue queue — it no longer relies on a manual
  "notify cdkd" step that never happened. The gate HARD-BLOCKS
  `gh pr create` for cat 1 / cat 2 until the sentinel carries a
  `github.com/go-to-k/cdkd/issues/` reference; cat 3 / cat 4 rely on the
  marker. `.claude/settings.json` `permissions.allow` pre-authorizes the
  scoped `gh issue create`.

  Out-of-scope diffs (internal refactors, docs, tests) pass through
  silently. `gh pr merge` is intentionally NOT gated — the parity
  question is a pre-create judgment.
  Details: [.claude/rules/hooks.md](.claude/rules/hooks.md) +
  [.claude/skills/check-cdkd-parity/SKILL.md](.claude/skills/check-cdkd-parity/SKILL.md).

## Positioning when communicating

- `cdkl` is the **binary** name (the command users type).
- `cdk-local` is the **npm package** name (what users import / install).
- When referring to the project in prose, use "cdk-local".
- When referring to the CLI command in code blocks / examples, use
  `cdkl invoke / invoke-agentcore / start-api / run-task / start-service / start-alb / start-cloudfront / list`.
- Do NOT name, recommend, or compare against any third-party product
  in committed artifacts (README, docs, JSDoc, CONTRIBUTING). No
  comparison tables, no "pair with" / "use alongside" recommendations,
  no parenthetical mentions, no examples. State cdk-local's scope
  ("application compute locally; managed services stay real AWS") on
  its own terms without naming competing or adjacent products.
  `sam local` is the only sanctioned exception.
- Do NOT reference cdkd internal implementation (deploy / destroy /
  state schema details / provider system) in cdk-local artifacts — the
  dependency direction is cdkd -> cdk-local, and cdk-local should read
  as self-contained.

## Reference

- `README.md` — user-facing intro + install + usage.
- `docs/library-mode.md` — programmatic / library-mode integration
  surface (factory exports, `LocalStateProvider` API) — linked from
  README's "Programmatic use" pointer.
- `vite.config.ts` — vp tasks, lint / fmt / pack / test config.
- `.github/workflows/ci.yml` — CI (typecheck + lint + test + build +
  Node 20/22/24 matrix smoke).
