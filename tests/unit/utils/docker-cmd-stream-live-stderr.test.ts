/**
 * go-to-k/cdkd#2429: a streamed child's stdout (BuildKit / pull progress under
 * debug) is written to the parent's STDERR, never its stdout, so a single-shot
 * invoke's stdout stays the payload alone — including when an embedding host's
 * logger bridge raises the level to debug. Only `spawn` is mocked.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDockerStreaming } from '../../../src/utils/docker-cmd.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe('spawnStreaming streamLive', () => {
  it("writes the child's stdout and stderr to the parent's stderr only", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
    child.stdout = Readable.from([Buffer.from('#5 [2/3] RUN npm ci\n')]);
    child.stderr = Readable.from([Buffer.from('progress on stderr\n')]);
    spawnMock.mockReturnValue(child);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const done = runDockerStreaming(['build', '.'], { streamLive: true });
    // Let both readables flush before the child exits.
    await new Promise((r) => setTimeout(r, 10));
    child.emit('close', 0);
    const result = await done;

    expect(out).not.toHaveBeenCalled();
    const written = err.mock.calls.map((c) => String(c[0]));
    expect(written).toContain('#5 [2/3] RUN npm ci\n');
    expect(written).toContain('progress on stderr\n');
    // The captured stdout is still returned to the caller unchanged.
    expect(result.stdout).toContain('#5 [2/3] RUN npm ci');
  });
});
