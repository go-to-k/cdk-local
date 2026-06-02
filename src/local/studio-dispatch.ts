import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioEventBus, type StudioTargetKind } from './studio-events.js';

/** A request to run a target, as the studio UI posts it to `/api/run`. */
export interface StudioRunRequest {
  /** Target id the user picked (display path or stack-qualified id). */
  targetId: string;
  /** Target kind. Slice B handles `'lambda'` (single-shot invoke) only. */
  kind: StudioTargetKind;
  /** The event payload to invoke with. */
  event: unknown;
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
export interface StudioDispatchConfig {
  /** Path to the `cdkl` CLI entry (`dist/cli.js`) — usually `process.argv[1]`. */
  cliEntry: string;
  /** The shared event bus; invocation + log events are emitted onto it. */
  bus: StudioEventBus;
  /** Working directory for the child invoke (defaults to `process.cwd()`). */
  cwd?: string;
  /** `--app` value to thread into the child invoke, if studio was given one. */
  app?: string;
  /** `-c key=value` context overrides to thread through. */
  context?: Record<string, string>;
  /** `--profile` to thread through. */
  profile?: string;
  /** `--region` to thread through. */
  region?: string;
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
 * Build the studio run dispatcher. Slice B drives a single-shot Lambda
 * invoke by spawning the SAME `cdkl invoke` the headless command runs —
 * studio is a control plane over the CLI, so re-using the whole command
 * (rather than re-wiring its internals) guarantees byte-for-byte parity
 * and keeps all of `cdkl invoke`'s process-global behavior
 * (`process.exit`, env mutation, stdin) isolated in a child process.
 *
 * The child's stdout is the Lambda response payload; its stderr (status
 * + container logs) is streamed line-by-line onto the bus as `log`
 * events. An `invocation` start event is emitted before spawn and an end
 * event (with response + status + duration) after exit, both keyed by
 * the same correlation id so the UI threads them into one timeline row.
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

    if (req.kind !== 'lambda') {
      // Serve targets (API / ALB / ECS) arrive in slice C; reject clearly
      // rather than silently mis-dispatching.
      const error = `Running '${req.kind}' targets from studio is not supported yet (Lambda only).`;
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

      const args = ['invoke', req.targetId, '--event', eventFile];
      if (config.app) args.push('--app', config.app);
      if (config.profile) args.push('--profile', config.profile);
      if (config.region) args.push('--region', config.region);
      for (const [k, v] of Object.entries(config.context ?? {})) {
        args.push('-c', `${k}=${v}`);
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
      const failure = stderr.trim() || `cdkl invoke exited ${code}`;

      // `cdkl invoke` interleaves synth progress + streamed container logs on
      // stdout and writes the Lambda response there too. The RIE response is
      // always a single line of valid JSON (the serialized handler return
      // value or error object), whereas progress / container lines
      // (`Synthesizing…`, `Starting container…`, `START/END/REPORT`) are NOT
      // JSON — so the response is the LAST JSON-parseable stdout line, which is
      // robust against a container log line flushing AFTER the response. Every
      // other stdout line is surfaced as a log event. Falls back to the last
      // line when nothing parses (an unusual non-JSON / empty response).
      const stdoutLines = stdout
        .split('\n')
        .map((l) => l.replace(/\r$/, '').trimEnd())
        .filter((l) => l.trim().length > 0);

      let responseIdx = -1;
      let response: unknown;
      if (ok) {
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
      } else {
        response = failure;
      }

      // Every stdout line that is not the response line is a log line.
      stdoutLines.forEach((line, i) => {
        if (i === responseIdx) return;
        config.bus.emit('log', {
          ts: clock(),
          containerId: invocationId,
          target: req.targetId,
          line,
          stream: 'stdout',
        });
      });

      const raw = responseIdx >= 0 ? (stdoutLines[responseIdx] ?? '') : '';
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
      child = spawnFn(nodeBin, argv, { cwd });
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

/** Try to JSON-parse `raw`; `ok` distinguishes a parsed value from a failure. */
function tryParseJson(raw: string): { ok: boolean; value: unknown } {
  if (raw === '') return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: undefined };
  }
}
