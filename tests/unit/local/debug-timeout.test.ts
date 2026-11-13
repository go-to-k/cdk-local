/**
 * go-to-k/cdk-local#948: while a debug port is set, the function Timeout is
 * lifted (SAM CLI's 36000 s) in the container and on the host-side RIE
 * deadline, so `--inspect-brk` can wait for a debugger past a 3 s Timeout.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
  applyDebuggerEnv,
  DEBUG_FUNCTION_TIMEOUT_SEC,
  rieInvokeTimeoutMs,
} from '../../../src/local/debug-timeout.js';

describe('debug timeout', () => {
  it('sets --inspect-brk and lifts AWS_LAMBDA_FUNCTION_TIMEOUT', () => {
    const env: Record<string, string> = { AWS_LAMBDA_FUNCTION_TIMEOUT: '3' };
    applyDebuggerEnv(env, 9229);
    expect(env['NODE_OPTIONS']).toBe('--inspect-brk=0.0.0.0:9229');
    expect(env['AWS_LAMBDA_FUNCTION_TIMEOUT']).toBe(String(DEBUG_FUNCTION_TIMEOUT_SEC));
    expect(DEBUG_FUNCTION_TIMEOUT_SEC).toBe(36_000);
  });

  it('keeps the 2x Timeout / 30 s floor deadline without a debugger', () => {
    expect(rieInvokeTimeoutMs(3, false)).toBe(30_000);
    expect(rieInvokeTimeoutMs(60, false)).toBe(120_000);
  });

  it('lifts the host-side deadline while debugging', () => {
    expect(rieInvokeTimeoutMs(3, true)).toBe(DEBUG_FUNCTION_TIMEOUT_SEC * 2 * 1000);
    // Still a valid setTimeout delay (below 2^31 - 1 ms).
    expect(rieInvokeTimeoutMs(900, true)).toBeLessThan(2 ** 31 - 1);
  });
});
