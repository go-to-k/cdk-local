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
};

program.addCommand(createLocalInvokeCommand({ extraStateProviders, embedConfig }));
```

Every field is optional and independently falls back to the cdk-local
default, so omitting `embedConfig` (or any single field) leaves native
`cdkl` behavior unchanged. Pass the same `embedConfig` to each factory
the host mounts so the branding is consistent across commands.
