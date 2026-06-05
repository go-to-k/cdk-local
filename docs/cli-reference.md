# cdk-local CLI Reference

This document covers every `cdkl` subcommand and flag in detail. For a
hands-on walkthrough, start with [getting-started.md](./getting-started.md).
For deeper notes on the local-execution model (route discovery, container
lifecycle, mTLS, authorizers, networking), see
[local-emulation.md](./local-emulation.md). When something breaks, see
[troubleshooting.md](./troubleshooting.md).

cdk-local has eight subcommands, all under the `cdkl` binary:

| Subcommand | Emulates | Backed by |
| --- | --- | --- |
| `cdkl list` (alias `cdkl ls`) | Lists the app's runnable targets (no execution) | Synthesis only — no Docker |
| `cdkl invoke <target>` | One-shot Lambda invoke | AWS Lambda Runtime Interface Emulator (RIE) container |
| `cdkl invoke-agentcore <target>` | One-shot Bedrock AgentCore Runtime invoke | Agent (container or fromCodeAsset / fromS3 managed-runtime) on its protocol contract — HTTP (`POST /invocations` + `GET /ping` on 8080), MCP (`POST /mcp` on 8000), A2A (`POST /` on 9000), or AGUI (SSE + `/ws` WebSocket on 8080) |
| `cdkl start-api` | Long-running HTTP server — API Gateway (REST v1 / HTTP API / WebSocket) + Lambda Function URL | RIE container pool + `node:http` listener (one server per discovered API) |
| `cdkl run-task <target>` | ECS `RunTask` for one task | docker network + ECS metadata sidecar (`amazon/amazon-ecs-local-container-endpoints`) |
| `cdkl start-service <targets...>` | Long-running ECS `Service` emulator (replicas only, no load balancer) | `run-task` machinery per replica + shared docker network + restart-on-exit watcher |
| `cdkl start-alb <targets...>` | ECS service(s) behind an ALB + a local front-door on each listener port | `start-service` machinery + host-side `node:http` reverse proxy round-robining the replicas |
| `cdkl start-agentcore <target>` | Long-running serve of an HTTP / AGUI AgentCore Runtime's `/ws` WebSocket endpoint | Agent container + a host WebSocket bridge (`node:http` + `ws`) that injects the session-id / `Authorization` upgrade headers a browser can't set |
| `cdkl studio` | Interactive web console over every runnable target — invoke / serve from the browser, watch a live activity timeline | `node:http` server hosting the embedded UI; spawns the same `invoke` / `start-api` / `start-alb` / `start-service` runners as child processes |

The run commands (`invoke` / `invoke-agentcore` / `start-api` / `run-task` /
`start-service` / `start-alb`) require Docker on the developer's machine. The
first run pulls the relevant base image (~600MB for the language-specific
Lambda images, ~50MB for `provided.*`, the agent's own container base for
`invoke-agentcore`, plus the ECS metadata sidecar for
`run-task` / `start-service` / `start-alb`). Subsequent runs reuse the cached image;
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
| `--region <region>` | — | AWS region for the host-side SDK calls (STS `GetCallerIdentity` for `${AWS::AccountId}` resolution, `AssumeRole` for `--assume-role`, the `--from-cfn-stack` CFn client) and the container's `AWS_REGION` env var. Defaults to `AWS_REGION` / `AWS_DEFAULT_REGION` env, then the synthesized stack region, then the `--profile`'s configured region. |

The `--from-cfn-stack` / `--stack-region` family is described in the
per-command sections below.

## Interactive target selection

The five run commands — `invoke`, `invoke-agentcore`, `run-task`,
`start-service`, `start-api` — open an arrow-key picker (powered by
`@clack/prompts`) when you OMIT the positional target in an interactive
terminal, instead of making you type a CDK path / logical ID. `invoke` /
`invoke-agentcore` / `run-task` pick a single target; `start-service` /
`start-api` open a multi-select (pick
one or more). The list is the same set `cdkl list` prints, so a Function
URL appears under its backing Lambda. (There is no `-i` / `--interactive`
flag — bare-in-a-TTY is the trigger.)

The multi-select starts with **nothing** selected. Space toggles the
current row, `→` selects all, `←` clears all, and Enter confirms — then a
Y/n confirmation runs before launch (declining returns to the picker with
the selection kept). Submitting with nothing selected asks whether to exit
(so a stray Enter never launches anything). For `start-api`,
each selected API is served on its own port; to serve them all, press `→`
then Enter (or, outside a TTY, just run bare `start-api` — see below).
Each API row is tagged with its surface kind — `REST API v1` /
`HTTP API v2` / `Function URL` / `WebSocket` — so otherwise-similar
surfaces are easy to tell apart. (The picker shows the CDK display path,
not the stack-qualified logical ID — `cdkl list -l` still prints it.)

The picker requires a TTY. In a non-interactive context (CI, pipes,
redirected stdin/stdout):

- `invoke` / `invoke-agentcore` / `run-task` / `start-service` fall back to
  the command's usual "target required" error — pass the target
  explicitly instead;
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

AgentCore Runtimes  ->  cdkl invoke-agentcore <target>
  MyStack/ChatAgent

Application Load Balancers  ->  cdkl start-alb <target...>
  MyStack/WebAlb
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

### `--env-vars` override keys

Each top-level JSON key in an `--env-vars` file picks which target to
overlay. The matching rules differ between Lambda / AgentCore (whose
construct path and logical ID both identify a single env block) and
ECS (whose env block lives inside a container element of the
TaskDefinition, not at the resource level):

| Target | Key shape | Match rule |
| --- | --- | --- |
| Every target | `Parameters` | Reserved literal; applied first to every container before any per-target overlay |
| Lambda / AgentCore Runtime | CDK construct path (e.g. `MyStack/Fn`) | Compared against the resource's `Metadata['aws:cdk:path']`; prefix-matched so `MyStack/Fn` also catches the synthesized `MyStack/Fn/Resource` |
| Lambda / AgentCore Runtime | CloudFormation logical ID (e.g. `MyStackFn1A2B3C`) | Compared against the synthesized top-level resource key in the template; exact match |
| ECS container | Container Name (e.g. `AppContainer`) | Compared against `ContainerDefinitions[].Name` in the synthesized TaskDefinition (= the `containerName` option of `taskDef.addContainer(id, { containerName, ... })`, or the construct id (first arg of `addContainer`) when omitted); exact match. The TaskDefinition's own CDK path / logical ID is NOT accepted — it would identify the TaskDef but not which container's env block to overlay |

`--env-vars` overlays the env block after the template's literals and
any resolved ECS `Secrets[]` have been applied. A per-target key wins
over `Parameters`. A `null` value clears the key (across every shape
above) — use the JSON literal `null`, not the string `"null"`.

`--env-vars` is composable with `--from-cfn-stack`: the latter resolves
intrinsics (`Ref` / `Fn::ImportValue` / `Fn::GetStackOutput` /
`Fn::GetAtt`) against the deployed stack first, then `--env-vars`
overlays your overrides on top.

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

## `cdkl invoke-agentcore` (run Bedrock AgentCore Runtime agents locally)

`cdkl invoke-agentcore <target>` runs an `AWS::BedrockAgentCore::Runtime`
agent container locally and invokes it once over its protocol contract. It
resolves the runtime, pulls / builds its container, starts it, waits for it
to become ready, sends one request, prints the response, and tears the
container down. The exact contract depends on `ProtocolConfiguration`:

- **HTTP** (default) — starts on port 8080, waits for `GET /ping` to return
  a 2xx, then POSTs the event to `POST /invocations` (with the session-id
  header) and prints the response body.
- **MCP** — starts on port 8000, then speaks the Model Context Protocol over
  Streamable HTTP at `POST /mcp`: see [MCP protocol](#mcp-protocol) below.
- **A2A** — starts on port 9000, then speaks Agent2Agent JSON-RPC 2.0 at
  `POST /` (the root). One JSON-RPC round-trip per invocation; default
  method is `agent/getCard` (the agent's discovery card). See
  [A2A protocol](#a2a-protocol) below.
- **AGUI** — starts on port 8080 (the AG-UI wire reuses the HTTP container
  port), serves SSE on `POST /invocations` and a bidirectional WebSocket on
  `/ws`. Routes through the same client path as HTTP — the SSE / WS
  handlers stream the AG-UI typed event envelope to stdout transparently
  (pipe through `jq` for pretty-printing). See [AGUI protocol](#agui-protocol)
  below.

This is the same request/response loop AgentCore runs in the cloud,
exercised locally before deploy. It supports the **container artifact**
(`AgentRuntimeArtifact.ContainerConfiguration.ContainerUri`) and the
**CodeConfiguration** managed-runtime artifact (`fromCodeAsset` AND `fromS3`,
built from source — see [CodeConfiguration](#codeconfiguration-managed-runtime)
below) on all four protocols. The agent's own calls to AWS managed
services (Bedrock models, memory, etc.) go to real AWS — credentials are
injected exactly like `cdkl invoke` (see below).

The container image is resolved like a container Lambda: a local cdk.out
asset (the `fromAsset` / Dockerfile path) is built with `docker build`;
otherwise an ECR URI is pulled (`--ecr-role-arn` for cross-account
registries), and a plain registry URI is `docker pull`ed.

### CodeConfiguration (managed runtime)

A `CodeConfiguration` artifact ships source + an `EntryPoint` + a `Runtime`
instead of a container — AWS runs it on a managed runtime whose entrypoint
self-serves the same HTTP (or MCP) contract (typically via the
`bedrock-agentcore` SDK). cdk-local replicates that with a **local from-source
build**: it gets the bundle source, generates a Dockerfile for the runtime's
base image (`PYTHON_3_10`-`PYTHON_3_14` → `python:3.x-slim`, `NODE_22` →
`node:22-slim`), installs the bundle's dependencies (`requirements.txt` /
`pyproject.toml` for Python, `package.json` for Node — when present), runs the
`EntryPoint`, then drives the started container with the same protocol client
as a container artifact.

Both bundle shapes are supported:

- **`fromCodeAsset`** (a CDK-managed local code asset) — read straight from
  `cdk.out`.
- **`fromS3`** (a pre-existing S3 object) — the bundle ZIP is downloaded from
  `Code.S3` and extracted to a temp dir, then built the same way. The download
  uses the resolved region (`--stack-region` / `--region` / env / the stack's
  region) and credentials (`--assume-role` STS temp creds when set, else
  `--profile` / the default chain). The S3 read needs credentials that can
  `s3:GetObject` the bundle object. `Code.S3.Bucket` may be either a literal
  bucket name OR an intrinsic resolved against `--from-cfn-stack` state — the
  same set of intrinsics env-var substitution supports: `Ref` (same-stack
  bucket), `Fn::ImportValue` (CloudFormation export), `Fn::GetStackOutput`
  (cdk-local cross-stack output). Without `--from-cfn-stack`, an intrinsic
  bucket fails fast with an actionable error.

`--no-build` reuses the previously-built image tag.

### Target resolution

Same target syntax as every other command — a CDK display path
(`MyStack/ChatAgent`) or a stack-qualified logical ID
(`MyStack:ChatAgent1234ABCD`); single-stack apps may omit the stack
prefix. Omit the target in a TTY to pick from a list.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-e, --event <file>` | `{}` | JSON event payload file POSTed to `/invocations`. |
| `--event-stdin` | off | Read the event JSON from stdin instead of a file (mutually exclusive with `--event`). |
| `--env-vars <file>` | — | JSON env-var overrides, SAM-compatible shape: `{"LogicalId":{"KEY":"VALUE"}}` plus an optional top-level `"Parameters"` block. `null` clears a key. |
| `--session-id <id>` | random UUID | Value for the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` request header. |
| `--ws` | off | Stream over the HTTP-protocol agent's bidirectional `/ws` WebSocket endpoint (on 8080) instead of `POST /invocations`. Sends `--event` as the first frame and prints every received frame to stdout until the agent closes. **TTY auto-detect**: when stdin is a TTY (real terminal), additionally reads stdin lines as follow-up text frames so each typed line becomes one WS frame — multi-turn REPL by default (Ctrl-D to end). When stdin is NOT a TTY (piped / redirected / CI), only the initial frame is sent — one-shot. Force one-shot in a TTY with `cdkl ... --ws </dev/null`. See [WebSocket transport](#websocket-transport---ws) below. Ignored for an MCP runtime. |
| `--bearer-token <jwt>` | — | Bearer JWT this command **supplies** as the outbound client when the runtime declares a `customJwtAuthorizer` — `cdkl invoke-agentcore` is the local-dev caller, so it always presents this token to its own invocation. Verified against the runtime's OIDC discovery URL (signature / `iss` / `exp` / audience) before the container starts, then forwarded to `/invocations` (or the `/ws` upgrade) as `Authorization: Bearer <jwt>`. Contrast with `cdkl start-alb --bearer-token` where the role flips: that command **receives** inbound requests and injects this token only as a default-when-missing fallback. |
| `--no-verify-auth` | off (verify on) | Skip inbound JWT verification even when the runtime declares a `customJwtAuthorizer` (local-dev escape hatch). A `--bearer-token`, if given, is still forwarded. |
| `--sigv4` | off | Sign the `/invocations` POST with AWS SigV4 (service `bedrock-agentcore`) using the resolved credentials — the same `Authorization: AWS4-HMAC-SHA256 ...` + `X-Amz-*` headers the cloud receives when the runtime declares no `customJwtAuthorizer`. Opt-in: default unsigned. Mutually exclusive with `--bearer-token`; ignored on a JWT-protected runtime. See [Inbound SigV4 (`--sigv4`)](#inbound-sigv4---sigv4) below. |
| `--platform <platform>` | `linux/arm64` | `docker --platform` for the agent container. Defaults to `linux/arm64` because the cloud AgentCore Runtime requires arm64 — the cloud service rejects amd64 images, so the local default mirrors the only architecture you can actually deploy. Contrast `cdkl invoke` / `cdkl start-api`, where the architecture is inferred per-Lambda from `Architectures: [x86_64\|arm64]` in the synthesized template (no `--platform` flag at all), and `cdkl run-task` / `start-service` / `start-alb`, where it is inferred from `RuntimePlatform.CpuArchitecture` on the task definition (no default — whatever the template declares wins). Override to `linux/amd64` only when iterating against an amd64 dev container locally; the image will not run on the cloud runtime as-is. |
| `--no-pull` | off | Skip `docker pull` (use the cached image). No-op for the local-build path. |
| `--no-build` | off | Skip `docker build` on the local-asset path (reuse the previously-built tag). No-op for the ECR / registry pull paths. |
| `--container-host <host>` | `127.0.0.1` | Host to bind the agent's published port to. |
| `--timeout <ms>` | `120000` | Per-request timeout in milliseconds. Applied to `POST /invocations`, `POST /mcp`, and the `/ws` open-to-close window. Raise this for long-running agent calls that exceed the default. |
| `--watch` | off | Re-synth + reload the agent container on CDK source changes. Only meaningful with the long-running `--ws` session path: the single-shot HTTP `POST /invocations`, MCP `POST /mcp`, and A2A `POST /` paths run once and exit, so `--watch` is logged as a one-line WARN there and the single shot proceeds normally. The per-firing classifier shared with `start-service` / `start-alb` decides `'rebuild'` vs `'soft-reload'`: source-only edits on an interpreted-language handler (Node / Python / Ruby / shell) `docker cp` + `docker restart` the running container, Dockerfile / dependency / compiled-source / ambiguous edits SIGTERM the old container and rebuild from scratch. The active `/ws` socket is closed cleanly on every reload firing (AgentCore has no protocol-defined mid-session container handoff) so the next session connects to the rebuilt container — the honest local-dev semantic. Honors `cdk.json`'s `watch.include` / `watch.exclude` globs. |
| `--assume-role [arn]` | off | Assume an execution role and forward STS temp creds. `--assume-role <arn>` uses the explicit ARN; bare `--assume-role` uses the runtime's `RoleArn` when it is a literal ARN, else resolves it from `--from-cfn-stack` state; `--no-assume-role` opts out. Off by default forwards the developer's shell credentials. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating against ECR for cross-account / centralized registries. |
| `--from-cfn-stack [name]` | — | Read a deployed CloudFormation stack via `ListStackResources` and substitute `Ref` / `Fn::ImportValue` in env vars with the deployed physical IDs / exports, resolve a same-stack `AWS::ECR::Repository` ContainerUri to the deployed image, and resolve `AWS::SSM::Parameter::Value` env values (decrypted `SecureString` values are kept off the `docker run` argv). Bare form uses the resolved stack name. |
| `--stack-region <region>` | — | Region of the state record to read; the CFn client region for `--from-cfn-stack`. |

### Credentials

The agent reaches real AWS via the standard SDK credential chain inside
the container. Precedence matches `cdkl invoke`: `--assume-role` (STS
temp creds) wins, otherwise the developer's shell credentials are
forwarded, overlaid with `--profile` when set (and the bind-mounted
shared-credentials file so `fromIni({ profile })` resolves).

Bare `--assume-role` (no ARN) uses the runtime's `RoleArn` when it is a
literal ARN; when it is an intrinsic (the common L2 case — `Fn::GetAtt` to
an auto-created role), the execution-role ARN is resolved from
`--from-cfn-stack` state where available (a role whose ARN is not in the
state record falls back to dev creds with a warning).

### Inbound JWT auth (`customJwtAuthorizer`)

When the runtime declares an `AuthorizerConfiguration.CustomJWTAuthorizer`,
`cdkl invoke-agentcore` enforces it the way AgentCore does in the cloud —
before the container starts:

- **No `--bearer-token`** → rejected (AgentCore returns 401). Pass a token,
  or `--no-verify-auth` to skip for local dev.
- **`--bearer-token <jwt>`** → the token is verified against the runtime's
  OIDC discovery URL: the discovery document is fetched for its `issuer` +
  `jwks_uri`, then the JWT's RS256 signature, `iss`, `exp`, audience,
  `allowedScopes`, and `customClaims` are checked:
  - **Audience** — `aud` (ID tokens) or `client_id` (access tokens) must
    match the `allowedAudience` ∪ `allowedClients` allowlist.
  - **`allowedScopes`** — the token's `scope` claim (OAuth space-separated
    string, or an array) must include EVERY required scope.
  - **`customClaims`** — every declared rule must hold against the token's
    matching claim:
    - `STRING` + `EQUALS` — claim string-equals the configured value;
    - `STRING_ARRAY` + `CONTAINS` — claim array includes the configured
      value;
    - `STRING_ARRAY` + `CONTAINS_ANY` — claim array shares at least one
      entry with the configured list.

  An invalid token is rejected (AgentCore returns 403); a valid one is
  forwarded to `/invocations` (or the `/ws` upgrade) as
  `Authorization: Bearer <jwt>`.
- **Discovery URL / JWKS unreachable** → falls back to pass-through (accept +
  warn), the same offline-dev trade-off `cdkl start-api` makes for
  unreachable Cognito JWKS. Scope / custom-claim verification does NOT run on
  the pass-through path — every Bearer token is accepted. The warn re-emits
  every 5 minutes per URL (#247) so a long-running session keeps surfacing
  the degraded state instead of silently accepting tokens for the rest of
  the run.
- **`--no-verify-auth`** → skips verification entirely; a `--bearer-token`,
  if given, is still forwarded.

### Inbound SigV4 (`--sigv4`)

In the cloud, an AgentCore Runtime that declares no `customJwtAuthorizer`
authenticates inbound `/invocations` requests via AWS IAM (SigV4) — the
caller signs the request and AgentCore verifies the signature against the
caller's IAM credentials. Locally the agent container has no AWS
public-key infrastructure to validate signatures against; passing
`--sigv4` opts into HEADER PARITY with the cloud so an agent that
introspects the inbound `Authorization` header (e.g. through the
`bedrock-agentcore` SDK's request context) sees the same shape it would in
production.

`--sigv4` signs the `POST /invocations` request with the resolved
credentials and forwards the full signed header set to the agent:

- `Authorization: AWS4-HMAC-SHA256 Credential=<accessKeyId>/<date>/<region>/bedrock-agentcore/aws4_request, SignedHeaders=..., Signature=...`
- `X-Amz-Date: <ISO-8601 basic>`
- `X-Amz-Content-Sha256: <body sha256 hex>`
- `X-Amz-Security-Token: <token>` (only when the credentials are STS-issued)

Credentials precedence (same chain as the rest of the command):

1. `--assume-role <arn>` → STS temp creds (warn + fall through on STS failure);
2. `--profile <name>` → profile creds (with `aws_session_token` when present);
3. shell env `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional
   `AWS_SESSION_TOKEN`).

With none of the above set, `--sigv4` fails fast with an actionable error.
Region resolution: `--region` / `--stack-region` / `AWS_REGION` /
`AWS_DEFAULT_REGION` / the stack's region.

`--sigv4` is mutually exclusive with `--bearer-token` (one inbound auth
per request) and is ignored on a runtime that declares a
`customJwtAuthorizer` (the JWT path takes precedence — `--sigv4` warns and
falls back to the JWT flow). The MCP and `/ws` paths are unaffected by
this flag.

### Streaming responses

(HTTP protocol.) A JSON (`application/json`) response is printed verbatim
once the request completes. A streaming SSE (`text/event-stream`) response
is written to stdout chunk-by-chunk as it arrives — so a token-streaming
agent shows incrementally, the same UX AgentCore gives in the cloud —
rather than all at once at the end. For full duplex, see the WebSocket
transport below.

### WebSocket transport (`--ws`)

An HTTP-protocol agent can also expose a bidirectional `/ws` WebSocket
endpoint on the same 8080 container (AWS supports `GET /ws` alongside
`POST /invocations` + `GET /ping`; the SDK's `BedrockAgentCoreApp`
registers it). `--ws` exercises it:

1. wait for `GET /ping`, then open `ws://<host>:8080/ws` with the
   `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header (and, for a
   protected runtime, `Authorization: Bearer <jwt>` after the same inbound
   JWT check above),
2. send `--event` (default `{}`) as the first frame,
3. print every received frame to stdout in arrival order until the agent
   closes the stream.

The over-the-wire framing on `/ws` is agent-defined — AWS pipes bytes
transparently — so `cdkl` mirrors that and does not interpret the frames.
`--ws` is HTTP-only; it is ignored (with a warning) for an MCP runtime.

### Interactive mode (TTY auto-detect)

`--ws` adapts to its stdin:

- **stdin is a TTY (real terminal)** — auto-attach a REPL on top of the
  same connection. After `--event` is sent as the first frame, each
  subsequent line you type on stdin becomes one follow-up text frame,
  until you Ctrl-D (stdin EOF) or the agent closes the WebSocket. This
  matches the deployed `/ws` endpoint's bidirectional shape: a TTY user
  gets a multi-turn session by default. Server-side close (agent closes
  the stream) ends the session early — the iterator is released and
  stdin reading stops.
- **stdin is NOT a TTY (piped, redirected, CI, `< /dev/null`)** — only
  the initial `--event` frame is sent; the client receives until the
  agent closes. The standard one-shot script-friendly shape.

```bash
# Interactive (real terminal): multi-turn REPL by default
cdkl invoke-agentcore MyChatAgent --ws --event ./open.json
# > here, each line you type becomes a follow-up WS frame
# > Ctrl-D to end

# One-shot in a TTY (force non-interactive): redirect stdin to /dev/null
cdkl invoke-agentcore MyChatAgent --ws --event ./open.json </dev/null

# CI / piped (stdin already non-TTY): one-shot by default
echo '{"prompt":"hi"}' | cdkl invoke-agentcore MyChatAgent --ws
```

`--ws` is HTTP-only; it is ignored (with a warning) for an MCP runtime.

### MCP protocol

When `ProtocolConfiguration = MCP`, the runtime's container serves the Model
Context Protocol over Streamable HTTP at `POST /mcp` on port 8000 (there is
no `GET /ping` — readiness is a successful `initialize`). `cdkl
invoke-agentcore` runs the minimal MCP session lifecycle:

1. `initialize` (retried while the container boots — this is the readiness
   wait); the server may assign an `Mcp-Session-Id` that subsequent requests
   echo,
2. `notifications/initialized`,
3. one JSON-RPC request — **`tools/list` by default**, or the
   `{"method": ..., "params": ...}` from `--event` (e.g.
   `{"method":"tools/call","params":{"name":"...","arguments":{...}}}`).

The JSON-RPC response is printed (handling both an `application/json` and a
`text/event-stream` reply). Talking to the local container is **vanilla
MCP**: the AgentCore session header and inbound OAuth bearer are managed-plane
concerns the cloud front door maps to MCP's own `Mcp-Session-Id`, so they are
not applied to a direct local `/mcp` call (`--bearer-token` / `--session-id`
are HTTP-protocol options and are ignored for MCP).

### A2A protocol

When `ProtocolConfiguration = A2A`, the runtime's container serves the
Agent2Agent JSON-RPC 2.0 contract at `POST /` (the root) on port 9000.
Unlike MCP there is no session lifecycle: each invocation is one POST that
carries the JSON-RPC request and the response is read back from the same
POST. `cdkl invoke-agentcore` POSTs the method/params from `--event`,
defaulting to `agent/getCard` (the agent's discovery card) when none is
supplied:

```bash
cdkl invoke-agentcore MyA2aAgent                                     # agent/getCard
cdkl invoke-agentcore MyA2aAgent --event ./tasks-send.json           # tasks/send
```

Where `tasks-send.json` is e.g.
`{"method":"tasks/send","params":{"id":"task-1","message":{...}}}`. The
JSON-RPC response is pretty-printed; a top-level JSON-RPC `error` exits
non-zero (matching the MCP path). Talking to the local container is
**vanilla A2A** — the AgentCore session header and inbound OAuth bearer are
managed-plane concerns layered on top in the cloud, so `--bearer-token` /
`--session-id` are HTTP-protocol options and are ignored for A2A.

### AGUI protocol

When `ProtocolConfiguration = AGUI`, the runtime's container serves the
AG-UI HTTP-compatible contract on port 8080 — SSE on `POST /invocations`,
WebSocket on `/ws`. `cdkl invoke-agentcore` routes AGUI through the same
client path as **HTTP**: it waits for `GET /ping`, POSTs `--event` to
`/invocations`, and streams the response body to stdout as it arrives. AG-UI
emits typed events (`RUN_STARTED`, `MESSAGE_CONTENT`, `RUN_FINISHED`, ...)
as one `data:` line each — pipe through `jq -c .` (or any JSON line tool)
for structured pretty-printing:

```bash
cdkl invoke-agentcore MyAguiAgent --event ./prompt.json | jq -c .
```

`--ws` / `--bearer-token` / `--no-verify-auth` / `--sigv4` all apply
unchanged — AGUI's wire is the same shape as HTTP's, so the entire HTTP
option surface carries over.

### Per-request timeout (`--timeout`)

The default per-request timeout is 120 seconds. It applies to every
transport:

- HTTP / AGUI `POST /invocations` — the streaming sink keeps writing chunks
  while the response body arrives, but the open-to-final-byte window is
  bounded by `--timeout`.
- MCP `POST /mcp` — applied to both the `notifications/initialized` POST
  and the one JSON-RPC request POST.
- A2A `POST /` — applied to the JSON-RPC POST.
- `/ws` — bounds the open-to-close window (the agent closes the stream).

Raise it for long-running agents whose response exceeds 120s:

```bash
cdkl invoke-agentcore MyAgent --event ./long-running.json --timeout 600000
```

Lower it in a CI smoke test to fail fast. The flag rejects zero, negatives,
and non-integer values pre-container.

### `cdkl invoke-agentcore` exit codes

- `0` — the agent answered with a success: a 2xx from `POST /invocations`
  (HTTP), or a JSON-RPC response with no top-level `error` (MCP).
- `1` — the agent returned a 4xx/5xx from `/invocations` or a JSON-RPC
  `error` (MCP), OR a cdk-local-side error: Docker not installed, image
  build / pull failed, target not found, the agent never became ready within
  the readiness window, or the container exited before responding.

## `cdkl start-agentcore` (serve an AgentCore `/ws` endpoint locally)

`cdkl start-agentcore <target>` is the long-running serve counterpart of the
single-shot `cdkl invoke-agentcore`. It boots an `AWS::BedrockAgentCore::Runtime`
agent container once — using the **same** image / env-var / `--from-cfn-stack`
/ `--assume-role` / `--bearer-token` resolution as `invoke-agentcore` — and
then serves the agent's bidirectional `/ws` WebSocket endpoint behind a host
**bridge** so a client can hold an interactive multi-frame session. It prints a
`Server listening on ws://127.0.0.1:<port>/ws` ready line and runs until `^C`.

**Why a bridge.** The AgentCore `/ws` upgrade requires the
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header (and `Authorization:
Bearer <jwt>` when the runtime declares a `customJwtAuthorizer`). A browser
`WebSocket` cannot set custom request headers, so it can't connect to the
container directly. The bridge accepts a header-less client on its own
`--port` and opens a connection to the container `/ws` with those headers
injected — a fresh session-id UUID per inbound connection (so each client /
browser tab is its own AgentCore session), unless `--session-id` pins one.

**Protocols.** HTTP and AGUI runtimes only — they expose `/ws` on 8080. MCP
(`POST /mcp`) and A2A (`POST /`) are single-shot request/response contracts
with no `/ws`, and are rejected up front with an actionable error (use
`cdkl invoke-agentcore` for those).

```bash
# Pick an AgentCore Runtime interactively (TTY), serve its /ws on a free port
cdkl start-agentcore

# Serve a named runtime's /ws on a fixed bridge port
cdkl start-agentcore MyStack/Agent --port 8080

# Forward a bearer token (verified against the runtime's OIDC discovery URL)
# on every bridged container upgrade
cdkl start-agentcore MyStack/Agent --bearer-token "$JWT"

# Bind to a deployed stack so intrinsic env values / ECR image URIs resolve
cdkl start-agentcore MyStack/Agent --from-cfn-stack
```

| Option | Default | Description |
| --- | --- | --- |
| `--port <n>` | `0` | Bridge-server bind port the client connects to (0 = OS-assigned). |
| `--host <ip>` | `127.0.0.1` | Bridge-server bind host. |
| `--session-id <id>` | random UUID per connection | Pin one AgentCore session-id header value for every connection. |
| `--bearer-token <jwt>` | — | Bearer JWT for a `customJwtAuthorizer`; verified against the runtime's OIDC discovery URL, then injected as `Authorization: Bearer <jwt>` on every container `/ws` upgrade. |
| `--no-verify-auth` | (verify on) | Skip inbound JWT verification (local-dev escape hatch); a `--bearer-token`, if given, is still forwarded. |
| `--env-vars <file>` | — | SAM-shape JSON env-var overrides for the agent container. |
| `--platform <platform>` | `linux/arm64` | `docker --platform` for the agent container. |
| `--no-pull` / `--no-build` | (on) | Skip the image pull / local build. |
| `--container-host <ip>` | `127.0.0.1` | Host IP used to bind the agent container port. |
| `--timeout <ms>` | `120000` | `GET /ping` container-ready probe timeout. |
| `--assume-role [arn]` | — | Assume the runtime's execution role and forward STS credentials to the container. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating against ECR. |
| `--from-cfn-stack [name]` | — | Resolve intrinsic env values / ECR image URIs against a deployed stack. |
| `--stack-region <region>` | — | Region of the state record (with `--from-cfn-stack`). |

`--watch` (reload on CDK source changes) is a planned follow-up; for now,
restart the command to pick up local edits. `start-agentcore` is also runnable
from `cdkl studio` (the `agentcore-ws` serve kind) with an in-browser WebSocket
console.

## `cdkl start-api` (long-running local API server)

`cdkl start-api` stands up a long-running HTTP server that maps
synthesized API Gateway routes (REST v1, HTTP API, WebSocket) and
Lambda Function URLs to local Lambda invocations against the AWS
Lambda Runtime Interface Emulator. Modeled on `sam local start-api`
but reusing cdk-local's synthesis, asset, and route-discovery
plumbing.

```bash
cdkl start-api                              # TTY: multi-select APIs (→ all); non-TTY: serve all
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
to serve every API (bare in a non-TTY) or to open the multi-select picker
(bare in a TTY). The same target syntax `cdkl invoke` /
`cdkl run-task` use applies to each identifier:

1. **Bare logical id** — `MyHttpApi`. **Single-stack apps only**.
2. **Stack-qualified logical id** — `MyStack:MyHttpApi`.
3. **CDK Construct path / display path** — `MyStack/MyHttpApi/Resource`.
4. **CDK Construct path prefix** — `MyStack/MyHttpApi`.

For Function URLs, the path forms reference the **backing Lambda's**
`aws:cdk:path`, not the auto-generated URL resource. A **WebSocket API**
is targetable by the same id forms (the `AWS::ApiGatewayV2::Api`
resource's logical id / stack-qualified id / construct path), so
`cdkl start-api MyStack/MyWsApi` serves exactly that WebSocket API.

The target filter applies to **WebSocket APIs too**: an explicit target
serves only the named APIs (REST / HTTP / Function URL / WebSocket
alike), and bare `start-api` (no target) serves every API including all
WebSocket APIs. (Previously WebSocket APIs were always served as a group
regardless of the target — so targeting an HTTP API also booted unrelated
WebSocket APIs, and a WebSocket-API target errored with "did not match any
discovered API". Both are fixed.)

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
| `--no-build` | off | Skip `docker build` on every container Lambda local-asset build path (reuse the previously-built tag from an earlier server boot). Requires the deterministic tag to already be in the local registry; errors clearly when missing. No-op for ZIP Lambdas and the ECR-pull fallback. Same semantics as `cdkl invoke --no-build`. Compatible with `--no-pull`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR on the container-Lambda ECR-pull fallback. Issues `sts:AssumeRole` via the CLI's resolved credentials (honoring `--profile`) and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull`. Required for cross-account / centralized registry pulls. Same-account / same-region pulls do not need this flag. Same semantics as `cdkl invoke --ecr-role-arn`. |
| `--container-host <host>` | `127.0.0.1` | IP the host uses to bind/probe the RIE port. Must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames like `host.docker.internal`. |
| `--debug-port-base <port>` | unset | Allocate a contiguous `--inspect-brk` port range across Lambdas (one per Lambda). |
| `--debug-port <port>` | unset | Alias of `--debug-port-base` for parity with `cdkl invoke --debug-port`. Reserves a contiguous `--inspect-brk` port range starting at `<port>`. `--debug-port-base` is the canonical name and wins when both are passed. |
| `--env-vars <file>` | unset | SAM-shape JSON: `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. Same format as `cdkl invoke`. |
| `--assume-role <arn-or-pair>` | unset | Two forms. (1) `--assume-role <arn>` (global default) — STS-AssumeRole this ARN for every routed Lambda. (2) `--assume-role <LogicalId>=<arn>` (repeatable per-Lambda override) — wins over both the global default and `--assume-role-auto` for the named Lambda. Per-Lambda > (`--assume-role-auto` OR global default) > unset (developer creds passed through). |
| `--assume-role-auto` | off | Issue #256 Option 1 — auto-resolve EACH routed Lambda's own `Role` (from the template's literal-ARN `Properties.Role`, or from `--from-cfn-stack` state for intrinsic-valued roles) and STS-AssumeRole that ARN per-Lambda. Slightly slower boot (N STS calls instead of 0) but the right shape when each routed Lambda's deployed role differs. Mutually exclusive with `--assume-role <arn>` (global default) on the global slot; combining them errors at boot. Compatible with `--assume-role <LogicalId>=<arn>` per-Lambda overrides (the map wins for named Lambdas, auto-resolve handles the rest). Misses (no literal ARN in the template AND no state loaded for the routed stack) warn-and-fall-through to dev creds for that one Lambda. |
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
| `--env-vars <file>` | unset | SAM-shape JSON overlay. Top-level keys are container names (`ContainerDefinitions[].Name`); `Parameters` is a global overlay. Overrides ECS `Secrets[]`-sourced values too (the secret is still fetched first, then replaced). When pointing a container at a tunneled VPC resource (e.g. an Aurora cluster reached via a local port forward), use `host.docker.internal` instead of `127.0.0.1` — `127.0.0.1` inside the container is the container itself, not the host. Same shape as `cdkl invoke --env-vars`. |
| `--container-host <ip>` | `127.0.0.1` | Bind IP for `PortMappings` published ports. Must be a numeric IP — Docker rejects hostnames in `-p <ip>:<port>:<port>`. |
| `--host-port <containerPort=hostPort>` | — | Publish a container port on a specific host port (e.g. `80=8080`); repeatable. Default: host port == container port. Map a privileged container port (< 1024) to a non-privileged host port to avoid macOS Docker Desktop's admin-password prompt. |
| `--assume-task-role [<arn>]` | unset | **Deprecated alias of `--assume-role`** (both forms accepted; `--assume-role` wins when both are passed and emits a one-time deprecation warn when only the legacy form is set). Bare flag uses the task definition's `TaskRoleArn`. Resolves a flat-string ARN directly; for `{Ref: <Role>}` / `{Fn::GetAtt: [<Role>, 'Arn']}` against a same-stack `AWS::IAM::Role`, cdk-local substitutes the caller's account id (via STS `GetCallerIdentity`) into `arn:aws:iam::<account>:role/<RoleLogicalId>`. Pass an explicit ARN to override. Either way, `sts:AssumeRole` runs once at startup; the resulting creds are exposed via the local metadata sidecar at `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. |
| `--assume-role [<arn>]` | unset | Cross-command alias for `--assume-task-role` matching the same flag on `invoke` / `invoke-agentcore` / `start-api`. Same three-form grammar and the same `sts:AssumeRole`-via-metadata-sidecar semantic. Issue #249 / C6 — non-breaking superset of the legacy name. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `ListStackResources` and substitute `Ref` / `Fn::ImportValue` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI. Bare form uses the CDK stack name; pass an explicit value when the CFn stack name differs. `Fn::GetAtt` is warn-and-dropped in v1. See [Env / Secrets substitution](#env--secrets-substitution---from-cfn-stack) below. |
| `--stack-region <region>` | — | Region of the state record to read. Drives the CFn client region for `--from-cfn-stack`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--no-build` | off | Skip `docker build` on every CDK-asset container (use the previously-built deterministic tag). Requires the tag to already be in the local registry; errors with an actionable message when missing. No-op for ECR-pull / public-registry containers. Same semantics as `cdkl invoke --no-build`. Compatible with `--no-pull`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR for cross-account / centralized registry pulls. Issues `sts:AssumeRole` via the CLI's resolved credentials (honoring `--profile`) and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull` on every container whose `Image` resolves to an `<acct>.dkr.ecr.<region>.amazonaws.com/...` URI. Required when the caller does not have direct cross-account access. Same-account / same-region pulls do not need this flag. No-op when `--no-pull` is set. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | `linux/amd64` or `linux/arm64`. Threaded into every container's `docker run --platform`. |
| `--keep-running` | off | Don't `docker rm -f` user containers on task exit (network + sidecar are still torn down). Use when you want to `docker exec` into a stopped container for post-mortems. |
| `--detach` | off | Start the containers and return without streaming logs or auto-tearing them down. Useful in CI smoke tests; caller manages container lifecycle. |
| `--image-override <target=dockerfile or dockerfile>` | — | Rebuild the task definition's pinned (deployed-registry) container image from a local `docker build` of the supplied Dockerfile, then run that locally-built image instead of pulling the pinned one. A task definition has ONE override target (its representative essential container), so an explicit `<target>=<dockerfile>` maps to it (a bare `<dockerfile>` works too — but the bare picker form needs a TTY and is skipped under `--no-interactive-overrides` / non-interactive runs, so prefer the explicit form when scripting). Lets `--from-cfn-stack` still reach real AWS state for env / secrets while you iterate on the application container locally. A pinned-but-uncovered image WARNs that local source edits will not take effect. Same engine as `start-service` / `start-alb`. |
| `--image-build-arg <KEY=VAL>` | — | `docker build --build-arg KEY=VAL` applied to the `--image-override` build (repeatable). |
| `--image-build-secret <id=src>` | — | `docker build --secret id=<id>,src=<src>` applied to the `--image-override` build (repeatable); enables `RUN --mount=type=secret,id=<id>` in the Dockerfile. |
| `--image-target <stage>` | — | `docker build --target <stage>` for the `--image-override` build (stop at an intermediate multi-stage stage). |
| `--no-interactive-overrides` | off | Suppress the interactive boot prompt that asks for a Dockerfile when the image is pinned (use in CI / scripted runs). |
| `--strict-overrides` | off | Fail fast when the pinned image stays uncovered after `--image-override` resolves. |

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

Every replica booted in one CLI invocation joins ONE shared docker
network (`<cluster>-svc-<rand>`, subnet `169.254.171.0/24`, with the
metadata-endpoint sidecar at `169.254.171.2`) so peer services reach
each other by container IP / network alias without `docker network
connect` choreography. (`cdkl run-task` differs — it uses a per-task
network on `169.254.170.0/24`.)

When two or more `<targets>` are supplied, every service is booted into
a shared Cloud Map / Service Connect registry on that one network so peer
services discover each other via a `docker --add-host` DNS overlay.

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
> from `docker inspect`. To reach an **ALB-fronted** service the way
> external traffic does — a single stable host endpoint that round-robins
> across the replicas — run [`cdkl start-alb`](#cdkl-start-alb-run-an-alb-fronted-service-locally)
> (name the ALB) instead; `start-service` itself is a pure replica runner
> and opens no front-door.
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
| `--assume-task-role [arn]` | unset | **Deprecated alias of `--assume-role`** (both forms accepted; `--assume-role` wins when both are passed and emits a one-time deprecation warn when only the legacy form is set). Assume the task definition's `TaskRoleArn` (or the supplied ARN) and forward STS-issued temp credentials via the metadata sidecar so every replica's containers run with the deployed task role. Same three-form grammar as `cdkl run-task`. |
| `--assume-role [arn]` | unset | Cross-command alias for `--assume-task-role` matching the same flag on `invoke` / `invoke-agentcore` / `start-api`. Same three-form grammar and the same `sts:AssumeRole`-via-metadata-sidecar semantic. Issue #249 / C6 — non-breaking superset of the legacy name. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before ECR `docker pull` for cross-account / centralized registries. Same shape as `cdkl run-task`. |
| `--platform <platform>` | inferred | Force `--platform linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--no-build` | off | Skip `docker build` on every CDK-asset container (use the previously-built deterministic tag). Requires the tag to already be in the local registry; errors when missing. No-op for ECR-pull / public-registry containers. Same semantics as `cdkl run-task --no-build`. Compatible with `--no-pull`. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `ListStackResources` and substitute `Ref` / `Fn::ImportValue` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI. Bare form uses the CDK stack name (per target when multiple `<targets...>` are supplied). `Fn::GetAtt` is warn-and-dropped in v1. Same shape as `cdkl run-task --from-cfn-stack`. |
| `--stack-region <region>` | — | Region of the state record to read. Drives the CFn client region for `--from-cfn-stack`. |
| `--watch` | off | Hot reload: re-synth + per-replica rolling deploy when the CDK app's source changes (mirrors `cdkl start-api --watch` semantics; honors `cdk.json` `watch.include` / `watch.exclude`). Each replica is rolled one at a time — boot a shadow replica with the new image under a bumped generation suffix, wait for a TCP-ready probe on the container port, atomically swap Service-Connect / Cloud Map registrations, then retire the old container — so peer services see zero connection refusals across the reload even on multi-replica services. Synth failures keep the previous replica(s) serving (warn-and-continue). Off by default. |
| `--no-logs` | off | Disable foreground streaming of each replica container stdout/stderr. By default every booted replica streams its docker logs to the host terminal with a `[svc=<service> r=<replica-index> c=<container>]` prefix, matching `cdkl run-task`'s log surface (so application `console.log` calls are visible without a side `docker logs -f`). Pass `--no-logs` for multi-replica / multi-service runs whose interleaved log volume is unreadable; `docker logs -f <id>` in a separate terminal stays available. |

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

### ALB front-door

`start-service` is a pure compute runner and opens no load-balancer
front-door. To reach an ALB-fronted service the way external traffic does,
run [`cdkl start-alb`](#cdkl-start-alb-run-an-alb-fronted-service-locally)
and name the ALB.

### `cdkl start-service` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, target not an ECS Service,
  network creation failed) OR uncaught exception during the run.
- `130` — exited via SIGINT (`^C`).

## `cdkl start-alb` (run an ALB-fronted service locally)

`cdkl start-alb <targets...>` is the ALB counterpart of `cdkl start-api`:
you name the **Application Load Balancer**, and cdk-local discovers the
ECS service(s) behind its HTTP and HTTPS listeners, boots their replicas
(the same shared docker network + Cloud Map + restart watcher as
`start-service`), and stands up a host-side **front-door** on each
listener port that round-robins each request across the running replicas
— one stable host endpoint, like behind a real load balancer. The
front-door applies the listener's rules across all six ALB condition
fields — **`path-pattern`**, **`host-header`**, **`http-header`**,
**`http-request-method`**, **`query-string`**, and **`source-ip`** — so
one host port can route across several backing services (e.g. `/api/*`
or `api.example.com` or `X-Tenant: acme` or `POST` writes or `?version=2`
or a `10.0.0.0/8` source range to one service, the default to another)
the way the deployed ALB does — including **weighted** forwards and
**`redirect` / `fixed-response`** actions.

`start-service` vs `start-alb` mirrors `invoke` / `run-task` (the compute
alone) vs `start-api` (the routed entry in front of the compute). Use
`start-service` for an ECS service with no load balancer (workers, queue
consumers, Service-Connect-only services) or to run the containers and
hit them directly; use `start-alb` for an `ApplicationLoadBalancedFargateService`-style
service you want to reach the way external traffic does.

### Resolution model

`start-alb` resolves the ALB you name → its
`AWS::ElasticLoadBalancingV2::Listener`s (matched by `LoadBalancerArn`) →
each listener's default action **and** its
`AWS::ElasticLoadBalancingV2::ListenerRule`s (any of the six ALB condition
fields: `path-pattern`, `host-header`, `http-header`,
`http-request-method`, `query-string`, `source-ip`) → each `forward`
action's `AWS::ElasticLoadBalancingV2::TargetGroup`(s) → either the
`AWS::ECS::Service` whose `LoadBalancers[]` references that target group (a
reverse scan — there is no direct TG → service pointer) or, for a
`TargetType: lambda` group, the backing `AWS::Lambda::Function` it targets.
The front-door for a listener port holds a routing table: each request is
matched against the rules in `Priority` order (lower number first; ALB
`*` / `?` glob for path / host / header / query-string conditions; exact
case-sensitive uppercase match for `http-request-method`; CIDR match for
`source-ip`), falling back to the default action; an unmatched request
with no default action returns 404. A `redirect` / `fixed-response` action
is synthesized directly; a weighted `forward` picks a target group by
weight. Each booted
replica publishes its target container port on an **ephemeral** host port
(so N replicas never collide), and the front-door forwards to those —
cross-platform, since traffic goes through published ports rather than
docker-network IPs the host can't reach on macOS Docker Desktop.

### Target resolution

- `Stack/Alb` (display path) or `Stack:LogicalId`; single-stack apps may
  omit the stack prefix. Omit `<targets>` in a TTY to multi-select.
- The target MUST resolve to an application
  `AWS::ElasticLoadBalancingV2::LoadBalancer` (NLBs are skipped).

### Options

Same option set as `cdkl start-service` (`--cluster`, `--max-tasks`,
`--restart-policy`, `--env-vars`, `--container-host`, `--assume-task-role`,
`--ecr-role-arn`, `--platform`, `--no-pull`, `--no-logs`, `--from-cfn-stack`,
`--stack-region`, `--watch`, plus the [common flags](#common-flags)),
except `--host-port` is replaced by the front-door flags below.

| Flag | Default | Behavior |
| --- | --- | --- |
| `--lb-port <listenerPort=hostPort>` | — | Bind the front-door on a specific host port (e.g. `80=8080`); repeatable. Default: host port == ALB listener port. Remap a privileged listener port (< 1024) to a non-privileged host port on macOS. |
| `--tls` | off | Terminate TLS locally for cloud-HTTPS listeners. Default: a cloud-HTTPS listener is served over plain HTTP locally (with `X-Forwarded-Proto: https` preserved so the upstream app still sees the deployed listener protocol). Implied by `--tls-cert` / `--tls-key`. Use this when local-dev cookies need `Secure` / `SameSite=None`, when the upstream app inspects TLS metadata, or for mTLS / SNI testing — otherwise plain HTTP is friendlier (no self-signed cert warnings in `curl` / browser). |
| `--tls-cert <path>` | unset | PEM-encoded server certificate for HTTPS front-door listeners. Implies `--tls`. Must be set together with `--tls-key`. Pass `--tls` alone (without `--tls-cert` / `--tls-key`) to auto-generate a self-signed cert (cached under `$XDG_CACHE_HOME/cdk-local/alb-https/`, defaulting to `~/.cache/cdk-local/alb-https/`); requires `openssl` on PATH. The deployed Listener `Certificates[]` are NOT fetched — ACM private keys are not retrievable by design. |
| `--tls-key <path>` | unset | PEM-encoded server private key matching `--tls-cert`. Implies `--tls`. Must be set together with `--tls-cert`. |
| `--no-verify-auth` | (verify enabled) | Disable local enforcement of `authenticate-cognito` / `authenticate-oidc` actions. Every request is served as if the guard passed. Useful for local dev that does not want to mint a Bearer token. |
| `--bearer-token <jwt>` | unset | Default Bearer JWT this command **injects only when missing** as the receiving local ALB front-door — `cdkl start-alb` accepts outside-in requests, so this token is the fallback slotted into `Authorization: Bearer <jwt>` if the caller did not already supply one. Verified against the same JWKS / OIDC discovery URL the deployed ALB would (signature + `iss` + `aud` + `exp`). Cookie pass-through (`AWSELBAuthSessionCookie-*`) also bypasses the guard. Contrast with `cdkl invoke-agentcore --bearer-token` where the role flips: that command is the outbound caller and always presents this token (the supplier). |
| `--watch` | off | Hot reload: re-synth + per-replica rolling deploy of every ECS service behind the ALB when the CDK app's source changes (mirrors `cdkl start-service --watch` semantics; honors `cdk.json` `watch.include` / `watch.exclude`). Each replica is rolled one at a time — boot a shadow under a bumped generation suffix, wait for a TCP-ready probe on the container port, atomically register it in the front-door pool, then drop the old entry and retire the old container — so a continuous external request stream against the listener port sees zero connection refusals across the reload. The host front-door (TLS materials, JWKS cache, Lambda-target containers, listener sockets) stays up across the reload; only the per-replica pool entries rotate. Lambda target groups behind the ALB are a no-op on reload (the warm RIE container keeps its boot-time image). Synth failures keep the previous replica(s) serving (warn-and-continue). Off by default. |

```bash
# ALB listener on :80 -> remap to a non-privileged host port on macOS
cdkl start-alb MyStack/WebAlb --lb-port 80=8080
# then: curl http://127.0.0.1:8080/  (round-robins across replicas)

# Cloud-HTTPS listener on :443 served over plain HTTP locally (default)
cdkl start-alb MyStack/WebAlb --lb-port 443=8443
# then: curl http://127.0.0.1:8443/
# (the upstream app still sees X-Forwarded-Proto: https)

# Opt in to real TLS termination with an auto-generated self-signed cert
cdkl start-alb MyStack/WebAlb --lb-port 443=8443 --tls
# then: curl --insecure https://127.0.0.1:8443/

# Opt in to real TLS with a BYO cert (must be set together; implies --tls)
cdkl start-alb MyStack/WebAlb --tls-cert ./server.pem --tls-key ./server-key.pem

# Authenticate-cognito: inject a pre-minted JWT as the default Authorization
cdkl start-alb MyStack/WebAlb --bearer-token "$(aws cognito-idp ... | jq -r .AuthenticationResult.IdToken)"
# or skip the auth check entirely for local dev
cdkl start-alb MyStack/WebAlb --no-verify-auth
```

### Scope

**HTTP** and **HTTPS** listeners with **ECS** and **Lambda** targets, with
priority-ordered listener rules matching every ALB condition field —
`path-pattern` and `host-header` (ALB `*` / `?` glob; host case-insensitive,
path-only excludes the query string), `http-header` (case-insensitive name
lookup + case-insensitive value glob), `http-request-method` (exact uppercase
match, no wildcards), `query-string` (`{ Key?, Value }` globs, case-insensitive,
percent / `+` decoded), and `source-ip` (IPv4 / IPv6 CIDR; IPv4-mapped IPv6
source addresses are unmapped before matching). Both default actions and rule
actions support single-target `forward`, **weighted** (multi-target) `forward`
(weighted-random selection; weight 0 never selected; a forward may mix ECS
and Lambda targets), `redirect` (301 / 302 with the
`#{protocol|host|port|path|query}` placeholders resolved against the
request — `#{protocol}` defaults to the listener's own scheme), and
`fixed-response` (synthesized status / content-type / body). A
`TargetType: lambda` target group invokes the backing Lambda locally — the
request becomes the ALB `requestContext.elb` event, runs through the Lambda RIE,
and the response is translated back (a malformed response → 502).

Cloud-HTTPS listeners are served over plain HTTP locally by default. The
listener-rule pipeline (path / host / header / method / query / source-ip
matching, weighted forwards, redirect / fixed-response, `authenticate-*`
gating, WebSocket upgrades) does not depend on TLS, and the ALB itself owns
TLS termination at the edge — the container behind it speaks plain HTTP in
either world. `X-Forwarded-Proto` is stamped as `https` for these listeners
(and the redirect `#{protocol}` default resolves to `https`) so the upstream
app still observes the deployed listener protocol. A warning lists each
cloud-HTTPS listener that is being served as HTTP locally so the degradation
is never silent.

Pass `--tls` (or `--tls-cert` / `--tls-key`, which imply `--tls`) to opt in to
real TLS termination locally. Under `--tls` the front-door uses the
user-supplied cert pair, or an auto-generated self-signed cert cached under
`~/.cache/cdk-local/alb-https/` when neither is supplied. The deployed
Listener's `Certificates[]` ACM ARNs are not fetched — ACM private keys are
not retrievable by design, so the local front-door always uses its own cert.
Clients should use `curl --insecure` (or trust the generated cert). The
`SslPolicy` cipher policy is not enforced; the upstream is dialed over plain
HTTP (TLS terminated at the front-door, not re-encrypted).

`authenticate-cognito` and `authenticate-oidc` actions are enforced locally
with a Bearer-JWT check — the same `iss` + `aud` + `exp` + signature pipeline
`cdkl start-api`'s JWT authorizers use, against either the Cognito direct
JWKS URL (`AuthenticateCognitoConfig.UserPoolArn` is split into `<region>` +
`<userPoolId>`) or the OIDC `Issuer`'s discovery URL. Missing / invalid token
answers `401 Unauthorized` with a `WWW-Authenticate: Bearer realm="..."`
header. `--bearer-token <jwt>` injects a default token when the inbound
request has none — handy for `curl` against a `cdkl start-alb` boot. The
deployed ALB also accepts an already-signed-in browser via the
`AWSELBAuthSessionCookie-*` cookie; the local front-door treats the presence
of that cookie as a pass-through (no JWT check) so a browser session that
authenticated through the cloud ALB keeps working against the local
front-door. `--no-verify-auth` disables every guard on the listener (every
request passes). `UserPoolArn` / `Issuer` / `ClientId` MUST be literal
strings in the synthesized template — a `Ref` / `Fn::GetAtt` / cross-stack
intrinsic in any of those fields drops the guard with a warning, and the
terminal action then serves unguarded.

**JWKS / OIDC discovery unreachable → token accepted without verification.**
When the upstream JWKS endpoint (Cognito) or OIDC discovery URL is
unreachable, the verifier falls back to pass-through accept (every Bearer
token is accepted) to keep local dev iterating through transient network
glitches / VPN drops / proxy outages — the same trade-off `cdkl start-api`
makes for unreachable Cognito JWKS. The fallback emits a `warn` line
naming the unreachable URL and re-emits it every 5 minutes per URL (#247).
A long-running `cdkl start-alb --watch` session therefore keeps surfacing
the degraded-auth state every 5 minutes rather than silently accepting
tokens for the rest of the run after the first warn fires. Do NOT rely on
this fallback in any shared environment — the dev machine accepts every
token, including forged ones.

**WebSocket `Upgrade`** is proxied for ECS forward targets. The inbound
upgrade request goes through the same `route()` callback as a regular
HTTP request, so listener rules (path / host / header / method /
query-string / source-ip) AND auth gates apply identically before the
upgrade is accepted. After matching, the client's raw TCP socket is
bridged to the picked replica with `Upgrade` / `Connection: Upgrade` /
`Sec-WebSocket-*` headers preserved verbatim (RFC 7230 marks `Upgrade`
as hop-by-hop, but the proxy MUST forward it for the handshake — nginx
/ haproxy / ALB all do). `X-Forwarded-For` / `X-Forwarded-Proto` /
`X-Forwarded-Port` are stamped. A Lambda target group answers `502`
on upgrade (mirrors ALB itself — Lambda TGs do not support WebSocket).
A `redirect` / `fixed-response` action answers with a regular HTTP/1.1
response over the raw socket (no upgrade), matching how a browser's WS
client surfaces such responses.

Out of scope:

- The full OAuth roundtrip (redirect to the IdP's authorize endpoint,
  callback, AWSELBAuthSessionCookie issuance) is NOT reproduced. The local
  front-door accepts a Bearer JWT or an already-issued session cookie; it
  does not mint one. To exercise the deployed sign-in flow, hit the
  deployed ALB once and reuse the cookie locally.
- ALB Mutual TLS (`MutualAuthentication.Mode: verify`) — tracked separately.
- Sticky sessions (`stickiness.enabled`) — round-robin only.
- gRPC / HTTP/2 target groups (`ProtocolVersion: GRPC` / `HTTP2`) — the
  front-door is HTTP/1.1 only.
- Health-check probes (`HealthCheckPath` / `Matcher`) — the pool is naive
  and does not gate draining on health.

The local front-door binds the request's `socket.remoteAddress` as the
source IP, so a `source-ip` CIDR narrower than `127.0.0.0/8` will not match
traffic that comes in on `127.0.0.1` — exercise such rules from a real
remote, or use a permissive loopback CIDR for local smoke tests.

### `cdkl start-alb` exit codes

- `0` — front-door + services started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, target not an application ALB, no
  frontable ECS service behind it, port bind failure) OR uncaught exception.
- `130` — exited via SIGINT (`^C`).

## `cdkl start-cloudfront` (serve a CloudFront distribution locally)

`cdkl start-cloudfront <target>` reproduces a CloudFront distribution's
**viewer-request → origin → viewer-response** pipeline on a local HTTP
(or HTTPS) server, so a URL-rewrite / routing / SPA-fallback change is
verifiable in seconds instead of a deploy. A CloudFront Function is your
own application compute — a few lines of rewrite JS — and this command
runs it wired to the actual origin content (default root object, the
real keys, index / error-page fallback), which is exactly the end-to-end
connection a unit test of the function alone cannot exercise.

Two origin kinds are served:

- an **S3 origin** — the static-site / SPA shape; the functions run
  in-process and the origin content is served from local files (the
  BucketDeployment source asset; no Docker). When there is no local
  BucketDeployment source — the front/back-split case where the CDK repo
  defines the distribution + bucket but the static files are uploaded out
  of band by a separate frontend repo / pipeline — `--from-cfn-stack`
  resolves the deployed bucket's name from state and serves it by reading
  from **real S3 on demand** (a request-time `GetObject` per touched key,
  no pre-sync, so a large CDN bucket is fine);
- a **Lambda Function URL origin** (`origins.FunctionUrlOrigin`) — the
  backing Lambda is your own application compute, run locally in a real
  RIE container (the same machinery `cdkl invoke` uses) and invoked with
  the Function URL request/response shape, so a CDN-fronted Lambda (SSR /
  API behind CloudFront) is testable end to end. A pure-S3 distribution
  needs no Docker; a Function URL origin boots one Lambda container.

It does NOT emulate the managed CloudFront service: other custom (non-S3,
non-Function-URL) origins and the 2.0 `cf.fetch` origin API are out of scope
(warn-and-skip; a request routed to one returns 502). A behavior's
**Lambda@Edge** functions (`LambdaFunctionAssociations`) ARE run — each is
real Lambda code, booted in a real RIE container and invoked at its event
point (see the Lambda@Edge resolution bullet below). A CloudFront Function's
**KeyValueStore** reads (`cf.kvs().get(key)`) ARE reproduced — backed by the
deployed store (`--from-cfn-stack`) or a local JSON map (`--kvs-file`); see the
KeyValueStore resolution bullet below. A Function URL origin
Lambda gets the **same container environment as a direct `cdkl invoke`**:
its declared `Environment.Variables` are injected, `--from-cfn-stack [name]`
substitutes intrinsic env values against a deployed stack, and
`--assume-role [arn]` injects the deployed execution role's STS credentials
(see the options table). Without a state-source flag the dev shell's
credentials are forwarded and intrinsic env values are dropped (warn-per-key),
matching `cdkl invoke`. `AWS_IAM` auth on the Function URL is not enforced
locally and response streaming is invoked buffered.

### Resolution model

`start-cloudfront` resolves the distribution you name →
its `DistributionConfig`:

- **Behaviors** — `DefaultCacheBehavior` + each `CacheBehaviors[]` entry.
  A request is matched against the `CacheBehaviors[]` path patterns (the
  ALB `*` / `?` glob) in declared order, falling back to the default
  behavior.
- **CloudFront Functions** — each behavior's `FunctionAssociations[]`
  (`{Fn::GetAtt: [<fn>, FunctionARN]}`) → the `AWS::CloudFront::Function`'s
  inline `FunctionCode`, compiled once and run per request in a `node:vm`
  sandbox (`cloudfront-js-1.0` / `2.0`; async handlers awaited). A
  viewer-request function returning a `statusCode` short-circuits with a
  generated response (redirect / fixed body); otherwise the rewritten
  request continues to the origin. A viewer-response function then runs
  over the origin response. The sandbox reproduces the
  CloudFront-Functions-2.0 runtime built-ins a bare `node:vm` lacks — the
  `Buffer`, `atob` / `btoa`, `TextEncoder` / `TextDecoder` globals and a
  `require` for the `crypto` / `querystring` / `buffer` modules (Node-backed)
  — so a function that uses, e.g., `Buffer.from(...).toString('base64')` for a
  Basic-Auth check runs locally instead of failing with `Buffer is not
  defined`. `fs` / `process` / timers / network / `eval` are not provided as
  globals (a `ReferenceError`, matching the restricted runtime); the vm is a
  fidelity sandbox, not a security boundary (moot — the function is your own
  code run locally).
- **Lambda@Edge** — each behavior's `LambdaFunctionAssociations[]`
  (`{EventType, LambdaFunctionARN, IncludeBody}`) → the
  `AWS::Lambda::Function` behind the association's `AWS::Lambda::Version`,
  booted once in a warm RIE container (the same machinery a Lambda Function
  URL origin uses — same `cdkl invoke` container env). The function is
  invoked at its event point with the Lambda@Edge event
  (`{ Records: [{ cf: { config, request, response } }] }`). All four event
  types run in pipeline order: `viewer-request` / `origin-request` (before
  the origin fetch — either may short-circuit with a generated `response` or
  rewrite the `request` — `uri` / `method` / `headers` / `querystring` /
  body) → origin → `origin-response` / `viewer-response` (modify the
  response `status` / `headers` / body). `IncludeBody` surfaces the request
  body (base64). Out of scope: the `request.origin` rewrite block (the local
  origin is fixed by the resolved behavior) and the edge size / timeout
  tiers. An imported / cross-region `EdgeFunction` ARN that does not resolve
  to a local `AWS::Lambda::Function` is warn-and-skipped.
- **KeyValueStore (`cf.kvs()`)** — a 2.0 function that opens with
  `import cf from 'cloudfront'` and reads `cf.kvs().get(key)` / `exists(key)`
  is run with that `import` stripped and a `cf` module injected into the
  sandbox. Each read is served by one of two bindings:
  - **`--from-cfn-stack`** — the function's
    `FunctionConfig.KeyValueStoreAssociations[].KeyValueStoreARN` resolves to
    the deployed `AWS::CloudFront::KeyValueStore` (its physical id from
    `ListStackResources` is the store NAME, looked up to its ARN via the
    control-plane `ListKeyValueStores`), and the read hits the real
    `cloudfront-keyvaluestore` `GetKey` data-plane API. The deployed store's
    data is read live — exactly like a Lambda reaching a real managed service.
  - **`--kvs-file <kvsLogicalId>=<file.json>`** — a local
    `{ "key": "value" }` map backs the reads with no AWS (the AWS-free escape
    hatch, symmetric with `--origin`). The key is the
    `AWS::CloudFront::KeyValueStore` resource logical id (named in the boot
    warning when a read is unbound).

  A read with neither binding fails with an actionable error naming both
  flags. `cf.kvs().meta()` / `count()` and KVS writes are not reproduced.
- **CORS (ResponseHeadersPolicy)** — a behavior's `ResponseHeadersPolicyId`
  → the `AWS::CloudFront::ResponseHeadersPolicy`'s `CorsConfig` is
  reproduced at the edge, per behavior. A matching `OPTIONS` preflight is
  answered with the canonical `204` + `Access-Control-Allow-*` headers
  before the origin is hit; an actual response gets
  `Access-Control-Allow-Origin` (+ `Vary: Origin` / `Allow-Credentials` /
  `Expose-Headers`) added last, mirroring `CorsConfig.OriginOverride`. This
  is what makes a browser fetch from an allowed origin work locally when
  CORS is owned by CloudFront (not by the origin Lambda / S3). Origin
  matching is literal-or-`*` — a wildcard-subdomain entry
  (`https://*.example.com`) is not matched, and an AWS-managed policy id
  (a literal, not a `{Ref}` to a local policy) cannot be fetched so its
  CORS is skipped. The CORS headers are always applied last, so
  `CorsConfig.OriginOverride: false` is not distinguished from `true`
  (an origin that emits its own `Access-Control-Allow-Origin` is still
  overridden locally). The policy's non-CORS sections
  (`SecurityHeadersConfig` / `CustomHeadersConfig` / `RemoveHeadersConfig` /
  `ServerTimingHeadersConfig`) are not applied.
- **S3 origin → local content** — the behavior's `TargetOriginId` → the
  origin's bucket (`{Fn::GetAtt: [<bucket>, RegionalDomainName]}`) → the
  `Custom::CDKBucketDeployment` custom resource whose
  `DestinationBucketName` is that bucket → its `SourceObjectKeys` → the
  staged asset directory in the cloud assembly (the same files that would
  be uploaded). `DefaultRootObject` is applied at `/` only — CloudFront
  does NOT auto-index sub-paths (that is what a rewrite function does).
  `CustomErrorResponses` (e.g. `403 → /index.html`) provide the SPA
  fallback for a missing key.
- **S3 origin → deployed bucket (real S3)** — when the above finds NO
  local BucketDeployment source (the front/back-split case: files uploaded
  out of band), `--from-cfn-stack` resolves the origin's bucket NAME and the
  origin is served by reading the **deployed bucket from real S3 on demand**.
  The bucket name is resolved in priority order: a same-stack CDK bucket's
  physical id from `ListStackResources`; else a literal bucket name parsed
  from the origin's `DomainName` (an external / imported-by-name bucket whose
  domain is `<bucket>.s3...amazonaws.com`); else — when the name is a pure
  intrinsic (a `Ref` parameter / cross-stack import) — from the deployed
  distribution via `cloudfront:GetDistributionConfig`. The read itself is a
  request-time `GetObject`
  per touched key — no pre-sync, so a CDN bucket with 100k objects is fine;
  the fetched bytes live only in memory for that one request). The same
  URI→key / `DefaultRootObject` / `CustomErrorResponses` resolution applies
  — only the byte source changes from a local file to S3. Selection is
  automatic per origin: a local BucketDeployment source wins (your latest
  in-repo edits), else this deployed-S3 path under `--from-cfn-stack`, else
  the `--origin <id>=<dir>` override. An `AccessDenied` (an OAC-locked
  bucket the dev credentials cannot read) warns once with the `--origin`
  escape hatch. Reads use the `--profile` / default credential chain; the
  S3 readers are boot-time only (re-applied to a `--watch` reload, not
  rebuilt). By default every request re-reads (always current); `--cache-origin`
  opts into an in-memory read-through cache of fetched objects for the session,
  cleared on each `--watch` reload.
- **Lambda Function URL origin → local invoke** — the origin's
  `DomainName` (`{Fn::Select: [2, {Fn::Split: ['/', {Fn::GetAtt: [<url>,
  FunctionUrl]}]}]}`) → the `AWS::Lambda::Url` → its `TargetFunctionArn`
  (a `Ref` or `{Fn::GetAtt: [<fn>, Arn]}`) → the backing
  `AWS::Lambda::Function`. One warm RIE container per backing function is
  booted at start-up (only when such an origin exists) and stopped on
  shutdown. A request routed there is translated into a Function URL
  (payload v2.0) event, invoked, and the response (status / headers /
  body / `cookies`) becomes the origin response — the viewer-response
  function still runs over it. The container is boot-time only: a `--watch`
  reload re-synths the viewer functions + S3 origins but does NOT rebuild
  it (restart to pick up a new Function URL origin or a code change).

### Target resolution

- `Stack/Dist` (display path), an ancestor prefix, or `Stack:LogicalId`;
  single-stack apps may omit the stack prefix. Omit `<target>` in a TTY to
  pick interactively.
- The target MUST resolve to an `AWS::CloudFront::Distribution`. One
  distribution per invocation.

### Options

On top of the [common flags](#common-flags):

| Flag | Default | Behavior |
| --- | --- | --- |
| `--port <port>` | `0` (auto-allocate) | Host port for the local server. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--origin <originId=dir>` | — | Point a distribution origin at a local directory (repeatable). Use when cdk-local cannot resolve the origin's BucketDeployment source automatically AND you do not want the deployed-S3 read-through (content uploaded out of band, or a non-CDK bucket). Wins over both the BucketDeployment source and the `--from-cfn-stack` deployed-S3 path. |
| `--kvs-file <kvsLogicalId=file.json>` | — | Back a CloudFront Function's KeyValueStore reads (`cf.kvs().get()`) with a local JSON map (repeatable). The key is the `AWS::CloudFront::KeyValueStore` resource logical id; the file is a flat `{ "key": "value" }` object path. The AWS-free alternative to `--from-cfn-stack`, which instead reads the deployed store via `GetKey`. |
| `--tls` | off | Terminate real HTTPS. Uses `--tls-cert` / `--tls-key` when supplied, else an auto-generated self-signed cert (cached under `$XDG_CACHE_HOME/cdk-local/alb-https/`; requires `openssl` on PATH). Implied by `--tls-cert` / `--tls-key`. |
| `--tls-cert <path>` | unset | PEM server certificate. Implies `--tls`; must be set with `--tls-key`. |
| `--tls-key <path>` | unset | PEM server private key matching `--tls-cert`. Implies `--tls`; must be set with `--tls-cert`. |
| `--no-pull` | off | Skip `docker pull` for a Lambda Function URL origin's base image (use the locally cached image). No effect on a pure-S3 distribution. |
| `--from-cfn-stack [name]` | off | Bind to a deployed CloudFormation stack (`ListStackResources`). Serves an S3 origin that has NO local BucketDeployment source from its deployed bucket, read from real S3 on demand (the front/back-split case — see the S3 origin → deployed bucket bullet above), AND resolves a Function URL origin / Lambda@Edge function's intrinsic env vars to the deployed physical IDs / exports. Bare form uses the resolved stack name; pass a value when the CFn stack name differs. Same semantics as `cdkl invoke --from-cfn-stack`. |
| `--cache-origin` | off | For a deployed-S3 origin (served from real S3 under `--from-cfn-stack`): keep fetched objects in memory for the session as a read-through cache instead of re-`GetObject`-ing on every request — faster repeat reads / fewer S3 GETs. An out-of-band S3 content change is NOT reflected until a `--watch` reload (which clears the cache) or a restart. Off by default (every request re-reads, always current). This is the local object cache, NOT CloudFront CDN / TTL caching. |
| `--stack-region <region>` | unset | Region of the state record to read; used with `--from-cfn-stack` as the CFn client region. |
| `--assume-role [arn]` | off | Assume a Function URL origin Lambda's deployed execution role and forward STS temp credentials into its container. `--assume-role <arn>` (explicit); `--assume-role` (bare, auto-resolves from state — requires `--from-cfn-stack`); `--no-assume-role` (opt out). Same semantics as `cdkl invoke --assume-role`. |
| `--watch` | off | Hot reload: re-synth + re-resolve the distribution and atomically swap the in-memory routing model when the CDK app's source changes (honors `cdk.json` `watch.include` / `watch.exclude`; `cdk.out`, `node_modules`, `.git` always excluded). The listening socket is never recreated; a synth failure keeps the previous version serving (warn-and-continue). A Function URL origin's RIE container is NOT rebuilt on reload (boot-time only). |

```bash
# Serve a static-site distribution; pick interactively in a TTY
cdkl start-cloudfront
# or name it:
cdkl start-cloudfront MyStack/SiteDist --port 8080
# then: curl http://127.0.0.1:8080/        (default root object)
#       curl http://127.0.0.1:8080/foo/    (viewer-request rewrites -> /foo/index.html)

# Iterate on the rewrite function with hot reload
cdkl start-cloudfront MyStack/SiteDist --port 8080 --watch

# Point an origin at a local build dir when the source can't be resolved
cdkl start-cloudfront MyStack/SiteDist --origin SiteOrigin=./dist

# Front/back split: no local content in this repo — serve the deployed
# bucket from real S3 on demand (resolves the bucket from the deployed stack)
cdkl start-cloudfront MyStack/SiteDist --from-cfn-stack

# Serve a distribution fronting a Lambda Function URL (boots a Lambda
# container); --no-pull reuses the cached base image
cdkl start-cloudfront MyStack/ApiDist --port 8080 --no-pull
# then: curl http://127.0.0.1:8080/        (CloudFront -> Function URL -> your Lambda)

# Back a CloudFront Function's cf.kvs().get() reads with a local JSON map
# (./routes.json is a flat { "key": "value" } file)
cdkl start-cloudfront MyStack/SiteDist --kvs-file RoutesKvs=./routes.json

# Or read the DEPLOYED KeyValueStore via the GetKey API
cdkl start-cloudfront MyStack/SiteDist --from-cfn-stack
```

### `cdkl start-cloudfront` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (target not a distribution, port bind failure,
  TLS material error) OR uncaught exception.
- `130` — exited via SIGINT (`^C`).

## `cdkl studio` (interactive web console)

`cdkl studio` is the interactive counterpart to the headless `invoke` /
`start-*` commands. It synthesizes the CDK app once, then serves a local
web console that lists every runnable target and lets you drive them from
the browser instead of the terminal. It is a control plane over the same
CLI runners: every action spawns the SAME `cdkl invoke` / `cdkl start-api`
/ `cdkl start-alb` / `cdkl start-service` the headless commands run as a
child process — there is no second execution path to keep in sync.

It takes no target argument (it lists them all). Run it from the CDK
project root:

```bash
cdkl studio                       # boot on the default port, open the browser
cdkl studio --studio-port 4000    # pin the port
cdkl studio --no-open             # do not auto-open the browser (CI / headless)
```

A **Session bar** under the header shows the read-only synth-time context
(`profile` / `region` / `app` — the target list was synthesized with them,
so they are fixed for the session) and lets you edit the run-time bindings
`--from-cfn-stack` and `--assume-role` — and the `--watch` mode — live: a
change applies to every subsequent invoke / serve started from the UI, no
restart needed (the CLI flags set the initial values).

The console is a three-pane layout:

- **Targets** — every synthesized target, grouped by command. Lambdas and
  AgentCore runtimes get an `[Invoke]` composer; `api` / `alb` / `ecs`
  serve targets get a `[Start]` / `[Stop]` control with a `running ● :port`
  indicator (an ECS service shows `running` with no port — it is pure
  compute with no host endpoint; only servable ECS *services* are runnable,
  not task definitions).
- **Workspace** — the composer for the selected target (event JSON for a
  Lambda or AgentCore invoke; start / stop for a serve). An **Options**
  section exposes the per-target run options as controls — a checkbox per
  boolean flag (e.g. ALB `--tls` / `--no-verify-auth`, an AgentCore
  runtime's `--ws` / `--sigv4`), an input per value flag (ECS
  `--max-tasks`, ALB `--bearer-token`, an AgentCore runtime's
  `--bearer-token` / `--session-id`), an add-row list for repeatable
  mappings (ALB `--lb-port`, ECS `--host-port`), and a KEY/VALUE-or-JSON
  editor for env vars (`--env-vars`). The values are passed to the spawned
  child command for that run.
- **Timeline** — a live activity feed over SSE carrying both Lambda
  invocations and captured serve requests. A started `start-api` / `start-alb`
  serve is fronted by a capture proxy, so every request to the served port
  (browser, `curl`, or app traffic alike) lands on the timeline as a
  read-only Request / Response detail with its bound logs. A log search box
  queries the session's retained log lines.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--studio-port <port>` | `9999` | Preferred port for the studio web server; bumps to the next free port on collision. |
| `--no-open` | (auto-opens) | Do not auto-open the browser when studio starts (TTY only). |
| `--from-cfn-stack [name]` | (off) | Bind the whole studio session to a deployed CloudFormation stack — every invoke / serve started from the UI runs against the stack's real ARNs / Secret values. Bare flag auto-resolves a single-stack app; pass a name to pick the stack. Forwarded to each child command. |
| `--assume-role <arn>` | (off) | IAM role ARN to assume for every invoke / serve started from the UI; the temporary credentials are forwarded into the containers. Forwarded to each child command. |
| `--stack <glob...>` | (all) | Filter the DISPLAYED targets by stack glob (a target id is `Stack/Construct`, so `dev/*` keeps stack `dev`'s targets, `dev*` any stack starting `dev`). Space-separate multiple globs (a target matching ANY is shown). **Display-only — does NOT scope synth**: the whole app is still synthesized, so gate synth itself with the app's own `-c` context / a committed `cdk.context.json`. |
| `--watch` | (off) | Spawn serves started from the UI (`start-api` / `start-alb` / `start-service`) with `--watch`, so they re-synth + rolling-reload on CDK source changes. Toggleable live from the Session bar (`PATCH /api/config`), applying to the next serve. No effect on single-shot invokes (each re-synths anyway); the target list is not re-synthed (restart studio to pick up newly-added resources). |

`--from-cfn-stack` and `--assume-role` are **session-global**: they apply
to every target you run from the UI, so they sit on `cdkl studio` itself
rather than being set per-target. `cdkl studio` also accepts the shared app
/ context / region / profile flags (`--app`, `-c key=value`, `--region`,
`--profile`, etc.) — they are threaded into the synth and into every child
runner it spawns.

Booting studio itself needs no Docker (it only synthesizes the app and
serves the UI); Docker is required the moment you invoke or serve a target
through it, because that spawns the real RIE / ECS containers.

### `cdkl studio` exit codes

- `0` — studio server started cleanly and shut down on SIGTERM.
- `1` — startup failure (synthesis error, port bind failure) OR uncaught
  exception.
- `130` — exited via SIGINT (`^C`).
