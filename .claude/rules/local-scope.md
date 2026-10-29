# Local-emulation scope: per-command semantics and fidelity boundaries

What each `cdkl` command reproduces and where fidelity stops. Read it before
asserting in docs or JSDoc what is / is not reproduced, and before extending a
command's emulation surface. Flag spellings live in README.md.

## Lambda / API Gateway

**Container env is one shared rule.** `resolveLambdaContainerEnv` resolves the
env of EVERY locally booted Lambda container — direct `cdkl invoke`, ALB Lambda
targets, CloudFront Lambda origins, Lambda@Edge, web functions — once each
at BOOT: `Environment.Variables`, `--from-cfn-stack` intrinsic substitution,
`--assume-role` STS / `--profile` creds. Decrypted `SecureString` values stay OFF
the `docker run` argv — except under finch on macOS / Windows, which rewrites
the value-less `-e KEY` onto the `limactl` argv, so a container with one is
refused there unless `<envPrefix>_ALLOW_SECRETS_ON_ARGV` is `1` / `true`
(#749). Creds ride the env overlay, so **the named-profile credentials-FILE
mount `cdkl invoke` adds is NOT reproduced** and an explicit
`fromIni({ profile })` is the one `--profile` case not covered. Without a state
flag, dev-shell creds are forwarded and intrinsic env values dropped (warn per
key).

## ECS: `start-service` / `start-alb` / `run-task`

Real Docker containers with awsvpc / Service Connect / Cloud Map.
`start-service` runs a service's replicas only — compute, no load balancer.

### `--watch` reload

A per-firing classifier picks the per-replica primitive:

- **soft-reload** — source-only edit on an interpreted-language handler (Node /
  Python / Ruby / shell; no Dockerfile, no dependency manifest, no compiled
  source): `docker cp` the asset dir into each replica's WORKDIR, then stop +
  start; registrations drained, re-published under the SAME owner key. On the
  shared network the container is DETACHED (Docker DNS) before the stop, gets a
  1s IP-only drain (#813), and is re-attached at the SAME IP while stopped
  (#660): WITH its aliases if it publishes host ports (a RUNNING re-attach
  drops them), else IP-only, aliases following the passed probe.
- **rebuild** — Dockerfile / dependency-manifest / compiled-source / ambiguous
  edits: boot a shadow (bumped gen) UNPUBLISHED until it listens (no
  registrations; aliases withheld unless it publishes host ports; #805; a crash
  restart too, #812), then swap registrations off the old one; drain; retire.

Invariants:

- **Ambiguity defaults to rebuild** (unreadable asset manifest, unrecognized
  change): slow-but-correct beats fast-but-stale.
- Multi-replica reloads roll SEQUENTIALLY: a request stream against the listener
  port must see zero connection refusals across a reload.
- **An ECR-pinned image pre-empts that default.** When the image is not a CDK
  docker-image asset, rolling re-pulls byte-identical content and reports
  `Reload complete.` as a silent no-op — so the roll is SKIPPED with a no-op log,
  and the configuration WARNs per target on ANY cold start, not only `--watch`.
- **The host front-door is built ONCE at boot and never recreated on reload**
  (TLS materials, JWKS cache, Lambda-target RIE containers, listener sockets);
  only replica pool entries rotate. Lambda target groups are a no-op on reload.

### `--image-override` family

Rebuilds a registry-pinned target from a local Dockerfile under the
deterministic tag `cdkl-override-<svc>-<hash>:local`, threaded through the
rebuild primitive. Engine: `src/local/image-override-engine.ts` (#238).

- A per-service build-input form overrides the global per-key on that target;
  `enforceImageOverrideOrphans` FAILS the boot when one names a service the map
  does not cover.
- The `ImageOverrideMap` survives boot, so every `--watch` firing re-invokes
  `runImageOverrideBuilds` per covered target, while the picker, the prompt and
  orphan re-validation are BOOT-TIME ONLY. A per-target rebuild failure warns and
  keeps the old replica serving; siblings keep rolling.
- A `run-task` task def has ONE override target, its representative essential
  container; a pinned but uncovered image WARNs.

### `start-alb`

Boots the ECS services behind the named ALB plus a front-door that round-robins
each listener port across replicas and applies the listener rules.

- HTTP **and HTTPS** listeners are served. A cloud-HTTPS listener runs over plain
  HTTP by default, with `X-Forwarded-Proto: https` preserved and redirect
  `#{protocol}` resolving to `https`; logged per listener. `--tls` opts in to
  real termination. ACM `Certificates[]` are NOT fetched (keys are not
  retrievable).
- `authenticate-cognito` / `authenticate-oidc`: a Bearer-JWT check (signature +
  `iss` + `aud` + `exp` against the deployed ALB's JWKS / OIDC discovery URL) or
  an `AWSELBAuthSessionCookie-*` pass-through, defeatable with
  `--no-verify-auth`. **The OAuth roundtrip — IdP redirect, callback, cookie
  issuance — is NOT reproduced.**
- WebSocket Upgrade is proxied for ECS forward targets through the same
  rule-matching + auth-gate pipeline, then the raw TCP socket is bridged.
  Lambda target groups refuse it with 502, mirroring ALB itself.
- `TargetType: lambda` target groups invoke the Lambda locally
  (`requestContext.elb` event); one forward can mix ECS and Lambda targets.

## Bedrock AgentCore Runtime

### `invoke-agentcore` (single-shot)

Covers the container artifact AND the CodeConfiguration managed-runtime artifact
(`fromCodeAsset` / `fromS3`; Python 3.10-3.14 / Node 22, built from source).

- The generated Dockerfile runs the EntryPoint AS-IS with **no dependency
  install**, matching the managed runtime, which resolves deps vendored into the
  bundle at deploy time — so a bundle that forgot to vendor its deps fails
  locally exactly as deployed; a manifest present WITHOUT vendored deps WARNs.
- **HTTP** is `POST /invocations` + `GET /ping` on 8080; **MCP** is
  Streamable-HTTP `POST /mcp` on 8000 (handshake, then ONE JSON-RPC request).
  SSE prints to stdout incrementally; `--ws` streams over `/ws` on the same 8080.
- A declared `customJwtAuthorizer` is enforced: the bearer token is verified
  against the runtime's OIDC discovery URL BEFORE the container starts, then
  forwarded. `--sigv4` is an opt-in alternative for a runtime declaring none.
- `--from-cfn-stack` reaches parity with `cdkl invoke` / `run-task`: same-stack
  ECR ContainerUri resolution, `AWS::SSM::Parameter::Value` env values, bare
  `--assume-role` resolving an intrinsic `RoleArn` from state.
- `--watch` works ONLY on the long-running `--ws` path (the ECS classifier);
  the `/ws` socket closes on every firing (no mid-session handoff). The
  single-shot paths WARN once and proceed.

### `start-agentcore` (long-running serve)

- **Inbound auth mirrors the cloud PER REQUEST**, unlike single-shot
  `invoke-agentcore`, which validates a token ONCE at boot: each `POST`'s
  `Authorization` is verified against the OIDC discovery URL / JWKS — `401` with
  no token, `403` when invalid, forwarded on pass; `GET /ping` stays
  unauthenticated. `--sigv4` is mutually exclusive with `--bearer-token`.
- For HTTP / AGUI the SAME port also serves `/ws` behind a host WebSocket BRIDGE
  that injects the session-id / `Authorization` upgrade headers a browser
  `WebSocket` cannot set — a fresh session-id per connection unless
  `--session-id` pins one.
- All four protocols are served: HTTP / AGUI on 8080, MCP on 8000, A2A on 9000.
  MCP / A2A have no `GET /ping`, so readiness is an HTTP response to the protocol
  path, and they are pure pass-through. HTTP / AGUI print a
  `Server listening on ws://...` ready line, kept VERBATIM for studio's
  agentcore-ws serve.
- `--watch` rotates ONLY the container, keeping the HOST serve up: rebuild boots
  a fresh container on a NEW port and re-points via `server.setContainerPort`,
  soft-reload preserves the port. The forever-promise main loop is SERVE-level,
  so a per-container teardown during reload never tears the serve down.

## CloudFront: `start-cloudfront`

One distribution per invocation.

- **CloudFront Functions** run in-process in a `node:vm` sandbox
  (`cloudfront-js-1.0` / `2.0`, async handlers awaited) that adds the 2.0
  built-ins a bare vm lacks (`Buffer`, `atob` / `btoa`, text codecs, `require`
  of `crypto` / `querystring` / `buffer`) — a superset of the 2.0 subset. `fs` /
  `process` / timers / network / `eval` are absent (`ReferenceError`). The vm is
  a fidelity sandbox, not a security boundary.
- **S3 origin content** is the BucketDeployment source asset from the cloud
  assembly (origin bucket -> `Custom::CDKBucketDeployment` -> `SourceObjectKeys`),
  served with `DefaultRootObject` (ROOT ONLY — sub-paths are not auto-indexed)
  and `CustomErrorResponses`.
- With NO local BucketDeployment source, `--from-cfn-stack` reads the deployed
  bucket from **real S3 on demand** (`GetObject` per touched key).
  Bucket name, in PRIORITY ORDER: the same-stack physical id
  (`ListStackResources`), a literal `DomainName`, else
  `cloudfront:GetDistributionConfig`. `AccessDenied` warns with the `--origin`
  hatch.
- `--cache-origin` caches that reader only (a WARNED no-op without
  `--from-cfn-stack`).
- Path patterns route across `DefaultCacheBehavior` + `CacheBehaviors[]`; a
  viewer-request function returning a `statusCode` short-circuits.
- **ResponseHeadersPolicy CORS** (`CorsConfig`) is reproduced per behavior: a
  matching `OPTIONS` preflight is answered `204` + CORS headers before the origin
  is hit, and a real response gets them added LAST (`OriginOverride: false` is
  NOT distinguished). Origin matching is literal-or-`*`; an AWS-managed policy
  id is not fetchable, so its CORS is skipped. Non-CORS sections are not applied.
- **Lambda Function URL origins** resolve `DomainName` -> `AWS::Lambda::Url` ->
  the backing function in a warm RIE container (payload v2.0 event); a pure-S3
  distribution needs no Docker. **AWS_IAM auth is NOT enforced; streaming is
  buffered.**
- **Web Function endpoint origins** (`GetAtt[<endpoint>, DomainName]`) run the
  endpoint's pick as `start-web-function` does (shared `WebFunctionServe`) and
  forward the origin request to it (502 unreachable, 504 past
  `OriginReadTimeout`). OAC signing and `AuthType` are NOT reproduced.
- **KeyValueStore reads** (`cf.kvs().get` / `exists`) are backed by the deployed
  store (by NAME via `ListKeyValueStores`, then the SigV4A `GetKey`) or a local
  JSON map (`--kvs-file`); a read with NO binding fails naming both flags.
  `meta()` / `count()` and writes are NOT reproduced.
- **Lambda@Edge** functions ARE run in warm RIE containers at all four event
  types (`viewer-request` / `origin-request` may short-circuit or rewrite). The
  `request.origin` rewrite block and the edge tiers are out of scope.
- **Any other custom origin** and the 2.0 `cf.fetch` API are WARN-and-skip;
  unresolved origins return 502.
- `--watch` swaps the routing model under the live socket: viewer functions and
  S3 origins reload; Lambda / Web Function origin containers are BOOT-TIME ONLY.

## Lambda Web Functions: `start-web-function`

ONE revision: `--revision`, a revision target, the endpoint's top weight, the
only revision, the only endpoint's pick. Code: the `S3Object`'s cdk.out asset
(no download; a `Fn.select(i, objectKeys)` key of an `extract: false`
BucketDeployment = its i-th source asset), RIE entrypoint replaced, no `--rm`; ready = an HTTP answer,
not TCP accept. Env: `resolveLambdaContainerEnv` sans Lambda-API fallbacks.
WARNED only: egress connector, non-`HomeRegion`, weighted split,
non-`ApplicationManaged` auth.

## Lambda MicroVMs: `start-microvm`

Dockerfile from `CodeArtifact.Uri`'s cdk.out asset (no download), built once;
one container per `--count`, no `--rm`. Hooks in cloud order: `/ready` (503 /
refused retried), `/validate` on the SAME container, `/run` with `{microvmId,
runHookPayload}`; traffic only after `/run` answers 200. Ports
8080 / `Hooks.Port` / EXPOSE / `--proxy-port` are PUBLISHED (Docker Desktop
cannot route to container IPs); any other is 403. `X-aws-proxy-*` and MicroVM
subprotocols stripped. Suspend = hook + `docker pause`. WARNED only: no
snapshot (pre-`/ready` state NOT shared), JWE auth, idle policy, egress, OS
caps, sizing.
