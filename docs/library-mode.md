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
  envPrefix: 'MYTOOL',          // env fallbacks: MYTOOL_APP / MYTOOL_ROLE_ARN
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

- `runEcsServiceEmulator(targets, options, strategy, extraStateProviders?)`
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
  `--ws`, `--ws-interactive`, `--bearer-token`, `--no-verify-auth`,
  `--sigv4`, `--platform`, `--no-pull`, `--no-build`, `--container-host`,
  `--timeout`, `--assume-role`, `--ecr-role-arn`, `--from-cfn-stack`,
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
