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
