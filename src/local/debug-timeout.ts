/**
 * Debugger wiring shared by `cdkl invoke --debug-port` and
 * `cdkl start-api --debug-port-base` (go-to-k/cdk-local#948).
 *
 * Node starts with `--inspect-brk`, so the handler does not run until a
 * debugger attaches. The Runtime Interface Emulator enforces
 * `AWS_LAMBDA_FUNCTION_TIMEOUT` on that wait too, so a function with CDK's
 * default 3 s `Timeout` was reset before anyone could attach. While a debug
 * port is set, the function timeout is lifted to 10 hours — the value SAM CLI
 * uses (`MAX_DEBUG_TIMEOUT = 36000` in `samcli/commands/local/lib/local_lambda.py`)
 * — in the container AND on the host-side RIE invoke deadline.
 */

/** The function timeout, in seconds, while a debugger port is set (SAM CLI's value). */
export const DEBUG_FUNCTION_TIMEOUT_SEC = 36_000;

/**
 * Point Node at the inspector port (`--inspect-brk`, so the handler waits for
 * a debugger) and lift the container's function timeout so the RIE does not
 * cut that wait.
 */
export function applyDebuggerEnv(dockerEnv: Record<string, string>, debugPort: number): void {
  dockerEnv['NODE_OPTIONS'] = `--inspect-brk=0.0.0.0:${debugPort}`;
  dockerEnv['AWS_LAMBDA_FUNCTION_TIMEOUT'] = String(DEBUG_FUNCTION_TIMEOUT_SEC);
}

/**
 * The host-side RIE invoke deadline: twice the function `Timeout` with a 30 s
 * floor, or twice the lifted debug timeout while a debugger port is set (so
 * the host does not abort the request the container is still allowed to run).
 */
export function rieInvokeTimeoutMs(timeoutSec: number, debugging: boolean): number {
  const effectiveSec = debugging ? Math.max(timeoutSec, DEBUG_FUNCTION_TIMEOUT_SEC) : timeoutSec;
  return Math.max(30_000, effectiveSec * 2 * 1000);
}

/** The one line printed when a debug port lifts the function timeout. */
export function debugTimeoutNotice(flag: string): string {
  return (
    `${flag}: the function Timeout is lifted to ${DEBUG_FUNCTION_TIMEOUT_SEC} seconds while debugging, ` +
    'so the handler waits for a debugger to attach.'
  );
}
