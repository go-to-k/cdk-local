import { spawn } from 'node:child_process';
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
import { listTargets } from '../../local/target-lister.js';
import { StudioEventBus } from '../../local/studio-events.js';
import {
  startStudioServer,
  toStudioTargetGroups,
  type RunningStudioServer,
} from '../../local/studio-server.js';

const DEFAULT_STUDIO_PORT = 9999;

/**
 * Parse + validate the `--studio-port` value. Accepts `0` (OS-assigned)
 * through `65535`. Exported so a unit test can assert the bounds without
 * driving the full command. Throws on anything out of range / non-numeric.
 */
export function parseStudioPort(raw: string): number {
  // `Number('')` / `Number('  ')` coerce to 0, which would pass the range
  // check; reject blank input explicitly.
  const port = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--studio-port must be 0..65535 (got ${raw}).`);
  }
  return port;
}

interface LocalStudioOptions {
  app?: string;
  output: string;
  verbose: boolean;
  profile?: string;
  roleArn?: string;
  context?: string[];
  region?: string;
  /** `--studio-port`: preferred listen port (bumps on collision). */
  studioPort: string;
  /** `--no-open`: suppress auto-opening the browser (Commander sets `open`). */
  open: boolean;
}

/**
 * Factory options for {@link createLocalStudioCommand}.
 */
export interface CreateLocalStudioCommandOptions {
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

async function localStudioCommand(options: LocalStudioOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const port = parseStudioPort(options.studioPort);

  await applyRoleArnIfSet({
    roleArn: options.roleArn,
    region: undefined,
    profile: options.profile,
  });

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
  const targetGroups = toStudioTargetGroups(listing);
  const appLabel = stacks.map((s) => s.stackName).join(', ') || appCmd;

  const bus = new StudioEventBus();
  const server = await startStudioServer({
    port,
    bus,
    targetGroups,
    appLabel,
    cliName: getEmbedConfig().cliName,
  });

  const cliName = getEmbedConfig().cliName;
  logger.info(`${cliName} studio is running at ${server.url}`);
  logger.info('Press Ctrl-C to stop.');

  // Auto-open the browser only in an interactive terminal (never in CI /
  // piped / integ runs) and unless --no-open was passed.
  if (options.open && process.stdout.isTTY) {
    openBrowser(server.url);
  }

  await blockUntilShutdown(server, cliName);
}

/** Best-effort cross-platform browser open. Failures are non-fatal. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Opening the browser is a convenience; ignore any failure.
  }
}

/**
 * Block until SIGINT / SIGTERM, then close the studio server and resolve.
 * Mirrors the long-running serve commands' graceful-shutdown contract.
 */
function blockUntilShutdown(server: RunningStudioServer, cliName: string): Promise<void> {
  return new Promise<void>((resolveShutdown) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      getLogger().info(`Received ${signal}; stopping ${cliName} studio...`);
      void server.close().finally(() => resolveShutdown());
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

export function createLocalStudioCommand(opts: CreateLocalStudioCommandOptions = {}): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('studio')
    .description(
      "Open the local studio: a web console that lists the synthesized CDK app's runnable " +
        'targets and lets you invoke / serve them from the browser while watching all activity ' +
        'in one timeline. The interactive counterpart to the headless invoke / start-* commands.'
    )
    .action(
      withErrorHandling(async (options: LocalStudioOptions) => {
        await localStudioCommand(options);
      })
    );

  addStudioSpecificOptions(cmd);
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(regionOption);
  return cmd;
}

/**
 * Register the option block `cdkl studio` adds on top of the shared
 * common / app / context option helpers. Kept in a named helper (not
 * inline in {@link createLocalStudioCommand}) so a host CLI embedding
 * this factory inherits new studio flags without a duplicate
 * `.addOption(...)` block, matching every other `add<Cmd>SpecificOptions`
 * extraction. Chainable: returns `cmd`.
 */
export function addStudioSpecificOptions(cmd: Command): Command {
  cmd.addOption(
    new Option(
      '--studio-port <port>',
      'Preferred port for the studio web server (bumps to the next free port on collision)'
    ).default(String(DEFAULT_STUDIO_PORT))
  );
  cmd.addOption(
    new Option('--no-open', 'Do not auto-open the browser when studio starts (TTY only)')
  );
  return cmd;
}
