# Local-emulation scope: per-command semantics and fidelity boundaries

The authoritative per-command detail behind CLAUDE.md's "Scope" section —
what each `cdkl` command reproduces, its flag families, and exactly where
fidelity stops. Read this before writing docs, README text, or JSDoc that
asserts what is / is not reproduced, and before extending a command's
emulation surface. (Auto-referenced from `.claude/CLAUDE.md` → "Scope".)

## Runs locally (application compute) — full detail

- Lambda functions — your code in a real `public.ecr.aws/lambda/*`
  container via the Lambda Runtime Interface Emulator
- API Gateway routing — REST v1 / HTTP v2 / Function URL / WebSocket
  served by a local HTTP server
- ECS tasks and services — real Docker containers with awsvpc /
  Service Connect / Cloud Map registry. `start-service` runs a service's
  replicas only (pure compute, no load balancer). `start-service --watch`
  and `start-alb --watch` re-synth + per-replica roll every booted ECS
  service when the CDK source changes. A per-firing classifier picks
  the per-replica primitive — Phase 4 of issue go-to-k/cdk-local#214 added a bind-mount
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
  Phase 2 + Phase 3 of issue go-to-k/cdk-local#214; the soft-reload path is similarly
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
  files (issue go-to-k/cdk-local#234; go-to-k/cdk-local#238 broadened the WARN to fire on any cold
  start when an ECR pin is detected, not just under `--watch`).
  Issue go-to-k/cdk-local#238 also added the `--image-override` flag family to
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
  lives in `src/local/image-override-engine.ts`. Issue go-to-k/cdk-local#262 retained
  the post-Stage-3 `ImageOverrideMap` so every `--watch` reload firing
  re-invokes `runImageOverrideBuilds` per covered target (no Stage 1
  picker re-fire, no Stage 3 prompt re-fire, no orphan re-validation
  — those are boot-time-only); a source edit under the covered
  Dockerfile's context flips the content-addressed tag and the
  rolling primitive boots a shadow against the freshly-built image
  (per-target rebuild failure logs a warn + keeps the old replica
  serving + lets sibling targets continue rolling). Issue go-to-k/cdk-local#240 added
  per-service variants of the three build-input flags
  (`<svc>:KEY=VAL` for build-arg / build-secret, `<svc>=stage` for
  target); the per-service form overrides the global per-key on the
  named target, and an orphan validator
  (`enforceImageOverrideOrphans`) fails the boot when a per-service
  flag names a service the resolved override map does NOT cover
  (typo / forgotten `--image-override` mapping). Issue go-to-k/cdk-local#388 extended
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
  `cdkl invoke` (issue go-to-k/cdk-local#380): its declared `Environment.Variables`,
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
  intrinsic `RoleArn` from state. Issue go-to-k/cdk-local#255 added `--watch` on the
  long-running `--ws` session path: the
  per-firing classifier shared with `start-service` / `start-alb`
  (Phase 4 of issue go-to-k/cdk-local#214) decides `'rebuild'` vs `'soft-reload'`;
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
  the SAME warm container** (issue go-to-k/cdk-local#454), mirroring AgentCore's deployed
  model where many `InvokeAgentRuntime` calls on one `runtimeSessionId`
  reuse one warm microVM (vs single-shot `invoke-agentcore`, which boots +
  tears down per call). The request body is streamed up and the response —
  JSON or an SSE `text/event-stream` — streamed back. Inbound auth mirrors
  the cloud PER REQUEST (issue go-to-k/cdk-local#454, slice 4a — unlike single-shot
  invoke-agentcore, which validates a `--bearer-token` ONCE at boot): when the
  runtime declares a `customJwtAuthorizer`, each `POST` contract request's
  `Authorization` is verified against the runtime's OIDC discovery URL /
  JWKS (signature + issuer + expiry + audience + scopes + custom claims) —
  `401` when no token, `403` when invalid, forwarded on pass; `GET /ping`
  stays an unauthenticated health check; `--bearer-token` is the default
  injected when an inbound request carries none, `--no-verify-auth` disables
  the gate. `--sigv4` (no `customJwtAuthorizer`) signs each forwarded request
  with AWS SigV4 (service `bedrock-agentcore`) so the container sees the same
  `Authorization` / `X-Amz-*` header set the cloud receives — mutually
  exclusive with `--bearer-token`; the body is buffered to sign. The
  per-request gate is the serve counterpart of `front-door-auth`'s ALB
  `AuthCheck`.
  For HTTP / AGUI runtimes, on the SAME port it also serves the
  bidirectional `/ws` endpoint behind a host WebSocket BRIDGE so a
  header-less client — a browser `WebSocket`, which cannot set the
  `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` (or `Authorization`)
  upgrade header — can hold an interactive multi-frame session. The bridge
  accepts the header-less client on the serve `--port` (default 0) and opens
  a `ws` connection to the container `/ws` with those headers injected (a
  fresh session-id UUID per inbound connection / per forwarded HTTP request,
  unless `--session-id` pins one), piping frames both ways. All four
  protocols are served (issue go-to-k/cdk-local#454, slice 2 dropped the MCP / A2A reject):
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
  line. Runs until `^C`. `--watch` (issue go-to-k/cdk-local#454, slice 4b) re-synths + reloads
  the warm container IN PLACE on a CDK source change, keeping the HOST serve
  UP — only the container rotates (like start-service: the front-door stays,
  the replicas roll). A per-firing classifier (shared with
  invoke-agentcore `--ws --watch` + the ECS serves) picks rebuild (SIGTERM the
  old container, boot a fresh one on a NEW port, re-point the serve via
  `server.setContainerPort` — the proxy reads the port live per request, the
  `/ws` bridge per upgrade) vs soft-reload (`docker cp` + `docker restart` the
  SAME container, port preserved); the forever-promise main loop is serve-level
  so a per-container teardown during reload never tears the serve down. The
  `cdkl invoke-agentcore` terminal path (interactive over stdin in a TTY) is
  unchanged
- API Gateway authorizers — Lambda authorizers, Cognito User Pool JWT
  verification, IAM SigV4 verification
- CloudFront distributions — the `viewer-request` -> S3 origin ->
  `viewer-response` pipeline served locally (`cdkl start-cloudfront`,
  issue go-to-k/cdk-local#363). The distribution's `AWS::CloudFront::Function`s (inline
  rewrite JS — URL rewrites, trailing-slash normalization, SPA fallback,
  header tweaks) are your own application compute and run in-process in a
  `node:vm` sandbox (`cloudfront-js-1.0` / `2.0`, async handlers awaited).
  The sandbox reproduces the CloudFront-Functions-2.0 runtime built-ins a
  bare vm context lacks (issue go-to-k/cdk-local#410): the `Buffer`, `atob` / `btoa`,
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
  go-to-k/cdk-local#405): a request-time `GetObject` per touched key (no pre-sync, so a CDN
  bucket with 100k objects is fine — a test touches a handful), reusing the
  same URI->key / `DefaultRootObject` / `CustomErrorResponses` resolution
  (`cloudfront-s3-origin`). The bucket name is resolved in priority order
  (issue go-to-k/cdk-local#405 + follow-up): a same-stack CDK bucket's physical id from
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
  so every request re-reads / is always current). It only feeds the
  deployed-S3 reader, so it is a no-op without `--from-cfn-stack` — a
  boot-time WARN (`warnUnusedCacheOrigin`) fires when it is set without the
  state flag so the no-op is never silent (not an error: it is harmless on
  its own, and studio's `--from-cfn-stack` binding is editable per session).
  Reads use
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
  (`origins.FunctionUrlOrigin`) is also served (issue go-to-k/cdk-local#376): the origin's
  `DomainName` (`Fn::Select[2, Fn::Split['/', GetAtt[Url, 'FunctionUrl']]]`)
  resolves to the `AWS::Lambda::Url` -> its `TargetFunctionArn` -> the
  backing `AWS::Lambda::Function`, which is booted once in a warm RIE
  container; a request routed there is invoked as a Function URL (payload
  v2.0) event and its response (status / headers / body / `cookies`)
  becomes the origin response (the viewer-response function still runs over
  it). So start-cloudfront is pure-local (no Docker) for a pure-S3
  distribution, and boots a Lambda container ONLY when the distribution has
  a Function URL origin. That Lambda gets the SAME container env as a direct
  `cdkl invoke` (issue go-to-k/cdk-local#380): its declared `Environment.Variables` are
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
  (issue go-to-k/cdk-local#399): the `import cf from 'cloudfront'` line is stripped and a `cf`
  module is injected into the `node:vm` sandbox whose `cf.kvs().get` /
  `exists` are backed by either the deployed store (`--from-cfn-stack` resolves
  the `AWS::CloudFront::KeyValueStore` ARN from state — the physical id is the
  store NAME, looked up to its ARN via the control-plane `ListKeyValueStores` —
  and reads it through the real `cloudfront-keyvaluestore` `GetKey` data-plane
  API, SigV4A-signed) or a local JSON map (`--kvs-file <key>=<file>`, the
  AWS-free escape hatch symmetric with `--origin`; the `<key>` is a
  KeyValueStore handle — its resource logical id, construct path, or bare
  construct id, normalized to the logical id, issue go-to-k/cdk-local#465). A KVS read with no
  binding fails with an actionable error naming both flags; `cf.kvs().meta()` /
  `count()` and KVS writes are not reproduced. A behavior's
  **Lambda@Edge** functions (`LambdaFunctionAssociations`) ARE run (issue
  go-to-k/cdk-local#400): each is real Lambda code, booted once in a warm RIE container (the
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
  `cloudfront` serve kind (issue go-to-k/cdk-local#367) — a [Start]/[Stop] control with a
  capture proxy, like `api` / `alb`; the session-global
  `--from-cfn-stack` / `--assume-role` bindings ARE forwarded to the studio
  cloudfront serve (issue go-to-k/cdk-local#380, since start-cloudfront declares those flags
  for its Function URL origin Lambda), same as every other serve kind
