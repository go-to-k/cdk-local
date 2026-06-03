import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
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
  annotatePinnedEcsTargets,
  type RunningStudioServer,
} from '../../local/studio-server.js';
import { filterStudioCustomResources } from '../../local/studio-custom-resource-filter.js';
import { createStudioDispatcher, type StudioRunRequest } from '../../local/studio-dispatch.js';
import {
  buildPerRunArgs,
  resolveEnvVars,
  type OptionValues,
} from '../../local/studio-option-specs.js';
import { tokenizeRawArgs } from '../../local/studio-option-catalog.js';
import { relayServeRequest } from '../../local/studio-request-relay.js';
import { resolveEcsServiceTarget } from '../../local/ecs-service-resolver.js';
import { isLocalCdkAssetImage } from '../../local/image-pin-detector.js';
import { discoverDockerfiles } from '../../local/image-override-engine.js';
import {
  createStudioServeManager,
  type StudioServeManager,
  type StudioStopRequest,
  type StudioServeState,
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
  const { targetId, kind, event, options, rawArgs, imageOverride } = body as Record<
    string,
    unknown
  >;
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
  let runImageOverride: string | undefined;
  if (imageOverride !== undefined) {
    if (typeof imageOverride !== 'string') {
      throw new Error('Request body "imageOverride" must be a string.');
    }
    if (imageOverride.trim() !== '') runImageOverride = imageOverride;
  }
  return {
    targetId,
    kind: kind as StudioTargetKind,
    event,
    ...(runOptions !== undefined ? { options: runOptions } : {}),
    ...(runRawArgs !== undefined ? { rawArgs: runRawArgs } : {}),
    ...(runImageOverride !== undefined ? { imageOverride: runImageOverride } : {}),
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

/** A composed HTTP request to a running serve, as the studio UI posts it. */
export interface StudioServeRequestPayload {
  targetId: string;
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

const SERVE_REQUEST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Pick the HTTP base URL the request composer relays to for a running serve
 * (issue #322): the first `http(s)://` endpoint (the api / alb capture-proxy
 * URL — a `ws://` WebSocket-API endpoint is NOT relayable, so it is skipped),
 * else the ecs `--host-port` host URL, else `undefined` (no reachable HTTP
 * endpoint). Exported so the relay base-URL choice is unit-testable.
 */
export function resolveServeBaseUrl(state: StudioServeState): string | undefined {
  const http = (state.endpoints || []).find((u) => /^https?:/.test(u));
  return http ?? state.hostUrl;
}

/**
 * Validate + narrow the untyped `POST /api/request` body (issue #322). Throws
 * on a malformed body; the studio server surfaces a thrown handler error as a
 * 500 (the same convention as {@link coerceRunRequest} / {@link
 * coerceStopRequest}) so a bad UI / curl payload fails loudly rather than
 * relaying a bogus request.
 */
export function coerceServeRequest(body: unknown): StudioServeRequestPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object.');
  }
  const { targetId, method, path, headers, body: reqBody } = body as Record<string, unknown>;
  if (typeof targetId !== 'string' || targetId.trim() === '') {
    throw new Error('Request body must include a non-empty "targetId" string.');
  }
  if (typeof method !== 'string' || !SERVE_REQUEST_METHODS.has(method.toUpperCase())) {
    throw new Error(
      `Request body "method" must be one of: ${[...SERVE_REQUEST_METHODS].join(', ')}.`
    );
  }
  const out: StudioServeRequestPayload = { targetId, method: method.toUpperCase() };
  if (path !== undefined) {
    if (typeof path !== 'string') throw new Error('Request body "path" must be a string.');
    out.path = path;
  }
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new Error('Request body "headers" must be a JSON object of string values.');
    }
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== 'string') throw new Error(`Request header "${k}" must be a string.`);
      if (k.trim() !== '') h[k] = v;
    }
    out.headers = h;
  }
  if (reqBody !== undefined) {
    if (typeof reqBody !== 'string') throw new Error('Request body "body" must be a string.');
    out.body = reqBody;
  }
  return out;
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

/**
 * Resolve the on-disk cloud-assembly directory the boot synth produced, so
 * studio can forward `--app <assemblyDir>` to NON-watch children and skip a
 * redundant re-synth (issue #324). Returns the absolute path when a
 * reusable assembly directory exists, else `undefined` (children then fall
 * back to forwarding the app command).
 *
 * Two cases yield a reusable dir:
 *   1. `--app` is itself a pre-synthesized assembly directory — `synthesize`
 *      read it in place (no `--output` write), so we reuse that very dir.
 *   2. `--app` is a CDK app command — the synth wrote the assembly to
 *      `--output` (default `cdk.out`), so we reuse that.
 *
 * The existence check is defensive: if neither path is a directory on disk
 * (an unusual synth setup), we return `undefined` rather than hand a child
 * a `--app` that points at nothing.
 *
 * Exported for unit testing.
 */
export function resolveBootAssemblyDir(appCmd: string, output: string): string | undefined {
  const isDir = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  // Case 1: --app already points at a pre-synthesized assembly directory.
  const appPath = resolve(appCmd);
  if (isDir(appPath)) return appPath;
  // Case 2: a CDK app command synthed into the --output directory.
  const outPath = resolve(output);
  if (isDir(outPath)) return outPath;
  return undefined;
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
  /**
   * `--include-custom-resources`: show CDK custom-resource / provider-framework
   * Lambdas in the target list (hidden by default).
   */
  includeCustomResources?: boolean;
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

  // The boot synth persisted the cloud assembly to `--output` (default
  // `cdk.out`). Capture it so NON-watch children studio spawns
  // (`cdkl invoke` / `start-api` / ...) read `--app <assemblyDir>` and skip
  // a redundant re-synth (issue #324). Guard on the dir actually existing —
  // when `--app` already pointed at a pre-synthesized assembly dir,
  // `synthesize` reads it in place and `--output` is never written, so we
  // reuse that same dir; otherwise (and only then) fall back to forwarding
  // the app command, never a non-existent path. A `--watch` serve still
  // re-synths (it forwards `--app <appCmd>` — decided per spawn).
  const assemblyDir = resolveBootAssemblyDir(appCmd, options.output);

  const listing = listTargets(stacks);
  // `--stack <glob>` scopes the LISTED targets (display only — the whole app
  // was already synthesized above; the filter never touches synth).
  const stackFiltered = filterStudioTargetGroups(toStudioTargetGroups(listing), options.stack);
  // Hide CDK custom-resource / provider-framework Lambdas by default so the UI
  // shows only the user's own functions (issue #323); `--include-custom-resources`
  // surfaces them. Applied AFTER the `--stack` display filter.
  const lambdasBefore = stackFiltered.find((g) => g.kind === 'lambda')?.entries.length ?? 0;
  const targetGroups = filterStudioCustomResources(stackFiltered, {
    include: options.includeCustomResources === true,
  });
  if (!options.includeCustomResources) {
    const lambdasAfter = targetGroups.find((g) => g.kind === 'lambda')?.entries.length ?? 0;
    const hidden = lambdasBefore - lambdasAfter;
    if (hidden > 0) {
      logger.info(
        `Hid ${hidden} CDK custom-resource / provider Lambda(s); pass --include-custom-resources to show them.`
      );
    }
  }
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

  // Mark servable ECS services whose image is a deployed-registry pin (ECR /
  // public) rather than a local CDK asset (issue #301). A pinned image does
  // NOT pick up local source edits, so the UI offers an image-override
  // Dockerfile picker for those services; a local-asset service already
  // hot-reloads under `--watch` and gets no picker.
  //
  // Classification is BEST-EFFORT and deliberately STATE-FREE: it reads the
  // synthed template only (no deployed-state fetch, no AWS calls at boot), so
  // it is cheap, but under `--from-cfn-stack` an ECR image expressed as an
  // unresolved intrinsic could be hinted differently than the actual
  // start-service verdict. The hint only governs whether the UI surfaces the
  // picker; a mis-hinted service can still be overridden via the "All options"
  // raw-args `--image-override`. Per-target resolution failures are non-fatal
  // (the service stays unmarked). Dockerfiles are scanned once, only when at
  // least one service is pinned, so an all-local app pays nothing.
  const anyPinned = annotatePinnedEcsTargets(targetGroups, (id) => {
    try {
      return !isLocalCdkAssetImage(resolveEcsServiceTarget(id, stacks));
    } catch (err) {
      logger.debug(
        `studio: could not classify pin status for '${id}': ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  });
  const dockerfiles = anyPinned ? discoverDockerfiles(process.cwd()) : [];

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
    assemblyDir?: string;
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
    ...(assemblyDir ? { assemblyDir } : {}),
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
    dockerfiles,
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
    onServeRequest: async (body) => {
      // Relay a composed HTTP request to a RUNNING serve, server-side (issue
      // #322). For api / alb the base URL is the capture-proxy endpoint (so
      // the request lands on the timeline); for an ecs serve published via
      // --host-port it is the replica host URL (no proxy, not captured).
      const req = coerceServeRequest(body);
      const state = serveManager.list().find((s) => s.targetId === req.targetId);
      if (!state || state.status !== 'running') {
        throw new Error(`'${req.targetId}' is not a running serve target.`);
      }
      const baseUrl = resolveServeBaseUrl(state);
      if (!baseUrl) {
        throw new Error(
          `'${req.targetId}' has no reachable HTTP endpoint (an ecs service needs --host-port).`
        );
      }
      const result = await relayServeRequest({
        baseUrl,
        method: req.method,
        ...(req.path !== undefined ? { path: req.path } : {}),
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      return result;
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
  cmd.addOption(
    new Option(
      '--include-custom-resources',
      'Show CDK custom-resource / provider-framework Lambdas in the target list (provider ' +
        'framework onEvent/onTimeout/isComplete handlers, log-retention, bucket-notifications, ' +
        'AwsCustomResource, BucketDeployment, etc.). Hidden by default so the list shows only ' +
        'your own functions.'
    )
  );
  return cmd;
}
