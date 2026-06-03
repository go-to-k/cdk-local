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
  filterStudioTargetGroups,
  type RunningStudioServer,
} from '../../local/studio-server.js';
import { createStudioDispatcher, type StudioRunRequest } from '../../local/studio-dispatch.js';
import {
  buildPerRunArgs,
  resolveEnvVars,
  type OptionValues,
} from '../../local/studio-option-specs.js';
import { tokenizeRawArgs } from '../../local/studio-option-catalog.js';
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
  const { targetId, kind, event, options, rawArgs } = body as Record<string, unknown>;
  if (typeof targetId !== 'string' || targetId.trim() === '') {
    throw new Error('Request body must include a non-empty "targetId" string.');
  }
  if (typeof kind !== 'string' || !STUDIO_TARGET_KINDS.includes(kind as StudioTargetKind)) {
    throw new Error(`Request body "kind" must be one of: ${STUDIO_TARGET_KINDS.join(', ')}.`);
  }
  let runOptions: OptionValues | undefined;
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new Error('Request body "options" must be a JSON object keyed by option flag.');
    }
    runOptions = options as OptionValues;
    // Validate the values against the kind's option specs NOW so a bad option
    // fails as a clean 400 at the boundary, not mid-spawn (buildPerRunArgs +
    // resolveEnvVars both throw on malformed input).
    buildPerRunArgs(kind as StudioTargetKind, runOptions);
    resolveEnvVars(kind as StudioTargetKind, runOptions);
  }
  let runRawArgs: string | undefined;
  if (rawArgs !== undefined) {
    if (typeof rawArgs !== 'string') {
      throw new Error('Request body "rawArgs" must be a string.');
    }
    // Tokenize NOW so an unterminated quote fails as a clean 400 at the
    // boundary rather than mid-spawn.
    tokenizeRawArgs(rawArgs);
    runRawArgs = rawArgs;
  }
  return {
    targetId,
    kind: kind as StudioTargetKind,
    event,
    ...(runOptions !== undefined ? { options: runOptions } : {}),
    ...(runRawArgs !== undefined ? { rawArgs: runRawArgs } : {}),
  };
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

/** The session config served at `GET /api/config` (issue #301 slice 3). */
export interface SessionConfigSnapshot {
  /** Read-only synth-time context the target list was synthesized with. */
  synth: { profile?: string | undefined; region?: string | undefined; app?: string | undefined };
  /** Editable run-time binding — `--from-cfn-stack` (bare `true` / named). */
  fromCfnStack?: string | boolean | undefined;
  /** Editable run-time binding — `--assume-role <arn>`. */
  assumeRole?: string | undefined;
  /**
   * Editable session mode — `--watch`: when true, serves started from the UI
   * are spawned with `--watch` so they hot-reload on CDK source changes
   * (issue #301). Has no effect on single-shot invokes.
   */
  watch?: boolean | undefined;
}

/** The editable run-time bindings {@link applyConfigPatch} mutates in place. */
export interface EditableSessionBindings {
  fromCfnStack?: string | boolean;
  assumeRole?: string;
  watch?: boolean;
}

/**
 * Validate a `PATCH /api/config` body and apply the editable run-time
 * bindings (`fromCfnStack` / `assumeRole`) onto `target` in place. Only the
 * keys PRESENT in the body are touched (a partial update); `null` / `false` /
 * `''` clears a binding. Throws on a malformed body / value so a bad patch
 * fails loudly rather than silently mis-binding subsequent runs — the studio
 * server surfaces a thrown handler error as a 500 (same as every other
 * `/api/*` dispatch). The read-only synth context (profile / region / app) is
 * never patchable.
 */
export function applyConfigPatch(body: unknown, target: EditableSessionBindings): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;
  if ('fromCfnStack' in b) {
    const v = b['fromCfnStack'];
    if (v === null || v === false || v === '') delete target.fromCfnStack;
    else if (v === true || typeof v === 'string') target.fromCfnStack = v;
    else throw new Error('"fromCfnStack" must be a string, boolean, or null.');
  }
  if ('assumeRole' in b) {
    const v = b['assumeRole'];
    if (v === null || v === '') delete target.assumeRole;
    else if (typeof v === 'string') target.assumeRole = v;
    else throw new Error('"assumeRole" must be a string or null.');
  }
  if ('watch' in b) {
    const v = b['watch'];
    if (v === null || v === false) delete target.watch;
    else if (v === true) target.watch = true;
    else throw new Error('"watch" must be a boolean or null.');
  }
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
  /**
   * `--from-cfn-stack [name]`: bind the whole studio session to a deployed
   * stack. Commander maps the bare flag to `true` and a named value to the
   * string; forwarded verbatim to every child command.
   */
  fromCfnStack?: string | boolean;
  /** `--assume-role <arn>`: explicit role ARN forwarded to every child command. */
  assumeRole?: string;
  /**
   * `--stack <glob...>`: DISPLAY-only filter — show only targets whose id
   * matches one of the globs (e.g. `dev/*`). Does NOT scope synth.
   */
  stack?: string[];
  /**
   * `--watch`: spawn serves started from the UI with `--watch` so they
   * hot-reload on CDK source changes. No effect on single-shot invokes.
   */
  watch?: boolean;
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
  // `--stack <glob>` scopes the LISTED targets (display only — the whole app
  // was already synthesized above; the filter never touches synth).
  const targetGroups = filterStudioTargetGroups(toStudioTargetGroups(listing), options.stack);
  if (options.stack && options.stack.length > 0) {
    const shown = targetGroups.reduce((n, g) => n + g.entries.length, 0);
    if (shown === 0) {
      logger.warn(`--stack ${options.stack.join(' ')} matched no targets; the UI list is empty.`);
    } else {
      logger.info(
        `--stack filter: showing ${shown} target(s) matching ${options.stack.join(' ')}.`
      );
    }
  }
  const appLabel = stacks.map((s) => s.stackName).join(', ') || appCmd;

  // ECS target ids that are actually servable (services, not task
  // definitions). The UI only wires servable rows, but a raw curl could
  // POST a task-def with kind:'ecs' — reject it at the boundary with a
  // clear message rather than spawning a doomed `start-service`.
  const servableEcs = new Set(
    targetGroups
      .filter((g) => g.kind === 'ecs')
      .flatMap((g) => g.entries.filter((e) => e.servable).map((e) => e.id))
  );

  const bus = new StudioEventBus();
  // `process.argv[1]` is the running CLI entry (`dist/cli.js` / the `cdkl`
  // bin); both the invoke dispatcher and the serve manager spawn it again
  // (`cdkl invoke <target>` / `cdkl start-api <target>`) — studio is a
  // control plane over the CLI.
  const cliEntry = process.argv[1] ?? '';
  // The MUTABLE session-run config. The dispatcher + serve-manager hold this
  // SAME object by reference and read it per-run, so editing the run-time
  // bindings (`fromCfnStack` / `assumeRole`) via `PATCH /api/config` applies
  // to subsequent invokes / serves without a restart (issue #301 slice 3).
  // `profile` / `region` / `app` are synth-time context (the target list was
  // synthed with them) — read-only, surfaced for display only.
  const childConfig: {
    cliEntry: string;
    bus: StudioEventBus;
    cwd: string;
    app?: string;
    profile?: string;
    region?: string;
    context?: Record<string, string>;
    fromCfnStack?: string | boolean;
    assumeRole?: string;
    watch?: boolean;
  } = {
    cliEntry,
    bus,
    cwd: process.cwd(),
    ...(appCmd ? { app: appCmd } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(options.fromCfnStack !== undefined ? { fromCfnStack: options.fromCfnStack } : {}),
    ...(options.assumeRole ? { assumeRole: options.assumeRole } : {}),
    ...(options.watch ? { watch: true } : {}),
  };
  const dispatcher = createStudioDispatcher(childConfig);
  const serveManager = createStudioServeManager(childConfig);

  const sessionConfigSnapshot = (): SessionConfigSnapshot => ({
    synth: { profile: childConfig.profile, region: childConfig.region, app: childConfig.app },
    fromCfnStack: childConfig.fromCfnStack,
    assumeRole: childConfig.assumeRole,
    watch: childConfig.watch,
  });
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
    // `/api/run`: a Lambda or an AgentCore runtime is a single-shot invoke;
    // api / alb / ecs are long-running serve starts (the serve manager rejects
    // any other kind).
    onRun: (body) => {
      const req = coerceRunRequest(body);
      if (req.kind === 'lambda' || req.kind === 'agentcore') return dispatcher.run(req);
      if (req.kind === 'ecs' && !servableEcs.has(req.targetId)) {
        return Promise.reject(
          new Error(
            `'${req.targetId}' is not a servable ECS service (an ECS task definition runs via run-task, not start-service).`
          )
        );
      }
      return serveManager.start(req);
    },
    onStop: async (body) => {
      const req = coerceStopRequest(body);
      await serveManager.stop(req);
      return { stopped: req.targetId };
    },
    getRunning: () => ({ running: serveManager.list() }),
    getConfig: () => sessionConfigSnapshot(),
    patchConfig: (body) => {
      // Mutates the shared childConfig the dispatcher + serve-manager read
      // per-run, so the new binding applies to subsequent invokes / serves.
      applyConfigPatch(body, childConfig);
      return Promise.resolve(sessionConfigSnapshot());
    },
  });

  const cliName = getEmbedConfig().cliName;
  logger.info(`${cliName} studio is running at ${server.url}`);
  if (childConfig.watch) {
    logger.info('Watch mode: ON — serves started from the UI hot-reload on CDK source changes.');
  }
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
  cmd.addOption(
    new Option(
      '--from-cfn-stack [cfn-stack-name]',
      'Bind the whole studio session to a deployed CloudFormation stack: every invoke / serve ' +
        'started from the UI runs against the deployed stack real ARNs / Secret values. Bare flag ' +
        'auto-resolves a single-stack app; pass a name to pick the stack. Forwarded to each child command.'
    )
  );
  cmd.addOption(
    new Option(
      '--assume-role <arn>',
      'IAM role ARN to assume for every invoke / serve started from the UI (temp credentials ' +
        'forwarded into the containers). Forwarded to each child command.'
    )
  );
  cmd.addOption(
    new Option(
      '--stack <glob...>',
      'Filter the DISPLAYED targets by stack glob (e.g. "dev/*"); a target id is ' +
        '"Stack/Construct". Display-only — does NOT scope synth (the whole app is still ' +
        "synthesized; gate synth with the app's own -c context or a committed cdk.context.json). " +
        'Space-separate multiple globs; a target matching ANY glob is shown.'
    )
  );
  cmd.addOption(
    new Option(
      '--watch',
      'Spawn serves started from the UI (start-api / start-alb / start-service) with --watch, so ' +
        'they re-synth + rolling-reload on CDK source changes. Toggleable from the Session bar. No ' +
        'effect on single-shot invokes (each invoke re-synths anyway); the target list is not ' +
        're-synthed (restart studio to pick up newly-added resources).'
    )
  );
  return cmd;
}
