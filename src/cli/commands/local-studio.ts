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
  annotateEcsTaskPinnedTargets,
  annotateAlbPinnedBackingServices,
  type RunningStudioServer,
  type StudioTargetGroup,
} from '../../local/studio-server.js';
import { resolveAlbFrontDoor } from '../../local/elb-front-door-resolver.js';
import { resolveAlbTarget } from './local-start-alb.js';
import { filterStudioCustomResources } from '../../local/studio-custom-resource-filter.js';
import {
  createStudioDispatcher,
  type StudioDispatcher,
  type StudioRunRequest,
} from '../../local/studio-dispatch.js';
import { reinvoke } from '../../local/studio-reinvoke.js';
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
  parseEcsTarget,
  resolveEcsTaskTarget,
  type EcsImageResolutionContext,
} from '../../local/ecs-task-resolver.js';
import { matchStacks } from '../stack-matcher.js';
import {
  createLocalStateProvider,
  resolveCfnFallbackRegion,
  isCfnFlagPresent,
  rejectExplicitCfnStackWithMultipleStacks,
} from './local-state-source.js';
import { buildEcsImageResolutionContext } from './local-run-task.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
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
  'ecs-task',
  'cloudfront',
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
  const { targetId, kind, event, options, rawArgs, imageOverride, imageOverrides } = body as Record<
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
  // Per-backing-service image overrides for an `alb` serve (issue #384): a map
  // of `Stack:LogicalId` -> Dockerfile path. Validate at the boundary so a
  // malformed map fails as a clean 400; drop blank values (the "(keep pinned
  // image)" picker choice).
  let runImageOverrides: Record<string, string> | undefined;
  if (imageOverrides !== undefined) {
    if (
      typeof imageOverrides !== 'object' ||
      imageOverrides === null ||
      Array.isArray(imageOverrides)
    ) {
      throw new Error('Request body "imageOverrides" must be a JSON object keyed by service id.');
    }
    const collected: Record<string, string> = {};
    for (const [svc, df] of Object.entries(imageOverrides as Record<string, unknown>)) {
      if (typeof df !== 'string') {
        throw new Error(`Request body "imageOverrides.${svc}" must be a string.`);
      }
      if (df.trim() !== '') collected[svc] = df.trim();
    }
    if (Object.keys(collected).length > 0) runImageOverrides = collected;
  }
  return {
    targetId,
    kind: kind as StudioTargetKind,
    event,
    ...(runOptions !== undefined ? { options: runOptions } : {}),
    ...(runRawArgs !== undefined ? { rawArgs: runRawArgs } : {}),
    ...(runImageOverride !== undefined ? { imageOverride: runImageOverride } : {}),
    ...(runImageOverrides !== undefined ? { imageOverrides: runImageOverrides } : {}),
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

/** Dependencies {@link routeStudioRun} dispatches a `POST /api/run` against. */
export interface StudioRunRouterDeps {
  /** The single-shot invoke dispatcher (lambda / agentcore). */
  dispatcher: Pick<StudioDispatcher, 'run'>;
  /** The long-running serve lifecycle (api / alb / ecs / ecs-task / cloudfront). */
  serveManager: Pick<StudioServeManager, 'start'>;
  /** Target ids of the servable ECS *services* (task defs are not servable as `ecs`). */
  servableEcs: ReadonlySet<string>;
}

/**
 * Route a validated `POST /api/run` request to the right runner: the
 * single-shot dispatcher for the invoke kinds (`lambda` / `agentcore`), or the
 * serve manager for every serve kind (`api` / `alb` / `ecs` / `ecs-task` /
 * `cloudfront`). An `ecs` target that is NOT a servable service (a raw curl
 * could POST a task-def id with `kind: 'ecs'`) is rejected at the boundary with
 * a clear message rather than spawning a doomed `start-service`. Extracted from
 * the `onRun` closure so the kind→runner routing is unit-testable without
 * booting the studio server.
 */
export function routeStudioRun(req: StudioRunRequest, deps: StudioRunRouterDeps): Promise<unknown> {
  if (req.kind === 'lambda' || req.kind === 'agentcore') return deps.dispatcher.run(req);
  if (req.kind === 'ecs' && !deps.servableEcs.has(req.targetId)) {
    return Promise.reject(
      new Error(
        `'${req.targetId}' is not a servable ECS service (an ECS task definition runs via run-task, not start-service).`
      )
    );
  }
  return deps.serveManager.start(req);
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

/** Validated `POST /api/reinvoke` body (issue #284). */
export interface StudioReinvokePayload {
  /** Id of the recorded invocation to re-run. */
  invocationId: string;
  /** The (possibly edited) payload to re-invoke with. */
  payload: unknown;
}

/**
 * Validate the `POST /api/reinvoke` body at the HTTP boundary (issue #284):
 * a non-empty `invocationId` string and a `payload` (the edited event — any
 * JSON value, including `null`, but the key must be present so an omitted
 * payload is a clean 4xx rather than a silent re-invoke with `undefined`).
 */
export function coerceReinvokeRequest(body: unknown): StudioReinvokePayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object.');
  }
  const record = body as Record<string, unknown>;
  const { invocationId } = record;
  if (typeof invocationId !== 'string' || invocationId.trim() === '') {
    throw new Error('Request body must include a non-empty "invocationId" string.');
  }
  if (!('payload' in record)) {
    throw new Error('Request body must include a "payload" (the edited event).');
  }
  return { invocationId, payload: record['payload'] };
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

/**
 * Resolve the {@link StackInfo} an ECS-service target id belongs to.
 *
 * A studio ECS target id is a CDK display path (`Stack/Construct/...`) or a
 * `Stack:LogicalId` form (the same shapes {@link resolveEcsServiceTarget}
 * accepts). We only need the owning stack so we can build that stack's
 * {@link EcsImageResolutionContext}. Returns `undefined` when the id has no
 * stack segment (single-stack app uses the lone stack) or the segment matches
 * no / multiple stacks — the caller then resolves without an image context,
 * which is exactly the no-`--from-cfn-stack` behavior.
 *
 * Exported for unit testing.
 */
export function resolveEcsServiceStack(
  targetId: string,
  stacks: StackInfo[]
): StackInfo | undefined {
  const parsed = parseEcsTarget(targetId);
  if (parsed.stackPattern === null) {
    return stacks.length === 1 ? stacks[0] : undefined;
  }
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  return matched.length === 1 ? matched[0] : undefined;
}

/** The subset of studio options the pin classifier forwards to the state-source helpers. */
export type LocalStateSourceLikeOptions = {
  fromCfnStack?: string | boolean;
  region?: string;
  profile?: string;
  stackRegion?: string;
  [key: string]: unknown;
};

/**
 * Pre-build the per-stack {@link EcsImageResolutionContext} map the boot-time
 * pin classifier needs (issue #354). `buildEcsImageResolutionContext` is
 * async (it may load deployed state / call STS), but the classify callback
 * `annotatePinnedEcsTargets` invokes is synchronous, so the contexts must be
 * materialized BEFORE classification.
 *
 * When `--from-cfn-stack` is NOT set, returns an empty map and the classifier
 * resolves against the synthed template only (the historical behavior). When
 * it IS set, for every distinct stack that owns a servable ECS service id this
 * builds a `LocalStateProvider` bound to THAT stack (so a multi-stack app with
 * bare `--from-cfn-stack` reads each stack's own CFn counterpart — the CFn
 * provider is stack-bound at construction, `load()` ignores its stack-name
 * argument), then builds + caches that stack's image-resolution context once.
 * Each per-stack provider is disposed before returning.
 *
 * A per-stack build failure is logged as a WARN and that stack maps to
 * `undefined` (resolve without an image context) rather than aborting boot.
 *
 * Exported for unit testing.
 */
export async function prepareEcsImageContexts(args: {
  serviceIds: string[];
  stacks: StackInfo[];
  options: LocalStateSourceLikeOptions;
  logger: ReturnType<typeof getLogger>;
}): Promise<Map<string, EcsImageResolutionContext | undefined>> {
  const { serviceIds, stacks, options, logger } = args;
  const contextByStack = new Map<string, EcsImageResolutionContext | undefined>();
  if (!isCfnFlagPresent(options)) return contextByStack;

  // The distinct owning stacks of the servable services, each built at most
  // once. An explicit `--from-cfn-stack <name>` binds the SINGLE named CFn
  // stack, so reject it up front when more than one stack owns a service (it
  // would silently mis-map logical IDs across siblings — same guard the
  // multi-stack serve commands apply); bare `--from-cfn-stack` is fine.
  const owningStacks: StackInfo[] = [];
  const seen = new Set<string>();
  for (const id of serviceIds) {
    // A malformed service id must NOT abort studio boot — skip it (the
    // classifier WARNs + leaves it unmarked too). In practice servable ids are
    // well-formed CDK display paths, so this is a defensive guard.
    let stack: StackInfo | undefined;
    try {
      stack = resolveEcsServiceStack(id, stacks);
    } catch {
      continue;
    }
    if (stack && !seen.has(stack.stackName)) {
      seen.add(stack.stackName);
      owningStacks.push(stack);
    }
  }
  rejectExplicitCfnStackWithMultipleStacks(options, owningStacks.length);

  for (const stack of owningStacks) {
    const stateProvider = createLocalStateProvider(
      options,
      stack.stackName,
      await resolveCfnFallbackRegion(options, stack.region)
    );
    try {
      // buildEcsImageResolutionContext reads `region` / `profile` off the bag
      // for the pseudo-parameter / state-load resolution; the studio options
      // carry both. The cast bridges to run-task's wider options shape (the
      // extra required fields like `cluster` are not read by this code path).
      const ctx = await buildEcsImageResolutionContext(
        stack,
        stateProvider,
        options as unknown as Parameters<typeof buildEcsImageResolutionContext>[2]
      );
      contextByStack.set(stack.stackName, ctx);
    } catch (err) {
      logger.warn(
        `studio: could not build deployed-state image context for stack '${stack.stackName}'; ` +
          `ECS services in it resolve against the synthed template only. ${
            err instanceof Error ? err.message : String(err)
          }`
      );
      contextByStack.set(stack.stackName, undefined);
    } finally {
      stateProvider?.dispose();
    }
  }
  return contextByStack;
}

/**
 * Build the boot-time ECS pin classifier `annotatePinnedEcsTargets` calls per
 * servable service (issue #354). When `--from-cfn-stack` is set, a service
 * whose container image is an INTRINSIC ECR URI (e.g.
 * `ContainerImage.fromEcrRepository(repo)`) is only resolvable WITH the
 * deployed-state image-resolution context — without it the resolver throws
 * and the service was silently left unmarked, so the UI never offered the
 * image-override picker even though `cdkl start-service --from-cfn-stack`
 * detects the very same pin. This threads each service's owning-stack
 * {@link EcsImageResolutionContext} (pre-built by
 * {@link prepareEcsImageContexts}) into {@link resolveEcsServiceTarget} so
 * the pin resolves, and surfaces a WARN (not a silent DEBUG swallow) when a
 * service still cannot be classified.
 *
 * The classifier is re-run whenever the Session-bar `--from-cfn-stack` binding
 * changes (`PATCH /api/config`), so the pickers appear / disappear under the
 * new binding without restarting studio (issue #385) — `classifyTargets`
 * re-invokes this against a fresh clone of the un-annotated target groups.
 *
 * Returns a `(id) => boolean` callback (true = pinned). Exported for testing.
 */
export function makePinClassifier(args: {
  stacks: StackInfo[];
  contextByStack: Map<string, EcsImageResolutionContext | undefined>;
  logger: ReturnType<typeof getLogger>;
}): (id: string) => boolean {
  const { stacks, contextByStack, logger } = args;
  return (id: string): boolean => {
    try {
      const stack = resolveEcsServiceStack(id, stacks);
      const context = stack ? contextByStack.get(stack.stackName) : undefined;
      return !isLocalCdkAssetImage(resolveEcsServiceTarget(id, stacks, context));
    } catch (err) {
      // Replaces the prior silent DEBUG swallow (issue #354): a service that
      // cannot be pin-classified is surfaced, not invisibly left unmarked, so
      // a misconfigured / unresolvable image is visible at boot.
      logger.warn(
        `studio: could not classify image-pin status for ECS service '${id}'; leaving it unmarked ` +
          `(the image-override picker will not be offered). ${
            err instanceof Error ? err.message : String(err)
          }`
      );
      return false;
    }
  };
}

/**
 * Build the boot-time pin classifier {@link annotateEcsTaskPinnedTargets} calls
 * per `ecs-task` task definition (issue #388) — the counterpart of
 * {@link makePinClassifier} for task defs. Resolves the task via
 * {@link resolveEcsTaskTarget} (threading the owning stack's
 * {@link EcsImageResolutionContext} so an INTRINSIC-ECR image resolves under
 * `--from-cfn-stack`, same as the service path) and classifies its
 * representative container (first essential, else first) as a deployed-registry
 * pin when the image kind is not `cdk-asset`. A task def that cannot be
 * classified is WARN-logged (not silently swallowed) and left unmarked.
 *
 * Returns a `(id) => boolean` callback (true = pinned). Exported for testing.
 */
export function makeTaskPinClassifier(args: {
  stacks: StackInfo[];
  contextByStack: Map<string, EcsImageResolutionContext | undefined>;
  logger: ReturnType<typeof getLogger>;
}): (id: string) => boolean {
  const { stacks, contextByStack, logger } = args;
  return (id: string): boolean => {
    try {
      const stack = resolveEcsServiceStack(id, stacks);
      const context = stack ? contextByStack.get(stack.stackName) : undefined;
      const task = resolveEcsTaskTarget(id, stacks, context);
      const representative = task.containers.find((c) => c.essential) ?? task.containers[0];
      return representative !== undefined && representative.image.kind !== 'cdk-asset';
    } catch (err) {
      logger.warn(
        `studio: could not classify image-pin status for ECS task definition '${id}'; leaving it ` +
          `unmarked (the image-override picker will not be offered). ${
            err instanceof Error ? err.message : String(err)
          }`
      );
      return false;
    }
  };
}

/**
 * Build the boot-time resolver `annotateAlbPinnedBackingServices` calls per
 * `alb` entry (issue #384). It resolves the ALB to its backing ECS services
 * (`resolveAlbFrontDoor`, template-only) and returns the subset that is in
 * `pinnedEcsByQualifiedId` — the `ecs` services already classified as a
 * deployed-registry pin by {@link makePinClassifier}. Each returned `id` is the
 * service's `Stack:LogicalId` (the `--image-override` key `start-alb` matches
 * against its own service-boot target); `label` is the pinned service's display
 * id. An ALB that cannot be resolved is WARN-logged + contributes no pickers
 * (the start-alb run still works; only the picker is absent). Exported for
 * testing.
 */
export function makeAlbBackingPinnedResolver(args: {
  stacks: StackInfo[];
  pinnedEcsByQualifiedId: Map<string, string>;
  logger: ReturnType<typeof getLogger>;
}): (albEntry: { id: string; qualifiedId: string }) => { id: string; label: string }[] {
  const { stacks, pinnedEcsByQualifiedId, logger } = args;
  return (albEntry) => {
    // No pinned ecs services => nothing an ALB picker could rebuild.
    if (pinnedEcsByQualifiedId.size === 0) return [];
    try {
      const { stack, albLogicalId } = resolveAlbTarget(albEntry.id, stacks);
      const resolution = resolveAlbFrontDoor(stack, albLogicalId);
      // Collect the distinct ECS-service targets the ALB forwards to (default
      // action + every rule action; redirect / fixed-response / lambda targets
      // carry no backing ECS service).
      const serviceQualifiedIds = new Set<string>();
      for (const listener of resolution.listeners) {
        const actions = [
          ...(listener.defaultAction ? [listener.defaultAction] : []),
          ...listener.rules.map((r) => r.action),
        ];
        for (const action of actions) {
          if (action.kind !== 'forward') continue;
          for (const t of action.targets) {
            if (t.kind === 'ecs') {
              serviceQualifiedIds.add(`${stack.stackName}:${t.serviceLogicalId}`);
            }
          }
        }
      }
      const out: { id: string; label: string }[] = [];
      for (const qid of serviceQualifiedIds) {
        const label = pinnedEcsByQualifiedId.get(qid);
        if (label !== undefined) out.push({ id: qid, label });
      }
      return out;
    } catch (err) {
      logger.warn(
        `studio: could not resolve ALB '${albEntry.id}' backing services for the image-override ` +
          `picker; the alb composer will not offer one. ${
            err instanceof Error ? err.message : String(err)
          }`
      );
      return [];
    }
  };
}

/**
 * Classify the studio target list for a given `--from-cfn-stack` binding
 * (issue #385): annotate a FRESH clone of the un-annotated base groups with the
 * `pinned` (ecs services) + `backingPinnedServices` (alb entries) image-override
 * hints, and scan the app dir for Dockerfiles when at least one target is
 * pinned. Returns the annotated groups + dockerfiles; the un-annotated
 * `baseGroups` argument is left untouched so it can be re-classified under a
 * different binding (the Session-bar `--from-cfn-stack` change path —
 * `PATCH /api/config` — re-runs this and swaps the served target list, so the
 * pickers appear without restarting studio). Runs once at boot and again per
 * binding change.
 *
 * The clone means a re-classify never inherits stale pins; the `fromCfnStack`
 * override is threaded into the state-source options so the pin classifier
 * resolves INTRINSIC-ECR images against the right (or no) deployed stack
 * (issue #354). Exported for unit testing.
 */
export async function classifyStudioTargets(args: {
  baseGroups: StudioTargetGroup[];
  stacks: StackInfo[];
  servableEcs: ReadonlySet<string>;
  options: LocalStateSourceLikeOptions;
  fromCfnStack: string | boolean | undefined;
  logger: ReturnType<typeof getLogger>;
}): Promise<{ groups: StudioTargetGroup[]; dockerfiles: string[] }> {
  const { baseGroups, stacks, servableEcs, options, fromCfnStack, logger } = args;
  const groups = structuredClone(baseGroups) as StudioTargetGroup[];
  // Re-bind the state-source options to the CURRENT `--from-cfn-stack` so the
  // pin classifier resolves intrinsic-ECR images against the right (or no)
  // deployed stack. `createLocalStateProvider` reads `fromCfnStack` / `profile`
  // / region off this bag. `as` (not an annotation): with
  // exactOptionalPropertyTypes a literal whose `fromCfnStack` may be `undefined`
  // cannot be assigned to the optional-but-non-undefined field; an undefined /
  // false value reads as "no --from-cfn-stack" via `isCfnFlagPresent`.
  const classifyOptions = { ...options, fromCfnStack } as LocalStateSourceLikeOptions;
  // Build the deployed-state image-resolution context per owning stack for the
  // servable ECS services AND the ECS task definitions (issue #388), so an
  // INTRINSIC-ECR image on EITHER resolves under `--from-cfn-stack`. The
  // contexts are keyed by stack name, so a task def sharing a stack with a
  // service reuses the same context.
  const taskDefIds = (baseGroups.find((g) => g.kind === 'ecs-task')?.entries ?? []).map(
    (e) => e.id
  );
  const contextByStack = await prepareEcsImageContexts({
    serviceIds: [...servableEcs, ...taskDefIds],
    stacks,
    options: classifyOptions,
    logger,
  });
  const anyPinned = annotatePinnedEcsTargets(
    groups,
    makePinClassifier({ stacks, contextByStack, logger })
  );
  // Issue #388 — classify ECS task definitions (the `ecs-task` kind) too, so a
  // pinned task-def image gets the same image-override picker. The `ecs-task`
  // composer spawns `cdkl run-task`, which accepts `--image-override`.
  const anyTaskPinned = annotateEcsTaskPinnedTargets(
    groups,
    makeTaskPinClassifier({ stacks, contextByStack, logger })
  );
  const pinnedEcsByQualifiedId = new Map<string, string>();
  for (const g of groups) {
    if (g.kind !== 'ecs') continue;
    for (const e of g.entries) {
      if (e.pinned) pinnedEcsByQualifiedId.set(e.qualifiedId, e.id);
    }
  }
  const anyAlbBackingPinned = annotateAlbPinnedBackingServices(
    groups,
    makeAlbBackingPinnedResolver({ stacks, pinnedEcsByQualifiedId, logger })
  );
  const dockerfiles =
    anyPinned || anyTaskPinned || anyAlbBackingPinned ? discoverDockerfiles(process.cwd()) : [];
  return { groups, dockerfiles };
}

/**
 * Re-classify the studio target list when the Session-bar `--from-cfn-stack`
 * binding changes (issue #385), and swap the served list via `applyTargets`.
 * The orchestration the `PATCH /api/config` handler runs, extracted so its
 * branches are unit-testable without booting the studio server:
 *
 *  - **change gate**: returns immediately when `after === before` (a watch /
 *    assume-role toggle does not change the pin classification);
 *  - **latest-wins**: bumps `tokenRef.current` before the async `classify` and
 *    applies the result ONLY if its token is still current — so a slow earlier
 *    re-classify cannot clobber a newer binding's result when patches arrive in
 *    quick succession;
 *  - **fail-soft**: a `classify` rejection is WARN-logged and the previous
 *    target list is kept (never throws — the PATCH still returns the config).
 *
 * `after` (the post-patch binding) is threaded into `classify`, never the boot
 * value, so the pin classifier resolves against the new stack. Exported for
 * unit testing.
 */
export async function reclassifyTargetsOnBindingChange(args: {
  before: string | boolean | undefined;
  after: string | boolean | undefined;
  classify: (
    fromCfnStack: string | boolean | undefined
  ) => Promise<{ groups: StudioTargetGroup[]; dockerfiles: string[] }>;
  applyTargets: (groups: StudioTargetGroup[], dockerfiles: string[]) => void;
  tokenRef: { current: number };
  logger: ReturnType<typeof getLogger>;
}): Promise<void> {
  const { before, after, classify, applyTargets, tokenRef, logger } = args;
  if (after === before) return;
  logger.info('--from-cfn-stack binding changed; re-classifying targets...');
  const myToken = ++tokenRef.current;
  try {
    const { groups, dockerfiles } = await classify(after);
    if (myToken === tokenRef.current) applyTargets(groups, dockerfiles);
  } catch (err) {
    logger.warn(
      'studio: could not re-classify targets after a --from-cfn-stack change; the target ' +
        `list keeps its previous pins (restart studio to retry). ${
          err instanceof Error ? err.message : String(err)
        }`
    );
  }
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
  /**
   * Host-injected extra state-source flag fields (parity with `run-task`'s
   * options bag) — read by {@link createLocalStateProvider} /
   * {@link prepareEcsImageContexts} for the boot-time ECS pin classification
   * under `--from-cfn-stack` (issue #354).
   */
  [key: string]: unknown;
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

  // Mark servable ECS services / ALB-backing services whose image is a
  // deployed-registry pin (ECR / public) rather than a local CDK asset
  // (issue #301 / #384). A pinned image does NOT pick up local source edits,
  // so the UI offers an image-override Dockerfile picker for those targets; a
  // local-asset service already hot-reloads under `--watch` and gets no picker.
  //
  // Classification reads the synthed template by default. Under
  // `--from-cfn-stack`, an ECR image expressed as an INTRINSIC URI (e.g.
  // `ContainerImage.fromEcrRepository(repo)`) is ONLY resolvable with the
  // deployed-state image-resolution context — the same context `cdkl run-task`
  // / `start-service --from-cfn-stack` build. So we build a `LocalStateProvider`
  // and thread each service's owning-stack `EcsImageResolutionContext` into the
  // resolver; without it the service would silently stay unmarked even though
  // start-service detects the pin (issue #354). The hint only governs whether
  // the UI surfaces the picker; a mis-hinted service can still be overridden via
  // the "All options" raw-args `--image-override`. A service that still cannot
  // be classified is WARN-logged (not silently swallowed). Dockerfiles are
  // scanned once per classify, only when at least one target is pinned, so an
  // all-local app pays nothing.
  //
  // Factored into `classifyTargets(fromCfnStack)` so the SAME path runs at boot
  // AND on a Session-bar `--from-cfn-stack` change (`PATCH /api/config`, issue
  // #385): the classify annotations (`pinned` / `backingPinnedServices`) are
  // added to a FRESH clone of the un-annotated base each call, so a re-classify
  // under a new binding never inherits stale pins from the prior one. The ALB
  // picker (issue #384) intersects each ALB's backing ECS services with the
  // pinned `ecs` set classified above; its key is `start-alb`'s own
  // `Stack:LogicalId` service-boot target.
  const baseTargetGroups = targetGroups;
  const classifyTargets = (
    fromCfnStack: string | boolean | undefined
  ): Promise<{ groups: StudioTargetGroup[]; dockerfiles: string[] }> =>
    classifyStudioTargets({
      baseGroups: baseTargetGroups,
      stacks,
      servableEcs,
      options,
      fromCfnStack,
      logger,
    });

  // Boot-time classification under the CLI `--from-cfn-stack` value.
  const { groups: initialGroups, dockerfiles: initialDockerfiles } = await classifyTargets(
    options.fromCfnStack
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

  // The running server, captured AFTER `startStudioServer` resolves so the
  // `patchConfig` handler (defined inline below) can call `setTargets` on it
  // to swap the target list under the live socket when `--from-cfn-stack`
  // changes (issue #385). The handler only fires at run-time, by which point
  // this is assigned. A monotonic token makes re-classification latest-wins so
  // a slow earlier classify cannot clobber a newer binding's result.
  let serverRef: RunningStudioServer | undefined;
  // Monotonic re-classification token (latest-wins). Held in a ref object so
  // {@link reclassifyTargetsOnBindingChange} can bump + compare it across
  // overlapping PATCHes without recreating the closure.
  const reclassifyToken = { current: 0 };

  const server = await startStudioServer({
    port,
    bus,
    targetGroups: initialGroups,
    dockerfiles: initialDockerfiles,
    appLabel,
    cliName: getEmbedConfig().cliName,
    store,
    // `/api/run`: a Lambda or an AgentCore runtime is a single-shot invoke;
    // api / alb / ecs / ecs-task / cloudfront are long-running serve starts.
    // The kind→runner routing lives in `routeStudioRun` (unit-tested).
    onRun: (body) =>
      routeStudioRun(coerceRunRequest(body), { dispatcher, serveManager, servableEcs }),
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
    // `/api/reinvoke`: re-run a past Lambda / AgentCore row with an edited
    // payload (issue #284). Resolves the source target from the store and
    // re-dispatches through the SAME single-shot dispatcher, threading
    // `reinvokeOf` so the new timeline row links to its source. A served
    // request is re-sent client-side via the request composer instead.
    onReinvoke: (body) => {
      const { invocationId, payload } = coerceReinvokeRequest(body);
      return reinvoke({ invocationId, payload }, { store, dispatcher });
    },
    getRunning: () => ({ running: serveManager.list() }),
    getConfig: () => sessionConfigSnapshot(),
    patchConfig: async (body) => {
      // Mutates the shared childConfig the dispatcher + serve-manager read
      // per-run, so the new binding applies to subsequent invokes / serves.
      const beforeFromCfn = childConfig.fromCfnStack;
      applyConfigPatch(body, childConfig);
      // A `--from-cfn-stack` change re-runs the ECS image-pin classification +
      // swaps the served target list under the live socket (issue #385); other
      // edits (assume-role / watch) skip it. The post-patch `childConfig.
      // fromCfnStack` is the new binding to classify against.
      await reclassifyTargetsOnBindingChange({
        before: beforeFromCfn,
        after: childConfig.fromCfnStack,
        classify: classifyTargets,
        applyTargets: (groups, dockerfiles) => serverRef?.setTargets(groups, dockerfiles),
        tokenRef: reclassifyToken,
        logger,
      });
      return sessionConfigSnapshot();
    },
  });
  serverRef = server;

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

  // Keep the control plane alive across a stray error (issue #346): a single
  // unhandled rejection / exception anywhere in the long-running studio process
  // would otherwise crash it, after which the browser sees "Failed to fetch"
  // and Stop / teardown stop responding. Log loudly and continue. Installed
  // only now that the server is listening, so genuine startup / bind errors
  // still propagate; removed on shutdown so it never leaks (e.g. for a host
  // CLI embedding studio).
  const uninstallGuard = installStudioResilienceGuard(logger);
  try {
    await blockUntilShutdown(server, serveManager, store, cliName);
  } finally {
    uninstallGuard();
  }
}

/**
 * Install process-level `uncaughtException` / `unhandledRejection` handlers
 * that LOG and continue (instead of crashing the studio process), returning an
 * uninstaller. studio is a long-running local dev control plane — a stray error
 * from one bad request must not take down the whole console (issue #346). This
 * also backstops the Ctrl-C SSE-socket-destroy race the streaming handler works
 * around. Genuine fatal conditions are still visible in the log. Exported for
 * unit testing; not a host-facing library API (not re-exported from
 * `src/index.ts` / `src/internal.ts`).
 */
export function installStudioResilienceGuard(logger: ReturnType<typeof getLogger>): () => void {
  const describe = (e: unknown): string => (e instanceof Error ? e.stack || e.message : String(e));
  const onUncaught = (err: unknown): void => {
    logger.warn(`studio caught an unexpected error and is continuing: ${describe(err)}`);
  };
  const onRejection = (reason: unknown): void => {
    logger.warn(
      `studio caught an unhandled promise rejection and is continuing: ${describe(reason)}`
    );
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return (): void => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
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
