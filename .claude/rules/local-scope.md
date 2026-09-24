# Local-emulation scope: per-command semantics and fidelity boundaries

What each `cdkl` command reproduces and where fidelity stops. Read it before
asserting in docs or JSDoc what is / is not reproduced, and before extending a
command's emulation surface. Flag spellings live in README.md.

## Lambda / API Gateway

- Lambda functions run in a real `public.ecr.aws/lambda/*` container via the
  Lambda Runtime Interface Emulator.
- API Gateway routing: REST v1 / HTTP v2 / Function URL / WebSocket over a local
  HTTP server, with Lambda / Cognito User Pool JWT / IAM SigV4 authorizers.

**Container env is one shared rule.** `resolveLambdaContainerEnv` resolves the
env of EVERY locally booted Lambda container — direct `cdkl invoke`, ALB Lambda
targets, CloudFront Function URL origins, Lambda@Edge — once per backing Lambda
at BOOT: `Environment.Variables`, `--from-cfn-stack` intrinsic substitution,
`--assume-role` STS / `--profile` creds. Decrypted `SecureString` values stay OFF
the `docker run` argv — except under finch on macOS / Windows, which rewrites
the value-less `-e KEY` onto the `limactl` argv, so a container with one is
refused there unless `<envPrefix>_ALLOW_SECRETS_ON_ARGV` is set (#749). Creds
ride the env overlay, so **the named-profile credentials-FILE mount `cdkl
invoke` adds is NOT reproduced** and an explicit `fromIni({ profile })` is the
one `--profile` case not covered. Without a state flag, dev-shell creds are
forwarded and intrinsic env values dropped (warn per key).

## ECS: `start-service` / `start-alb` / `run-task`

Real Docker containers with awsvpc / Service Connect / Cloud Map.
`start-service` runs a service's replicas only — compute, no load balancer.

### `--watch` reload

A per-firing classifier picks the per-replica primitive:

- **soft-reload** — source-only edit on an interpreted-language handler (Node /
  Python / Ruby / shell; no Dockerfile, no dependency manifest, no compiled
  source): `docker cp` the synthed asset dir into each replica's WORKDIR +
  `docker restart`. No build, no shadow boot; IP and host port are PRESERVED, so
  draining the Cloud Map handles + front-door pool entry and re-publishing under
  the SAME owner key is a no-op at the end-state level — but that round trip
  holds the zero-connection-refusal guarantee while the container restarts.
- **rebuild** — Dockerfile / dependency-manifest / compiled-source / ambiguous
  edits: boot a shadow replica under a bumped generation suffix, atomically swap
  Cloud Map + front-door registrations off the dying replica (after a TCP-ready
  probe on the shadow's port), then retire the old container.

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
rebuild primitive. Engine: `src/local/image-override-engine.ts` (issue
go-to-k/cdk-local#238).

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
  `#{protocol}` resolving to `https`; the degradation is logged per listener,
  never silent. `--tls` opts in to real termination. Deployed `Certificates[]`
  ACM ARNs are NOT fetched — ACM private keys are not retrievable by design.
- `authenticate-cognito` / `authenticate-oidc`: a Bearer-JWT check (signature +
  `iss` + `aud` + `exp` against the deployed ALB's JWKS / OIDC discovery URL) or
  an `AWSELBAuthSessionCookie-*` pass-through, defeatable with
  `--no-verify-auth`. **The OAuth roundtrip — IdP redirect, callback, cookie
  issuance — is NOT reproduced.**
- WebSocket Upgrade is proxied for ECS forward targets through the same
  rule-matching + auth-gate pipeline, then the raw TCP socket is bridged.
  Lambda target groups refuse it with 502, mirroring ALB itself.
- `TargetType: lambda` target groups invoke the Lambda locally with a
  `requestContext.elb` event, so one forward can mix ECS and Lambda targets.

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
- `--watch` works ONLY on the long-running `--ws` path (same classifier as the
  ECS serves); the `/ws` socket is closed cleanly on every firing, since
  AgentCore has no mid-session handoff. The single-shot HTTP / MCP / A2A paths
  WARN once and proceed single-shot.

### `start-agentcore` (long-running serve)

Boots the container ONCE and keeps it warm on one host port until `^C`, so many
calls reuse one container.

- **Inbound auth mirrors the cloud PER REQUEST**, unlike single-shot
  `invoke-agentcore`, which validates a token ONCE at boot: each `POST`'s
  `Authorization` is verified against the OIDC discovery URL / JWKS — `401` with
  no token, `403` when invalid, forwarded on pass; `GET /ping` stays
  unauthenticated. `--sigv4` is mutually exclusive with `--bearer-token`.
- For HTTP / AGUI the SAME port also serves `/ws` behind a host WebSocket BRIDGE:
  a header-less client (a browser `WebSocket` cannot set the session-id or
  `Authorization` upgrade header) could not otherwise hold a session, so the
  bridge injects them, with a fresh session-id per connection / request unless
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

The `viewer-request` -> S3 origin -> `viewer-response` pipeline, one
distribution per invocation.

- **CloudFront Functions** run in-process in a `node:vm` sandbox
  (`cloudfront-js-1.0` / `2.0`, async handlers awaited) that adds the 2.0
  built-ins a bare vm lacks (`Buffer`, `atob` / `btoa`, the text codecs, a
  `require` for `crypto` / `querystring` / `buffer`) from Node — a superset of
  the documented 2.0 subset. `fs` / `process` / timers / network / `eval` are NOT
  provided (a `ReferenceError`, matching the restricted runtime). The vm is a
  fidelity sandbox, not a security boundary.
- **S3 origin content** is the BucketDeployment source asset from the cloud
  assembly (origin bucket -> `Custom::CDKBucketDeployment` -> `SourceObjectKeys`),
  served with `DefaultRootObject` (ROOT ONLY — sub-paths are not auto-indexed)
  and `CustomErrorResponses`.
- With NO local BucketDeployment source, `--from-cfn-stack` reads the deployed
  bucket from **real S3 on demand** (a `GetObject` per touched key, no pre-sync).
  Bucket name, in PRIORITY ORDER: the same-stack bucket's physical id from
  `ListStackResources`; else a literal name from the origin's `DomainName`; else
  — for a pure intrinsic — `cloudfront:GetDistributionConfig`. `AccessDenied`
  warns with the `--origin` hatch.
- `--cache-origin` caches that reader only, so without `--from-cfn-stack` it is
  a no-op — a boot-time WARN keeps that visible.
- Path patterns route across `DefaultCacheBehavior` + `CacheBehaviors[]`; a
  viewer-request function returning a `statusCode` short-circuits.
- **ResponseHeadersPolicy CORS** (`CorsConfig`) is reproduced per behavior: a
  matching `OPTIONS` preflight is answered `204` + CORS headers before the origin
  is hit, and a real response gets them added LAST — so
  `CorsConfig.OriginOverride: false` is NOT distinguished from `true`. Origin
  matching is literal-or-`*` (no wildcard subdomains; an AWS-managed policy id is
  not fetchable, so its CORS is skipped). Non-CORS sections are not applied.
- **Lambda Function URL origins** resolve `DomainName` -> `AWS::Lambda::Url` ->
  the backing function, booted once in a warm RIE container and invoked with a
  Function URL (payload v2.0) event. start-cloudfront is therefore PURE-LOCAL
  (no Docker) for a pure-S3 distribution and boots a container ONLY for such an
  origin. **AWS_IAM auth on the Function URL is NOT enforced, and response
  streaming is buffered.**
- **KeyValueStore reads** (`cf.kvs().get` / `exists`) are reproduced: the
  `import cf from 'cloudfront'` line is stripped and a `cf` module injected,
  backed by the deployed store (its physical id is the store NAME, resolved via
  `ListKeyValueStores`, then read through the real SigV4A-signed `GetKey`
  data-plane API) or by a local JSON map (`--kvs-file <key>=<file>`). A read with
  NO binding fails with an error naming both flags. `meta()` / `count()` and KVS
  writes are NOT reproduced.
- **Lambda@Edge** functions ARE run, each in a warm RIE container, with all four
  event types wired — `viewer-request` / `origin-request` (either may
  short-circuit or rewrite) -> origin -> `origin-response` / `viewer-response`.
  The `request.origin` rewrite block and the edge tiers are out of scope.
- **Origins: S3 + Lambda Function URL ONLY.** A generic custom origin and the 2.0
  `cf.fetch` API are WARN-and-skip; unresolved origins return 502.
- `--watch` atomically swaps the in-memory routing model under the live socket:
  viewer functions and S3 origins reload, but a Function URL origin's warm
  container is BOOT-TIME ONLY.
