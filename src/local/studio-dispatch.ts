import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioEventBus, type StudioTargetKind } from './studio-events.js';
import { buildSharedChildArgs, type SharedChildConfig } from './studio-child-args.js';
import { buildPerRunArgs, resolveEnvVars, type OptionValues } from './studio-option-specs.js';

/**
 * The single-shot invoke kinds this dispatcher drives, mapped to the `cdkl`
 * subcommand each spawns. `lambda` -> `cdkl invoke`; `agentcore` ->
 * `cdkl invoke-agentcore` (issue #301 / #303). Serve kinds (api / alb / ecs)
 * are NOT here — they are long-running and handled by the serve manager.
 */
const INVOKE_VERBS: Partial<Record<StudioTargetKind, string>> = {
  lambda: 'invoke',
  agentcore: 'invoke-agentcore',
};

/** A request to run a target, as the studio UI posts it to `/api/run`. */
export interface StudioRunRequest {
  /** Target id the user picked (display path or stack-qualified id). */
  targetId: string;
  /**
   * Target kind. This dispatcher drives the single-shot invoke kinds —
   * `'lambda'` (`cdkl invoke`) and `'agentcore'` (`cdkl invoke-agentcore`).
   * Serve kinds (api / alb / ecs) go to the serve manager instead.
   */
  kind: StudioTargetKind;
  /** The event payload to invoke with. */
  event: unknown;
  /** Per-run option values (issue #301 slice 2), keyed by option flag. */
  options?: OptionValues;
}

/** The outcome of a single-shot run, returned from `/api/run`. */
export interface StudioRunResult {
  /** Correlation id shared with the emitted invocation events. */
  invocationId: string;
  /** Whether the underlying `cdkl invoke` exited 0. */
  ok: boolean;
  /**
   * Synthetic status for the timeline: 200 when the invoke succeeded,
   * 500 when it failed. A direct Lambda invoke has no HTTP status; this
   * is the UI's success/failure signal only.
   */
  status: number;
  /** Parsed Lambda response (JSON when parseable, else the raw string). */
  response?: unknown;
  /** Raw stdout payload from `cdkl invoke`. */
  raw?: string;
  /** Error summary when the invoke failed. */
  error?: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

/** Config for {@link createStudioDispatcher}. */
export interface StudioDispatchConfig extends SharedChildConfig {
  /** Path to the `cdkl` CLI entry (`dist/cli.js`) — usually `process.argv[1]`. */
  cliEntry: string;
  /** The shared event bus; invocation + log events are emitted onto it. */
  bus: StudioEventBus;
  /** Working directory for the child invoke (defaults to `process.cwd()`). */
  cwd?: string;
  /** Node binary to spawn (defaults to `process.execPath`; injectable for tests). */
  nodeBin?: string;
  /** Spawn implementation (injectable for tests). */
  spawnFn?: typeof nodeSpawn;
  /** Clock (injectable for tests; defaults to `Date.now`). */
  clock?: () => number;
  /** Invocation-id factory (injectable for tests). */
  idFactory?: () => string;
}

/** A bound dispatcher exposing the `/api/run` handler. */
export interface StudioDispatcher {
  run: (req: StudioRunRequest) => Promise<StudioRunResult>;
}

let idCounter = 0;

/**
 * Build the studio run dispatcher. It drives a single-shot invoke by
 * spawning the SAME headless command the CLI runs — `cdkl invoke` for a
 * `lambda` target, `cdkl invoke-agentcore` for an `agentcore` target —
 * because studio is a control plane over the CLI; re-using the whole
 * command (rather than re-wiring its internals) guarantees byte-for-byte
 * parity and keeps all of the command's process-global behavior
 * (`process.exit`, env mutation, stdin) isolated in a child process.
 *
 * The child's stdout carries the response (the Lambda return value, or the
 * AgentCore agent's streamed output); its stderr (status + diagnostics) is
 * streamed line-by-line onto the bus as `log` events. An `invocation` start
 * event is emitted before spawn and an end event (with response + status +
 * duration) after exit, both keyed by the same correlation id so the UI
 * threads them into one timeline row.
 *
 * The two kinds differ only in how the response is recovered from stdout
 * (a Lambda RIE prints exactly one JSON response line interleaved with
 * container logs; an AgentCore agent streams its whole output to stdout) —
 * see {@link extractResponse}.
 */
export function createStudioDispatcher(config: StudioDispatchConfig): StudioDispatcher {
  const spawnFn = config.spawnFn ?? nodeSpawn;
  const nodeBin = config.nodeBin ?? process.execPath;
  const clock = config.clock ?? Date.now;
  const idFactory =
    config.idFactory ??
    (() => {
      idCounter += 1;
      return `inv-${clock()}-${idCounter}`;
    });

  async function run(req: StudioRunRequest): Promise<StudioRunResult> {
    const invocationId = idFactory();
    const startedAt = clock();

    const verb = INVOKE_VERBS[req.kind];
    if (verb === undefined) {
      // Serve targets (api / alb / ecs) are long-running and dispatched by
      // the serve manager, not here; reject clearly rather than silently
      // mis-dispatching.
      const error = `'${req.kind}' targets are not single-shot invokes (served via start-* instead).`;
      config.bus.emit('invocation', {
        id: invocationId,
        ts: startedAt,
        target: req.targetId,
        kind: req.kind,
        label: 'invoke',
        request: req.event,
        response: error,
        status: 501,
        durationMs: clock() - startedAt,
      });
      return { invocationId, ok: false, status: 501, error, durationMs: clock() - startedAt };
    }

    config.bus.emit('invocation', {
      id: invocationId,
      ts: startedAt,
      target: req.targetId,
      kind: req.kind,
      label: 'invoke',
      request: req.event,
    });

    // `dir` is created inside the try so a `writeFileSync` / `JSON.stringify`
    // throw still hits the finally that cleans it up.
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), 'cdkl-studio-run-'));
      const eventFile = join(dir, 'event.json');
      writeFileSync(eventFile, JSON.stringify(req.event ?? {}));

      const args = [
        verb,
        req.targetId,
        '--event',
        eventFile,
        ...buildSharedChildArgs(config),
        ...buildPerRunArgs(req.kind, req.options),
      ];

      // The `--env-vars` per-run option takes a FILE — materialize the UI's
      // KV rows / JSON into a SAM-shape temp file (in the same auto-cleaned
      // dir as the event) and point the child at it.
      const envVars = resolveEnvVars(req.kind, req.options);
      if (envVars) {
        const envFile = join(dir, 'env-vars.json');
        writeFileSync(envFile, JSON.stringify(envVars));
        args.push('--env-vars', envFile);
      }

      const { code, stdout, stderr } = await runChild(
        spawnFn,
        nodeBin,
        [config.cliEntry, ...args],
        config.cwd ?? process.cwd(),
        invocationId,
        req.targetId,
        config.bus,
        clock
      );

      const durationMs = clock() - startedAt;
      const ok = code === 0;
      const failure = stderr.trim() || `cdkl ${verb} exited ${code}`;

      const { response, raw, stdoutLogLines } = extractResponse(req.kind, stdout, ok, failure);

      // Surface the stdout lines that are NOT the response as log events
      // (Lambda container logs; AgentCore has none — its whole stdout is the
      // response, so stdoutLogLines is empty there).
      stdoutLogLines.forEach((line) => {
        config.bus.emit('log', {
          ts: clock(),
          containerId: invocationId,
          target: req.targetId,
          line,
          stream: 'stdout',
        });
      });

      const status = ok ? 200 : 500;

      config.bus.emit('invocation', {
        id: invocationId,
        ts: startedAt,
        target: req.targetId,
        kind: req.kind,
        label: 'invoke',
        request: req.event,
        response,
        status,
        durationMs,
      });

      const result: StudioRunResult = { invocationId, ok, status, durationMs };
      if (raw) result.raw = raw;
      if (response !== undefined) result.response = response;
      if (!ok) result.error = failure;
      return result;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  return { run };
}

interface ChildOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the child invoke, accumulate stdout, and stream stderr to the
 * bus line-by-line as `log` events. Resolves on process close.
 */
function runChild(
  spawnFn: typeof nodeSpawn,
  nodeBin: string,
  argv: string[],
  cwd: string,
  invocationId: string,
  target: string,
  bus: StudioEventBus,
  clock: () => number
): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      // Silence cdk-local's OWN synth / orchestration progress in the child
      // (toolkit "Successfully synthesized to ...", asset-bundling, info-level
      // status) so the studio LOGS panel shows only the Lambda container's
      // runtime logs (which stream straight from `docker logs`, unaffected by
      // this level) plus the response. See `resolveConfiguredLogLevel`.
      child = spawnFn(nodeBin, argv, {
        cwd,
        env: { ...process.env, CDKL_LOG_LEVEL: 'warn' },
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let lineBuf = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      lineBuf += chunk;
      let nl = lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.length > 0) {
          bus.emit('log', {
            ts: clock(),
            containerId: invocationId,
            target,
            line,
            stream: 'stderr',
          });
        }
        nl = lineBuf.indexOf('\n');
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (lineBuf.length > 0) {
        bus.emit('log', {
          ts: clock(),
          containerId: invocationId,
          target,
          line: lineBuf,
          stream: 'stderr',
        });
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** The response recovered from a child's stdout, plus the leftover log lines. */
interface ExtractedResponse {
  /** The response value to thread into the timeline (parsed JSON or raw text). */
  response: unknown;
  /** The single raw stdout line / text the response was recovered from. */
  raw: string;
  /** Stdout lines that are NOT the response — surfaced as `log` events. */
  stdoutLogLines: string[];
}

/**
 * Recover the response from a child's accumulated stdout, per target kind.
 * On failure (`ok === false`) the response is the `failure` summary for every
 * kind and no stdout is treated as the response.
 *
 * - **lambda**: `cdkl invoke` interleaves container logs (`START`/`END`/
 *   `REPORT`, handler `console.log`) with the RIE response on stdout. The
 *   response is always a single line of valid JSON, so it is the LAST
 *   JSON-parseable stdout line (robust against a container log line flushing
 *   AFTER the response); every other line is a log. Falls back to the last
 *   line when nothing parses (an unusual non-JSON / empty response).
 * - **agentcore**: `cdkl invoke-agentcore` streams the agent's WHOLE output to
 *   stdout (HTTP SSE chunks / MCP-A2A JSON-RPC result / `--ws` frames) and
 *   nothing else (synth progress is silenced to stderr by `CDKL_LOG_LEVEL`),
 *   so the entire stdout IS the response — parsed as JSON when it parses
 *   whole (a single MCP result), else kept as the raw streamed text. There
 *   are no separate stdout log lines.
 */
function extractResponse(
  kind: StudioTargetKind,
  stdout: string,
  ok: boolean,
  failure: string
): ExtractedResponse {
  if (kind === 'agentcore') {
    const text = stdout.trim();
    if (!ok) return { response: failure, raw: '', stdoutLogLines: [] };
    const parsed = tryParseJson(text);
    return { response: parsed.ok ? parsed.value : text, raw: text, stdoutLogLines: [] };
  }

  // lambda (and any other future single-line-JSON-response kind)
  const stdoutLines = stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trimEnd())
    .filter((l) => l.trim().length > 0);

  if (!ok) {
    return { response: failure, raw: '', stdoutLogLines: stdoutLines };
  }

  let responseIdx = -1;
  let response: unknown;
  for (let i = stdoutLines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseJson(stdoutLines[i] ?? '');
    if (parsed.ok) {
      responseIdx = i;
      response = parsed.value;
      break;
    }
  }
  if (responseIdx === -1 && stdoutLines.length > 0) {
    responseIdx = stdoutLines.length - 1;
    response = stdoutLines[responseIdx];
  }

  const raw = responseIdx >= 0 ? (stdoutLines[responseIdx] ?? '') : '';
  const stdoutLogLines = stdoutLines.filter((_, i) => i !== responseIdx);
  return { response, raw, stdoutLogLines };
}

/** Try to JSON-parse `raw`; `ok` distinguishes a parsed value from a failure. */
function tryParseJson(raw: string): { ok: boolean; value: unknown } {
  if (raw === '') return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: undefined };
  }
}
