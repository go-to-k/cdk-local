# Local execution

`cdkl *` runs AWS workloads on the developer's machine via Docker — no
AWS deploy, no `template.yaml` to maintain, no `cdk synth | sam ...`
round-trip. Reuses cdk-local's synthesis / asset / construct-path
plumbing directly.

## Scope

cdk-local runs your **application compute** (Lambda functions, API
Gateway endpoints, ECS tasks/services) locally in Docker, using your
CDK app as the source of truth. It does NOT emulate AWS managed
services (DynamoDB, S3, Secrets Manager, SNS, SQS, EventBridge, etc.) —
your handler code calls those over the public AWS APIs using your IAM
credentials.

## Subcommands

| Subcommand | Emulates | Backed by |
| --- | --- | --- |
| `cdkl invoke <target>` | One-shot Lambda invoke | AWS Lambda Runtime Interface Emulator (RIE) container |
| `cdkl start-api` | Long-running HTTP server — API Gateway (REST v1 / HTTP API / WebSocket) + Lambda Function URL | RIE container pool + `node:http` listener (one server per discovered API) |
| `cdkl run-task <target>` | ECS `RunTask` for one task | docker network + ECS metadata sidecar (`amazon/amazon-ecs-local-container-endpoints`) |
| `cdkl start-service <target>` | Long-running ECS `Service` emulator | `run-task` machinery per replica + per-replica docker subnet allocator + restart-on-exit watcher |

## Requirements

All `cdkl *` commands require Docker on the developer's machine. The
first run pulls the relevant base image (~600MB for the language-specific
Lambda images, ~50MB for `provided.*`, plus the ECS metadata sidecar
for `run-task`). Subsequent runs reuse the cached image; pass
`--no-pull` to skip the `docker pull` round-trip altogether (per-command
`--no-pull` semantics may differ — see each section below).

## Common flags

Shared across all subcommands:

- `-a, --app <cmd-or-dir>` — CDK app command or pre-synthesized
  `cdk.out` directory. Defaults to synth-every-time; pass `-a cdk.out`
  to iterate faster.
- `--env-vars <file>` — SAM-compatible JSON override:
  `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. `null` clears a
  key. Keys MUST be logical IDs today; display-path keys are tracked as
  issue [#27](https://github.com/go-to-k/cdk-local/issues/27).
- `--no-pull` — Skip `docker pull` (per-command semantics differ;
  consult each section).
- `--from-cfn-stack [cfn-stack-name]` — Bind the local run to a
  deployed CloudFormation stack: cdk-local calls
  `cloudformation:DescribeStacks` / `ListStackResources` /
  `ListExports` and substitutes the deployed physical IDs / exports /
  outputs into the local container's env vars / secrets / image URIs.
  See the per-command sections below.
- `--stack-region <region>` — Region used when constructing the
  CloudFormation client for `--from-cfn-stack`.
- `--container-host <ip>` — Bind IP for published ports (default
  `127.0.0.1`). Must be a numeric IP; Docker rejects hostnames in
  `-p <ip>:<port>:<port>`.

## `invoke` (run Lambda functions locally)

`cdkl invoke <target>` runs a Lambda function from a CDK app on the
developer's machine, inside a Docker container that bundles the AWS
Lambda Runtime Interface Emulator (RIE). Modeled on `sam local invoke`
but reusing cdk-local's synthesis / asset / construct-path plumbing.

**Requires Docker.** The first invocation pulls the Lambda base image
(`public.ecr.aws/lambda/nodejs:<version>`,
`public.ecr.aws/lambda/python:<version>`,
`public.ecr.aws/lambda/ruby:<version>`,
`public.ecr.aws/lambda/java:<version>`,
`public.ecr.aws/lambda/dotnet:<version>`, or
`public.ecr.aws/lambda/provided:<al2|al2023>` — ~600MB for the
language-specific images, ~50MB for the OS-only `provided.*`);
subsequent invocations reuse the cached image. Pass `--no-pull` to
skip the `docker pull` round-trip altogether. Supported runtimes:
`nodejs18.x` / `nodejs20.x` / `nodejs22.x` / `nodejs24.x` /
`python3.11` / `python3.12` / `python3.13` / `python3.14` /
`ruby3.2` / `ruby3.3` / `java8.al2` / `java11` / `java17` / `java21` /
`dotnet6` / `dotnet8` / `provided.al2` / `provided.al2023`. The
deprecated `go1.x` runtime is rejected with a migration pointer to
`provided.al2023`. Java, .NET, and `provided.*` are **asset-backed
only** — inline `Code.ZipFile` is rejected with a routing message
("use `lambda.Code.fromAsset(...)`") because the Handler shape names
a compiled artifact (`package.Class::method` for Java's JVM class;
`Assembly::Namespace.Class::Method` for .NET's CLR assembly; an
arbitrary `bootstrap` binary for `provided.*`).

**Container Lambdas** — `lambda.DockerImageFunction(...)` /
`Code.ImageUri` is supported in addition to ZIP Lambdas. cdk-local
reads the function's local `Dockerfile` from `cdk.out` (via the asset
manifest keyed off the `:<hash>` suffix on `Code.ImageUri`) and runs
`docker build` locally, then `docker run` against the resulting image.
When no asset matches (typically: invoking a stack deployed elsewhere),
cdk-local falls back to `docker pull` from ECR. **Cross-account /
cross-region pull is supported**: cdk-local auto-detects cross-account
from `sts:GetCallerIdentity`, builds the ECR client for the URI's
region, and (when `--ecr-role-arn <arn>` is passed) issues
`sts:AssumeRole` to pick up permissions in the target account. Without
`--ecr-role-arn`, cdk-local falls through to the caller's credentials —
works when the target ECR repository's resource policy grants the
caller directly (AWS surfaces `AccessDenied` if missing, with a hint at
the flag). `Architectures: [x86_64]` (default) and `[arm64]` are
honored via `--platform linux/amd64` / `linux/arm64` on both the build
and the run.

### Target resolution

The positional `<target>` accepts two forms:

- **CDK display path** — `MyStack/MyApi/Handler`. Matches via the same
  prefix rule cdk-local uses elsewhere: an L2 path resolves to the
  synthesized L1 child (`MyStack/MyApi/Handler/Resource`).
- **Stack-qualified logical ID** — `MyStack:MyApiHandler1234ABCD`. The
  colon is unambiguous because logical IDs cannot contain `/` or `:`.

Single-stack apps may omit the stack prefix entirely: `cdkl invoke
MyHandler` is valid when the app contains exactly one stack.

When the target does not match anything, the error lists every Lambda
in the resolved stack so the user can copy/paste a valid one.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-e, --event <file>` | `{}` | JSON event payload file. |
| `--event-stdin` | off | Read event JSON from stdin (mutually exclusive with `--event`). |
| `--env-vars <file>` | — | JSON env-var overrides, SAM-compatible shape: `{"LogicalId":{"KEY":"VALUE"}}` plus an optional top-level `"Parameters"` block applied to every invoke. `null` clears a key. |
| `--no-pull` | off | Skip `docker pull`. Semantics differ by code path: **ZIP Lambdas** — skip pulling the public Lambda base image. **Container Lambdas, local-build path** — no-op (docker build's default does not refresh the FROM cache). **Container Lambdas, ECR-pull fallback** — skip `docker pull` AND error if the image is not in the local cache (re-run without `--no-pull` or pre-pull manually). |
| `--no-build` | off | Skip `docker build` on the **Container Lambdas, local-build path** (`Code.ImageUri`). Requires the deterministic `cdkl-invoke-<hash>` tag to already be in the local docker registry from a prior `cdkl invoke` (or manual `docker build`); errors clearly when missing. **No-op for ZIP Lambdas** (no docker build runs there) AND for the **Container Lambdas, ECR-pull fallback** (use `--no-pull` to control that path). Compatible with `--no-pull`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR on the **Container Lambdas, ECR-pull fallback** path. Issues `sts:AssumeRole` via the CLI's resolved credentials (honoring `--profile`) and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull`. Required for cross-account pulls when the caller's identity does not already have direct cross-account access. Same-account / same-region pulls do not need this flag; cross-account without the flag falls back to the caller's credentials (succeeds when an IAM resource policy on the ECR repo grants the caller directly, else AWS surfaces `AccessDenied`). No-op when `--no-pull` is set. |
| `--debug-port <port>` | off | Set `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` and publish the port; attach a Node debugger to step through the handler. |
| `--container-host <host>` | `127.0.0.1` | Host to bind the RIE port to. |
| `--assume-role [arn]` | off | STS-assume the deployed function's execution role and forward the resulting temp credentials to the container, so the handler runs under the deployed role's narrow permissions instead of the developer's typically-admin shell credentials. Three forms: (1) `--assume-role <arn>` assumes the explicit ARN (precedence wins); (2) `--assume-role` (bare) auto-resolves the function's `Properties.Role` from the bound CloudFormation stack (requires `--from-cfn-stack`); (3) `--no-assume-role` explicitly opts out (forces dev creds even with `--from-cfn-stack`). Off by default — when omitted, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` are passed through unchanged (SAM-compatible default). STS failures degrade to a warn + dev-creds fallback. |
| `-a, --app <cmd-or-dir>` | — | CDK app command or pre-synthesized `cdk.out` directory. Default: synth every time. Pass `-a cdk.out` to skip synthesis when iterating. |
| `--output <dir>` | `cdk.out` | Output directory for synthesis. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack and substitute `Ref` / `Fn::ImportValue` / supported `Fn::Sub` / `Fn::Join` placeholders + AWS pseudo parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` / `${AWS::URLSuffix}`) in env vars with the deployed physical IDs / exports. Bare form uses the CDK stack name (typical case); pass an explicit value when the deployed CFn stack name differs (e.g. CDK's `stackName` prop was overridden). `Fn::GetAtt` (and other intrinsics `ListStackResources` can't resolve) in the Lambda's OWN env is recovered from the deployed function's resolved `Environment.Variables` via `lambda:GetFunctionConfiguration`. See [CloudFormation-driven env recovery (`--from-cfn-stack`)](#cloudformation-driven-env-recovery---from-cfn-stack) below. |
| `--stack-region <region>` | auto | Region used to construct the CloudFormation client for `--from-cfn-stack`. Defaults to `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > the synth-derived stack region > the `--profile`'s configured region (`~/.aws/config`). |
| `--layer-role-arn <arn>` | — | Role ARN to assume before calling `lambda:GetLayerVersion` on literal-ARN layer entries. Issues `sts:AssumeRole` via the default credential chain and uses the resulting temp creds for the GetLayerVersion call only — the assumed role is NOT propagated into the Lambda container at runtime (that's what `--assume-role` is for). Use this when the layer lives in a different account than the calling identity and direct cross-account access is not granted via the layer's resource policy. |

### Environment variables

Template `Properties.Environment.Variables` entries:

- **Literal values** (string / number / boolean) are passed through as-is.
- **Intrinsic-valued entries** (`Ref` / `Fn::GetAtt` / `Fn::Sub` /
  `Fn::Join`, plus the `${AWS::AccountId}` / `${AWS::Region}` /
  `${AWS::Partition}` / `${AWS::URLSuffix}` pseudo parameters) need a
  bound CloudFormation stack (and a single `sts:GetCallerIdentity` for
  `${AWS::AccountId}`) to resolve. Without `--from-cfn-stack` cdk-local
  emits a warning naming the variable and **drops** it (rather than
  silently substituting garbage); pass `--from-cfn-stack` (see below)
  to recover deployed values from CloudFormation, or override
  intrinsics via `--env-vars`.

Standard Lambda runtime env vars are always set:
`AWS_LAMBDA_FUNCTION_NAME`, `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`,
`AWS_LAMBDA_FUNCTION_TIMEOUT`, `AWS_LAMBDA_FUNCTION_VERSION`,
`AWS_LAMBDA_LOG_GROUP_NAME`, `AWS_LAMBDA_LOG_STREAM_NAME`. The
handler's `context.*` fields look real.

### CloudFormation-driven env recovery (`--from-cfn-stack`)

When the target stack has been deployed via `cdk deploy` (or any other
CloudFormation-based path), the function's intrinsic-valued env vars
(`Ref` / `Fn::ImportValue` / `Fn::Sub`) reference resources whose
physical IDs only exist in AWS. The default behavior is to drop those
entries with a warn — correct when there's no source of truth, but
unhelpful when CloudFormation already knows them. `--from-cfn-stack`
opts in to reading the deployed CFn stack and substituting the deployed
values before the env block reaches the container.

```bash
# Bare flag — uses the CDK stack name as the CFn stack name
# (typical for CDK apps where they match).
cdk deploy MyStack
cdkl invoke MyStack/MyApi/Handler --from-cfn-stack

# Explicit CFn stack name — use when the deployed CFn stack name
# differs from the CDK display name (e.g. when CDK's `stackName`
# prop was overridden).
cdkl invoke MyStack/MyApi/Handler --from-cfn-stack MyExplicitCfnStackName

# Cross-region CFn stack — --stack-region drives the CFn client region.
cdkl invoke MyStack/MyApi/Handler --from-cfn-stack --stack-region eu-west-1

# Combine with --env-vars to override a single key (override wins).
# --env-vars takes a JSON file path; e.g. ./env.json holding
# {"Parameters":{"DEBUG":"1"}}.
cdkl invoke MyStack/MyApi/Handler --from-cfn-stack \
  --env-vars ./env.json
```

**Resolution priority** (highest priority wins):

1. `--env-vars` file function-specific entry (`{LogicalId: {KEY: VALUE}}`).
2. `--env-vars` file global `Parameters` block.
3. `--from-cfn-stack` substituted intrinsic (when the flag is set AND
   the template entry was a supported intrinsic AND substitution
   succeeded).
4. `--from-cfn-stack` deployed-env fallback (the consumer function's own
   deploy-time-resolved value, for intrinsic keys step 3 could not
   resolve — see `Fn::GetAtt` recovery below).
5. Template literal value.

**What's resolved**: `Ref: <LogicalId>` against
`ListStackResources` (paginated — every page is walked so stacks with
more than 100 resources are fully mapped), `Fn::ImportValue:
<ExportName>` against `cloudformation:ListExports` (paginated, memoized
for one substitution pass), and supported `Fn::Sub` / `Fn::Join` /
`${AWS::*}` shapes via the same substitution engine.

**`Fn::GetAtt` recovery**: CFn's `ListStackResources` does NOT return
per-attribute values — it only exposes `(LogicalResourceId,
PhysicalResourceId, ResourceType)` triplets — so `Fn::GetAtt` does not
resolve against the resource map. For a Lambda's OWN env vars cdk-local
closes this by reading the deployed function's already-resolved
`Environment.Variables` via `lambda:GetFunctionConfiguration`
(CloudFormation resolved every intrinsic at deploy time), so e.g.
`SIBLING_ARN: Fn::GetAtt <OtherFunction>.Arn` is recovered without a
manual override. The same fallback covers `Fn::Sub` / `Fn::ImportValue`
/ cross-stack `Ref` in the env block. Keys absent from the deployed
function's env (e.g. a var added locally since the last deploy) still
warn-and-drop — override via `--env-vars`. Recovered values enter the
local container env in plaintext; Lambda env vars are a non-secret
property, so this exposes nothing the deployed function doesn't already
surface to a caller with `lambda:GetFunctionConfiguration`.

**Auto-assume execution role**: when `--from-cfn-stack` is paired with
bare `--assume-role` (no ARN argument), cdk-local reads the function's
`Properties.Role` from the deployed CFn stack, resolves the IAM Role
ARN, and STS-assumes that role automatically — no manual ARN lookup
required. Pass `--no-assume-role` to explicitly opt out even with
`--from-cfn-stack`; pass `--assume-role <arn>` to override the resolved
ARN with an explicit one. STS failures (insufficient permissions /
trust-policy mismatch) degrade to a warn + dev-creds fallback — this is
a developer-loop tool, not a security boundary.

**Pseudo parameters**: when the function's template env contains any
intrinsic value, `--from-cfn-stack` issues a single
`sts:GetCallerIdentity` (for `${AWS::AccountId}`) and derives
`partition` / `urlSuffix` from the resolved region (`--stack-region` >
`--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > the synth-derived
stack region). STS failures degrade to warn — substitution still runs
for non-`AWS::*` refs; affected `${AWS::*}` placeholders fall back to
warn + drop. Literal-only env maps skip the STS hop.

**Region handling**: the CFn client is region-bound at construction
time. When NONE of the region signals is set the CLI **throws** with a
remediation message — CFn `ListStackResources` queries a specific
region and silently picking `us-east-1` would query the wrong stack
environment.

**Multi-stack guard**: `start-api` / `start-service` route multiple
stacks in one invocation (for `start-api`, multi-stack routing is opt-in
via `--all-stacks`). Bare `--from-cfn-stack` works there because each
routed stack uses its own CDK stack name as the CFn stack name — so
`--all-stacks --from-cfn-stack` (bare) binds every routed stack to its
own deployed stack. **Explicit `--from-cfn-stack <name>` is rejected**
when more than one stack is routed (the explicit name would apply to
every routed stack and silently mismap `Ref` lookups whose logical IDs
happen to collide between siblings) — and `--all-stacks` rejects it
upfront for the same reason. Use bare `--from-cfn-stack` for multi-stack
apps, or run one cdk-local invocation per stack.

**Failure modes**: `ListStackResources` failures (stack not found,
access denied, throttling) degrade to a per-key warn + drop — the
invoke continues with literal-only env vars. `ListExports` failures
only affect `Fn::ImportValue` resolution; same-stack `Ref`
substitutions still succeed because they only need the
`ListStackResources` result.

**Out of scope** (deferred): the substitution engine itself still does
not resolve `Fn::GetAtt` or other intrinsics (`Fn::Select`, `Fn::Split`,
`Fn::If`, etc.) against the resource map — but for a Lambda's own env the
deployed-env fallback above recovers `Fn::GetAtt` (and `Fn::Sub` /
`Fn::ImportValue` / cross-stack `Ref`) from the deployed function config.
Intrinsics with no deployed-env counterpart are treated as unresolved
(warn + drop).

### Asset resolution

**ZIP Lambdas**: cdk-local uses the CDK-blessed
`Metadata['aws:asset:path']` hint on each Lambda's CFn resource (the
same source SAM uses) to find the local unzipped asset directory under
`cdk.out`, and bind-mounts it at `/var/task` read-only. `Code.ZipFile`
(inline) functions are materialized to a tmpdir using the file path
implied by the function's `Handler` property (`index.handler` →
`tmpdir/index.js`).

### Lambda Layers

Same-stack `AWS::Lambda::LayerVersion` references in `Properties.Layers`
are resolved automatically and bind-mounted at `/opt` (read-only)
inside the container. The flow:

1. `cdkl invoke` walks `Properties.Layers` left-to-right.
2. Each entry must be `{Ref: '<LayerLogicalId>'}` or
   `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` pointing at an
   `AWS::Lambda::LayerVersion` resource in the same stack. The layer's
   `Metadata['aws:asset:path']` is read the same way Lambda code is
   located — the layer asset is unzipped under `cdk.out/asset.<hash>/`
   ready to bind-mount.
3. cdk-local produces a single bind mount at `/opt`:
   - **Single layer**: the layer's asset dir is bind-mounted directly
     (no copy).
   - **Multiple layers**: each layer's contents are copied into a
     freshly-allocated tmpdir IN ORDER (later layers overwrite earlier
     files via `cpSync({force: true})`); the merged tmpdir is then
     bind-mounted at `/opt` and removed in the cleanup path.
   - The merge mirrors AWS Lambda's actual runtime behavior: AWS
     extracts every layer ZIP into `/opt` in template order so later
     layers shadow earlier files (**"last layer wins on file
     collision"**). cdk-local cannot rely on multiple `-v ...:/opt:ro`
     entries — Docker rejects duplicate bind mounts at the same target
     path with `Error response from daemon: Duplicate mount point: /opt`.
4. The layer's directory layout (`/opt/python/...`,
   `/opt/nodejs/...`, `/opt/lib/...`, etc.) is the user's
   responsibility — cdk-local does NOT inspect the contents.

**Out of scope (v1)** — hard-errors with a clear pointer at the
offending entry:

- Literal-ARN layer entries (`arn:aws:lambda:...`) — these are external
  / pre-existing layers including cross-account / cross-region. No
  asset on disk to mount; deferred to a follow-up.
- Same-stack refs that don't point at an `AWS::Lambda::LayerVersion`
  (typo'd logical ID).
- Same-stack refs to a `LayerVersion` whose `Metadata['aws:asset:path']`
  is missing.

**Container Lambdas** (`Code.ImageUri`): the `Layers` property is
silently ignored — matches AWS behavior, since container images bake
their layers at build time and AWS rejects `Layers` on container
Lambdas at deploy time.

### Container Lambdas

`Code.ImageUri`: cdk-local extracts the asset hash from the `:<hash>`
tail of the image URI (CDK synthesizes the URI as a `Fn::Sub` whose
body ends in the asset hash) and looks the matching entry up in the
stack's asset manifest (`cdk.out/<stack>.assets.json`,
`dockerImages[<hash>]`). When the lookup hits, `cdkl invoke` calls
`docker build` against the recorded build context. When the lookup
misses AND the manifest contains exactly one Docker asset, that single
asset is used (single-asset fallback — covers digest-pinned URIs). When
both miss, cdk-local falls back to **ECR pull** with cross-account /
cross-region support: cdk-local builds the ECR client for the URI's
region and (when `--ecr-role-arn <arn>` is passed) issues
`sts:AssumeRole` to gain credentials in the target account before
authenticating to ECR and pulling. Without `--ecr-role-arn`, cdk-local
uses the caller's credentials directly (works when the ECR repo's
resource policy grants the caller, else AWS surfaces `AccessDenied`
with a hint at the flag).

`ImageConfig.Command` becomes the docker run CMD;
`ImageConfig.EntryPoint` (when set) becomes `--entrypoint <first>`
plus the rest as positional args; `ImageConfig.WorkingDirectory`
becomes `--workdir`. When `EntryPoint` is unset (the common case), the
image's default entrypoint stays in charge — for AWS Lambda base
images that's `/lambda-entrypoint.sh`, which routes to RIE on port
8080.

### Ephemeral storage (`/tmp` cap)

When a Lambda's template declares `Properties.EphemeralStorage.Size`
(typical CDK shape:
`new lambda.Function(this, 'X', { ephemeralStorageSize: cdk.Size.gibibytes(2) })`),
`cdkl invoke` adds `--tmpfs /tmp:rw,size=<N>m` to the `docker run`
command so the container's `/tmp` is a memory-backed filesystem capped
at the templated value (`N` MiB; `cdk.Size.gibibytes(2)` serializes to
`2048`). Handlers that exceed the deployed cap fail locally with
`ENOSPC` the way they would on AWS, and handlers that detect free space
via `statvfs` / `df` see the configured cap rather than the host's
overlay-fs.

Applies to both ZIP and IMAGE (container) Lambdas — `--tmpfs` overlays
mount-time inside any container regardless of base image. Container
Lambdas get an `[info]` log line at startup so users notice the
`/tmp` override on top of whatever their Dockerfile placed there.

When `EphemeralStorage` is absent, no `--tmpfs` is emitted and the
container's `/tmp` is whatever the base image provides (AWS Lambda
base images don't mount a sized tmpfs themselves). Templates over the
AWS 10240 MiB (10 GiB) ceiling hard-error at resolve time with an
actionable message rather than hanging on a `docker run` that AWS
would have refused anyway. Intrinsic-valued `Size` entries (the
`{Ref: 'SomeParam'}` shape) drop silently to no-`--tmpfs` since local
invoke cannot resolve them without the Parameters context the deploy
engine has.

The same cap applies to `cdkl start-api`'s warm container pool — each
cold-started container for a Lambda with `EphemeralStorage` gets the
same sized `/tmp`.

### `invoke` exit codes

- `0` — RIE answered, regardless of whether the handler returned a
  success payload OR an error payload. Lambda-style: a thrown handler
  produces a 200 with an error structure on AWS, and we mirror that.
- `1` — cdk-local-side errors before/after the handler ran: Docker not
  installed, image pull failed, target not found, RIE port unreachable
  after the readiness window, container exited before responding.

### v1 scope (out of scope, deferred)

| Out of scope | Deferred to |
| --- | --- |
| Cross-account / cross-region / pre-existing-ARN Lambda Layers | Future PR (same-stack `AWS::Lambda::LayerVersion` refs are supported in v1; literal ARNs hard-error — see "Lambda Layers" section above) |
| `Fn::GetAtt` in `--from-cfn-stack` Lambda env | Recovered from the deployed function's `Environment.Variables` (`lambda:GetFunctionConfiguration`) |
| `Fn::Select` / `Fn::Split` / `Fn::If` etc. in `--from-cfn-stack` (substitution engine) | Future PR (warn + drop today, unless present in the deployed function's env) |
| SQS / S3 event source emulation | Future PR |
| VPC simulation | Never (local can't replicate VPC) |
| Custom Resources (`Custom::*`) | Never — these are invoked by the deploy framework, not by users. cdk-local surfaces a clear error pointing at the underlying ServiceToken Lambda. |

## `start-api` (long-running local API server)

`cdkl start-api` stands up a long-running HTTP server that maps
synthesized API Gateway routes (REST v1, HTTP API, WebSocket) and
Lambda Function URLs to local Lambda invocations against the AWS
Lambda Runtime Interface Emulator. Modeled on `sam local start-api`
but reusing cdk-local's synthesis, asset, and route-discovery
plumbing — no `template.yaml` round-trip.

**Requires Docker.** As with `cdkl invoke`, the first run pulls the
Lambda base image (~600MB once per machine). Pass `--no-pull` on
subsequent runs to skip the layer check.

```bash
cdkl start-api                              # auto-allocate one port PER discovered API
cdkl start-api --port 3000                  # first API → 3000, second API → 3001, ...
cdkl start-api MyAdminApi                   # logical id (single-stack apps)
cdkl start-api MyStack/MyAdminApi           # OR: CDK Construct path (prefix-matched)
cdkl start-api --warm                       # pre-start one container per Lambda
```

### One server per API

Every discovered API surface (`AWS::ApiGatewayV2::Api`,
`AWS::ApiGateway::RestApi`, `AWS::Lambda::Url`) gets its own HTTP
server on its own port. cdk-local prints one `Server listening on
http://<host>:<port>  (<API> (<kind>))` line per server at startup,
and one route table per server underneath.

This is a deliberate departure from `sam local start-api`'s
single-server-per-template model: realistic CDK apps usually define
multiple APIs (admin + public, internal + external) with different
authorizer setups, different CORS configs, and overlapping paths.
Lumping them into one server forces an awkward "first-match-wins"
semantic that doesn't mirror AWS Lambda's actual routing.

Port assignment:

| `--port` value | Per-API port allocation |
| --- | --- |
| `0` (default) | Every server auto-allocates its own port. |
| `3000` | First API → `3000`, second API → `3001`, third → `3002`, ... |

Pass an optional positional `<target>` to launch exactly one server
for the named API. The same target syntax `cdkl invoke` / `cdkl
run-task` use applies here — the whole `cdkl *` family addresses
resources consistently:

1. **Bare logical id** — `MyHttpApi`. **Single-stack apps only**;
   in multi-stack apps cdk-local rejects this form with a
   disambiguation hint. The id is the HTTP API / REST API logical id,
   or (for Function URLs) the backing Lambda's logical id.
2. **Stack-qualified logical id** — `MyStack:MyHttpApi`. Works in any
   app size; required when the same bare id exists in two stacks.
3. **CDK Construct path / display path** — `MyStack/MyHttpApi/Resource`.
   Exact match against the resource's `aws:cdk:path` metadata.
4. **CDK Construct path prefix** — `MyStack/MyHttpApi`. Matches when
   the input is a strict ancestor of the resource's `aws:cdk:path`:
   CDK's `new apigw2.HttpApi(stack, 'MyHttpApi')` synthesizes the L1
   child at `MyStack/MyHttpApi/Resource`, so `cdkl start-api
   MyStack/MyHttpApi` resolves cleanly without having to type the
   synthesized `/Resource` suffix.

For Function URLs, the path forms reference the **backing Lambda's**
`aws:cdk:path`, not the auto-generated URL resource — so `cdkl
start-api MyStack/MyHandler` matches the Function URL declared by
`new lambda.Function(this, 'MyHandler').addFunctionUrl()`.

Routes from templates without `aws:cdk:path` metadata (hand-rolled
`cfn.Resource` defs, or older CDK that didn't emit the metadata)
still match by bare logical id (form 1) and by stack-qualified logical
id (form 2) — only the path forms (3, 4) need the metadata.

### Discovered routes

| Source | CFn types |
| --- | --- |
| HTTP API | `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| REST v1 | `AWS::ApiGateway::RestApi`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Stage` |
| Function URL | `AWS::Lambda::Url` |

Per-route classification (boot never aborts on per-integration
unsupportedness):

| Class | Trigger | Behavior |
| --- | --- | --- |
| Normal AWS_PROXY | AWS_PROXY integration with a resolvable Lambda Arn | Dispatched to the Lambda via the container pool. |
| Synthetic CORS preflight | REST v1 `HttpMethod: OPTIONS` + `Integration.Type: MOCK` + `IntegrationResponses[].ResponseParameters` carries literal `method.response.header.*` pairs (the shape CDK's `defaultCorsPreflightOptions` synthesizes) | Captured at boot. The HTTP server returns the captured status + headers directly on OPTIONS without invoking any Lambda. |
| Streaming Function URL | `AWS::Lambda::Url` with `InvokeMode: RESPONSE_STREAM` | Dispatched via the RIE streaming protocol: the request goes out with `Lambda-Runtime-Function-Response-Mode: streaming` and the response body's JSON prelude (`{statusCode, headers, cookies?}` + an 8-NULL-byte separator + raw body) is parsed; the body Readable is piped to the HTTP client with `Transfer-Encoding: chunked`. Note: AWS's local RIE buffers the response (verified empirically against `public.ecr.aws/lambda/nodejs:20`), so curl observes the chunks in one block locally even though cdk-local's pipe / chunked-encoding machinery works correctly — real incremental delivery only manifests against the deployed Lambda runtime. |
| REST v1 non-AWS_PROXY | `Integration.Type` is one of `MOCK` (non-CORS-preflight), `HTTP_PROXY`, `HTTP`, or `AWS` (Lambda non-proxy). | Dispatched via the per-kind handler in [src/local/rest-v1-integrations.ts](../src/local/rest-v1-integrations.ts). MOCK / HTTP / AWS apply VTL request + response templates via the hand-rolled engine at [src/local/vtl-engine.ts](../src/local/vtl-engine.ts). HTTP_PROXY forwards verbatim with `RequestParameters` mappings. AWS Lambda non-proxy uses the same container pool as AWS_PROXY but transforms event payload + response via VTL and routes errors through `IntegrationResponses[].SelectionPattern`. |
| Deferred-error unsupported | REST v1 AWS integration targeting a non-Lambda service (`:s3:path/...` / `:sqs:action/...` etc.); HTTP_PROXY / HTTP with a non-literal `Uri` (cdk-local does not resolve Fn::Sub / Fn::Join in HTTP Uris); HTTP API v2 service integrations (`IntegrationSubtype` set); Function URLs with an unrecognized `AuthType` (anything other than `'NONE'` / `'AWS_IAM'`); routes whose Lambda Arn intrinsic cannot be resolved against the same template (cross-stack / imported references) | Boot continues. The route appears in the route table tagged `[501 Not Implemented]` and a `[warn]` line per route is printed up front. When the route is hit at request time, the HTTP server returns HTTP 501 with `{"message": "Not Implemented", "reason": "<the discovery reason>"}` in the JSON body, without invoking any Lambda. |
| Hard error | Template-structural problems the discovery layer cannot generate a meaningful route from: missing `Integration` on a Method, non-Ref `RestApiId` / `ApiId`, malformed Route `Target`, ParentId chain failures, missing `PathPart`, unresolvable `TargetFunctionArn` on a Function URL | Boot aborts via `RouteDiscoveryError` with every offending route listed in a single message. |

The deferred-error class lets you run the supported subset of an API
locally even when the CDK app contains direct AWS-service integrations,
WebSocket routes, or other unimplemented shapes — only the unsupported
routes themselves return 501; everything else dispatches as normal.

### REST v1 non-AWS_PROXY integrations

`cdkl start-api` emulates all four non-AWS_PROXY REST v1 integration
types end-to-end:

| Type | Behavior | Notes |
| --- | --- | --- |
| `MOCK` | Renders `Integration.RequestTemplates['application/json']` (VTL) to extract `{"statusCode": N}`; matches against `IntegrationResponses[].StatusCode`; renders the picked entry's `ResponseTemplates[<content-type>]` (VTL) against an empty input context (`$inputRoot = null`). | When no request template is set, defaults to the entry with no `SelectionPattern`. `ResponseParameters` header literals (`'value'`) apply; mapping expressions (`integration.response.*` / `context.*`) are warn-and-skipped. |
| `HTTP_PROXY` | Forwards the HTTP request to `Integration.Uri` with `{paramName}` path-placeholder substitution. Honors `Integration.IntegrationHttpMethod`. Applies `Integration.RequestParameters` (header `'literal'` / `method.request.header.X` mappings; querystring / path mappings are recognized but logged-and-skipped — use `{param}` URI substitution instead). | Forwards the upstream body verbatim. `IntegrationResponses[].SelectionPattern` (regex against the upstream status as a string) drives the final HTTP status; `ResponseParameters` applies. |
| `HTTP` (non-proxy) | HTTP_PROXY + VTL on both directions: `RequestTemplates[<content-type>]` transforms the body before sending; `IntegrationResponses[].ResponseTemplates[<content-type>]` transforms the upstream body before returning. | Same `RequestParameters` semantics as HTTP_PROXY. |
| `AWS` (Lambda non-proxy) | VTL request template synthesizes the Lambda event payload (parsed as JSON when the rendered template is valid JSON, otherwise passed through as a string — matches AWS-deployed behavior). The Lambda runs in the same warm RIE container pool as AWS_PROXY. Error envelope (`{errorMessage, errorType?, stackTrace?}`) routes through `SelectionPattern` against `errorMessage`. Response template runs with `$inputRoot = <parsed Lambda return value>`. | Direct AWS-service integrations (`Type: 'AWS'` with `Uri` pointing at `:s3:path/...` / `:sqs:action/...` / etc.) are NOT emulated locally — they surface as deferred-501 unsupported routes. Deploy to AWS or pin a public HTTP_PROXY to a mock service. |

The VTL engine at [src/local/vtl-engine.ts](../src/local/vtl-engine.ts)
implements a hand-rolled minimal subset of AWS API Gateway's VTL spec.
Supported features:

- Variable references: `$var`, `${var}`, `$obj.field.subField`
- Built-ins:
  - `$input.body` — raw request body
  - `$input.json('$.path')` — JSON-stringified slice (primitives JSON-quoted)
  - `$input.path('$.path')` — native value
  - `$input.params()` — `{header, querystring, path}` union
  - `$input.params('name')` — path > query > header precedence
  - `$input.params('header').<name>` / `.querystring` / `.path`
  - `$context.requestId` / `httpMethod` / `resourcePath` / `stage`
  - `$context.identity.sourceIp` / `userAgent`
  - `$util.escapeJavaScript(s)` / `base64Encode` / `base64Decode` / `urlEncode` / `urlDecode` / `parseJson`
- Directives: `#set($var = expr)`, `#if(cond)` / `#elseif` / `#else` / `#end`, `#foreach($x in $list)` / `#end`, `##` line comments
- Operators: `&&`, `||`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`
- JSONPath subset: `$`, `$.field`, `$.field.sub`, `$.array[index]`, quoted-string bracket keys

**Intentionally NOT supported** (any usage surfaces `VtlEvaluationError`
with the offending construct named in the message — converted to
HTTP 502 + reason JSON body at request time):

- Velocity arithmetic operators (`+ - * /`) outside literal concat
- User-defined `#macro`
- `#parse` / `#include`
- Range operator (`[1..5]`)
- `$velocityCount` and other Velocity context built-ins
- JSONPath filter expressions (`$..items`, `$.items[?(@.x > 5)]`)

### Routing precedence

3 tiers per AWS docs: full match → greedy `{proxy+}` → `$default`.
Within "full match" tier, more literal segments win as a best-effort
tie-break (AWS does not formally specify multi-route precedence within
the same tier; cdk-local uses literal-segment count as a heuristic).

### Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--port <port>` | auto-allocate | First API server's port (subsequent APIs get `port+1`, `port+2`, ...). Pass `0` (default) to auto-allocate each. The actual port assignment is printed at startup. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--stack <name>` | single-stack auto-detect | Required when the app has multiple stacks AND no other selector identifies the target. In multi-stack apps the synth stack is picked from the first match of: (1) `--stack <name>`, (2) `--from-cfn-stack <explicit-name>`, (3) the positional target's stack-name prefix (e.g. `MyStack/MyApi` → `MyStack`), (4) `--all-stacks` (serve every stack). |
| `--all-stacks` | off | Serve every stack's API in a multi-stack app (each API on its own port) instead of erroring out for an ambiguous selection. Mutually exclusive with a positional target, `--stack`, and an explicit `--from-cfn-stack <name>`; the bare `--from-cfn-stack` flag stays compatible (binds each routed stack to its own CFn stack). No-op in a single-stack app. |
| `--warm` | off | Pre-start one container per discovered Lambda at server boot. Trades RAM for first-request latency. |
| `--per-lambda-concurrency <n>` | `2` | Pool size cap per Lambda. Max 4 in v1; above-cap values are clamped with a warn. |
| `--no-pull` | off | Skip `docker pull`. |
| `--container-host <host>` | `127.0.0.1` | IP the host uses to bind/probe the RIE port. Must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames like `host.docker.internal`. |
| `--debug-port-base <port>` | unset | Allocate a contiguous `--inspect-brk` port range across Lambdas (one per Lambda). |
| `--env-vars <file>` | unset | SAM-shape JSON: `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. Same format as `cdkl invoke`. |
| `--assume-role <arn-or-pair>` | unset | Repeatable. Bare `<arn>` = global default; `<LogicalId>=<arn>` = per-Lambda override. Per-Lambda > global > unset (developer creds passed through). |
| `--watch` | off | Hot reload: re-synth + re-discover routes when the CDK app's source tree (the directory holding `cdk.json`) changes. Honors `cdk.json` `watch.include` / `watch.exclude`; `cdk.out/`, `node_modules`, and `.git` are always excluded so the reload's own re-synth writes never re-trigger it. 500ms debounce. Synth failures keep the previous version serving (warn-and-continue, never crashes the server). |
| `--stage <name>` | first attached | Select an API Gateway Stage by `StageName`. Drives `event.stageVariables` (REST v1 + HTTP API v2). When the override doesn't match any Stage on a given API, that API's routes get `stageVariables: null` and the CLI emits a warn line up front. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack and substitute `Ref` / `Fn::ImportValue` / supported `Fn::Sub` / `Fn::Join` placeholders + AWS pseudo parameters in Lambda env vars with the deployed physical IDs / exports. **The bare form is the typical shape** — `cdkl start-api MyStack/MyApi --from-cfn-stack` resolves to the CDK stack name (`MyStack` here) per routed stack. Pass an explicit value (`--from-cfn-stack <name>`) only when the deployed CFn stack name differs from the CDK stack name (e.g. CDK's `stackName` prop was overridden). The explicit form is rejected when more than one stack is routed in one invocation; the bare form is fine for multi-stack. `Fn::GetAtt` (and other intrinsics `ListStackResources` can't resolve) in a routed Lambda's OWN env is recovered from the deployed function's resolved `Environment.Variables` via `lambda:GetFunctionConfiguration`. Re-runs against fresh CFn data on every hot-reload firing (`--watch`). ListStackResources failures degrade per-stack to warn-and-fall-back so an unreadable stack never aborts the server. |
| `--stack-region <region>` | auto | Region used to construct the CloudFormation client for `--from-cfn-stack`. |
| `--mtls-truststore <path>` | unset | PEM-encoded CA bundle for client-certificate verification. When set, the server switches from HTTP to HTTPS and the TLS handshake rejects clients whose certificate doesn't chain to one of these CAs. Must be set together with `--mtls-cert` + `--mtls-key`; partial flag sets are rejected. See the "mTLS (mutual TLS)" section below for the openssl recipe + event-shape details. |
| `--mtls-cert <path>` | unset | PEM-encoded server certificate for mutual TLS. Self-signed is fine for local dev. Must be set together with `--mtls-truststore` + `--mtls-key`. |
| `--mtls-key <path>` | unset | PEM-encoded server private key matching `--mtls-cert`. Must be set together with `--mtls-truststore` + `--mtls-cert`. |

**Container `AWS_REGION` fallback**: when neither `--assume-role`'s STS
region nor an `AWS_REGION` / `AWS_DEFAULT_REGION` env var already set a
region for a Lambda container, cdk-local seeds `AWS_REGION` from the first
available of `--stack-region` > the synth-derived stack region
(`env.region` on the CDK stack, read from the cloud assembly manifest) >
the `--profile`'s configured region (`~/.aws/config`'s `region =`).
`--profile` injects the credential triple but the synthesized credentials
file carries no `region =`, and the synth-derived stack region was
previously used only host-side for the `--from-cfn-stack` CFn client — so
without this a handler's ambient-region SDK call (`new XxxClient({})`)
booted with credentials but failed locally with "Region is missing" while
succeeding when deployed. A region-agnostic stack run with no profile
region and no `AWS_REGION` env still surfaces that SDK error — set
`AWS_REGION` or `--stack-region`.

### Hot reload (`--watch`)

When `--watch` is set, cdk-local installs a
[chokidar](https://github.com/paulmillr/chokidar)-backed file watcher
over the CDK app's **source tree** — the synth working directory, which
is where `cdk.json` lives. Editing handler or construct source and
saving triggers a debounced (500ms window) reload, so no separate
`cdk watch` / `cdk synth` process is needed.

The watch set honors `cdk.json`'s `watch.include` / `watch.exclude`
globs (mirroring `cdk watch`); `watch.include` defaults to `**` and a
missing `watch` block is not an error. Three paths are ALWAYS excluded:

- the synth **output directory** (`cdk.out/`, or the `--output` value),
- `node_modules`,
- `.git`.

Excluding the output directory is load-bearing for correctness: each
reload re-synths INTO `cdk.out/`, so watching it would make the reload's
own writes re-trigger the watcher forever. Because the output directory
is pruned, those re-synth writes are invisible to the watcher and there
is no reload loop.

A qualifying change triggers the reload sequence:

1. Re-run `cdk synth`.
2. Re-run route discovery, stage resolution, and CORS-config
   extraction.
3. Build per-Lambda specs + a fresh container pool.
4. Atomically swap the server state. Routes added / removed / changed
   take effect on the next request.
5. Dispose the previous pool in the background — in-flight requests
   complete against the old containers; new requests hit the new
   pool.

Synth failures during reload do NOT crash the server. The previous
version keeps serving and the CLI emits a `[warn]` line naming the
failure. Reloads serialize, so a burst of file changes coalesces to
one synth.

### CORS preflight

cdk-local's HTTP server intercepts OPTIONS preflight requests for HTTP
API v2 routes whose `AWS::ApiGatewayV2::Api` has a `CorsConfiguration`:

- Match `Origin` against `AllowOrigins` (literal entries or `*`).
- Match `Access-Control-Request-Method` against `AllowMethods`.
- Match each `Access-Control-Request-Headers` entry against
  `AllowHeaders` (case-insensitive).
- Respond `204 No Content` with the canonical `Access-Control-Allow-*`
  headers, plus `Access-Control-Max-Age` / `Access-Control-Expose-Headers`
  / `Access-Control-Allow-Credentials` when configured.
- Always set `Vary: Origin` so downstream caches (browser / CDN) do
  not share the response across origins (load-bearing whenever
  `Access-Control-Allow-Origin` was derived from the request — the
  wildcard echo, literal-origin echo, and `AllowCredentials` echo
  paths all qualify).

When `AllowCredentials: true` AND the origin matched via `*`, the
response echoes the request's literal `Origin` (browser fetch spec
disallows `*` + credentials).

`Access-Control-Request-Headers` lists are validated strictly: a
malformed entry (e.g. `"Content-Type,,Authorization"` — a trailing /
embedded empty entry) rejects the preflight rather than silently
skipping the empty entry. This matches AWS's stricter HTTP API
behavior on preflight headers.

When the user has registered an explicit OPTIONS method on a path
(an `AWS::ApiGatewayV2::Route` whose `RouteKey` is `OPTIONS /...`)
**on the same API as the matched route**, preflight interception is
skipped — the user's Lambda owns the OPTIONS surface. The same-API
filter is load-bearing in multi-API stacks: an explicit OPTIONS
route on Stack B's REST v1 API at the same path no longer suppresses
preflight on Stack A's HTTP API v2.

REST v1 (`AWS::ApiGateway::*`) CORS via Mock OPTIONS methods IS
intercepted when the synthesized template matches CDK's
`defaultCorsPreflightOptions` shape: `HttpMethod: 'OPTIONS'` +
`Integration.Type: 'MOCK'` + `IntegrationResponses[].ResponseParameters`
carrying literal `method.response.header.Access-Control-Allow-*` pairs.
The headers are extracted at boot (AWS's `"'value'"` single-quote
wrappers are stripped) and the HTTP server returns the captured
status and headers directly on OPTIONS requests — no Lambda
invocation, no VTL evaluation. The default status code is 204
(matches the CDK default); intrinsic-valued (`Fn::Sub` / `Ref` etc.)
`ResponseParameters` are dropped silently because cdk-local cannot
evaluate VTL locally, and if the drop leaves zero header literals the
route falls back to the deferred-error 501 class.

Other REST v1 MOCK shapes (non-OPTIONS methods, MOCK without literal
header parameters, MOCK with VTL `RequestTemplates` that produce custom
bodies) are dispatched via the full MOCK handler — see the "REST v1
non-AWS_PROXY integrations" section above.

### Stage variables

`event.stageVariables` is populated from the selected Stage's
`Variables` (REST v1) / `StageVariables` (HTTP API v2) map.

- **Default**: the first Stage attached to each API in template
  order.
- **`--stage <name>`**: select a Stage by `StageName`. Applied per-API
  — a `--stage prod` override against an app with three APIs picks
  the matching Stage on each. APIs without a matching Stage get
  `stageVariables: null` and surface a warn line at startup. The
  resolved stage name is threaded into `event.requestContext.stage`
  for **both** REST v1 and HTTP API v2 routes. AWS supports named
  stages on HTTP API v2 (`CreateStage` accepts any name; `$default`
  is the auto-deploy default but not the only option), so a v2
  template that pins a named Stage gets that name surfaced through
  the integration event — matching what the deployed endpoint would
  emit. v2 APIs without a templated Stage continue to use
  `'$default'`.
- **Function URL** routes don't have a Stage — `stageVariables` stays
  `null` regardless of the flag.
- **Intrinsic-valued entries** (`Ref`, `Fn::GetAtt`, `Fn::Sub`) in
  the Stage's `Variables` map are dropped with a warn (the local
  server has no deploy state to resolve them against without
  `--from-cfn-stack`).

### Container lifecycle

- One pool per Lambda. Each container's RIE port is bound to its own
  free host port (`pickFreePort`); the user-facing HTTP server stays on
  the single `--port`.
- `acquire()` returns the first idle container in the pool; lazy-grows
  up to `--per-lambda-concurrency` under a per-Lambda mutex. Above the
  cap, requests queue.
- `release()` returns the container to the pool and starts a 60s idle
  timer. Idle GC fires after 60s of inactivity per pool.
- Containers are named `cdkl-<logicalId>-<pid>-<rand>` so an
  external sweep can mop up orphans (`docker ps --filter
  name=cdkl-`).

### Lambda Layers in `start-api`

`cdkl start-api` resolves same-stack `AWS::Lambda::LayerVersion`
references the same way `cdkl invoke` does — see the **Lambda Layers**
section under `invoke` above for the full rules (supported reference
shapes, last-layer-wins on file collision, the single merged `/opt`
bind mount, hard-error cases). The merge happens once per Lambda at
server boot (not per request); the merged tmpdir is removed by the
graceful shutdown path. Single-layer Lambdas skip the copy and
bind-mount the layer's asset dir directly.

### Container Lambdas (`Code.ImageUri`) in `start-api`

`cdkl start-api` supports `lambda.DockerImageFunction` /
`Code.ImageUri` on the same terms as `cdkl invoke` (see the
**Container Lambdas** section under `invoke` above). At server boot —
and on every `--watch` reload — cdk-local resolves each container
Lambda's image once: **local-build** from the `cdk.out` asset manifest
when the synthesizer produced a matching `dockerImages` entry (then
`docker build` runs against the recorded build context), or
**ECR-pull** fallback when no asset matches. The resulting
deterministic `cdkl-invoke-<hash>` tag goes into the warm
container pool; the pool runs `docker run` against it verbatim — no
`/var/task` bind-mount, no base-image pull, `ImageConfig.Command` /
`ImageConfig.EntryPoint` / `ImageConfig.WorkingDirectory` /
`--platform` (from `Architectures`) all threaded through. Container
Lambdas silently ignore `Properties.Layers` (matches AWS's invoke-time
behavior — layers are baked into the image at build time on the IMAGE
branch). Hot reload (`--watch`) detects Dockerfile / build-context
changes via the content-addressed image tag: a real source edit flips
the tag at the next reload's `docker build`, the spec signature
compares unequal, and the pool entry tears down + restarts so the next
request sees the new image.

### Graceful shutdown

`SIGINT` / `SIGTERM` / `uncaughtException` / `unhandledRejection` all
run the same dispose path: drain in-flight requests, tear down every
container (tolerating per-container removal failures — logged at warn,
loop continues). The verify-time `docker ps --filter` sweep is the
defense-in-depth backstop.

Double-`^C` bypasses dispose and exits immediately so the user can
escape a hung Docker daemon. The skipped containers are reported with
the `docker ps` cleanup command in the warning.

### `start-api` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, port bind failed, route
  discovery rejected) OR uncaught exception during the run.
- `130` — exited via SIGINT.

### `start-api` authorizers

cdk-local supports four authorizer kinds in front of any discovered
route:

- **Lambda TOKEN** (REST v1) — `AWS::ApiGateway::Authorizer.Type: 'TOKEN'`.
  The header named in `IdentitySource` (default
  `method.request.header.Authorization`) is forwarded to the authorizer
  Lambda as `event.authorizationToken`. The Lambda's response must carry
  a `policyDocument` with at least one `{ Effect: 'Allow', Resource:
  <methodArn> }` statement; cdk-local matches `Resource` against the
  request's methodArn (literal or `*`/`?` wildcard) on every request —
  cached verdicts get re-evaluated against the new methodArn so a
  narrow-Resource Allow doesn't leak across routes. Allow → context
  flat under `event.requestContext.authorizer`. Policy-deny → HTTP 403,
  missing identity header → HTTP 401 without invoking the Lambda.
- **Lambda REQUEST** — REST v1 (`Type: 'REQUEST'`) and HTTP v2
  (`AuthorizerType: 'REQUEST'`). The full request snapshot (headers,
  query string, path parameters) is passed to the authorizer Lambda.
  HTTP v2 also accepts the simple `{ isAuthorized, context }` response
  shape in addition to the IAM-policy shape. REST v1 missing-identity →
  HTTP 401 without invoking the Lambda; HTTP v2 falls through.
- **Cognito User Pool** (REST v1) — `Type: 'COGNITO_USER_POOLS'`. The
  Bearer token from `Authorization: Bearer <token>` is verified locally
  against the user pool's published JWKS. Allow → claims under
  `event.requestContext.authorizer.claims`. Deny → HTTP 403.
- **JWT** (HTTP v2) — `AuthorizerType: 'JWT'`. Same JWKS-based
  verification, with `aud` / `client_id` matched against the
  `JwtConfiguration.Audience` allowlist. Allow → claims under
  `event.requestContext.authorizer.jwt.claims`. Deny → HTTP 401.

Authorizer results are cached per `(authorizer, identity)` for the TTL
declared by the authorizer (REST v1: `AuthorizerResultTtlInSeconds`,
default 300s, max 3600s; HTTP v2: 0 by default = no cache; JWT: cached
for `min(remaining-exp, 300s)`).

**JWKS-fetch failure → pass-through.** When the JWKS endpoint is
unreachable at startup, cdk-local warns and falls back to a pass-through
mode where every Bearer token is accepted as if valid (including
malformed / non-JWT garbage — a real JWT still gets its claims
surfaced into `event.requestContext.authorizer`, a malformed token
gets a synthetic `unknown` principal and an empty claims map):

```text
[warn] [cognito-jwt] JWKS unreachable at https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json: ...
        JWT validation will allow all tokens — local dev fallback. Configure
        network access to the JWKS URL to enable real signature verification.
```

The failure entry has a short TTL (~60s) so a transient blip doesn't
lock pass-through for the full 1hr success TTL — the next minute's
request retries the JWKS fetch. The pass-through warn line itself
fires at most once per JWKS URL per server lifecycle (the warn-set
is constructed once at server startup, not per request).

This is a deliberate dev-tool tradeoff: surprising deny is worse than
warn+allow when the developer is iterating on a function and the JWKS
URL is blocked by a corporate proxy. **Do NOT rely on this in any
shared environment** — the dev's machine accepts every token, including
forged ones.

`AWS_IAM` authorization is supported with **signature-verification-only**
semantics on BOTH REST v1 (`AuthorizationType: 'AWS_IAM'`) and Function
URLs (`AuthType: 'AWS_IAM'`) — see the next section. mTLS authorizers
and any non-TOKEN/REQUEST/COGNITO_USER_POOLS Type / non-REQUEST/JWT
AuthorizerType still hard-error at discovery with the offending route's
location named.

### `start-api` AWS_IAM authorizer (REST v1 + Function URL, signature verification only)

Routes that declare REST v1 `AuthorizationType: 'AWS_IAM'` OR Function
URL `AuthType: 'AWS_IAM'` boot and serve requests; cdk-local verifies
the inbound `Authorization: AWS4-HMAC-SHA256 ...` SigV4 signature
against the developer's **local** AWS credentials (the same default
credential chain every other cdk-local command uses):

1. Parse the header into `(Credential, SignedHeaders, Signature)`.
2. Reconstruct the canonical request per the AWS SigV4 spec.
3. Derive the signing key from the local secret access key + the
   request's date / region / service scope.
4. Constant-time compare the recomputed signature with the header's.

Outcomes:

- **Valid signature with the dev's credentials** → request reaches the
  handler.
  - **REST v1**: the handler sees the access-key-id as
    `event.requestContext.authorizer.principalId` (flat v1 overlay).
  - **Function URL**: NO authorizer block is synthesized. The base v2
    event's `requestContext.authorizer` stays `null`. AWS-deployed
    Function URLs write principal context under
    `event.requestContext.authorizer.iam.{accessKey, accountId, callerId,
    userArn, ...}`, and cdk-local has no local IAM data plane to populate
    that block (no STS GetCallerIdentity per request, no policy
    emulation). Emitting principalId under `.lambda` would mislead
    handlers that defensive-read `.iam`, so the deployed and local
    behavior diverge only by absence of identity context — never by
    location.
- **No / malformed `Authorization` header**, **signature mismatch
  under the dev's own credentials**, or any other rejection → 403
  matching the deployed response:
  - REST v1: 403 (`{"message":"Missing Authentication Token"}`) for
    missing-identity, 403 (`{"message":"Forbidden"}`) for policy-deny —
    matches AWS-deployed API Gateway REST v1 IAM rejection (lowercase
    `message`).
  - Function URL: 403 (`{"Message":"Forbidden"}`) for both deny kinds —
    matches Lambda's deployed Function URL IAM rejection (capital
    `Message`).
- **Different `Credential` access-key-id than the dev has** (or no local
  AWS credentials configured) → the local server cannot reproduce a
  signing key it doesn't have, so verification is impossible. **Warn-and-pass
  by default**: the request reaches the handler with a placeholder
  principalId (`unverified-foreign-identity` / `unverified-no-creds`) plus a
  one-line warn. Local execution targets app logic and ergonomics, not an
  authorization boundary cdk-local cannot fully emulate, and the most common
  legitimate case (federated / Cognito Identity Pool / cross-account signers)
  is foreign by construction — so blocking it would be the wrong default. The
  placeholder principalId keeps identity-based handler authz from trusting a
  forged caller, and the deployed API Gateway still does the real
  verification + IAM evaluation. Pass `--strict-sigv4` to **deny** unverifiable
  requests instead (fail-closed). The warn fires at most once per foreign
  access-key-id per server lifecycle.

#### OAC-fronted Function URLs (auto-relaxed)

A Function URL declared with `AuthType: 'AWS_IAM'` is, in the
production-recommended CDK pattern
(`FunctionUrlOrigin.withOriginAccessControl`), fronted by a CloudFront
distribution that re-signs every origin request with CloudFront's own
identity via an Origin Access Control (OAC). The end client never signs
as the IAM principal — the Function URL's resource policy trusts
`cloudfront.amazonaws.com`, not the caller. Locally there is no CloudFront
in the path, so no client signature can reproduce CloudFront's.

cdk-local detects this from the synthesized template (a CloudFront origin
whose `DomainName` resolves to the Function URL and that carries an
`OriginAccessControlId` whose `SigningBehavior` is not `never`) and
**always warn-and-passes those routes — even under `--strict-sigv4`**,
because no local client signature can ever reproduce CloudFront's. (Other
AWS_IAM routes also warn-and-pass by default, but `--strict-sigv4` flips
them to fail-closed; OAC-fronted routes ignore it.) The startup notice
(below) lists OAC-fronted routes
separately so the relaxation is explicit.

**What is NOT verified locally** (deliberately out of scope):

- IAM resource / action / condition policy evaluation. The local
  server has no IAM data plane. Signature-verified callers reach the
  handler under their own identity; downstream authorization is the
  dev's responsibility. Use the deployed API to test the full IAM
  policy surface.
- STS temporary credentials' session-token validation against AWS.
  We accept whatever session-token the request was signed with.

At startup cdk-local emits a one-line warn naming every IAM-protected
route so the developer is aware of the signature-verification-only
boundary:

```text
[warn] 2 route(s) declare AuthorizationType: AWS_IAM — cdkl start-api
       verifies SigV4 signatures against your local AWS credentials, but does NOT
       emulate IAM policy evaluation (resource / action / condition rules).
       Signature-verified callers reach the handler under their own identity;
       downstream authorization is the dev's responsibility.
[warn]   - MyStack/ProtectedMethod
[warn]   - MyStack/AnotherProtectedMethod
```

OAC-fronted Function URLs (auto-relaxed, see above) are reported under a
separate line so their warn-and-pass behavior is explicit:

```text
[warn] 1 Function URL route(s) with AuthType: AWS_IAM are fronted by a CloudFront
       Origin Access Control. In production CloudFront re-signs the origin request,
       so no local client signature can be verified — cdkl start-api passes these
       through (warn-and-pass) and they ignore --strict-sigv4. Do NOT
       trust the request identity in handler code.
[warn]   - MyStack/StreamingFnUrl
```

Tooling that signs requests works out of the box — common helpers
include `aws-sigv4-sdk` (AWS SDK v3 signer), `curl --aws-sigv4`,
Postman's AWS Signature auth, and the `awscurl` CLI.

### `start-api` VPC-config Lambdas

Lambdas with `Properties.VpcConfig` set still run locally — cdk-local
does NOT block these — but the local container does NOT get attached
to the deployed VPC's subnets. Calls from the handler to private RDS /
ElastiCache / VPC-only endpoints will fail. cdk-local surfaces a
one-line warn at startup naming each affected Lambda:

```text
[warn] Lambda MyVpcLambda has VpcConfig — local container will reach external
        services via the host's network, NOT through the deployed VPC's
        NAT/private subnets. Calls to private RDS/ElastiCache will fail.
```

AWS SDK calls from the container still use the developer's shell
credentials (or `--assume-role`-issued temp creds) and reach the public
AWS endpoints; nothing about that path changes.

### `start-api` mTLS (mutual TLS)

`cdkl start-api` supports API Gateway custom-domain mutual TLS: when
all three `--mtls-truststore <path>` / `--mtls-cert <path>` /
`--mtls-key <path>` flags are set, the server switches from plain HTTP
to HTTPS and the TLS handshake itself enforces the client-certificate
trust check against the supplied CA bundle. Clients without a cert,
with a self-signed cert, or with a cert that doesn't chain to one of
the CAs in the trust store are rejected by Node's `tls` module BEFORE
the request reaches cdk-local's per-request handler — no per-request
code path is needed.

The verified client certificate is surfaced on the Lambda event under:

- **REST v1**: `event.requestContext.identity.clientCert`
- **HTTP API v2**: `event.requestContext.authentication.clientCert`

Both shapes match AWS API Gateway's deployed-mTLS event shape:

```json
{
  "clientCertPem": "-----BEGIN CERTIFICATE-----\n...",
  "subjectDN": "CN=client,O=example,C=US",
  "issuerDN": "CN=My CA,O=example,C=US",
  "serialNumber": "01:23:45:...",
  "validity": {
    "notBefore": "May 22 03:30:00 2026 GMT",
    "notAfter": "May 22 03:30:00 2027 GMT"
  }
}
```

mTLS runs ORTHOGONALLY to the existing TOKEN / REQUEST / COGNITO_USER_POOLS
/ JWT authorizers — the TLS handshake completes first (rejecting
unknown-CA clients), then the authorizer pipeline runs against the
already-authenticated client.

**Partial flag sets are rejected at CLI parse time** (the server never
boots in a half-configured state): if any of the three flags is set,
all three must be set. Leave all three unset for plain HTTP (the
default).

#### Generating a local CA + server + client cert with openssl

```bash
# 1. Create a local CA
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ca-key.pem -out ca.pem \
  -subj "/CN=cdkl-ca" -days 365

# 2. Generate a server cert signed by the local CA
openssl req -newkey rsa:2048 -nodes \
  -keyout server-key.pem -out server-csr.pem \
  -subj "/CN=localhost"
openssl x509 -req -in server-csr.pem \
  -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out server-cert.pem -days 365

# 3. Generate a client cert signed by the local CA
openssl req -newkey rsa:2048 -nodes \
  -keyout client-key.pem -out client-csr.pem \
  -subj "/CN=client"
openssl x509 -req -in client-csr.pem \
  -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out client-cert.pem -days 365

# 4. Start the server with mTLS enabled
cdkl start-api \
  --mtls-truststore ca.pem \
  --mtls-cert server-cert.pem \
  --mtls-key server-key.pem

# 5. curl the server with the client cert
curl --cacert ca.pem \
  --cert client-cert.pem --key client-key.pem \
  https://localhost:<port>/items
```

#### mTLS scope

- The mTLS configuration is at the SERVER level (the equivalent of an
  API Gateway custom-domain `MutualTlsAuthentication.TruststoreUri`).
  cdk-local does NOT parse the synth template's
  `AWS::ApiGateway::DomainName` / `AWS::ApiGatewayV2::DomainName`
  resources — the CLI flags are the authoritative source. If your CDK
  app declares mTLS on a DomainName, you can re-use the same CA bundle
  locally by pointing `--mtls-truststore` at the file you uploaded to
  the deployed truststore S3 location.
- The server cert and key are for the LOCAL server only (clients
  connect to `localhost`). Self-signed is the typical case.
- AWS-deployed mTLS uses `MutualTlsAuthentication.TruststoreVersion`
  for live trust-store updates; the local server reads the
  `--mtls-truststore` file once at boot. Restart `cdkl start-api` to
  pick up a new CA bundle (the `--watch` reload pipeline does NOT
  re-read the mTLS materials).

### `start-api` v1 scope (out of scope, deferred)

| Out of scope | Deferred to |
| --- | --- |
| AWS_IAM authorizer (REST v1 + Function URL) — IAM policy evaluation (resource/action/condition). Signature verification IS implemented on both surfaces. | Out of scope (the local server has no IAM data plane) |
| REST v1 AWS integration with non-Lambda service backend (`:s3:path/...` / `:sqs:action/...` / `:dynamodb:action/...` / etc.) | Future PR — requires per-service SDK clients, IAM credential threading, and a per-service compatibility matrix. v1 emulates Lambda non-proxy AWS integrations only. |
| VTL features outside the supported subset (arithmetic outside literal concat, `#macro` / `#parse` / `#include`, range operator, `$velocityCount`, JSONPath filter expressions) | Surface as `VtlEvaluationError` → HTTP 502 + reason body. Hand-roll the missing feature in [src/local/vtl-engine.ts](../src/local/vtl-engine.ts) if a real workload needs it. |
| Throttling / quotas / usage plans / API keys | Never |
| Per-Lambda concurrency above 4 | Future PR if a real workload needs it |

## `run-task` (run an ECS task definition locally)

`cdkl run-task <Stack/TaskDefinitionPath>` is the ECS counterpart of
`cdkl invoke`. It takes an `AWS::ECS::TaskDefinition` defined in a CDK
app and starts every container on the developer's Docker host — no AWS
deploy needed.

Synchronous run of one task: stream every container's stdout/stderr
with a `[<name>]` prefix, propagate the essential container's exit
code. For long-running ECS Services with replicas + restart policy, use
`cdkl start-service` (covered below). Service Connect / Cloud Map
cross-service discovery is provided via the `start-service` Cloud Map
DNS overlay; ALB-emulated path/host-based routing remains deferred.

**Requires Docker.** The first run pulls the AWS-published
`amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar (a
small Go binary maintained by awslabs) plus each container's image.

### `run-task` target resolution

Same target-syntax rules as `cdkl invoke`:

- CDK display path (`MyStack/MyService/TaskDef`) — preferred
- Stack-qualified logical id (`MyStack:MyServiceTaskDefXYZ1234`)
- Single-stack apps may omit the stack prefix (`MyTaskDef`)

Path matching is prefix-based: an L2 path like `MyStack/MyService/TaskDef`
resolves to the synthesized L1 child (`MyStack/MyService/TaskDef/Resource`).

### `run-task` options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkl` | Surfaced as `ECS_CONTAINER_METADATA_URI_V4`'s `Cluster` field and used as the docker network prefix (`<name>-task-<rand>`). |
| `--env-vars <file>` | unset | SAM-shape JSON overlay. Top-level keys are container names; `Parameters` is a global overlay. Same shape as `cdkl invoke --env-vars`. |
| `--container-host <ip>` | `127.0.0.1` | Bind IP for `PortMappings` published ports. Must be a numeric IP — Docker rejects hostnames in `-p <ip>:<port>:<port>`. |
| `--host-port <containerPort=hostPort>` | — | Publish a container port on a specific host port (e.g. `80=8080`); repeatable. Default: host port == container port. Map a privileged container port (< 1024) to a non-privileged host port to avoid macOS Docker Desktop's admin-password prompt. |
| `--assume-task-role [<arn>]` | unset (host creds pass through) | Bare flag uses the task definition's `TaskRoleArn`. Resolves a flat-string ARN directly; for `{Ref: <Role>}` / `{Fn::GetAtt: [<Role>, 'Arn']}` against a same-stack `AWS::IAM::Role`, cdk-local substitutes the caller's account id (via STS `GetCallerIdentity`) into `arn:aws:iam::<account>:role/<RoleLogicalId>`. Pass an explicit ARN to override. Either way, `sts:AssumeRole` runs once at startup; the resulting creds are exposed via the local metadata sidecar at `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack and substitute `Ref` / `Fn::ImportValue` / supported `Fn::Sub` / `Fn::Join` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Bare form uses the CDK stack name; pass an explicit value when the CFn stack name differs. `Fn::GetAtt` is warn-and-dropped in v1 (CFn `ListStackResources` does not return per-attribute values). See "Env / Secrets substitution" below. |
| `--stack-region <region>` | unset | Region used to construct the CloudFormation client for `--from-cfn-stack`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR for cross-account / centralized registry pulls. Issues `sts:AssumeRole` via the CLI's resolved credentials (honoring `--profile`) and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull` on every container whose `Image` resolves to an `<acct>.dkr.ecr.<region>.amazonaws.com/...` URI. Required when the caller's identity does not already have cross-account access to the target repository. Same-account / same-region pulls do not need this flag. No-op when `--no-pull` is set. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | `linux/amd64` or `linux/arm64`. Threaded into every container's `docker run --platform`. |
| `--keep-running` | off | Don't `docker rm -f` user containers on task exit (network + sidecar are still torn down). Use when you want to `docker exec` into a stopped container for post-mortems. |
| `--detach` | off | Start the containers and return without streaming logs or auto-tearing them down. Useful in CI smoke tests; caller manages container lifecycle. |

Plus the standard shared options: `-a/--app`, `-c/--context`, `--profile`,
`--role-arn`, `--region`, `--verbose`, `--output`.

### Networking model

For every task invocation cdk-local:

1. Creates a fresh docker network `cdkl-task-<random>` (or
   `--cluster <name>-task-<random>`) with subnet `169.254.170.0/24`.
2. Starts the AWS-published
   `amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar
   on the network at the well-known IP `169.254.170.2`.
3. Starts every user container on the same network with
   `--network-alias <container-name>` so siblings resolve each other by
   their CFn `ContainerDefinitions[].Name`.
4. Injects per-container env vars: `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>`
   and (when `--assume-task-role` is set) `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>`.

`awsvpc` network mode is mapped to `bridge` locally with a warn line —
docker cannot emulate ENI-per-task. AWS SDK calls from inside the
container still reach public AWS endpoints via the developer network.

### ECR image resolution

`ContainerDefinitions[].Image` is parsed in three tiers:

1. **Public images** — `public.ecr.aws/...`, `docker.io/...`, `nginx:latest`, etc. → plain `docker pull` (subject to `--no-pull`).
2. **Direct ECR URIs** — `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` (flat string, no intrinsics) → `pullEcrImage` (STS check + ECR auth + `docker pull`). Cross-account / cross-region supported: cdk-local builds the ECR client for the URI's region and (when `--ecr-role-arn <arn>` is passed) issues `sts:AssumeRole` to gain credentials in the target account. Without `--ecr-role-arn`, cdk-local falls through to the caller's credentials (succeeds when an IAM resource policy grants the caller direct cross-account access).
3. **CDK-asset images** (`ContainerImage.fromAsset` / `DockerImageAsset`) → `cdk.out/<stack>.assets.json` lookup → `docker build` via the shared asset helper, tagged `cdkl-run-task-<asset-hash>`.

For `Fn::Sub` / `Fn::GetAtt` shapes pointing at AWS pseudo parameters
or a same-stack ECR repository (the typical
`ContainerImage.fromEcrRepository(repo)` synthesis), two additional
resolution tiers fire **before** the URI is fed to tier 2:

- **Tier 1 — AWS pseudo-parameter substitution (no CFn stack needed)**:
  `${AWS::AccountId}` → STS `GetCallerIdentity` (lazy, cached for the
  run); `${AWS::Region}` → `--region` / `AWS_REGION` /
  `AWS_DEFAULT_REGION`; `${AWS::Partition}` → derived from region
  (`cn-*` → `aws-cn`, `us-gov-*` → `aws-us-gov`, else `aws`);
  `${AWS::URLSuffix}` → matches partition. Substituted URI then routes
  through tier 2.
- **Tier 2 — same-stack ECR Repository reference (CFn stack needed)**:
  when the `Fn::Sub` body contains `${<LogicalId>}` against an
  `AWS::ECR::Repository`, or when the template uses
  `Fn::GetAtt: [<Repo>, 'RepositoryUri']`, cdk-local needs the
  deployed physical repo name. Pass `--from-cfn-stack` (the stack must
  have been deployed via `cdk deploy`); cdk-local calls
  `ListStackResources`, substitutes the physical name, then routes
  through tier 2. Without `--from-cfn-stack` the error message points
  back at this flag as the resolution path.

### Env / Secrets substitution (`--from-cfn-stack`)

`ContainerDefinitions[].Environment[].Value` and `Secrets[].ValueFrom`
entries are commonly intrinsic-valued in real-world CDK ECS apps —
`table.tableName` synthesizes as `Ref`, `table.tableArn` as
`Fn::GetAtt`, `ecs.Secret.fromSecretsManager(secret)` as `Ref` against
the secret (returns the deployed ARN), `ecs.Secret.fromSsmParameter(p)`
as `Fn::Join` over pseudo parameters + a `Ref` to the parameter, etc.
Without `--from-cfn-stack` these intrinsics are silently dropped and
the developer sees an empty env var or a missing secret.

`cdkl run-task --from-cfn-stack` substitutes every intrinsic-valued
entry against the deployed CloudFormation stack plus AWS pseudo
parameters:

| Intrinsic | Source |
| --- | --- |
| `Ref: <LogicalId>` | `ListStackResources` → `PhysicalResourceId` |
| `Fn::ImportValue: <ExportName>` | `ListExports` (memoized for one substitution pass) |
| `Fn::Sub: '...${X}...${AWS::Region}...'` | recursive substitution against CFn data + pseudo parameters |
| `Fn::Join: [<delim>, [<elements>]]` | recursive substitution of every element, then `Array.join` |
| `Ref: AWS::AccountId` / `AWS::Region` / `AWS::Partition` / `AWS::URLSuffix` | STS `GetCallerIdentity` (lazy, cached) + the resolved region + region-derived partition / URL suffix |

`Fn::GetAtt` is warn-and-dropped in v1 (CFn API limitation).

Per-key best-effort: when a substitution can't be produced (CFn
resource missing, attribute not exposed via CFn, unsupported
intrinsic), the env / secret entry is dropped and a per-key warning
surfaces on the task's warnings line — the run-task invocation never
aborts. ListStackResources failures (no record, access denied,
throttling) also degrade to warn-and-fall-back rather than hard-fail.

Resolved `Secrets[].ValueFrom` strings then flow into the standard
SecretsManager / SSM resolver below.

### Secrets / SSM parameter resolution

`ContainerDefinitions[].Secrets[].ValueFrom` entries are resolved once
at startup via the AWS SDK (after any `--from-cfn-stack` intrinsic
substitution above). Three accepted shapes:

| `valueFrom` | API |
| --- | --- |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `SecretsManagerClient.GetSecretValue` |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::` | `GetSecretValue`, then JSON.parse + extract `json-key` |
| `arn:aws:ssm:<region>:<account>:parameter/<name>` | `SSMClient.GetParameter({ WithDecryption: true })` |

Resolution failures (NotFound / AccessDenied / network error / invalid
ARN) hard-fail with the offending container + secret name. The user
fixes their AWS creds / IAM policy and re-runs. (Mirrors the
`cdkl invoke --from-cfn-stack` philosophy: explicit failure beats
silently-empty.)

### Container start ordering — `DependsOn`

| Condition | What cdk-local waits for |
| --- | --- |
| `START` | Dependency's `docker run` has returned. |
| `COMPLETE` | Dependency's container has exited (any code). |
| `SUCCESS` | Dependency's container has exited with exit code 0. |
| `HEALTHY` | Dependency's `HEALTHCHECK` reports `healthy` (polled every 1s, capped at 5 min). |

Cyclic dependencies → hard-error at discovery with the offending cycle
named. Topological sort decides the start order; siblings with no
dependsOn relation start in template order.

### Volumes

| `Volumes[]` shape | Local realization |
| --- | --- |
| `Host: { SourcePath: '/some/path' }` | `docker run -v /some/path:<containerPath>` bind mount (caller's responsibility that the host path exists; a missing path emits a warn) |
| `Host` (no `SourcePath`) | Docker anonymous volume — empty per-task scratch |
| `DockerVolumeConfiguration: { Scope: 'task' \| 'shared', Driver, DriverOpts }` | `docker volume create --driver <driver> --opt ...` per task; per-task scope is torn down at exit |
| `EFSVolumeConfiguration` | **Hard-error**. Bind-mount a local directory at the same `containerPath` instead. |
| `FSxWindowsFileServerVolumeConfiguration` | **Hard-error**. |

### Lifecycle + teardown

1. The first `essential: true` container (defaults to `containers[0]`
   when no container declares `essential: false`) drives the task.
2. When the essential container exits, cdk-local `docker stop`s every
   other container with a 10s grace then `docker rm -f`.
3. The metadata sidecar is `docker rm -f`'d and the docker network is
   removed.
4. cdk-local exits with the essential container's exit code.

`^C` triggers the same teardown. Double-`^C` exits 130 immediately
(skipping container cleanup — same pattern as `cdkl start-api`).

`--detach` skips steps 1, 2, and 4. The sidecar and user containers
stay running for the caller to manage. cdk-local prints the network
name on exit so you can `docker ps --filter network=<name>` to inspect.

`--keep-running` skips step 2 only. The network + sidecar are still
torn down. Use to `docker exec` into a stopped container post-mortem.

### `run-task` exit codes

- `0` — essential container exited 0.
- N (non-zero) — essential container exited N (cdk-local propagates the code).
- Various cdk-local-side error codes (Docker missing, target not found,
  network creation failed, secret resolution failed, ...) follow the
  global handler's defaults (typically 1).

### `run-task` scope (out of scope, deferred)

| Out of scope | Why |
| --- | --- |
| `AWS::ECS::Service` / `DesiredCount` / `LaunchType` | Use `cdkl start-service` instead |
| ALB / NLB target group registration / listener rules | Deferred follow-up — needs an HTTP proxy emulator |
| Service Connect / Cloud Map | Implemented for `cdkl start-service` via `--add-host` DNS overlay. `cdkl run-task` is single-task by design; cross-service discovery is meaningful only with multiple long-running services, so it stays out of scope here. |
| Auto Scaling / Deployment Strategy | Not meaningful locally |
| Fargate vs EC2 launch-type differences (PID namespace, `awsvpc`-only, ephemeral storage cap) | Local Docker can't enforce these |
| EFS / FSx volumes | Need real AWS NFS / SMB; hard-error with a routing hint |
| ECS Exec | Use `docker exec` directly |
| CloudWatch Logs auto-shipping (`logConfiguration.LogDriver: 'awslogs'`) | stdout/stderr already streamed; skip the driver |
| X-Ray sidecar's AWS-API mocking | Run the daemon explicitly if you need it |
| AWS App Mesh / Envoy fidelity | Not meaningful locally |
| awsvpc / ENI complete fidelity | Map to docker bridge with a warn |

## `start-service` (run an ECS Service locally)

`cdkl start-service <Stack/ServiceLogicalPath>` is the long-running
counterpart of `cdkl run-task`. It locates an `AWS::ECS::Service` in
the synthesized template, chains into the existing `run-task`
machinery once per `DesiredCount` replica (clamped by `--max-tasks`,
default 3), and keeps every replica running until `^C`. Failed
replicas restart per `--restart-policy on-failure | always | none`
with exponential backoff (1s → 30s capped) so a crash-looping container
does not hammer docker.

Each replica gets its own per-task docker network on a UNIQUE
`169.254.<N>.0/24` subnet (170, 171, 172, ...; see
[src/local/ecs-network.ts](../src/local/ecs-network.ts)
`buildEndpointSubnet`) so concurrent replicas don't collide on a
single /24 — the same metadata-endpoint sidecar starts at
`169.254.<N>.2` per replica and every container's
`ECS_CONTAINER_METADATA_URI_V4` is rewritten to point at its own
replica's sidecar.

> **Host-port publishing and multi-replica services.** A
> **single-replica** service publishes its container `PortMappings` to
> the host (`-p <container-host>:<hostPort>:<containerPort>`) so you can
> `curl localhost:<port>` from the host. A **multi-replica** service
> (effective replica count > 1 after the `--max-tasks` clamp) does NOT
> publish host ports: N replicas all map the same container port, so a
> fixed host-port publish would make the 2nd+ replica fail to boot with
> `Bind for 127.0.0.1:<port> failed: port is already allocated`. This
> matches production — real ECS Service Connect / `awsvpc` tasks have
> per-task ENIs and never share a host port. Peers still reach a
> multi-replica service by container IP / network alias on the shared
> docker network; to hit a specific replica from the host, `docker exec`
> into it or read its IP from `docker inspect`.
>
> **macOS privileged ports.** The host port equals the container port by
> default. On macOS, Docker Desktop binds host ports below 1024 through a
> privileged helper (`com.docker.vmnetd`) that prompts for an admin
> password. To avoid the prompt, map the privileged container port to a
> non-privileged host port explicitly with `--host-port` (repeatable),
> e.g. `--host-port 80=8080` — then reach the container at
> `127.0.0.1:8080`. cdk-local never changes the host port silently.

### `start-service` target resolution

Same grammar as `run-task`:

- `Stack/Service/...` (display path) or `Stack:LogicalId` (logical id).
- Single-stack apps may omit the stack prefix.
- The target MUST resolve to an `AWS::ECS::Service`; passing a bare
  TaskDefinition surfaces a clear "use cdkl run-task" hint.

The Service's `TaskDefinition` property MUST be `{Ref:
'<TaskDefLogicalId>'}` referencing a same-stack
`AWS::ECS::TaskDefinition` (the standard CDK shape). Cross-stack
TaskDefinitions and `Fn::ImportValue` shapes are rejected with a clear
error.

### `start-service` options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkl` | Cluster name surfaced to `ECS_CONTAINER_METADATA_URI_V4` and reported in the local task ARN. All replicas attach to one shared `cdkl-svc-<rand>` docker network for the lifetime of the CLI invocation; each replica's metadata sidecar binds its own 169.254.&lt;N&gt;.2 IP so per-replica metadata stays distinguishable in `docker ps`. |
| `--max-tasks <n>` | `3` | Hard cap on local replica count regardless of template `DesiredCount`. Local dev machines should not run an unbounded number of containers; raise this for production-shape workloads only when warranted. |
| `--restart-policy <p>` | `on-failure` | Restart-on-exit behavior. `on-failure` restarts only on non-zero exit; `always` restarts on every exit (mirrors ECS Service deployment semantics more closely); `none` shuts the affected replica down and runs the service degraded. |
| `--env-vars <file>` | — | SAM-shape JSON env-var overrides; same format as `run-task`. |
| `--container-host <ip>` | `127.0.0.1` | Host IP to bind published container ports to. Must be a numeric IP. |
| `--host-port <containerPort=hostPort>` | — | Publish a container port on a specific host port (e.g. `80=8080`); repeatable. Default: host port == container port. Map a privileged container port (< 1024) to a non-privileged host port to avoid macOS Docker Desktop's admin-password prompt. Single-replica services only. |
| `--assume-task-role [arn]` | unset | Assume the task definition's TaskRoleArn (or the supplied ARN) and forward STS-issued temp credentials via the metadata sidecar so every replica's containers run with the deployed task role. Same three-form grammar as `run-task`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before ECR `docker pull` for cross-account / centralized registries. Same shape as `run-task`. |
| `--platform <p>` | inferred | Force `--platform linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` on every container image and the metadata sidecar. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack and substitute `Ref` / `Fn::ImportValue` / supported `Fn::Sub` / `Fn::Join` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Bare form uses the CDK stack name (per target when multiple `<targets...>` are supplied). `Fn::GetAtt` is warn-and-dropped in v1. Same shape as `cdkl run-task --from-cfn-stack`. |
| `--stack-region <region>` | — | Region used to construct the CloudFormation client for `--from-cfn-stack`. |
| `--watch` | off | Hot reload: re-synth + per-replica rolling deploy when the CDK app's source changes. Honors `cdk.json` `watch.include` / `watch.exclude` (mirrors `cdk watch`); `cdk.out/`, `node_modules`, and `.git` are always excluded so the reload's own re-synth writes never re-trigger it. 500ms debounce. Each replica is rolled one at a time — boot a shadow replica with the new image under a bumped generation suffix, wait for a TCP-ready probe on the container port, atomically swap Service-Connect / Cloud Map registrations, then retire the old container — so peer services see zero connection refusals across the reload even on multi-replica services. Synth failures keep the previous replica(s) serving (warn-and-continue, never crashes the emulator). |
| `--no-logs` | off | Disable foreground streaming of each replica container stdout/stderr. By default every booted replica streams its docker logs to the host terminal with a `[svc=<service> r=<replica-index> c=<container>]` prefix, matching `cdkl run-task`'s log surface so application `console.log` calls are visible without a side `docker logs -f`. The streamer follows replicas across `--watch` reloads (both the rebuild rolling primitive and the soft-reload `docker restart` path). Pass `--no-logs` for multi-replica / multi-service runs whose interleaved log volume is unreadable; `docker logs -f <id>` in a separate terminal stays available. |

### `start-service --watch` (hot reload)

When `--watch` is set, `cdkl start-service` installs the same
debounced [chokidar](https://github.com/paulmillr/chokidar)-backed
file watcher that `cdkl start-api --watch` uses, rooted at the synth
working directory (where `cdk.json` lives). On a debounced firing
(500ms after the last save) the emulator re-synths, re-resolves every
booted service against the new stacks, and per-target rolls each
replica through the new task definition one at a time. No second
terminal running `cdk watch` / `cdk synth` is needed; an edit to a
container handler or task definition flows through to the next
request without `^C` / re-launch.

Per-replica rolling deploy (Phase 2 of issue #214):

For each replica `i` in the old set:

1. **Boot the shadow.** A fresh "shadow" replica is started with the
   new image under a bumped generation suffix
   (`<service>-svc-<svcLogical>-r<i>-g<gen>` docker network /
   `<service>:r<i>:g<gen>` Cloud Map ownerKey), so the shadow's
   docker / registry names don't collide with the dying old replica's.
2. **TCP-ready probe.** The shadow's first essential-container port
   is probed via TCP-connect on the shadow's docker network IP, polled
   every 100ms up to 10s. Without this gate, the swap could land
   before the app inside the new image binds its listener, causing
   peer requests routed to the shadow to see ECONNREFUSED for the
   first few hundred ms after the roll. A timeout warns + swaps anyway
   (the dying old replica's image is about to be torn down — the
   shadow's new image is the user's intent).
3. **Atomic registry swap.** The shadow is already registered in
   Cloud Map / Service Connect under a fresh ownerKey (the runner's
   normal publish path). The old replica's registrations are dropped
   in one synchronous Map mutation — consumers rebuilding their
   `--add-host` set during the swap window still see at least one
   live endpoint per fqdn.
4. **Retire the old.** The old replica's docker container + network
   are torn down via the same `cleanupEcsRun` path SIGINT uses.

A continuous external probe (e.g. a sidecar curl loop against the
Service Connect DNS alias) observes zero connection refusals across
the roll: at every instant in the swap window at least one live
replica carries the alias.

Synth-failure semantics mirror `start-api --watch`: a failed re-synth
warns and leaves every existing replica on the previous image. A
per-replica boot failure during the roll keeps the OLD replica
serving and surfaces the error so the remaining replicas can still
be rolled.

The watch set honors `cdk.json`'s `watch.include` / `watch.exclude`
globs the same way `start-api --watch` does — see the
[Hot reload (`--watch`)](#hot-reload---watch) section above for the
exact include / exclude / synth-failure semantics; they are
identical here.

Trade-offs (issue #214 follow-ups):

- **No scale-during-watch.** Bumping the service's `DesiredCount`
  (or flipping `--max-tasks`) mid-watch rolls every EXISTING replica
  through the new task definition but does NOT add / remove replicas
  to match the new count. A warn surfaces so the user can `^C` and
  re-launch to apply the new replica count.

**Source-only edits use the bind-mount fast path (Phase 4 of issue #214).**
On a `--watch` reload, the classifier inspects the set of changed paths
and routes the firing through one of two per-replica primitives:

- **Soft-reload (fast path).** When every changed path is a plain
  interpreted-language source file (no Dockerfile, no
  dependency-manifest, no compiled-language source), the runner
  `docker cp`s the freshly-synthed asset directory's contents into
  each replica's WORKDIR and `docker restart`s the container. No
  `docker build`, no shadow boot, no Cloud Map / front-door pool
  swap — the container's docker network IP and host port are
  preserved across the restart, so peer services and the front-door
  pool keep their existing registrations. Typical end-to-end latency
  is well under a second for an interpreted handler (Node / Python /
  Ruby / shell). The reload-log line surfaces the verdict as
  `verdict=soft-reload (...)` and per-replica completion as
  `Soft-reloaded replica r<i> ... restart + TCP-ready probe complete;
  registrations unchanged.`
- **Rebuild (fallback).** When ANY changed path matches the asset's
  Dockerfile, a recognized dependency manifest
  (`package.json` / `pnpm-lock.yaml` / `requirements.txt` /
  `pyproject.toml` / `go.mod` / `Cargo.toml` / etc.), or a
  compiled-language source (`.go` / `.rs` / `.java` / `.kt` /
  `.scala` / `.cs` / `.swift` / `.c` / `.cpp` / `.zig` / etc.), the
  runner falls through to the Phase 1-3 rolling primitive — `docker
  build` + shadow boot + atomic Cloud Map / front-door pool swap +
  retire-old. The reload-log line surfaces the verdict as
  `verdict=rebuild (...)` naming the trigger.

The classifier defaults to `rebuild` on ANY ambiguity (asset manifest
can't be loaded, unrecognized change). A slow-but-correct reload is
strictly better than a fast-but-stale one — a missed Dockerfile /
dependency edit would leave the running container on the previous
image while the source files said otherwise.

The one ambiguity-default the reload pathway pre-empts is "target
image is not a CDK docker-image asset" (typical under
`--from-cfn-stack` against a service whose CDK source uses
`ContainerImage.fromEcrRepository(repo, tag)`, or a hand-pinned
public-registry image): the rolling primitive would re-pull
byte-identical content from the deployed registry on every save and
surface `Reload complete.` even though nothing in the running
container changed — a silent no-op disguised as success. To avoid
that footgun (issue #234), the reload SKIPS the roll for such
targets with a `Reload skipped for '<target>' (no-op): image pinned
to deployed registry; no local rebuild possible.` log on each
firing, and the same configuration triggers a loud boot-time WARN
per affected target naming the pinned image URI so the user knows
local source edits will not take effect before they spend time
saving files. To iterate on local source for an ECR-pinned service,
drop `--from-cfn-stack` and switch the CDK app to
`ContainerImage.fromAsset(...)`. Env / Secrets diff propagation
under `--from-cfn-stack` (a watcher firing legitimately picking up
a flipped deployed env value for an ECR-pinned target) is a
follow-up — today the skip is total.

Known fast-path limitations (Phase 4 trade-offs):

- The fast path applies to interpreted-language handlers only. A
  compiled-language source edit always falls through to rebuild
  (copying `main.go` without a recompile inside the container would
  leave the running binary unchanged).
- The runner `docker cp`s into the image's declared `WORKDIR`. A
  Dockerfile that does `COPY . /opt/app/` while leaving `WORKDIR /`
  is not handled correctly — the user-side workaround is to set
  `WORKDIR` to the COPY target. Documented as a known limitation;
  a future opt-out flag may surface if it bites.
- Task-spec changes (env vars, memory limits, mounts, added
  sidecars) declared in CDK construct code that don't touch the
  asset source flip the asset hash to the same value across the
  synth. The classifier detects this and forces the rebuild path so
  the rolling primitive's fresh `docker create` picks up the new
  spec — soft-reload would `docker cp` identical files and `docker
  restart` with the OLD spec, silently dropping the user's intent.

`cdkl start-alb --watch` (Phase 3 of issue #214) reuses this same
per-replica rolling primitive — every ECS service behind the named
ALB is rolled identically, and the ALB front-door pool entry for the
rolled replica is swapped atomically as part of the same step
(register-new-before-unregister-old, single-assignment Map mutation
on a single JS thread; a continuous external request stream against
the listener port never observes an empty pool). The host front-door
(TLS materials, JWKS cache, Lambda-target RIE containers, listener
sockets) is built once at boot and is NOT recreated on reload — only
the per-replica pool entries rotate. Lambda target groups behind the
ALB are a no-op on `--watch` reload (the warm RIE container keeps
its boot-time image; Lambda hot-reload is the `start-api` path's
concern). The Phase 4 bind-mount fast path also applies under
`start-alb --watch` for the ECS replicas; the front-door pool entries
need no swap on the soft-reload path because the container's docker
network IP and host port are preserved across `docker restart`.

### `start-service` lifecycle

`^C` (SIGINT) and SIGTERM trigger a graceful shutdown across every
replica in parallel — each replica's docker containers + per-replica
network + metadata sidecar are torn down via the same `cleanupEcsRun`
path `run-task` uses. Double-`^C` bypasses cleanup and exits 130
immediately so users have an escape hatch when docker hangs.

### `start-service` scope (deferred follow-ups)

| Deferred | Tracked in / Why |
| --- | --- |
| Local load-balancer emulator (listener + round-robin + target-group health check) | Follow-up PR — needs an HTTP/TCP proxy emulator. Today's start-service does NOT register replicas to a local listener; reach a single-replica service via its published container ports, or any replica via its docker network IP / alias (multi-replica services skip the host-port publish — see the host-port note above). |
| Envoy sidecar (L7 routing / retries / circuit breaking / mTLS) | Deferred follow-up — Cloud Map DNS overlay covers ~80% of debugging use cases; the missing 20% requires the AWS-published Envoy image (~120MB / task). DNS-only mode is the default; an opt-in `--envoy` flag will ship with the sidecar. |
| Rolling deployment strategy (`DeploymentConfiguration.MaximumPercent` etc.) | Follow-up — meaningful only with the LB emulator. |
| `HealthCheckGracePeriodSeconds` runtime semantics | Field is parsed and surfaced on `ResolvedEcsService` but not yet acted on. Becomes load-bearing when the LB emulator ships (today's restart policy fires on essential-container exit code, not health-check failure). |

### `awsvpc` network mode

ECS Services on Fargate require `awsvpc`. cdk-local maps `awsvpc` to a
per-task docker bridge network with a startup warn; security groups
are NOT enforced locally and per-task ENIs are not emulated.

## See also

- [Getting started](./getting-started.md)
- [CLI reference](./cli-reference.md)
- [Troubleshooting](./troubleshooting.md)
