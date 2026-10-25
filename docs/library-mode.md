# Programmatic use

cdk-local exports its Commander commands as factories, so you can build
a custom CLI that adds your own state-source flags on top of the
built-in `--from-cfn-stack`.

This is the integration surface that lets a host project reuse
cdk-local's local-execution engine while plugging in its own way of
locating deployed ARNs / Secret values / IAM credentials (for example,
a CLI that reads from a custom deployment registry rather than from
CloudFormation).

```typescript
import { Command } from 'commander';
import {
  createLocalInvokeCommand,
  createLocalStartApiCommand,
  type LocalStateProvider,
  type LocalStateProviderFactory,
} from 'cdk-local';

// Register a custom state source. The key (e.g. `fromMyStore`) is the
// camel-case Commander option name your factory keys off.
const extraStateProviders: Record<string, LocalStateProviderFactory> = {
  fromMyStore: (opts) => new MyStoreStateProvider(opts),
};

const program = new Command();
program.addCommand(createLocalInvokeCommand({ extraStateProviders }));
program.addCommand(createLocalStartApiCommand({ extraStateProviders }));
program.parseAsync(process.argv);

class MyStoreStateProvider implements LocalStateProvider {
  readonly label = '--from-my-store';
  async load(stackName: string, synthRegion: string | undefined) { /* ... */ return undefined; }
  async buildCrossStackResolver(consumerRegion: string) { /* ... */ return undefined; }
  dispose() { /* close clients */ }
}
```

The dispatcher enforces mutual exclusion across `--from-cfn-stack` and
every registered extra flag, so users get one consistent error message
when they pass conflicting flags.

A registered flag reaches every state-backed path of the command it is
passed to, exactly where `--from-cfn-stack` would: on `start-cloudfront` that
is the deployed-S3 origin, KeyValueStore reads, and the Function URL origin /
Lambda@Edge container environment; on `start-alb` it is the Lambda target
groups as well as the ECS services. Your factory receives the full parsed
options bag, so it can read its own companion flags (a bucket, a prefix)
alongside the activating one.

## Synthesizing with your own synthesizer

`start-agentcore`, `start-web-function`, `start-cloudfront`, `start-service` and `start-alb` take a
`synthesizer` option. Pass one and the command synthesizes the CDK app with it,
on boot and on every `--watch` reload, instead of the built-in
`@aws-cdk/toolkit-lib` synthesizer. A host that has its own synthesis (its own
context-provider lookups, Stage enumeration) keeps every command on that one
path. Any object with a `synthesize(opts)` method that returns `{ stacks }`
fits `CdkAppSynthesizer`. Return every stack, a `cdk.Stage`'s included, with
`displayName` set to its hierarchical construct path (`MyStage/Api`): target
resolution picks a path-form target's stack by that path.

For example:

```typescript
import { createLocalStartServiceCommand, type CdkAppSynthesizer } from 'cdk-local';

const synthesizer: CdkAppSynthesizer = {
  synthesize: (opts) => mySynth({ app: opts.app, output: opts.output, context: opts.context }),
};
program.addCommand(createLocalStartServiceCommand({ extraStateProviders, synthesizer }));
```

Without it, the built-in synthesizer runs, as in `cdkl` itself.

Your synthesizer must behave like the built-in one where these commands rely on
it:

- Write the Cloud Assembly to `opts.output` (default `cdk.out`). A `--watch`
  reload reads `<output>/<stack>.assets.json` from disk, and the file watcher
  ignores only that directory (besides `cdk.out`, `node_modules` and `.git`), so an assembly written elsewhere loses
  soft-reload and can re-trigger the watcher on every synth.
- Read `opts.app` as a pre-synthesized assembly when it names an existing
  directory (`--app cdk.out`).
- Set `assetOutdir` (the app's absolute output directory) and
  `assetManifestPath` on every stack that ships assets. `assetOutdir` bounds
  every asset path the assembly supplies.

## Keep your `commander` major the same as cdk-local's

`addCommand` splices a cdk-local-built `Command` into **your** Commander
tree. Your tree then dispatches into that subcommand by calling
commander's internal methods on it, so when your project and cdk-local
resolve different commander MAJORS, the call can name a method the other
copy does not have. The failure is a `TypeError` deep inside
`commander/lib/command.js`, not a version warning, and it arrives at parse
time rather than at install time.

The break is DIRECTIONAL. It happens when YOUR commander is newer than
cdk-local's by an internal it calls: commander 13 added a
`subCommand._prepareForParse()` call to `_dispatchSubcommand`, which
commander 12 does not define. Measured with `program.addCommand(...)`
driven through `<sub> --help`, `help <sub>`, an unknown option and an
argParser option, each compared with a same-major (14 and 14) baseline:

| Your commander | cdk-local's commander | Result |
| --- | --- | --- |
| 15 | 12 | `TypeError: subCommand._prepareForParse is not a function` at `Command._dispatchSubcommand (commander/lib/command.js:1368)` on every dispatch; only `help <sub>` still renders |
| 12 | 14 | same as the baseline |
| 12 | 15 | same as the baseline |
| 15 | 14 | same as the baseline |

An older host working today is not a guarantee: the next major can add
another internal call in either direction. Depending on the same major as
cdk-local is the rule that stays safe.

Two *copies* of the SAME major are fine — commander uses `instanceof`
only for the `.option(Option)` overload and detects argParser failures by
`err.code`, so nothing depends on object identity across the boundary.

The type layer does not save you either way, and it does not fully warn
you: cdk-local's published typings import `Command` and `Option` from
`commander`, so the package enters your type graph. Commander's typings
declare no `private` / `protected` members, so the two `Command` types
are compared structurally — a NEWER `Command` is assignable where an
older one is expected (it is a superset), while the reverse is not.
Measured on that same 15-vs-12 pair: 8 errors, all of the shape
`Type 'Command' is missing the following properties from type 'Command':
saveStateBeforeParse, restoreStateBeforeParse, helpGroup, commandsGroup`.
So a mismatch may typecheck in one direction and fail in the other.

### Nothing checks this at install time

`commander` is a regular `dependency` of cdk-local. With a different major
in your project, both npm and pnpm install it SILENTLY: no error, no
warning, and two commander copies in the tree. So check it yourself:
read the `commander` range in cdk-local's `package.json`, depend on the
same major, and confirm with:

```bash
npm ls commander     # or: pnpm why commander
```

which should show ONE major.

### Why commander is not a `peerDependency`

A peer declaration is the usual way to say "the consumer supplies this",
and it was measured rather than assumed: npm 11 and pnpm 11, cdk-local's
commander declared four ways, against a host with no commander, the same
major, and an older and a newer major.

- **Non-optional peer.** npm REFUSES the install (`ERESOLVE`) for any
  other major, including the older and newer hosts in the table above
  that work. pnpm installs it with only a generic
  `Issues with peer dependencies found` line and then runs cdk-local
  itself on YOUR major, which cdk-local is not tested against.
- **Optional peer.** With no commander in the project — the plain CLI
  install, which is most users — nothing provides it and `cdkl` itself
  fails to start (`ERR_MODULE_NOT_FOUND`), under npm and pnpm alike.
- **Dependency plus optional peer.** npm stays silent, exactly as with a
  plain dependency; pnpm prints the same generic line and lets the peer
  override the dependency, again running cdk-local on your major.

None of the three turns the mismatch into a clear install-time signal,
and each costs the CLI-only users something to address a constraint only
library-mode consumers have. It is also the same direction as
go-to-k/cdkd#2861, which moved cdkd's entries out of `peerDependencies`.

## Rebranding the embedded commands

By default the factories render cdk-local's own branding into
user-visible strings and generated resource names — the `cdkl` binary
name, the `cdk-local` product name, `cdkl-*` Docker / AWS resource
identifiers, and the `/cdk-local-aws` credentials bind-mount. A host
that surfaces these commands under its own name passes an `embedConfig`
so error messages and resource names read in the host's branding
instead:

```typescript
import { createLocalInvokeCommand, type CdkLocalEmbedConfig } from 'cdk-local';

const embedConfig: CdkLocalEmbedConfig = {
  cliName: 'mytool local',      // subcommand refs: `mytool local invoke` ...
  binaryName: 'mytool',         // bare process refs: `mytool is exiting` ...
  productName: 'mytool',        // prose refs: `mytool supports ...`
  resourceNamePrefix: 'mytool-local', // docker/AWS names: `mytool-local-<id>`
  awsBindMountPath: '/mytool-aws',    // container creds bind-mount target
  envPrefix: 'MYTOOL',          // env vars: MYTOOL_APP / MYTOOL_ROLE_ARN / MYTOOL_ALLOW_SECRETS_ON_ARGV
};

program.addCommand(createLocalInvokeCommand({ extraStateProviders, embedConfig }));
```

Every field is optional and independently falls back to the cdk-local
default, so omitting `embedConfig` (or any single field) leaves native
`cdkl` behavior unchanged. Pass the same `embedConfig` to each factory
the host mounts so the branding is consistent across commands.

Two further optional fields tune the AWS_IAM SigV4 warn-message wording
for a host whose `start-api` ships a different unverifiable-signature
default than cdk-local's `warn-and-pass`:

```typescript
const embedConfig: CdkLocalEmbedConfig = {
  // ...branding fields above...
  sigV4StrictByDefault: true,            // host fails-closed by default (cdk-local default: false)
  sigV4OptFlag: '--allow-unverified-sigv4', // host's strictness flag (cdk-local default: '--strict-sigv4')
};
```

`sigV4StrictByDefault` flips the polarity of the SigV4 deny / pass warn
messages (so a fail-closed host's advice reads "pass `<flag>` to
warn-and-pass" instead of cdk-local's opt-in "remove `--strict-sigv4`
…"), and `sigV4OptFlag` substitutes the host's own flag name. They affect
only message text — the actual deny / pass decision is driven by the
`sigV4Strict` argument the host passes to `startApiServer`.

`workloadIdentity` (`'role'` | `'caller'`, default `'role'`) chooses which
identity resolves the emulated workload's inputs once `--role-arn` has
assumed a role: `'role'` runs everything as the assumed role (standalone
`cdkl`), `'caller'` keeps the role for synth, the ECR pull and a fromS3 code
bundle and resolves the workload's inputs (the container's credential
triple, secrets, `{{resolve:...}}`, `--from-cfn-stack`, literal layer ARNs,
the CloudFront engine's deployed reads) as the identity the process had
before the assume. `${AWS::AccountId}` follows where the stack
was read: the caller's account under `--from-cfn-stack`, the deploy account
(the `--role-arn` role) with a host state provider or no state source. In
caller mode the `--ecr-role-arn` / `--layer-role-arn` /
`--assume-role` hops are signed by the caller, so a target role's trust
policy must trust the caller, not only the deploy role. See
[Caller-identity mode](#caller-identity-mode-workloadidentity-caller).

### Routing cdk-local's log lines through the host's logger

By default cdk-local writes its own progress / warning lines to the console
(info and debug to stdout, warn and error to stderr). A host with its own
logger passes it as `logger`, and cdk-local hands it every line instead,
unformatted: the host decides which stream each level lands on, filters by
its own level, and formats the line. cdk-local's level changes (a command's
`--verbose`) are forwarded to it with `setLevel`, and its level reads come
from `getLevel`, so a host's `--verbose` also reaches the debug lines
cdk-local's warnings point at. Any object with `debug` / `info` / `warn` /
`error` / `setLevel` / `getLevel` fits `EmbedHostLogger`:

```typescript
setEmbedConfig({ cliName: 'mytool local', logger: myToolLogger });
```

This is what keeps a single-shot invoke's stdout payload-clean
(`mytool local invoke Fn | jq`) when the host reserves stdout for the
response. `setEmbedConfig` replaces the whole config, so pass `logger` and
`workloadIdentity` in every config you install (the factories' `embedConfig`
included); a config without `workloadIdentity` falls back to `'role'`.

cdk-local keeps its own console logger in three cases: in a process where
`CDKL_LOG_LEVEL` or `CDKL_LOG_STREAM` is set (`studio` sets them on the
children it spawns to control what reaches its LOGS panel and on which
pipe), when the host logger calls back into cdk-local's logger (no
recursion), and for any line the host logger throws on.

### Caller-identity mode (`workloadIdentity: 'caller'`)

A host whose `--role-arn` is a deploy identity sets
`workloadIdentity: 'caller'` so the emulated workload does not run as that
role. When cdk-local itself performs the assume (`--role-arn`), it records
the caller's pre-assume credentials. A host that performs the assume itself
must do the same, BEFORE it overwrites `AWS_*`:

```typescript
import { readEnvCallerCredentials, recordAssumedRole } from 'cdk-local/internal';

// `role` is the credentials returned by the host's own AssumeRole call.
recordAssumedRole(readEnvCallerCredentials(), role); // then overwrite AWS_* with the role
```

The second argument is the assumed role's own `{ accessKeyId, secretAccessKey,
sessionToken }`. `${AWS::AccountId}` follows where the stack was read: under
`--from-cfn-stack` the stack is read as the caller (CloudFormation reads only
the caller's own account), so it resolves to the caller's account; with a host
state provider or no state source it resolves to the deploy account (the
role's), so a cross-account deploy role yields the account where the stack
lives. Without the second
argument the lookup falls back to `buildStsClientConfig`: the selected profile's
account when a profile is set (the caller's account, the wrong one for a
cross-account role), else the default chain (the env, i.e. the role). So a host
that records its own assume should always pass the role triple.

The record is write-once per process (a second call throws), and it lives in
the process that assumed: a child process spawned afterwards inherits the
role's triple and no record. The host must also mirror its `--profile` flag
into `AWS_PROFILE`, because several workload sites read the profile
selection from the environment rather than from an argument.

### Shim hosts that don't use the factories

A host that re-exports cdk-local's leaf modules as shims
(`export { resolveRuntimeImage } from 'cdk-local'` etc.) but keeps its
OWN command implementations does not go through the factories, so the
factory-internal `setEmbedConfig` never fires — those bundled modules
would render cdk-local's `cdkl` defaults. Such a host calls
`setEmbedConfig` directly, once, at startup (before any shimmed module
runs — e.g. when building its local command tree):

```typescript
import { setEmbedConfig } from 'cdk-local';

setEmbedConfig({
  cliName: 'mytool local',
  binaryName: 'mytool',
  productName: 'mytool',
  resourceNamePrefix: 'mytool-local',
  awsBindMountPath: '/mytool-aws',
  envPrefix: 'MYTOOL',
});
```

`setEmbedConfig` is idempotent and installs process-wide state read by
every `getEmbedConfig()` call in cdk-local's bundle, so a single call
covers all re-exported shims. `getEmbedConfig()` reads the resolved
config and `resetEmbedConfig()` restores the defaults (test isolation).

## Low-level building blocks (shim hosts)

These live behind the dedicated `cdk-local/internal` subpath:

```ts
import { pickRefLogicalId } from 'cdk-local/internal';
```

**No semver guarantee.** Everything under `cdk-local/internal` is
implementation detail of the `cdkl` CLI and may change or be removed
without a major version bump — only the main `cdk-local` entry
documented above is semver-covered. These symbols are reachable ONLY via
`cdk-local/internal`; the main `cdk-local` entry does not re-export them.

Most hosts only need the command factories above. A host that instead
re-exports cdk-local's individual `src/local/**` modules verbatim
(rather than carrying its own byte-identical copy) can also import the
pure, dependency-free helpers those modules expose:

- `pickRefLogicalId` — extract the logical id from a `{ Ref: ... }`
  intrinsic.
- `resolveLambdaArnIntrinsic` (+ `LambdaArnResolveOutcome`) — resolve a
  Lambda ARN expressed as `Ref` / `Fn::GetAtt` / the REST-v1 invoke-ARN
  `Fn::Join` / `Fn::Sub` wrappers.
- `resolveServiceIntegrationParameters` / `resolveSelectionExpression`
  (+ `RequestParameterContext` / `ResolveParametersOutcome`) — API
  Gateway request-parameter mapping.
- `translateLambdaResponse` (+ `TranslatedHttpResponse`) — Lambda
  proxy response → HTTP response translation.
- `getContainerNetworkIp` — read a container's per-network IP via
  `docker inspect`.

The `start-api` route-resolution layer is exposed on the same basis —
pure functions over a synthesized Cloud Assembly that the local HTTP
server runs on:

- `discoverRoutes` (+ `DiscoveredRoute` / `RestV1IntegrationConfig`) —
  synth template → discovered REST v1 / HTTP API / Function URL routes.
- `matchRoute` (+ `RouteMatchResult`) — match an incoming request path
  to a discovered route (full → greedy → `$default` precedence).
- `buildHttpApiV2Event` / `buildRestV1Event` / `applyAuthorizerOverlay`
  (+ `HttpRequestSnapshot` / `MatchedRouteContext` /
  `AuthorizerEventOverlay`) — build the API Gateway v1 / v2 event shapes.
- `discoverWebSocketApis` / `discoverWebSocketApisOrThrow` /
  `parseSelectionExpressionPath` (+ `DiscoveredWebSocketApi` /
  `WebSocketRouteEntry`) — WebSocket API discovery.

The `start-api` authorizer primitives are exposed on the same basis:

- `createAuthorizerCache` (+ `AuthorizerCache` / `CachedAuthorizerResult`)
  — TTL-aware cache mirroring API Gateway's authorizer-result caching.
- `createJwksCache` / `buildCognitoJwksUrl` / `buildJwksUrlFromIssuer` /
  `verifyCognitoJwt` / `verifyJwtAuthorizer` (+ `JwksCache`) — Cognito
  User Pool / JWT authorizer verification against published JWKS.
- `buildMethodArn` / `invokeTokenAuthorizer` / `invokeRequestAuthorizer` /
  `computeRequestIdentityHash` / `evaluateCachedLambdaPolicy` — Lambda
  (TOKEN / REQUEST) authorizer invocation and IAM-policy evaluation.

The `invoke` / `start-api` env-var and stage layers, plus the
`start-service` Cloud Map registry, are exposed on the same basis:

- `resolveEnvVars` (+ `EnvOverrideFile`) — merge template-literal env
  vars with SAM-shape `--env-vars` overrides (intrinsic-valued entries
  warn-and-drop unless substituted upstream).
- `buildStageMap` / `attachStageContext` (+ `ResolvedStage`) — per-API
  Stage selection; attaches stage context (`event.stageVariables`) to
  discovered routes.
- `CloudMapRegistry` (+ `RegistrationHandle`) — in-process Cloud Map
  service registry so peers reach each other by IP / network alias on the
  shared service network; `RegistrationHandle` is the handle returned by
  `register()` for symmetric unregister.
- `resolveRuntimeImage` / `resolveRuntimeFileExtension` /
  `resolveRuntimeCodeMountPath` — Lambda `Runtime` → ECR base-image,
  source-file extension, and in-container code-mount path.
- `buildConnectEvent` / `buildDisconnectEvent` / `buildMessageEvent`
  (+ `WebSocketHandshakeSnapshot` / `WebSocketLambdaEvent`) — WebSocket API
  `$connect` / `$disconnect` / message Lambda event-shape builders.
- `ConnectionRegistry` / `handleConnectionsRequest` / `parseConnectionsPath` /
  `buildMgmtEndpointEnvUrl` (+ `ConnectionRegistryEntry`) — WebSocket
  `@connections` management API: in-process connection registry + the local
  management-endpoint HTTP handler.

These are stable, side-effect-free utilities; they are exposed for
1:1 re-export and are not a recommended way to build a custom CLI (use
the factories for that).

## ECS service emulator engine (`start-service` / `start-alb` hosts)

A host CLI that ports `cdkl start-service` and / or `cdkl start-alb`
verbatim (rather than re-exporting the factory) wraps the shared
orchestrator directly. The engine boots the ECS replicas, attaches the
shared docker network + Cloud Map / Service Connect overlay, optionally
stands up the ALB front-door per listener, and tears everything down on
SIGINT — every CLI behavior the upstream `cdkl` commands have:

- `runEcsServiceEmulator(targets, options, strategy, extraStateProviders?, synthesizer?)`
  — the entry point both upstream CLI commands wrap. `strategy` decides
  per-command behavior (target selection, picker prompts, front-door plan
  resolution); `serviceStrategy` and `albStrategy` are the two strategies
  the upstream CLI ships.
- `addCommonEcsServiceOptions(cmd)` — option block shared by both
  commands (`--cluster`, `--max-tasks`, `--container-host`,
  `--from-cfn-stack`, etc.). Compose with `addAlbSpecificOptions(cmd)`
  for an ALB-fronted host CLI; `start-service` hosts only need the
  common block.
- `addAlbSpecificOptions(cmd)` — ALB-only option block (`--lb-port`,
  `--tls`, `--tls-cert`, `--tls-key`, `--no-verify-auth`,
  `--bearer-token`). Calling this from a host's `start-alb` keeps the
  option set in sync as upstream cdk-local adds or renames ALB-only
  flags; no duplicate `.addOption(...)` blocks.
- `albStrategy(options)` / `resolveAlbTarget(target, stacks)` /
  `parseLbPortOverrides(values)` — the matching `EmulatorStrategy` plus
  the target / port-override resolvers a host calls directly when it
  composes a custom `start-alb` command around `runEcsServiceEmulator`.
- `parseMaxTasks` / `parseRestartPolicy` — option parsers that pair with
  `--max-tasks` and `--restart-policy` from the common block.
- `resolveSharedSidecarCredentials` / `buildEcsImageResolutionContext`
  — pre-boot helpers for hosts that need to materialize sidecar creds
  or image-resolution context before delegating to the engine
  (e.g. test setup).
- `MAX_TASKS_SUBNET_RANGE_CAP` — the per-network replica cap the engine
  enforces; surfaced so a host CLI can validate `--max-tasks` against
  the same ceiling.
- `EcsServiceEmulatorOptions` / `EmulatorStrategy` / `ServiceBoot` /
  `FrontDoorPlan` / `PlannedAction` / `PlannedForwardAction` /
  `PlannedRedirectAction` / `PlannedFixedResponseAction` /
  `PlannedForwardTarget` / `PlannedEcsForwardTarget` /
  `PlannedLambdaForwardTarget` / `PlannedFrontDoorListener` — the
  engine's option + pre-boot-plan types.

Host CLIs that wrap `start-alb` for an ALB-fronted workload typically
look like:

```ts
import {
  addCommonEcsServiceOptions,
  addAlbSpecificOptions,
  albStrategy,
  runEcsServiceEmulator,
  type EcsServiceEmulatorOptions,
} from 'cdk-local/internal';

const cmd = new Command('start-alb')
  .description(...)
  .argument('[targets...]', ...)
  // ... host-specific options ...
  .action(async (targets: string[], options: EcsServiceEmulatorOptions) => {
    await runEcsServiceEmulator(targets, options, albStrategy(options));
  });
addAlbSpecificOptions(cmd);
addCommonEcsServiceOptions(cmd);
```

`addAlbSpecificOptions` after host-specific options keeps the host's
flags in their own `--help` cluster; Commander itself is
insertion-order-independent for parsing.

## ALB front-door target resolution

A host wrapping `start-alb` also needs the resolver layer that turns an
ALB target string into a listener-by-listener routing table:

- `resolveAlbFrontDoor` (+ `ResolvedListenerAction` /
  `FrontDoorForwardTarget`) — ALB → listeners → ListenerRules
  (path / host / header / method / query / source-ip) → forward (single
  or weighted) / redirect / fixed-response → backing ECS Services or
  Lambda functions.
- `isApplicationLoadBalancer` — type-narrowing predicate that
  disambiguates ApplicationLoadBalancer from NetworkLoadBalancer when
  picking targets.

## Per-command option blocks (host CLIs that wrap a single command)

A host CLI that ports an individual `cdkl` command verbatim (rather than
re-exporting the factory) can compose the per-command option block on
its own Commander instance. Each helper registers only that command's
NON-common flags; the host still owns the shared `commonOptions` /
`appOptions` / `contextOptions` / `regionOption` block (or
calls them via its own re-export). Adding or renaming a per-command flag
in upstream cdk-local propagates to every embedder calling the helper —
no duplicate `.addOption(...)` block on the host side.

- `addInvokeSpecificOptions(cmd)` — `cdkl invoke` flags
  (`--event`, `--event-stdin`, `--env-vars`, `--no-pull`, `--no-build`,
  `--debug-port`, `--container-host`, `--assume-role`, `--layer-role-arn`,
  `--ecr-role-arn`, `--from-cfn-stack`, `--stack-region`).
- `addInvokeAgentCoreSpecificOptions(cmd)` — `cdkl invoke-agentcore`
  flags (`--event`, `--event-stdin`, `--env-vars`, `--session-id`,
  `--ws`, `--bearer-token`, `--no-verify-auth`,
  `--sigv4`, `--platform`, `--no-pull`, `--no-build`, `--container-host`,
  `--timeout`, `--assume-role`, `--ecr-role-arn`, `--from-cfn-stack`,
  `--stack-region`).
- `addStartWebFunctionSpecificOptions(cmd)` — `cdkl start-web-function`
  flags (`--revision`, `--port`, `--host`, `--platform`, `--env-vars`,
  `--no-pull`, `--timeout`, `--assume-role`, `--from-cfn-stack`,
  `--stack-region`).
- `addStartApiSpecificOptions(cmd)` — `cdkl start-api` flags
  (`--port`, `--host`, `--stack`, `--all-stacks`, `--warm`,
  `--per-lambda-concurrency`, `--no-pull`, `--container-host`,
  `--debug-port-base`, `--env-vars`, `--assume-role`, `--watch`,
  `--stage`, `--api`, `--layer-role-arn`, `--from-cfn-stack`,
  `--stack-region`, `--mtls-truststore`, `--mtls-cert`, `--mtls-key`,
  `--strict-sigv4`).
- `addRunTaskSpecificOptions(cmd)` — `cdkl run-task` flags
  (`--cluster`, `--env-vars`, `--container-host`, `--host-port`,
  `--assume-task-role`, `--no-pull`, `--ecr-role-arn`, `--platform`,
  `--keep-running`, `--detach`, `--from-cfn-stack`, `--stack-region`).
  Does NOT compose with `addCommonEcsServiceOptions` — the single-task
  surface intentionally diverges from the multi-replica service surface
  (no `--max-tasks` / `--restart-policy`).
- `addStartServiceSpecificOptions(cmd)` — `cdkl start-service`
  flags (`--host-port`, `--watch`, plus the `--image-override` family:
  `--image-override`, `--image-build-arg`, `--image-build-secret`,
  `--image-target`, `--no-interactive-overrides`, `--strict-overrides`).
  Compose with `addCommonEcsServiceOptions` (no `addAlbSpecificOptions` —
  `start-service` runs replicas only, no load balancer).
- `addListSpecificOptions(cmd)` — `cdkl list` flag (`-l, --long`).
  Intentionally minimal so the surface-contract test pattern stays
  uniform across every per-command helper.

Each helper is chainable (returns `cmd`); the upstream `cdkl` factories
themselves call the helper to avoid duplicating the option block,
so the helper and the factory cannot drift apart silently (the
`tests/unit/cli/option-surface-contracts.test.ts` drift guards fail
the moment someone adds a flag inline in `create<Cmd>Command` instead
of inside the matching `add<Cmd>SpecificOptions` helper).
