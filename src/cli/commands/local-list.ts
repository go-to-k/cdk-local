import { Command } from 'commander';
import { appOptions, commonOptions, contextOptions, parseContextOptions } from '../options.js';
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

  logger.info('Synthesizing CDK app...');
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
  process.stdout.write(`${formatTargetListing(listing, getEmbedConfig().cliName)}\n`);
}

/**
 * Render a {@link TargetListing} as the grouped, two-column text table
 * `cdkl list` prints. Each non-empty category names the command that
 * consumes it and lists every target's CDK display path alongside its
 * stack-qualified logical ID. Exported so a unit test can assert the
 * output shape without running synthesis.
 */
export function formatTargetListing(listing: TargetListing, cliName: string): string {
  if (countTargets(listing) === 0) {
    return `No runnable targets (Lambda functions, APIs, ECS services / tasks) found in this CDK app.`;
  }

  const sections: string[][] = [
    formatSection('Lambda Functions', `${cliName} invoke <target>`, listing.lambdas),
    formatSection('APIs', `${cliName} start-api [target]`, listing.apis),
    formatSection('ECS Services', `${cliName} start-service <target...>`, listing.ecsServices),
    formatSection(
      'ECS Task Definitions',
      `${cliName} run-task <target>`,
      listing.ecsTaskDefinitions
    ),
  ];

  return sections
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}

function formatSection(title: string, command: string, entries: TargetEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines = [`${title}  (${command})`];
  const width = Math.max(0, ...entries.map((e) => (e.displayPath ?? '').length));
  for (const entry of entries) {
    if (entry.displayPath) {
      lines.push(`  ${entry.displayPath.padEnd(width)}  ${entry.qualifiedId}`);
    } else {
      lines.push(`  ${entry.qualifiedId}`);
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
        '(start-api), ECS services (start-service), and ECS task definitions (run-task). Each target is ' +
        'shown with its CDK display path and stack-qualified logical ID — copy either form as the ' +
        '<target> argument for the matching command.'
    )
    .action(
      withErrorHandling(async (options: LocalListOptions) => {
        await localListCommand(options);
      })
    );

  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  return cmd;
}
