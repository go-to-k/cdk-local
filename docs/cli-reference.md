# cdk-local CLI Reference

This document covers every `cdkl` subcommand and flag in detail. For a
hands-on walkthrough, start with [getting-started.md](./getting-started.md).
For deeper notes on the local-execution model (route discovery, container
lifecycle, mTLS, authorizers, networking), see
[local-emulation.md](./local-emulation.md). When something breaks, see
[troubleshooting.md](./troubleshooting.md).

cdk-local has five subcommands, all under the `cdkl` binary:

| Subcommand | Emulates | Backed by |
| --- | --- | --- |
| `cdkl list` (alias `cdkl ls`) | Lists the app's runnable targets (no execution) | Synthesis only — no Docker |
| `cdkl invoke <target>` | One-shot Lambda invoke | AWS Lambda Runtime Interface Emulator (RIE) container |
| `cdkl start-api` | Long-running HTTP server — API Gateway (REST v1 / HTTP API / WebSocket) + Lambda Function URL | RIE container pool + `node:http` listener (one server per discovered API) |
| `cdkl run-task <target>` | ECS `RunTask` for one task | docker network + ECS metadata sidecar (`amazon/amazon-ecs-local-container-endpoints`) |
| `cdkl start-service <targets...>` | Long-running ECS `Service` emulator | `run-task` machinery per replica + per-replica docker subnet allocator + restart-on-exit watcher |

The four run commands (`invoke` / `start-api` / `run-task` /
`start-service`) require Docker on the developer's machine. The first
run pulls the relevant base image (~600MB for the language-specific
Lambda images, ~50MB for `provided.*`, plus the ECS metadata sidecar for
`run-task` / `start-service`). Subsequent runs reuse the cached image;
pass `--no-pull` to skip the `docker pull` round-trip. `cdkl list` only
synthesizes the app, so it needs no Docker.

## Common flags

Shared across every `cdkl` subcommand (declared in
[src/cli/options.ts](../src/cli/options.ts)):

| Option | Default | Description |
| --- | --- | --- |
| `--verbose` | off | Enable verbose / debug logging. |
| `--profile <profile>` | unset | AWS profile name (consumed by the SDK default credential chain). |
| `--role-arn <arn>` | unset | IAM role ARN to assume for AWS API calls. Also reads `CDKL_ROLE_ARN` env var. |
| `-y, --yes` | off | Automatically answer interactive prompts with the recommended response. |
| `-a, --app <cmd-or-dir>` | — | CDK app command (e.g. `"node app.ts"`) or path to a pre-synthesized cloud assembly directory (e.g. `"cdk.out"`). Falls back to `CDKL_APP` env or the `app` field in `cdk.json`. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c, --context <key=value...>` | — | Set CDK context values (repeatable). |
| `--region <region>` | — | **Deprecated.** No effect on local commands; the SDK picks the region from `AWS_REGION` or your AWS profile. Kept for muscle-memory compatibility. |

The `--from-cfn-stack` / `--stack-region` family is described in the
per-command sections below.

## Interactive target selection

The four run commands — `invoke`, `run-task`, `start-service`,
`start-api` — open an arrow-key picker (powered by `@clack/prompts`)
when you OMIT the positional target in an interactive terminal, instead
of making you type a CDK path / logical ID. `invoke` / `run-task` pick a
single target; `start-service` / `start-api` open a multi-select (pick
one or more). The list is the same set `cdkl list` prints, so a Function
URL appears under its backing Lambda. (There is no `-i` / `--interactive`
flag — bare-in-a-TTY is the trigger.)

`start-api`'s multi-select starts with **every** discovered API
pre-selected, so a bare Enter serves them all (its long-standing default)
and deselecting rows serves a subset — each selected API on its own port.
Each API row is tagged with its surface kind — `REST API v1` /
`HTTP API v2` / `Function URL` / `WebSocket` — so otherwise-similar
surfaces are easy to tell apart. (The picker shows the CDK display path,
not the stack-qualified logical ID — `cdkl list -l` still prints it.)

The picker requires a TTY. In a non-interactive context (CI, pipes,
redirected stdin/stdout):

- `invoke` / `run-task` / `start-service` fall back to the command's
  usual "target required" error — pass the target explicitly instead;
- `start-api` is the exception: bare in a non-TTY it serves **every**
  discovered API (its serve-all default needs no prompt), so scripts
  keep working unchanged. Pass one or more positional targets to serve a
  specific subset.

Ctrl+C / Esc at the prompt aborts with exit code 130 and no error noise.
`list` has no picker (it always lists everything).

## `cdkl list` (discover runnable targets)

`cdkl list` (alias `cdkl ls`) synthesizes the CDK app and prints every
target the other subcommands can run, grouped by command. Most of the
time you do not need it — running a command with no target opens an
interactive picker (see the "Interactive target selection" section
above). Reach for `list` to browse what exists, or to grab the exact
target string for a script.

Each target is printed by its CDK display path (the recommended,
readable target form). API targets additionally show their surface kind
(`HTTP API v2`, `REST API v1`, `Function URL`, `WebSocket`) in
parentheses, so the API group's otherwise-similar paths are easy to tell
apart. Pass `-l` / `--long` to additionally print the stack-qualified
logical ID (`<Stack>:<LogicalId>`) on an indented line beneath each path —
useful for the SAM-style logical-ID form or for any resource without an
`aws:cdk:path`.

It needs no Docker. It synthesizes the app — which may perform context
lookups, and (like every command) honors `--role-arn` / `CDKL_ROLE_ARN`
by assuming that role first — and otherwise accepts only the
[common flags](#common-flags) (`--app` / `--output` / `--context` /
`--profile` / `--role-arn` / `--verbose`). There is no `<target>`
argument; the command always lists the whole app. Only the list is
written to stdout; the `Synthesizing...` status and toolkit synth
messages go to stderr, so `cdkl list | ...` stays clean.

```text
$ cdkl list

Lambda Functions  ->  cdkl invoke <target>
  MyStack/ItemsHandler

APIs  ->  cdkl start-api [target...]
  MyStack/MyHttpApi  (HTTP API v2)

ECS Services  ->  cdkl start-service <target...>
  MyStack/WebService

ECS Task Definitions  ->  cdkl run-task <target>
  MyStack/WebTask
```

```text
$ cdkl list -l
...
Lambda Functions  ->  cdkl invoke <target>
  MyStack/ItemsHandler
      MyStack:ItemsHandlerFB09CCF4
...
```

Categories with no matching resources are omitted. The `APIs` group
covers every surface `start-api` can serve — REST v1, HTTP API v2,
Function URLs, and WebSocket APIs. A Function URL is shown under its
backing Lambda's display path (and logical ID, with `-l`), because that
is how `start-api` addresses a Function URL target (so the same row may
also appear under `Lambda Functions`, where `invoke` runs it directly).

## `cdkl invoke` (run Lambda functions locally)

`cdkl invoke <target>` runs a Lambda function from a CDK app on the
developer's machine, inside a Docker container that bundles the AWS
Lambda Runtime Interface Emulator (RIE). Modeled on `sam local invoke`
but reusing cdk-local's synthesis / asset / construct-path plumbing.

The first invocation pulls the Lambda base image
(`public.ecr.aws/lambda/nodejs:<version>`,
`public.ecr.aws/lambda/python:<version>`,
`public.ecr.aws/lambda/ruby:<version>`,
`public.ecr.aws/lambda/java:<version>`,
`public.ecr.aws/lambda/dotnet:<version>`, or
`public.ecr.aws/lambda/provided:<al2|al2023>` — ~600MB for the
language-specific images, ~50MB for the OS-only `provided.*`);
subsequent invocations reuse the cached image. Pass `--no-pull` to skip
the `docker pull` round-trip.

Supported runtimes: `nodejs18.x` / `nodejs20.x` / `nodejs22.x` /
`nodejs24.x` / `python3.11` / `python3.12` / `python3.13` /
`python3.14` / `ruby3.2` / `ruby3.3` / `java8.al2` / `java11` /
`java17` / `java21` / `dotnet6` / `dotnet8` / `provided.al2` /
`provided.al2023`. The deprecated `go1.x` runtime is rejected with a
migration pointer to `provided.al2023`. Java, .NET, and `provided.*`
are **asset-backed only** — inline `Code.ZipFile` is rejected because
the Handler shape names a compiled artifact.

**Container Lambdas** — `lambda.DockerImageFunction(...)` /
`Code.ImageUri` is supported in addition to ZIP Lambdas. cdk-local reads
the function's local `Dockerfile` from `cdk.out` (via the asset manifest
keyed off the `:<hash>` suffix on `Code.ImageUri`) and runs `docker
build` locally, then `docker run` against the resulting image. When no
asset matches (typically: invoking a stack deployed elsewhere),
cdk-local falls back to `docker pull` from ECR with cross-account /
cross-region support: it auto-detects cross-account from
`sts:GetCallerIdentity`, builds the ECR client for the URI's region,
and (when `--ecr-role-arn <arn>` is passed) issues `sts:AssumeRole` to
pick up permissions in the target account. `Architectures: [x86_64]`
(default) and `[arm64]` are honored via `--platform linux/amd64` /
`linux/arm64` on both the build and the run.

### Target resolution

The positional `<target>` accepts two forms:

- **CDK display path** — `MyStack/MyApi/Handler`. An L2 path resolves
  to the synthesized L1 child (`MyStack/MyApi/Handler/Resource`).
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
| `--no-pull` | off | Skip `docker pull`. Semantics differ by code path: **ZIP Lambdas** — skip pulling the public Lambda base image. **Container Lambdas, local-build path** — no-op (`docker build`'s default does not refresh the FROM cache). **Container Lambdas, ECR-pull fallback** — skip `docker pull` AND error if the image is not in the local cache. |
| `--no-build` | off | Skip `docker build` on the **Container Lambdas, local-build path** (`Code.ImageUri`). Requires the deterministic tag to already be in the local docker registry from a prior `cdkl invoke`; errors clearly when missing. No-op for ZIP Lambdas and the ECR-pull fallback. Compatible with `--no-pull`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR on the **Container Lambdas, ECR-pull fallback** path. Issues `sts:AssumeRole` via the CLI's resolved credentials (honoring `--profile`) and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull`. Required for cross-account pulls when the caller's identity does not already have direct cross-account access. No-op when `--no-pull` is set. |
| `--debug-port <port>` | off | Set `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` and publish the port; attach a Node debugger to step through the handler. |
| `--container-host <host>` | `127.0.0.1` | Host to bind the RIE port to. |
| `--assume-role [arn]` | off | STS-assume the deployed function's execution role and forward the resulting temp credentials to the container, so the handler runs under the deployed role's narrow permissions instead of the developer's typically-admin shell credentials. Three forms: (1) `--assume-role <arn>` assumes the explicit ARN (precedence wins); (2) `--assume-role` (bare) auto-resolves the function's `Properties.Role` from the active state source (requires `--from-cfn-stack` or a host-provided extension); (3) `--no-assume-role` explicitly opts out. Off by default — when omitted, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` are passed through unchanged (SAM-compatible default). STS failures degrade to a warn + dev-creds fallback. |
| `--layer-role-arn <arn>` | — | Role to `sts:AssumeRole` before calling `lambda:GetLayerVersion` on every literal-ARN entry in `Properties.Layers`. Use only when the dev credentials cannot read the layer — typically cross-account layers. AWS-published public layers (e.g. Lambda Powertools) are readable from every account and need no role. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `ListStackResources` and substitute `Ref` / `Fn::ImportValue` placeholders in env vars with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). Bare form uses the resolved stack name; pass an explicit value when the CFn stack name differs. `Fn::GetAtt` (and other intrinsics `ListStackResources` can't resolve) in the Lambda's OWN env is recovered from the deployed function's resolved `Environment.Variables` via `lambda:GetFunctionConfiguration`. See [CloudFormation-driven env recovery](#cloudformation-driven-env-recovery---from-cfn-stack) below. |
| `--stack-region <region>` | — | Region of the state record to read. Drives the CFn client region when `--from-cfn-stack` is set. |

Plus the [common flags](#common-flags): `-a/--app`, `--output`,
`-c/--context`, `--profile`, `--role-arn`, `--verbose`, `-y/--yes`.

### Environment variables

Template `Properties.Environment.Variables` entries:

- **Literal values** (string / number / boolean) are passed through as-is.
- **Intrinsic-valued entries** (`Ref` / `Fn::GetAtt` / `Fn::Sub` /
  `Fn::Join`, plus the `${AWS::AccountId}` / `${AWS::Region}` /
  `${AWS::Partition}` / `${AWS::URLSuffix}` pseudo parameters) need a
  state source (and a single `sts:GetCallerIdentity` for
  `${AWS::AccountId}`) to resolve. Without a state source, cdk-local
  emits a warning naming the variable and **drops** it (rather than
  silently substituting garbage); pass `--from-cfn-stack` (see below)
  to recover deployed values, or override intrinsics via `--env-vars`.

Standard Lambda runtime env vars are always set:
`AWS_LAMBDA_FUNCTION_NAME`, `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`,
`AWS_LAMBDA_FUNCTION_TIMEOUT`, `AWS_LAMBDA_FUNCTION_VERSION`,
`AWS_LAMBDA_LOG_GROUP_NAME`, `AWS_LAMBDA_LOG_STREAM_NAME`. The
handler's `context.*` fields look real.

### CloudFormation-driven env recovery (`--from-cfn-stack`)

For CDK apps deployed via the upstream CDK CLI (`cdk deploy` →
CloudFormation), use `--from-cfn-stack` to pull deployed physical IDs
and exports into the Lambda's env block: cdk-local calls
`cloudformation:ListStackResources` against the named CFn stack to
populate the per-logical-id physical-id map, then runs the substitution
engine against it.

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

**What's resolved**: `Ref: <LogicalId>` against
`ListStackResources` (paginated — every page is walked so stacks with
more than 100 resources are fully mapped) and
`Fn::ImportValue: <ExportName>` against
`cloudformation:ListExports` (paginated, memoized for one substitution
pass).

**Resolution priority** (highest priority wins):

1. `--env-vars` file function-specific entry (`{LogicalId: {KEY: VALUE}}`).
2. `--env-vars` file global `Parameters` block.
3. `--from-cfn-stack` substituted intrinsic (when the flag is set AND
   the template entry was a supported intrinsic AND substitution
   succeeded).
4. `--from-cfn-stack` deployed-env fallback (the consumer function's own
   deploy-time-resolved value, for intrinsic keys step 3 could not
   resolve — see below).
5. Template literal value.

**`Fn::GetAtt` recovery**: CFn's `ListStackResources` does NOT return
per-attribute values — it only exposes `(LogicalResourceId,
PhysicalResourceId, ResourceType)` triplets — so `Fn::GetAtt` does not
resolve against the resource map. cdk-local closes this for a Lambda's
OWN env vars by reading the deployed function's already-resolved
`Environment.Variables` via `lambda:GetFunctionConfiguration`
(CloudFormation resolved every intrinsic at deploy time), so e.g.
`SIBLING_ARN: Fn::GetAtt <OtherFunction>.Arn` is recovered without a
manual override. The same fallback also covers `Fn::Sub` /
`Fn::ImportValue` / cross-stack `Ref` in the env block. Keys not present
in the deployed function's env (e.g. a var you added locally since the
last deploy) still warn-and-drop — override via `--env-vars`. Recovered
values enter the local container env in plaintext; Lambda env vars are a
non-secret property, so this exposes nothing the deployed function
doesn't already surface to a caller with `lambda:GetFunctionConfiguration`.

**Region handling**: the CFn client is region-bound at construction
time using the precedence `--stack-region` > `--region` > `AWS_REGION` >
`AWS_DEFAULT_REGION` > the synth-derived stack region > the `--profile`'s
configured region (`~/.aws/config`). The profile fallback means
`--from-cfn-stack --profile <p>` works against an env-agnostic stack
without an explicit `--region`, the same way `aws cloudformation
... --profile <p>` resolves region from the profile. When NONE of these
signals is set, the CLI throws with a remediation message — CFn
`ListStackResources` queries a specific region and silently
picking `us-east-1` would query the wrong stack environment.

**Failure modes**: `ListStackResources` failures (stack not found,
access denied, throttling) degrade to a per-key warn + drop.
`ListExports` failures only affect `Fn::ImportValue` resolution;
same-stack `Ref` substitutions still succeed because they only need
the `ListStackResources` result.

**Auto-assume execution role**: when `--from-cfn-stack` is paired with
bare `--assume-role` (no ARN argument), cdk-local resolves the
function's `Properties.Role` from the loaded state and STS-assumes that
role automatically — no manual ARN lookup required. Pass
`--no-assume-role` to explicitly opt out; pass `--assume-role <arn>`
to override the resolved ARN with an explicit one. STS failures
(insufficient permissions / trust-policy mismatch) degrade to a warn
+ dev-creds fallback — this is a developer-loop tool, not a security
boundary.

### Asset resolution

**ZIP Lambdas**: cdk-local uses the CDK-blessed
`Metadata['aws:asset:path']` hint on each Lambda's CFn resource (the
same source SAM uses) to find the local unzipped asset directory under
`cdk.out`, and bind-mounts it at `/var/task` read-only. `Code.ZipFile`
(inline) functions are materialized to a tmpdir using the file path
implied by the function's `Handler` property (`index.handler` →
`tmpdir/index.js`).

### Lambda Layers

Same-stack `AWS::Lambda::LayerVersion` references in
`Properties.Layers` are resolved automatically and bind-mounted at
`/opt` (read-only) inside the container:

1. cdk-local walks `Properties.Layers` left-to-right.
2. Each entry must be `{Ref: '<LayerLogicalId>'}` or `{Fn::GetAtt:
   ['<LayerLogicalId>', 'Ref']}` pointing at an
   `AWS::Lambda::LayerVersion` resource in the same stack. The layer's
   `Metadata['aws:asset:path']` is read the same way Lambda code is
   located.
3. cdk-local produces a single bind mount at `/opt`:
   - **Single layer**: the layer's asset dir is bind-mounted directly
     (no copy).
   - **Multiple layers**: each layer's contents are copied into a
     freshly-allocated tmpdir IN ORDER (later layers overwrite earlier
     files); the merged tmpdir is then bind-mounted at `/opt` and
     removed in the cleanup path. Mirrors AWS Lambda's actual runtime
     behavior — **last layer wins on file collision**.

**Literal-ARN layer entries** (`arn:aws:lambda:...`) are also
supported: cdk-local calls `lambda:GetLayerVersion` against the literal
ARN, downloads the layer ZIP from the returned signed URL, extracts to
a tmpdir, and bind-mounts it on the same merged `/opt` path as
same-stack refs. Cross-account layers may require `--layer-role-arn
<arn>` to assume a role with `lambda:GetLayerVersion` permission;
AWS-published public layers (e.g. Lambda Powertools) need no role.

**Container Lambdas** (`Code.ImageUri`): the `Layers` property is
silently ignored — matches AWS behavior, since container images bake
their layers at build time and AWS rejects `Layers` on container
Lambdas at deploy time.

### Ephemeral storage (`/tmp` cap)

When a Lambda's template declares `Properties.EphemeralStorage.Size`,
`cdkl invoke` adds `--tmpfs /tmp:rw,size=<N>m` to the `docker run`
command so the container's `/tmp` is a memory-backed filesystem capped
at the templated value. Handlers that exceed the deployed cap fail
locally with `ENOSPC` the way they would on AWS, and handlers that
detect free space via `statvfs` / `df` see the configured cap rather
than the host's overlay-fs.

Applies to both ZIP and IMAGE (container) Lambdas. Container Lambdas
get an `[info]` log line at startup so users notice the `/tmp`
override on top of whatever their Dockerfile placed there.

When `EphemeralStorage` is absent, no `--tmpfs` is emitted and the
container's `/tmp` is whatever the base image provides. Templates over
the AWS 10240 MiB (10 GiB) ceiling hard-error at resolve time.

The same cap applies to `cdkl start-api`'s warm container pool — each
cold-started container for a Lambda with `EphemeralStorage` gets the
same sized `/tmp`.

### `cdkl invoke` exit codes

- `0` — RIE answered, regardless of whether the handler returned a
  success payload OR an error payload. Lambda-style: a thrown handler
  produces a 200 with an error structure on AWS, and we mirror that.
- `1` — cdk-local-side errors before/after the handler ran: Docker not
  installed, image pull failed, target not found, RIE port unreachable
  after the readiness window, container exited before responding.

## `cdkl start-api` (long-running local API server)

`cdkl start-api` stands up a long-running HTTP server that maps
synthesized API Gateway routes (REST v1, HTTP API, WebSocket) and
Lambda Function URLs to local Lambda invocations against the AWS
Lambda Runtime Interface Emulator. Modeled on `sam local start-api`
but reusing cdk-local's synthesis, asset, and route-discovery
plumbing.

```bash
cdkl start-api                              # TTY: multi-select APIs (Enter = all); non-TTY: serve all
cdkl start-api --port 3000                  # first API → 3000, second API → 3001, ...
cdkl start-api MyAdminApi                   # serve one API (logical id; single-stack apps)
cdkl start-api MyAdminApi MyPublicApi       # serve a SUBSET (each on its own port)
cdkl start-api MyStack/MyAdminApi           # OR: CDK Construct path (prefix-matched)
cdkl start-api --all-stacks                 # multi-stack: serve EVERY stack's API
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

Pass one or more positional `<targets...>` to serve exactly that
**subset** — the union of the named APIs, each on its own port. Omit them
to serve every API (bare in a non-TTY) or to open the pre-selected-all
multi-select (bare in a TTY). The same target syntax `cdkl invoke` /
`cdkl run-task` use applies to each identifier:

1. **Bare logical id** — `MyHttpApi`. **Single-stack apps only**.
2. **Stack-qualified logical id** — `MyStack:MyHttpApi`.
3. **CDK Construct path / display path** — `MyStack/MyHttpApi/Resource`.
4. **CDK Construct path prefix** — `MyStack/MyHttpApi`.

For Function URLs, the path forms reference the **backing Lambda's**
`aws:cdk:path`, not the auto-generated URL resource.

When several targets are passed and they span **different stacks**, the
single-stack synth optimization is skipped and every stack is
synthesized, then filtered down to the union. A typo'd identifier that
matches no API is warned about and ignored (the matching siblings still
serve), but if NONE of the identifiers match the run errors.

**Deprecated `--api <id>` alias.** Earlier versions used a `--api`
flag for the same purpose. The flag is still accepted (emitting a
deprecation warn on use), accepts the same four forms, and takes a
**single** identifier — for a subset use multiple positional targets. It
will be removed in a future major release; migrate scripts / CI to the
positional form. Passing both positional targets and `--api` at once
produces an error — they're mutually exclusive.

### Options

| Flag | Default | Notes |
| --- | --- | --- |
| `--port <port>` | `0` (auto-allocate) | First API server's port (subsequent APIs get `port+1`, `port+2`, ...). Pass `0` (default) to auto-allocate each. The actual port assignment is printed at startup. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--stack <name>` | single-stack auto-detect | Required when the app has multiple stacks AND no other selector identifies the target. In multi-stack apps the synth stack is picked from the first match of: (1) `--stack <name>`, (2) `--from-cfn-stack <explicit-name>`, (3) the positional targets' shared stack-name prefix (e.g. `MyStack/MyApi` → `MyStack`; skipped when the targets span different stacks, in which case every stack is synthesized and filtered to the union), (4) `--all-stacks` (serve every stack). |
| `--all-stacks` | off | Serve every stack's API in a multi-stack app (each API on its own port) instead of erroring out for an ambiguous selection. Mutually exclusive with a positional target subset, `--stack`, and an explicit `--from-cfn-stack <name>` (those name a single stack); the bare `--from-cfn-stack` flag stays compatible — it binds each routed stack to its own CFn stack. No-op in a single-stack app (that one stack is already served). |
| `--warm` | off | Pre-start one container per discovered Lambda at server boot. Trades RAM for first-request latency. |
| `--per-lambda-concurrency <n>` | `2` | Pool size cap per Lambda. Max 4 in v1; above-cap values are clamped with a warn. |
| `--no-pull` | off | Skip `docker pull` (use cached image). |
| `--container-host <host>` | `127.0.0.1` | IP the host uses to bind/probe the RIE port. Must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames like `host.docker.internal`. |
| `--debug-port-base <port>` | unset | Allocate a contiguous `--inspect-brk` port range across Lambdas (one per Lambda). |
| `--env-vars <file>` | unset | SAM-shape JSON: `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. Same format as `cdkl invoke`. |
| `--assume-role <arn-or-pair>` | unset | Repeatable. Bare `<arn>` = global default; `<LogicalId>=<arn>` = per-Lambda override. Per-Lambda > global > unset (developer creds passed through). |
| `--watch` | off | Hot reload: re-synth + re-discover routes when `cdk.out/` or any routed Lambda's asset directory changes. Synth failures keep the previous version serving (warn-and-continue, never crashes the server). |
| `--stage <name>` | first attached | Select an API Gateway Stage by `StageName`. Drives `event.stageVariables` (REST v1 + HTTP API v2). For HTTP API v2 routes, `requestContext.stage` is always `$default` regardless of this flag (AWS-side limitation); only `event.stageVariables` is affected. For REST v1 the selected StageName is also threaded into `requestContext.stage`. |
| `--api <id>` | unset | **Deprecated** — use the positional `<targets...>` argument instead. Accepts a SINGLE identifier; for a subset pass multiple positional targets. Same accepted forms. Emits a deprecation warn on use. |
| `--layer-role-arn <arn>` | — | Role to `sts:AssumeRole` before calling `lambda:GetLayerVersion` on every literal-ARN entry in `Properties.Layers`. Same semantics as `cdkl invoke --layer-role-arn`. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `ListStackResources` and substitute `Ref` / `Fn::ImportValue` in Lambda env vars with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI. **The bare form is the typical shape** — `cdkl start-api MyStack/MyApi --from-cfn-stack` resolves to the routed stack's CDK name (`MyStack` here) per routed stack. Pass an explicit value (`--from-cfn-stack <name>`) only when the deployed CFn stack name differs from the CDK stack name (e.g. CDK's `stackName` prop was overridden). `Fn::GetAtt` (and other intrinsics `ListStackResources` can't resolve) in a routed Lambda's OWN env is recovered from the deployed function's resolved `Environment.Variables` via `lambda:GetFunctionConfiguration`. Same semantics as `cdkl invoke --from-cfn-stack`. |
| `--stack-region <region>` | — | Region of the state record to read. Drives the CFn client region for `--from-cfn-stack`. |
| `--mtls-truststore <path>` | unset | PEM-encoded CA bundle for client-certificate verification. When set, the server switches from HTTP to HTTPS and the TLS handshake rejects clients whose certificate doesn't chain to one of these CAs. Must be set together with `--mtls-cert` + `--mtls-key`; partial flag sets are rejected. See [local-emulation.md](./local-emulation.md) for the openssl recipe + event-shape details. |
| `--mtls-cert <path>` | unset | PEM-encoded server certificate for mutual TLS. Self-signed is fine for local dev. Must be set together with `--mtls-truststore` + `--mtls-key`. |
| `--mtls-key <path>` | unset | PEM-encoded server private key matching `--mtls-cert`. Must be set together with `--mtls-truststore` + `--mtls-cert`. |
| `--strict-sigv4` | off | Opt-in: **deny** `AWS_IAM` SigV4 requests that cannot be cryptographically verified (foreign access-key-id — e.g. a federated / Cognito Identity Pool / cross-account signer — OR no local AWS credentials configured) instead of the default warn-and-pass. **Default off**: cdk-local warn-and-passes unverifiable IAM requests with a placeholder principalId (`unverified-foreign-identity` / `unverified-no-creds`) so local dev exercises app logic without reproducing an auth boundary it cannot fully emulate; the deployed API Gateway still does the real verification. Use `--strict-sigv4` when you want local enforcement to mirror a verified-identity assumption. **Function URLs fronted by a CloudFront OAC always warn-and-pass and ignore `--strict-sigv4`** — CloudFront re-signs origin requests in production, so no local client signature can be verified; see [local-emulation.md](./local-emulation.md#oac-fronted-function-urls-auto-relaxed). |

Plus the [common flags](#common-flags): `-a/--app`, `--output`,
`-c/--context`, `--profile`, `--role-arn`, `--verbose`, `-y/--yes`.

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

### `cdkl start-api` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, port bind failed, route
  discovery rejected) OR uncaught exception during the run.
- `130` — exited via SIGINT (`^C`).

Detailed coverage of route discovery, REST v1 non-AWS_PROXY
integrations, CORS preflight, stage variables, container lifecycle,
authorizers (Lambda TOKEN/REQUEST, Cognito User Pool, JWT, AWS_IAM
signature verification), VPC-config Lambdas, mTLS, and hot-reload
internals lives in [local-emulation.md](./local-emulation.md).

## `cdkl run-task` (run an ECS task definition locally)

`cdkl run-task <target>` is the ECS counterpart of `cdkl invoke`. It
takes an `AWS::ECS::TaskDefinition` defined in a CDK app and starts
every container on the developer's Docker host — no AWS deploy needed.
The implementation runs one task synchronously, streams every
container's stdout/stderr with a `[<name>]` prefix, and propagates the
essential container's exit code.

The first run pulls the AWS-published
`amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar (a
small Go binary maintained by awslabs) plus each container's image.

### Target resolution

Same target-syntax rules as `cdkl invoke`:

- CDK display path (`MyStack/MyService/TaskDef`) — preferred
- Stack-qualified logical id (`MyStack:MyServiceTaskDefXYZ1234`)
- Single-stack apps may omit the stack prefix (`MyTaskDef`)

Path matching is prefix-based: an L2 path like
`MyStack/MyService/TaskDef` resolves to the synthesized L1 child
(`MyStack/MyService/TaskDef/Resource`).

### Options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkl` | Surfaced as `ECS_CONTAINER_METADATA_URI_V4`'s `Cluster` field and used as the docker network prefix (`<name>-task-<rand>`). |
| `--env-vars <file>` | unset | SAM-shape JSON overlay. Top-level keys are container names; `Parameters` is a global overlay. Same shape as `cdkl invoke --env-vars`. |
| `--container-host <ip>` | `127.0.0.1` | Bind IP for `PortMappings` published ports. Must be a numeric IP — Docker rejects hostnames in `-p <ip>:<port>:<port>`. |
| `--host-port <containerPort=hostPort>` | — | Publish a container port on a specific host port (e.g. `80=8080`); repeatable. Default: host port == container port. Map a privileged container port (< 1024) to a non-privileged host port to avoid macOS Docker Desktop's admin-password prompt. |
| `--assume-task-role [<arn>]` | unset | Bare flag uses the task definition's `TaskRoleArn`. Resolves a flat-string ARN directly; for `{Ref: <Role>}` / `{Fn::GetAtt: [<Role>, 'Arn']}` against a same-stack `AWS::IAM::Role`, cdk-local substitutes the caller's account id (via STS `GetCallerIdentity`) into `arn:aws:iam::<account>:role/<RoleLogicalId>`. Pass an explicit ARN to override. Either way, `sts:AssumeRole` runs once at startup; the resulting creds are exposed via the local metadata sidecar at `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `ListStackResources` and substitute `Ref` / `Fn::ImportValue` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI. Bare form uses the CDK stack name; pass an explicit value when the CFn stack name differs. `Fn::GetAtt` is warn-and-dropped in v1. See [Env / Secrets substitution](#env--secrets-substitution---from-cfn-stack) below. |
| `--stack-region <region>` | — | Region of the state record to read. Drives the CFn client region for `--from-cfn-stack`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR for cross-account / centralized registry pulls. Issues `sts:AssumeRole` via the CLI's resolved credentials (honoring `--profile`) and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull` on every container whose `Image` resolves to an `<acct>.dkr.ecr.<region>.amazonaws.com/...` URI. Required when the caller does not have direct cross-account access. Same-account / same-region pulls do not need this flag. No-op when `--no-pull` is set. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | `linux/amd64` or `linux/arm64`. Threaded into every container's `docker run --platform`. |
| `--keep-running` | off | Don't `docker rm -f` user containers on task exit (network + sidecar are still torn down). Use when you want to `docker exec` into a stopped container for post-mortems. |
| `--detach` | off | Start the containers and return without streaming logs or auto-tearing them down. Useful in CI smoke tests; caller manages container lifecycle. |

Plus the [common flags](#common-flags): `-a/--app`, `--output`,
`-c/--context`, `--profile`, `--role-arn`, `--verbose`, `-y/--yes`.

### Networking model

For every task invocation cdk-local:

1. Creates a fresh docker network `cdkl-task-<random>` (or
   `<--cluster>-task-<random>`) with subnet `169.254.170.0/24`.
2. Starts the AWS-published
   `amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar
   on the network at the well-known IP `169.254.170.2`.
3. Starts every user container on the same network with
   `--network-alias <container-name>` so siblings resolve each other by
   their CFn `ContainerDefinitions[].Name`.
4. Injects per-container env vars:
   `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>`
   and (when `--assume-task-role` is set)
   `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>`.

`awsvpc` network mode is mapped to `bridge` locally with a warn line —
docker cannot emulate ENI-per-task. AWS SDK calls from inside the
container still reach public AWS endpoints via the developer network.

### ECR image resolution

`ContainerDefinitions[].Image` is parsed in three tiers:

1. **Public images** — `public.ecr.aws/...`, `docker.io/...`,
   `nginx:latest`, etc. → plain `docker pull` (subject to `--no-pull`).
2. **Direct ECR URIs** —
   `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` (flat
   string, no intrinsics) → `pullEcrImage` (STS check + ECR auth +
   `docker pull`). Cross-account / cross-region supported: cdk-local
   builds the ECR client for the URI's region and (when `--ecr-role-arn
   <arn>` is passed) issues `sts:AssumeRole` to gain credentials in
   the target account.
3. **CDK-asset images** (`ContainerImage.fromAsset` /
   `DockerImageAsset`) → `cdk.out/<stack>.assets.json` lookup →
   `docker build` via the shared docker-build helper, tagged
   `cdkl-run-task-<asset-hash>`.

For `Fn::Sub` / `Fn::GetAtt` shapes pointing at AWS pseudo parameters
or a same-stack ECR repository (the typical
`ContainerImage.fromEcrRepository(repo)` synthesis), two additional
resolution tiers fire **before** the URI is fed to tier 2:

- **AWS pseudo-parameter substitution (no state needed)**:
  `${AWS::AccountId}` → STS `GetCallerIdentity` (lazy, cached for the
  run); `${AWS::Region}` → `AWS_REGION` / `AWS_DEFAULT_REGION` /
  synth-derived stack region; `${AWS::Partition}` → derived from
  region; `${AWS::URLSuffix}` → matches partition.
- **Same-stack ECR Repository reference (state needed)**: when the
  `Fn::Sub` body contains `${<LogicalId>}` against an
  `AWS::ECR::Repository`, or when the template uses `Fn::GetAtt:
  [<Repo>, 'RepositoryUri']`, cdk-local needs the deployed physical
  repo name. Pass `--from-cfn-stack` (the stack must have been deployed
  via `cdk deploy`); cdk-local loads state, substitutes the physical
  name, then routes through tier 2.

### Env / Secrets substitution (`--from-cfn-stack`)

`ContainerDefinitions[].Environment[].Value` and `Secrets[].ValueFrom`
entries are commonly intrinsic-valued in real-world CDK ECS apps —
`table.tableName` synthesizes as `Ref`, `table.tableArn` as
`Fn::GetAtt`, `ecs.Secret.fromSecretsManager(secret)` as `Ref` against
the secret (returns the deployed ARN), etc. Without a state source
these intrinsics are silently dropped and the developer sees an empty
env var or a missing secret.

`cdkl run-task --from-cfn-stack` substitutes every intrinsic-valued
entry against the deployed CFn stack plus AWS pseudo parameters:

| Intrinsic | Source |
| --- | --- |
| `Ref: <LogicalId>` | `ListStackResources` physical resource id |
| `Fn::ImportValue: <ExportName>` | `ListExports` (paginated, memoized) |
| `Fn::Sub: '...${X}...${AWS::Region}...'` | recursive substitution against CFn lookups + pseudo parameters |
| `Fn::Join: [<delim>, [<elements>]]` | recursive substitution of every element, then `Array.join` |
| `Ref: AWS::AccountId` / `AWS::Region` / `AWS::Partition` / `AWS::URLSuffix` | STS `GetCallerIdentity` (lazy, cached) + the resolved region + region-derived partition / URL suffix |
| `Fn::GetAtt: [<LogicalId>, <Attr>]` | **warn-and-dropped** in v1 (CFn `ListStackResources` does not return per-attribute values) |

Per-key best-effort: when a substitution can't be produced (state
missing for a referenced logical ID, attribute not captured, unsupported
intrinsic), the env / secret entry is dropped and a per-key warning
surfaces on the task's warnings line — the run-task invocation never
aborts. State-load failures (no record, ambiguity, region resolution
error) also degrade to warn-and-fall-back rather than hard-fail.

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
ARN) hard-fail with the offending container + secret name. Explicit
failure beats silently-empty.

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

### `cdkl run-task` exit codes

- `0` — essential container exited 0.
- N (non-zero) — essential container exited N (cdk-local propagates
  the code).
- Various cdk-local-side error codes (Docker missing, target not
  found, network creation failed, secret resolution failed, ...)
  follow the global handler's defaults (typically 1).

## `cdkl start-service` (run an ECS Service locally)

`cdkl start-service <targets...>` is the long-running counterpart of
`cdkl run-task`. It locates one or more `AWS::ECS::Service` resources
in the synthesized template, chains into the existing `run-task`
machinery once per `DesiredCount` replica (clamped by `--max-tasks`,
default 3), and keeps every replica running until `^C`. Failed
replicas restart per `--restart-policy` with exponential backoff (1s →
30s capped) so a crash-looping container does not hammer docker.

Each replica gets its own per-task docker network on a UNIQUE
`169.254.<N>.0/24` subnet (170, 171, 172, ...) so concurrent replicas
don't collide on a single /24 — the same metadata-endpoint sidecar
starts at `169.254.<N>.2` per replica.

When two or more `<targets>` are supplied, every service is booted into
a shared Cloud Map / Service Connect registry so peer services discover
each other via a `docker --add-host` DNS overlay.

> **Host-port publishing and multi-replica services.** A
> **single-replica** service publishes its container `PortMappings` to
> the host (`-p <container-host>:<hostPort>:<containerPort>`) so you can
> `curl localhost:<port>` from the host. A **multi-replica** service
> (effective replica count > 1 after the `--max-tasks` clamp) does NOT
> publish host ports: N replicas all map the same container port, so a
> fixed host-port publish would make the 2nd+ replica fail to boot with
> `Bind for 127.0.0.1:<port> failed: port is already allocated`. This
> matches production. Peers still reach a multi-replica service by
> container IP / network alias on the shared docker network; to hit a
> specific replica from the host, `docker exec` into it or read its IP
> from `docker inspect`.
>
> **macOS privileged ports.** The host port equals the container port by
> default. On macOS, Docker Desktop binds host ports below 1024 through a
> privileged helper (`com.docker.vmnetd`) that prompts for an admin
> password. To avoid the prompt, map the privileged container port to a
> non-privileged host port explicitly with `--host-port` (repeatable),
> e.g. `--host-port 80=8080` — then reach the container at
> `127.0.0.1:8080`. cdk-local never changes the host port silently.

### Target resolution

Same grammar as `cdkl run-task`:

- `Stack/Service/...` (display path) or `Stack:LogicalId` (logical
  id).
- Single-stack apps may omit the stack prefix.
- The target MUST resolve to an `AWS::ECS::Service`; passing a bare
  TaskDefinition surfaces a clear "use cdkl run-task" hint.

The Service's `TaskDefinition` property MUST be `{Ref:
'<TaskDefLogicalId>'}` referencing a same-stack
`AWS::ECS::TaskDefinition` (the standard CDK shape). Cross-stack
TaskDefinitions and `Fn::ImportValue` shapes are rejected with a clear
error.

### Options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkl` | Cluster name surfaced to `ECS_CONTAINER_METADATA_URI_V4` and used as the docker network prefix. Each replica's network appends `-svc-<service>-r<index>` so per-replica networks are easy to identify in `docker ps`. |
| `--max-tasks <n>` | `3` | Hard cap on local replica count regardless of template `DesiredCount`. Local dev machines should not run an unbounded number of containers. Cannot exceed the per-replica /24 subnet allocator's range. |
| `--restart-policy <policy>` | `on-failure` | Restart-on-exit behavior. `on-failure` restarts only on non-zero exit; `always` restarts on every exit; `none` shuts the affected replica down and runs the service degraded. |
| `--env-vars <file>` | — | SAM-shape JSON env-var overrides; same format as `cdkl run-task`. |
| `--container-host <ip>` | `127.0.0.1` | Host IP to bind published container ports to. Must be a numeric IP. |
| `--host-port <containerPort=hostPort>` | — | Publish a container port on a specific host port (e.g. `80=8080`); repeatable. Default: host port == container port. Map a privileged container port (< 1024) to a non-privileged host port to avoid macOS Docker Desktop's admin-password prompt. Single-replica services only. |
| `--assume-task-role [arn]` | unset | Assume the task definition's `TaskRoleArn` (or the supplied ARN) and forward STS-issued temp credentials via the metadata sidecar so every replica's containers run with the deployed task role. Same three-form grammar as `cdkl run-task`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before ECR `docker pull` for cross-account / centralized registries. Same shape as `cdkl run-task`. |
| `--platform <platform>` | inferred | Force `--platform linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `ListStackResources` and substitute `Ref` / `Fn::ImportValue` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI. Bare form uses the CDK stack name (per target when multiple `<targets...>` are supplied). `Fn::GetAtt` is warn-and-dropped in v1. Same shape as `cdkl run-task --from-cfn-stack`. |
| `--stack-region <region>` | — | Region of the state record to read. Drives the CFn client region for `--from-cfn-stack`. |

Plus the [common flags](#common-flags): `-a/--app`, `--output`,
`-c/--context`, `--profile`, `--role-arn`, `--verbose`, `-y/--yes`.

### Lifecycle

`^C` (SIGINT) and SIGTERM trigger a graceful shutdown across every
replica in parallel — each replica's docker containers + per-replica
network + metadata sidecar are torn down via the same cleanup path
`cdkl run-task` uses. Double-`^C` bypasses cleanup and exits 130
immediately so users have an escape hatch when docker hangs.

### `awsvpc` network mode

ECS Services on Fargate require `awsvpc`. cdk-local maps `awsvpc` to a
per-task docker bridge network with a startup warn; security groups
are NOT enforced locally and per-task ENIs are not emulated.

### `cdkl start-service` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, target not an ECS Service,
  network creation failed) OR uncaught exception during the run.
- `130` — exited via SIGINT (`^C`).
