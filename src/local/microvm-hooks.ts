import { request } from 'http';
import { randomUUID } from 'crypto';
import { CdkLocalError } from '../utils/error-handler.js';
import { displayToolOutput } from '../utils/ident-display.js';
import { formatAuthority } from '../utils/url-authority.js';
import type { MicrovmBuildHook, MicrovmHookName, MicrovmRuntimeHook } from './microvm-image.js';
import { probeHttp, type ProbeOutcome } from './web-function-runner.js';

/** Where every lifecycle hook is served, on `Hooks.Port`. */
export const MICROVM_HOOK_PATH_PREFIX = '/aws/lambda-microvms/runtime/v1/';

/** The largest `runHookPayload` `run-microvm` accepts (16 KB). */
export const MAX_RUN_HOOK_PAYLOAD_BYTES = 16 * 1024;

/** How long a refused / 503 build hook waits before the next attempt. */
export const HOOK_RETRY_INTERVAL_MS = 250;

/** One hook POST's result. */
export type HookPostResult =
  | { kind: 'status'; status: number; body: string }
  /** Refused or reset: nothing listens on the hooks port (yet). */
  | { kind: 'refused' }
  /** The request was held open past its deadline. */
  | { kind: 'timeout' };

/** Seams for the hook driver, injectable in unit tests. */
export interface MicrovmHookDeps {
  post: (
    host: string,
    port: number,
    path: string,
    body: string | undefined,
    timeoutMs: number
  ) => Promise<HookPostResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Whether the container still runs; a build hook poll fails fast once it does not. */
  isAlive?: () => Promise<boolean>;
}

/** The host:port cdk-local reaches the container's `Hooks.Port` on. */
export interface HookEndpoint {
  host: string;
  port: number;
}

/** A hook failed; the message names the hook, the answer and the next step. */
export class MicrovmHookError extends CdkLocalError {
  constructor(message: string, code: string = 'LOCAL_START_MICROVM_HOOK_FAILED') {
    super(message, code);
    this.name = 'MicrovmHookError';
    Object.setPrototypeOf(this, MicrovmHookError.prototype);
  }
}

/** A generated MicroVM id, shaped as the cloud's (`mvm-<uuid>`). */
export function generateMicrovmId(): string {
  return `mvm-${randomUUID()}`;
}

/** The `/run` hook's request body: `{ microvmId, runHookPayload }`, the payload only when given. */
export function runHookBody(microvmId: string, runHookPayload: string | undefined): string {
  return JSON.stringify({
    microvmId,
    ...(runHookPayload !== undefined && { runHookPayload }),
  });
}

/**
 * Poll a build hook (`/ready` or `/validate`) the way the image build does:
 * 503 — and, locally, a refused connection while the app is still starting —
 * means "not yet" and is retried until `timeoutMs`; 200 means done; any other
 * status fails. A request held open until the deadline fails too: the cloud
 * ends the build when that happens, so a hook must answer 503 at once.
 * Returns the number of attempts made.
 */
export async function pollBuildHook(
  hook: MicrovmBuildHook,
  endpoint: HookEndpoint,
  timeoutMs: number,
  deps: MicrovmHookDeps = defaultHookDeps
): Promise<number> {
  const path = `${MICROVM_HOOK_PATH_PREFIX}${hook}`;
  const deadline = deps.now() + timeoutMs;
  let attempts = 0;
  let last: HookPostResult = { kind: 'refused' };
  while (deps.now() < deadline) {
    const remaining = Math.max(1, deadline - deps.now());
    last = await deps.post(endpoint.host, endpoint.port, path, undefined, remaining);
    attempts++;
    if (last.kind === 'status' && last.status === 200) return attempts;
    if (last.kind === 'timeout') {
      throw new MicrovmHookError(
        `The /${hook} hook held the request open for ${timeoutMs}ms without answering. Answer 503 ` +
          `immediately while not ready (the cloud ends the image build when a held request ` +
          `reaches the timeout), or raise ${timeoutField(hook)}.`,
        'LOCAL_START_MICROVM_HOOK_TIMEOUT'
      );
    }
    if (last.kind === 'status' && last.status !== 503) {
      throw new MicrovmHookError(
        `The /${hook} hook answered HTTP ${last.status}; it must answer 200 when done or 503 to ` +
          `be retried.${bodySuffix(last.body)}`
      );
    }
    if (deps.isAlive && attempts % 4 === 0 && !(await deps.isAlive())) {
      throw new MicrovmHookError(
        `The MicroVM container exited while cdk-local polled its /${hook} hook.`,
        'LOCAL_START_MICROVM_EXITED'
      );
    }
    await deps.sleep(HOOK_RETRY_INTERVAL_MS);
  }
  const lastSeen =
    last.kind === 'status'
      ? `its last answer was HTTP ${last.status}`
      : `nothing answered on ${formatAuthority(endpoint.host, endpoint.port)} (the hooks port)`;
  throw new MicrovmHookError(
    `The /${hook} hook did not answer 200 within ${timeoutMs}ms (${timeoutField(hook)}); ` +
      `${lastSeen}.`,
    'LOCAL_START_MICROVM_HOOK_TIMEOUT'
  );
}

/**
 * Call a MicroVM hook (`/run`, `/suspend`, `/resume`, `/terminate`) once, as
 * the service does: it must answer 200 within `timeoutMs`. Anything else fails
 * naming the answer.
 */
export async function callRuntimeHook(
  hook: MicrovmRuntimeHook,
  endpoint: HookEndpoint,
  timeoutMs: number,
  body: string | undefined,
  deps: MicrovmHookDeps = defaultHookDeps
): Promise<void> {
  const path = `${MICROVM_HOOK_PATH_PREFIX}${hook}`;
  const result = await deps.post(endpoint.host, endpoint.port, path, body, timeoutMs);
  if (result.kind === 'status' && result.status === 200) return;
  if (result.kind === 'timeout') {
    throw new MicrovmHookError(
      `The /${hook} hook did not answer within ${timeoutMs}ms (${timeoutField(hook)}).`,
      'LOCAL_START_MICROVM_HOOK_TIMEOUT'
    );
  }
  if (result.kind === 'refused') {
    throw new MicrovmHookError(
      `The /${hook} hook could not be reached: nothing answered on the hooks port ` +
        `(${formatAuthority(endpoint.host, endpoint.port)}).`
    );
  }
  throw new MicrovmHookError(
    `The /${hook} hook answered HTTP ${result.status}; it must answer 200.${bodySuffix(result.body)}`
  );
}

/**
 * With no `/ready` hook, wait until the application answers ANY HTTP request
 * on `endpoint` (the hooks port when hooks are configured, else 8080) — what
 * a snapshot taken after the app started amounts to locally. A TCP accept is
 * not enough: Docker's port forwarder accepts before the app listens.
 */
export async function waitForAppAnswer(
  endpoint: HookEndpoint,
  timeoutMs: number,
  deps: {
    probe: (host: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    isAlive?: () => Promise<boolean>;
  } = { probe: probeHttp, sleep: defaultHookDeps.sleep, now: defaultHookDeps.now }
): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  let attempt = 0;
  while (deps.now() < deadline) {
    const remaining = Math.max(1, deadline - deps.now());
    const outcome = await deps.probe(endpoint.host, endpoint.port, Math.min(remaining, 10_000));
    if (outcome === 'answered') return;
    attempt++;
    if (deps.isAlive && attempt % 4 === 0 && !(await deps.isAlive())) {
      throw new MicrovmHookError(
        'The MicroVM container exited before its application answered HTTP.',
        'LOCAL_START_MICROVM_EXITED'
      );
    }
    if (outcome === 'refused') await deps.sleep(HOOK_RETRY_INTERVAL_MS);
  }
  throw new MicrovmHookError(
    `The MicroVM application never answered HTTP on ${formatAuthority(endpoint.host, endpoint.port)} ` +
      `within ${timeoutMs}ms. With no /ready hook, cdk-local waits for the app to answer before ` +
      `driving the next hook; raise --timeout, or enable the /ready hook.`,
    'LOCAL_START_MICROVM_NOT_READY'
  );
}

function timeoutField(hook: MicrovmHookName): string {
  const name = hook.charAt(0).toUpperCase() + hook.slice(1);
  return `${name}TimeoutInSeconds, or --timeout when it is unset`;
}

function bodySuffix(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  const clipped = trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
  return ` Body: ${displayToolOutput(clipped)}`;
}

/** One POST to a hook path. Exported for unit testing. */
export function postHook(
  host: string,
  port: number,
  path: string,
  body: string | undefined,
  timeoutMs: number
): Promise<HookPostResult> {
  return new Promise((resolvePost) => {
    let settled = false;
    const settle = (r: HookPostResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePost(r);
    };
    const payload = body ?? '';
    const req = request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          connection: 'close',
          'content-length': Buffer.byteLength(payload),
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < 64 * 1024) chunks.push(c);
          size += c.length;
        });
        res.on('end', () =>
          settle({
            kind: 'status',
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        );
        res.on('error', () => settle({ kind: 'status', status: res.statusCode ?? 0, body: '' }));
      }
    );
    // A whole-request deadline (connect + response), so a hook held open is a
    // `timeout`, and a connect that never completes is too.
    const timer = setTimeout(() => {
      settle({ kind: 'timeout' });
      req.destroy();
    }, timeoutMs);
    req.on('error', () => settle({ kind: 'refused' }));
    req.end(payload);
  });
}

/** The real seams: an HTTP POST, `setTimeout`, `Date.now`. */
export const defaultHookDeps: MicrovmHookDeps = {
  post: postHook,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
