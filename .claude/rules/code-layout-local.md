# Code layout: the `src/local/` runtime deep-dive

The per-subsystem invariants behind
[.claude/rules/code-layout.md](.claude/rules/code-layout.md)'s `src/local/`
section. Read before changing any of these subsystems.

## `credential-error` — a security boundary

How an AWS SDK failure becomes a line a THIRD PARTY can read at default level —
a log line, and a served HTTP response body.

- `describeAwsFailureForWarn` keeps a MODELED service exception's message,
  flattened and length-capped, and withholds every other error — credential-chain
  failures above all, which can carry a `credential_process` command line — down
  to a clamped class name plus a character count, emitting the full text at
  `debug`. `describeCredentialLoadFailure` is the unconditional-withhold form,
  for a `catch` around credential resolution alone (`sigv4-verify`).
- Choose PER OCCURRENCE, never mechanically, on two axes: LEVEL (default-level,
  reaching a third-party reader such as the studio log ring?) and RECONSTRUCTION
  (does the `catch` see only the credential chain, or a service RESPONSE whose
  message is the diagnosis?). The test is what a `catch` CAN SEE, never where it
  sits; a purely LOCAL `catch` sees neither population.
- Governed sites beyond `sigv4-verify` and the STS relays:
  `cfn-local-state-provider`, `ssm-parameter-resolver`, `state-resolver`,
  `cloudfront-kvs-client`, `cloudfront-s3-origin`, `layer-arn-materializer`,
  `ecr-puller`, `ecs-secrets-resolver`, `httpv2-service-integration` (an HTTP
  RESPONSE BODY — the widest reader), `local-studio`'s image-context warn.
  Uncovered: `cloudfront-server`'s `Request handling failed:` relay.
- Two NON-error leaks stay closed: `cfn-local-state-provider` FLATTENS the
  wire-derived `PhysicalResourceId` it interpolates, and `ecs-service-runner`
  emits an exited container's log tail as ONE warn PER LINE, so every line
  carries the `WARN: ` prefix `studio-serve-manager`'s matcher skips.
- Two calling conventions: render each failure ONCE (the helper EMITS the `debug`
  line), and give cdk-local's OWN throws an identifiable class, re-raised ABOVE
  the relay — the policy is positive, withholding anything that is not a parsed
  service response, cdk-local's own text included.

## AgentCore

- **agentcore-resolver** (target + container-URI resolution),
  **agentcore-client** (`/ping` + `/invocations`), **agentcore-s3-bundle**
  (downloads + extracts a `fromS3` bundle).
- **agentcore-ws-client** — `invokeAgentCoreWs`, plus `bridgeAgentCoreWs`, a
  caller-driven relay opening the container `/ws` with session-id / Authorization
  injected and sending NO initial frame. **agentcore-ws-bridge** —
  `startAgentCoreWsBridge`, a host WS server accepting a header-less client;
  `attachAgentCoreWsBridge` extracts that wiring for an existing `http.Server`.
- **agentcore-http-server** — protocol-aware via a `routes` + `attachWs` config,
  proxying to the warm container with streaming request / response. A per-request
  `authCheck` gates each `POST` contract request — `GET /ping` is NEVER gated —
  401 / 403 on deny; `signRequest` buffers the POST body, signs it SigV4, drops
  the inbound chunked `transfer-encoding`. `setContainerPort(port)` lets a
  `--watch` rebuild re-point the serve without rebinding the listener: the proxy
  reads the port LIVE per request, the bridge per upgrade
  (`number | (() => number)`).
- **agentcore-serve-auth** — `buildAgentCoreServeAuthCheck`, the per-request
  inbound-JWT gate, reusing `cognito-jwt`'s `verifyJwtViaDiscovery`.

## ALB front door

- **elb-front-door-resolver** — the `start-alb` entry: ALB -> Listeners +
  ListenerRules across all six condition fields -> forward / weighted-forward /
  redirect / fixed-response -> backing ECS Services or Lambdas.
- **alb-path-matcher** (glob matcher + exact method + CIDR source-ip, priority
  ordered), **alb-lambda-event** (`requestContext.elb` translation),
  **front-door-pool** (round-robin replica pool), **front-door-tls** (PEM pair or
  a self-signed cert cached under XDG cache), **front-door-auth** (the per-action
  `AuthCheck`, cognito-jwt Bearer plus an `AWSELBAuthSessionCookie-*`
  pass-through).
- **front-door-lambda-runner** — one warm RIE container per Lambda target;
  accepts a pre-resolved `containerEnv` + `sensitiveEnvKeys` from the caller, the
  default being a shell-creds-only forward.
- **front-door-server** — the reverse proxy resolving a per-request RouteAction.
  The HTTPS branch flips `X-Forwarded-Proto` and the redirect `#{protocol}`
  default to `https`; an `auth` guard denies with 401; a WebSocket `Upgrade` runs
  through the SAME route + auth pipeline before the raw socket is bridged.

## Reload classification

- **source-change-classifier** — the per-firing `'rebuild'` vs `'soft-reload'`
  decision. Defaults to rebuild on ambiguity AND requires the asset hash to
  actually flip before returning soft-reload, or a construct edit that changed
  the task spec is soft-reloaded with the OLD spec.
- **image-pin-detector** — local CDK asset vs deployed-registry pin, so the
  emulator WARNs at boot and SKIPS the no-op rolling primitive instead of
  surfacing `Reload complete.`
- **image-override-engine** — parses the `--image-override` family, fires the
  picker and the TTY boot prompt for uncovered pinned targets, runs
  `docker build` once per covered target, and produces the deterministic
  local-only tag the boot path threads into `imageOverrideByContainer`.

## CloudFront

- **cloudfront-resolver** — the `start-cloudfront` entry: behaviors -> path
  pattern + viewer functions + Lambda@Edge associations (resolved through
  `AWS::Lambda::Version` via `pickLambdaEdgeFunctionLogicalId`); origins (S3 ->
  local BucketDeployment dir, else `s3-unresolved`, promoted by the command to
  `s3-deployed`; `describeS3OriginDomain` parses a literal bucket name out of an
  external origin's `DomainName`, marking a pure-intrinsic one
  `deployedConfigOnly`; a Function URL origin -> backing function via
  `DomainName` + `AWS::Lambda::Url` `TargetFunctionArn`; custom / unresolved
  flagged); per-behavior CORS via `resolveResponseHeadersPolicyCors`, SHARED with
  the `start-api` chain.
- **cloudfront-function-runtime** — compiles and runs an inline function in a
  `node:vm` sandbox. `cloudFrontRuntimeGlobals` merges the 2.0 built-ins a bare
  vm lacks into BOTH the compile probe and the invoke sandbox;
  `stripCloudFrontImport` drops the `import cf from 'cloudfront'` line at compile
  time, so a KVS-reading function compiles as a plain `vm.Script`, `cf` being
  injected under the binding name at invoke time.
- **cloudfront-kvs** (the binding-agnostic `cf` shim, incl. the unbound module
  that fails a read with an actionable error), **cloudfront-kvs-client** (the AWS
  boundary: the deployed `GetKey` source, store NAME -> ARN via
  `ListKeyValueStores`, and a side-effect `import '@aws-sdk/signature-v4a'`
  registering the signer the API requires), **cloudfront-kvs-binding** (re-run
  per `--watch` reload).
- **cloudfront-static-origin** (default-root-object, path-traversal guard, MIME
  by extension, SPA fallback; its `resolveErrorResponseCandidates` 403-then-404
  helper is SHARED with the deployed-S3 reader), **cloudfront-s3-origin**
  (`createS3OriginReader`, a request-time `GetObject` per key reusing that
  resolution; `classifyS3Error` maps a miss to the SPA fallback, an
  `AccessDenied` to an actionable `--origin` warning),
  **cloudfront-lambda-origin** (a payload-v2.0 event via `buildHttpApiV2Event`
  with a synthetic `$default` route), **cloudfront-edge-event** (the
  `{ Records: [{ cf: {...} }] }` wire format and the header multi-map).
- **cloudfront-distribution-config** — `resolveDeployedOriginBucket`, the
  `GetDistributionConfig` fallback for a pure-intrinsic bucket name. **It never
  throws**: a read failure resolves to `undefined`, falling the command back to
  the `--origin` guidance.
- **cloudfront-server** — the local server; the per-request ORDER is fixed:
  behavior match -> CORS preflight short-circuit -> viewer-request fn ->
  Lambda@Edge viewer-request / origin-request (either may short-circuit or
  rewrite) -> origin (static, deployed-S3 reader or Function URL invoker, all
  boot-time maps) -> Lambda@Edge origin-response -> viewer-response fn THEN
  Lambda@Edge viewer-response (both run, CloudFront Function FIRST) ->
  `applyCorsResponseHeadersFromConfig`. A mutable distribution cell lets
  `--watch` swap the model under the live socket.

## Studio

- **studio-custom-resource-filter** — hides CDK custom-resource /
  provider-framework Lambdas, matched by construct path (incl. a GENERIC
  `custom::` catch-all); `--include-custom-resources` opts back in.
- **studio-events** — the typed in-process bus (`invocation` / `log` / `serve`)
  every observation flows through; the server forwards it over SSE.
- **studio-server** — the localhost server: embedded UI, `/api/targets`,
  `/api/events` (opens with a `hello` carrying a per-boot `instanceId`, beats a
  JS-visible `ping`), run / stop / running / request / reinvoke / history / logs
  / config endpoints; collision-bumps its port. An api / alb relay goes through
  the capture proxy; an ecs relay hits the replica host URL directly yet still
  reaches the timeline, via the command's own `invocation` pair
  (`relayAndCaptureServeRequest`). An external curl to the host port is the one
  uncaptured case.
- **studio-ui** — the framework-free UI embedded as a STRING, so it ships in the
  npm package with no asset-copy build step. Invariants: serve states are `error`
  + message (boot failure), `stopped` WITH a message (crash after running),
  `stopped` with NO message (clean stop); a failed serve keeps its "Started with"
  summary and offers `Reconfigure`, composer PRE-FILLED from the same
  `serveApplied` record; LOG lines colour off a leading `WARN:` / `ERROR:` prefix
  (the only severity signal on a colourless child pipe); `● live` latches
  disconnected on a reconnect with a DIFFERENT `instanceId`, and a heartbeat
  watchdog flips it when no `ping` arrives, catching a dead server the socket
  reports no `error` for.
- **studio-reinvoke** — re-fires an edited payload through the SAME dispatcher
  `/api/run` uses, threading `reinvokeOf`. Lambda / AgentCore only; a served
  request is re-sent client-side so the capture proxy still records it.
- **studio-dispatch** — the `/api/run` handler for the invoke kinds: spawns the
  SAME headless command the CLI runs, returns the response. `extractResponse` per
  kind: a Lambda's from the `--response-file` (ONLY the raw RIE payload, so a
  trailing `console.log(JSON)` cannot be mistaken for it), else the last
  JSON-parseable stdout line; an AgentCore agent streams its WHOLE output to
  stdout, so all of stdout IS the response. The child gets `CDKL_LOG_LEVEL=warn`,
  and **`CDKL_LOG_STREAM` is PINNED to `stderr`** rather than inherited — the
  spawn spreads `process.env`, so an exported `CDKL_LOG_STREAM=stdout` would
  route cdk-local's own warns onto the RESPONSE channel.
- **studio-child-args** — `buildSharedChildArgs`, the single place turning the
  session-global config into the argv fragment both spawn sites forward, so they
  cannot drift. `omitStateBindings` suppresses the state bindings for a child
  that does not declare them.
- **studio-option-specs** — `OPTION_SPECS`, the per-target run-option table that
  is the single source the UI renders controls from AND the server builds +
  validates argv from (`buildPerRunArgs`); `resolveEnvVars` materializes an
  env-kv option into a SAM-shape temp file passed as `--env-vars <file>`.
- **studio-option-catalog** — the AUTO-DERIVED catalog behind "All options".
  `buildFlagCatalog` introspects each kind's command factory; a flag is
  `renderable` when NEITHER curated (`OPTION_SPECS`) NOR studio-managed
  (`CATALOG_MANAGED_FLAGS` — the override-SELECTION flags, NOT the build-input
  pass-throughs, since the picker threads only `--image-override`). Raw
  extra-args are appended LAST so they can override an earlier flag; children
  spawn WITHOUT a shell, so there is no injection surface, and `coerceRunRequest`
  validates both maps at the `/api/run` boundary — an unknown flag or
  unterminated quote is a clean 400.
- **studio-serve-manager** — the serve lifecycle, parameterized by a per-kind
  `ServeKindSpec`. `api` / `alb` / `cloudfront` endpoints are fronted by a
  studio-proxy, so the `endpoints` handed to the UI are the PROXY urls; `ecs` is
  pure compute, no proxy. For `agentcore-ws` a `ws://` endpoint passes straight
  through (the proxy gate is `/^https?:/`) while the `http://` contract endpoint
  — a SECOND ready line, captured by `extraEndpointRe` — is proxied. Stop
  SIGTERMs with a generous grace, so the command's own replica + docker-network
  teardown completes before any SIGKILL. Each serve child gets
  `CDKL_LOG_STREAM=stdout`, unifying warn / error onto ONE pipe (two OS pipes
  have no cross-pipe order guarantee); safe here — ready lines come from stdout,
  errors from the child `error` / `close` events. An env-kv temp dir OUTLIVES the
  child (a `--watch` serve re-reads it); `closeProxies` removes it.
- **studio-proxy** — a capturing reverse proxy per HTTP serve endpoint, emitting
  `invocation` start/end events with bounded bodies; `Upgrade` requests are
  raw-bridged without capture. **The upstream it will front is bounded to
  LOOPBACK**, because endpoints are learned by regex-matching child stdout, and a
  relayed SDK message or an application log could otherwise name any host. Three
  bounds: a line carrying cdk-local's own `WARN: ` / `ERROR: ` prefix is never
  pattern-matched (`classifyChildLine` strips ANSI, the verbose preamble and a
  `[module]` tag first, so anchoring survives `--verbose`); every ready pattern is
  anchored to line start; the resolved upstream must be loopback
  (`normalizeLocalUpstream`) or the serve is REFUSED with a warn. A WILDCARD bind
  address is REWRITTEN to `127.0.0.1` rather than refused — a bind address, not a
  destination. The same bound covers the `ecs` `hostUrl` the composer targets
  directly.
- **studio-store** — a bounded, newest-wins window of invocations + log lines
  answering history on reconnect, full-text search and per-invocation log
  binding: the single-shot invoke kinds bind STRICTLY by container id, a captured
  serve request best-effort by target + time window.
