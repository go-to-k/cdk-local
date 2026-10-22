/**
 * go-to-k/cdk-local#761: `spawnForeground`'s generic spawn failure prints the
 * error CODE, never Node's message (which carries the command raw); an error
 * with no code falls back to `spawn error`.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error("spawn x' forged ENOPE")));
    return child;
  },
}));

const { spawnForeground } = await import('../../../src/utils/docker-cmd.js');

describe('spawnForeground generic failure', () => {
  it('falls back to `spawn error` and drops the raw message', async () => {
    const err = await spawnForeground("x' forged", [], {}).catch((e: unknown) => e);
    expect((err as Error).message).toBe(`"x' forged" failed: spawn error`);
  });
});
