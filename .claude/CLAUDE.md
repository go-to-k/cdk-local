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
  (typo / forgotten `--image-override` mapping).
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
  targets
- Bedrock AgentCore Runtime agents — the agent served over its protocol
  contract, invoked once locally (`cdkl invoke-agentcore`); covers both the
  container artifact and the CodeConfiguration managed-runtime artifact
  (`fromCodeAsset` AND `fromS3` — Python 3.10-3.14 / Node 22, built from source:
  a generated Dockerfile installs the bundle's deps and runs the EntryPoint,
  which self-serves the contract; a `fromS3` bundle's ZIP is downloaded from S3
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
  `POST /` paths logs a one-line WARN and proceeds single-shot
- API Gateway authorizers — Lambda authorizers, Cognito User Pool JWT
  verification, IAM SigV4 verification

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
  `createLocalStartAlbCommand`, `createLocalListCommand`,
  `createLocalStudioCommand`) + shared option
  helpers. `start-service` and `start-alb` share one neutral orchestration
  in `commands/ecs-service-emulator.ts` (synth + shared docker network +
  Cloud Map + restart watcher + optional front-door); each command is a
  thin strategy over it (service targets vs ALB targets).
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
  subsequent runs without a restart. Issue #301 slice 4 added
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
  through `coerceRunRequest` (validated) + the serve manager.
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
  bidirectional `/ws` WebSocket client for `--ws`) + agentcore-s3-bundle
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
  (one warm RIE container per Lambda target), front-door-tls (resolves
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
  studio-custom-resource-filter (issue #323 —
  `isCustomResourceLambdaTarget` / `filterStudioCustomResources`:
  recognizes CDK custom-resource / provider-framework Lambdas by their
  construct path (provider-framework `framework-on*`, `LogRetention`,
  `BucketNotificationsHandler`, `AwsCustomResource`, CDK bucket
  deployment, the `AWS679...` singleton, etc.) so `cdkl studio` hides
  them from the target list by default — `--include-custom-resources`
  opts back in),
  studio-events (issue #282 — the typed in-process event bus every
  `cdkl studio` observation flows through (`invocation` / `log` /
  `serve` events); the studio HTTP server
  subscribes and forwards to the browser over SSE), studio-server
  (the localhost HTTP server behind `cdkl studio`: serves the embedded
  UI at `/`, the synthesized target list (+ the boot-discovered
  Dockerfiles + a `pinned` flag per ecs service — set by
  `annotatePinnedEcsTargets` — for the image-override picker, issue #301;
  CDK custom-resource / provider-framework Lambdas are excluded by
  default via `filterStudioCustomResources`, issue #323 — pass
  `cdkl studio --include-custom-resources` to surface them)
  at `/api/targets`, an SSE
  stream of the event bus at `/api/events`, `POST /api/run` (single-shot
  invoke / serve start), `POST /api/stop` (serve stop),
  `GET /api/running` (running serve snapshot), `POST /api/request`
  (issue #322 — relay a composed HTTP request to a running serve via
  `studio-request-relay` so the browser composer reaches the served port
  same-origin; api / alb go through the capture proxy and land on the
  timeline, an ecs `--host-port` serve hits the replica host URL directly),
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
  The Session bar applies on change (no Save button — `applyConfig` PATCHes
  `/api/config` immediately on a checkbox toggle / input change, issue
  #301); Lambdas + AgentCore runtimes get an
  [Invoke] composer (`INVOKE_KINDS`), serve
  targets (api / alb / ecs) a [Start]/[Stop] control with a `running ●
  :port` indicator (ecs services show `running` with no port — only the
  servable ECS *services* are runnable, not the task definitions); a served
  API Gateway WebSocket API additionally gets a WebSocket console
  (`renderWsConsole` — connect / send-frame / received-frame log) wired
  straight to its ws:// endpoint, with the socket + frame log held in module
  state so a log-driven serve re-render never drops the connection (issue
  #303); every composer (invoke + serve) carries a collapsed "All options"
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
  gets no picker (issue #301); the
  timeline carries both Lambda invocations and captured serve requests,
  the latter opening a read-only Request/Response detail; a log search box
  queries the store and a captured request's detail shows its bound logs),
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
  drift),
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
  `--bearer-token` / `--session-id` (scalar), and `--env-vars` (env-kv)),
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
  `ServeKindSpec`: `api` (`start-api`) + `alb` (`start-alb`) expose host
  HTTP endpoints each fronted by a studio-proxy so the `endpoints` handed
  to the UI are the proxy URLs (slice C2 capture), while `ecs`
  (`start-service`) is pure compute — no host port, no capture, just the
  running replicas + their streamed logs. Resolves running on the kind's
  ready line (`Server listening on <url>` / `ALB front-door: <url>` /
  `Service(s) running:`), tracks the running set for `/api/running`, and
  SIGTERMs the child on `/api/stop` / studio shutdown with a generous
  grace so the serve command's OWN ECS-replica + docker-network teardown
  completes before any SIGKILL. Under `cdkl studio --watch` it appends
  `--watch` to each serve child — read off the mutable config per
  `start()`, so a Session-bar toggle applies to the next serve),
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
    notified (issue / cross-link)?
  - **New CLI option** — added inside the relevant
    `add<Cmd>SpecificOptions` helper (not inline in
    `create<Cmd>Command`)? contract test still green?
  - **New public helper / type in `src/local/**`** — exported from
    `src/internal.ts`? JSDoc names the host-side use case?
  - **Behavior change** — cdkd informed? migration note in PR body?

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
  `cdkl invoke / invoke-agentcore / start-api / run-task / start-service / start-alb / list`.
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
