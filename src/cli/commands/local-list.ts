import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  regionOption,
  parseContextOptions,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import {
  countTargets,
  listTargets,
  type TargetEntry,
  type TargetListing,
} from '../../local/target-lister.js';

interface LocalListOptions {
  app?: string;
  output: string;
  verbose: boolean;
  profile?: string;
  roleArn?: string;
  context?: string[];
  region?: string;
  /** `-l/--long`: also print each target's stack-qualified logical ID. */
  long: boolean;
}

/**
 * Factory options for {@link createLocalListCommand}.
 */
export interface CreateLocalListCommandOptions {
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

async function localListCommand(options: LocalListOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  await applyRoleArnIfSet({ roleArn: options.roleArn, region: undefined });

  const appCmd = resolveApp(options.app);
  if (!appCmd) {
    throw new Error(
      `No CDK app specified. Pass --app, set ${getEmbedConfig().envPrefix}_APP, or add "app" to cdk.json.`
    );
  }

  // Status goes to stderr so `cdkl list` stdout is ONLY the target list
  // (clean for `cdkl list | ...`). Synthesis progress from toolkit-lib is
  // routed to stderr too (see CdklIoHost).
  process.stderr.write('Synthesizing CDK app...\n');
  const synthesizer = new Synthesizer();
  const context = parseContextOptions(options.context);
  const synthOpts: SynthesisOptions = {
    app: appCmd,
    output: options.output,
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
  };
  const { stacks } = await synthesizer.synthesize(synthOpts);

  const listing = listTargets(stacks);
  process.stdout.write(
    `${formatTargetListing(listing, getEmbedConfig().cliName, { long: options.long })}\n`
  );
}

/** Options for {@link formatTargetListing}. */
export interface FormatTargetListingOptions {
  /**
   * Also print each target's stack-qualified logical ID (`-l/--long`).
   * Off by default: the CDK display path alone is the recommended,
   * readable target form, and the wide two-column layout wrapped badly
   * for the long auto-generated names CDK emits.
   */
  long?: boolean;
}

/**
 * Render a {@link TargetListing} as the grouped text list `cdkl list`
 * prints. Each non-empty category is preceded by a blank line and a
 * header naming the command that runs it, then one target per line by
 * CDK display path. With {@link FormatTargetListingOptions.long}, each
 * target's stack-qualified logical ID is printed on an indented line
 * beneath it. Exported so a unit test can assert the output shape
 * without running synthesis.
 */
export function formatTargetListing(
  listing: TargetListing,
  cliName: string,
  options: FormatTargetListingOptions = {}
): string {
  if (countTargets(listing) === 0) {
    return `No runnable targets (Lambda functions, APIs, ECS services / tasks, AgentCore Runtimes, load balancers) found in this CDK app.`;
  }

  const long = options.long ?? false;
  const sections: string[][] = [
    formatSection('Lambda Functions', `${cliName} invoke <target>`, listing.lambdas, long),
    formatSection('APIs', `${cliName} start-api [target...]`, listing.apis, long),
    formatSection(
      'ECS Services',
      `${cliName} start-service <target...>`,
      listing.ecsServices,
      long
    ),
    formatSection(
      'ECS Task Definitions',
      `${cliName} run-task <target>`,
      listing.ecsTaskDefinitions,
      long
    ),
    formatSection(
      'AgentCore Runtimes',
      `${cliName} invoke-agentcore <target>`,
      listing.agentCoreRuntimes,
      long
    ),
    formatSection(
      'Application Load Balancers',
      `${cliName} start-alb <target...>`,
      listing.loadBalancers,
      long
    ),
  ];

  // Leading blank line + a blank line between groups so each header is a
  // clear landmark (and the first group is separated from the synth
  // status that precedes it on stderr).
  return (
    '\n' +
    sections
      .filter((lines) => lines.length > 0)
      .map((lines) => lines.join('\n'))
      .join('\n\n')
  );
}

function formatSection(
  title: string,
  command: string,
  entries: TargetEntry[],
  long: boolean
): string[] {
  if (entries.length === 0) return [];
  const lines = [`${title}  ->  ${command}`];
  for (const entry of entries) {
    const primary = entry.displayPath ?? entry.qualifiedId;
    // Append the API surface kind (REST API v1 / HTTP API v2 / Function URL
    // / WebSocket) so the API group's otherwise-similar paths are
    // distinguishable; only `apis` entries carry a kind.
    lines.push(entry.kind ? `  ${primary}  (${entry.kind})` : `  ${primary}`);
    // The qualified ID is only extra info when a display path was shown;
    // when it IS the primary, don't repeat it.
    if (long && entry.displayPath) {
      lines.push(`      ${entry.qualifiedId}`);
    }
  }
  return lines;
}

export function createLocalListCommand(opts: CreateLocalListCommandOptions = {}): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('list')
    .alias('ls')
    .description(
      'List the runnable targets in the synthesized CDK app, grouped by the command that runs them: ' +
        'Lambda functions (invoke), API Gateway REST v1 / HTTP v2 / Function URL / WebSocket surfaces ' +
        '(start-api), ECS services (start-service), ECS task definitions (run-task), AgentCore ' +
        'Runtimes (invoke-agentcore), and Application Load Balancers (start-alb). Each target is ' +
        'shown by its CDK display path; pass -l to also print the stack-qualified logical ID. Tip: you ' +
        'usually do not need to copy these — just run the command (e.g. `invoke`) with no target in a ' +
        'terminal and pick from the list.'
    )
    .action(
      withErrorHandling(async (options: LocalListOptions) => {
        await localListCommand(options);
      })
    );

  addListSpecificOptions(cmd);
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(regionOption);
  return cmd;
}

/**
 * Register the option block that `cdkl list` adds on top of the shared
 * common / app / context option helpers. Shared between `cdkl list` and any
 * host CLI (e.g. cdkd's `local list`) that wraps the synthesis-driven
 * target enumeration, so adding or renaming a `list`-only flag here
 * propagates to every embedder without duplicate `.addOption(...)` blocks.
 *
 * Calling order only affects `--help` presentation (Commander parses
 * insertion-order-independent). The host-CLI convention is host-specific
 * options first, then this helper, then the shared common / app / context
 * options — host flags / list flags / common flags grouped in three
 * `--help` clusters. Chainable: returns `cmd`.
 *
 * Today `cdkl list` only contributes one non-common flag (`-l, --long`),
 * but the helper is still exposed so the surface-contract test pattern
 * (helper + common == createLocalListCommand) is uniform across every
 * `add<Cmd>SpecificOptions` extraction.
 */
export function addListSpecificOptions(cmd: Command): Command {
  return cmd.addOption(
    new Option(
      '-l, --long',
      "Also print each target's stack-qualified logical ID (<Stack>:<LogicalId>) beneath it"
    ).default(false)
  );
}
