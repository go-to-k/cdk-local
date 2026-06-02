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
import { StudioEventBus, type StudioTargetKind } from '../../local/studio-events.js';
import { createStudioStore, type StudioStore } from '../../local/studio-store.js';
import {
  startStudioServer,
  toStudioTargetGroups,
  type RunningStudioServer,
} from '../../local/studio-server.js';
import { createStudioDispatcher, type StudioRunRequest } from '../../local/studio-dispatch.js';
import {
  createStudioServeManager,
  type StudioServeManager,
  type StudioStopRequest,
} from '../../local/studio-serve-manager.js';

const STUDIO_TARGET_KINDS: readonly StudioTargetKind[] = [
  'lambda',
  'api',
  'alb',
  'ecs',
  'agentcore',
];

/**
 * Validate + narrow the untyped `POST /api/run` body into a
 * {@link StudioRunRequest}. Throws (→ 400 from the server) on a malformed
 * body so a bad UI / curl payload fails loudly rather than spawning an
 * `invoke` for an empty target.
 */
export function coerceRunRequest(body: unknown): StudioRunRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object.');
  }
  const { targetId, kind, event } = body as Record<string, unknown>;
  if (typeof targetId !== 'string' || targetId.trim() === '') {
    throw new Error('Request body must include a non-empty "targetId" string.');
  }
  if (typeof kind !== 'string' || !STUDIO_TARGET_KINDS.includes(kind as StudioTargetKind)) {
    throw new Error(`Request body "kind" must be one of: ${STUDIO_TARGET_KINDS.join(', ')}.`);
  }
  return { targetId, kind: kind as StudioTargetKind, event };
}

/**
 * Validate + narrow the untyped `POST /api/stop` body into a
 * {@link StudioStopRequest}. Throws (→ 400 from the server) on a missing
 * / empty target id.
 */
export function coerceStopRequest(body: unknown): StudioStopRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object.');
  }
  const { targetId } = body as Record<string, unknown>;
  if (typeof targetId !== 'string' || targetId.trim() === '') {
    throw new Error('Request body must include a non-empty "targetId" string.');
  }
  return { targetId };
}

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
  // `process.argv[1]` is the running CLI entry (`dist/cli.js` / the `cdkl`
  // bin); both the invoke dispatcher and the serve manager spawn it again
  // (`cdkl invoke <target>` / `cdkl start-api <target>`) — studio is a
  // control plane over the CLI.
  const cliEntry = process.argv[1] ?? '';
  const childConfig = {
    cliEntry,
    bus,
    cwd: process.cwd(),
    ...(appCmd ? { app: appCmd } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
  const dispatcher = createStudioDispatcher(childConfig);
  const serveManager = createStudioServeManager(childConfig);
  // Retain a bounded window of invocations + logs so the browser can render
  // history on (re)connect, search logs full-text, and bind a request's
  // logs at CloudWatch granularity (slice C3).
  const store = createStudioStore(bus);

  const server = await startStudioServer({
    port,
    bus,
    targetGroups,
    appLabel,
    cliName: getEmbedConfig().cliName,
    store,
    // `/api/run`: a Lambda is a single-shot invoke; everything else is a
    // long-running serve start (slice C1 supports the `api` kind, the
    // serve manager rejects the rest with a clear message).
    onRun: (body) => {
      const req = coerceRunRequest(body);
      return req.kind === 'lambda' ? dispatcher.run(req) : serveManager.start(req);
    },
    onStop: async (body) => {
      const req = coerceStopRequest(body);
      await serveManager.stop(req);
      return { stopped: req.targetId };
    },
    getRunning: () => ({ running: serveManager.list() }),
  });

  const cliName = getEmbedConfig().cliName;
  logger.info(`${cliName} studio is running at ${server.url}`);
  logger.info('Press Ctrl-C to stop.');

  // Auto-open the browser only in an interactive terminal (never in CI /
  // piped / integ runs) and unless --no-open was passed.
  if (options.open && process.stdout.isTTY) {
    openBrowser(server.url);
  }

  await blockUntilShutdown(server, serveManager, store, cliName);
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
 * Block until SIGINT / SIGTERM, then stop every running serve child,
 * close the studio server, and resolve. Mirrors the long-running serve
 * commands' graceful-shutdown contract — the serve children are killed
 * BEFORE the server closes so their RIE containers are torn down rather
 * than orphaned.
 */
function blockUntilShutdown(
  server: RunningStudioServer,
  serveManager: StudioServeManager,
  store: StudioStore,
  cliName: string
): Promise<void> {
  return new Promise<void>((resolveShutdown) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      getLogger().info(`Received ${signal}; stopping ${cliName} studio...`);
      // Unsubscribe the store from the bus so a host CLI that restarts
      // studio in a long-lived process does not accumulate listeners.
      store.dispose();
      void serveManager
        .stopAll()
        .catch((err: unknown) => getLogger().warn(`Error stopping serve targets: ${String(err)}`))
        .then(() => server.close())
        .catch((err: unknown) => getLogger().warn(`Error stopping studio server: ${String(err)}`))
        .finally(() => resolveShutdown());
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
