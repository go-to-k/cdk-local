/**
 * Tests for the `progressLabel` spinner integration in `spawnStreaming`.
 *
 * User-reported gap (image-override path): a multi-minute `docker build`
 * looked like cdk-local had hung — `logger.info("Building override
 * image...")` fired once and nothing animated until the build completed
 * or failed. The spinner is the visible motion that closes that gap.
 *
 * The mocked surface:
 *   - `node:child_process.spawn` — control exit code + stream events.
 *   - `@clack/prompts.spinner` — count `.start` / `.stop` calls.
 *   - `process.stdout.isTTY` — toggle the TTY precondition.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDockerStreaming } from '../../../src/utils/docker-cmd.js';
import { getLogger } from '../../../src/utils/logger.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const spinnerStartMock = vi.hoisted(() => vi.fn());
const spinnerStopMock = vi.hoisted(() => vi.fn());
const spinnerFactoryMock = vi.hoisted(() =>
  vi.fn(() => ({ start: spinnerStartMock, stop: spinnerStopMock }))
);
vi.mock('@clack/prompts', () => ({ spinner: spinnerFactoryMock }));

type FakeChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  return child;
}

describe('spawnStreaming progressLabel spinner', () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    spawnMock.mockReset();
    spinnerStartMock.mockReset();
    spinnerStopMock.mockReset();
    spinnerFactoryMock.mockClear();
    // Logger at info level so streamLive defaults to false.
    getLogger().setLevel('info');
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('starts + stops a spinner with the given label on success when TTY + non-streamLive + label set', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDockerStreaming(['build', '.'], { progressLabel: 'Building foo' });
    // Emit close(0) on the next tick so the listener attaches first.
    setImmediate(() => child.emit('close', 0));
    await promise;

    expect(spinnerFactoryMock).toHaveBeenCalledTimes(1);
    expect(spinnerStartMock).toHaveBeenCalledWith('Building foo');
    expect(spinnerStopMock).toHaveBeenCalledWith('Building foo');
  });

  it('stops the spinner on non-zero exit so the upstream error stderr renders cleanly', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDockerStreaming(['build', '.'], { progressLabel: 'Building foo' });
    setImmediate(() => child.emit('close', 1));
    await expect(promise).rejects.toBeInstanceOf(Error);

    expect(spinnerStartMock).toHaveBeenCalledWith('Building foo');
    expect(spinnerStopMock).toHaveBeenCalledWith('Building foo');
  });

  it('stops the spinner on spawn ENOENT before the rejection propagates', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDockerStreaming(['build', '.'], { progressLabel: 'Building foo' });
    setImmediate(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      child.emit('error', err);
    });
    await expect(promise).rejects.toThrow(/Install Docker/);

    expect(spinnerStartMock).toHaveBeenCalledWith('Building foo');
    expect(spinnerStopMock).toHaveBeenCalledWith('Building foo');
  });

  it('does NOT start a spinner when stdout is not a TTY (CI / piped invocations)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDockerStreaming(['build', '.'], { progressLabel: 'Building foo' });
    setImmediate(() => child.emit('close', 0));
    await promise;

    expect(spinnerFactoryMock).not.toHaveBeenCalled();
    expect(spinnerStartMock).not.toHaveBeenCalled();
    expect(spinnerStopMock).not.toHaveBeenCalled();
  });

  it('does NOT start a spinner when streamLive is true (live BuildKit output already shows motion)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDockerStreaming(['build', '.'], {
      progressLabel: 'Building foo',
      streamLive: true,
    });
    setImmediate(() => child.emit('close', 0));
    await promise;

    expect(spinnerFactoryMock).not.toHaveBeenCalled();
    expect(spinnerStartMock).not.toHaveBeenCalled();
  });

  it('does NOT start a spinner when progressLabel is undefined (pre-spinner default behavior)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDockerStreaming(['build', '.'], {});
    setImmediate(() => child.emit('close', 0));
    await promise;

    expect(spinnerFactoryMock).not.toHaveBeenCalled();
  });
});
