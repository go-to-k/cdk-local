import { describe, it, expect, vi } from 'vite-plus/test';

import { createShutdownSignalHandler } from '../../../src/utils/shutdown-signal.js';

function setup() {
  let release!: () => void;
  const cleanupDone = new Promise<void>((r) => {
    release = r;
  });
  const cleanup = vi.fn(() => cleanupDone);
  const exit = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const writeStderr = vi.fn();
  const handler = createShutdownSignalHandler({
    cleanup,
    stoppingMessage: (s) => `Stopping on ${s}`,
    forceExitHint: 'HINT',
    info,
    warn,
    exit,
    writeStderr,
  });
  return { handler, cleanup, release, exit, info, warn, writeStderr };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createShutdownSignalHandler', () => {
  it('first signal runs the cleanup and exits with its code only after the cleanup settles', async () => {
    const s = setup();
    s.handler('SIGTERM', 0);
    expect(s.info).toHaveBeenCalledWith('Stopping on SIGTERM');
    expect(s.cleanup).toHaveBeenCalledTimes(1);
    await flush();
    expect(s.exit).not.toHaveBeenCalled();
    s.release();
    await flush();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it('a second signal during the cleanup neither exits nor skips the cleanup', async () => {
    const s = setup();
    s.handler('SIGINT', 130);
    s.handler('SIGINT', 130);
    expect(s.exit).not.toHaveBeenCalled();
    expect(s.writeStderr).not.toHaveBeenCalled();
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.warn.mock.calls[0]![0]).toMatch(/still shutting down/);
    expect(s.cleanup).toHaveBeenCalledTimes(1);
    s.release();
    await flush();
    expect(s.exit).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledWith(130);
  });

  it('a third signal force-exits with the hint', () => {
    const s = setup();
    s.handler('SIGINT', 130);
    s.handler('SIGINT', 130);
    s.handler('SIGTERM', 0);
    expect(s.writeStderr).toHaveBeenCalledTimes(1);
    expect(s.writeStderr.mock.calls[0]![0]).toMatch(/Force-exit on repeated SIGTERM.*HINT/);
    expect(s.exit).toHaveBeenCalledWith(130);
    expect(s.cleanup).toHaveBeenCalledTimes(1);
  });
});
