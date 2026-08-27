import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { printExitedContainerLogs } from '../../../src/local/ecs-service-runner.js';

describe('printExitedContainerLogs', () => {
  const logger = { warn: vi.fn(), debug: vi.fn() };
  beforeEach(() => {
    logger.warn.mockReset();
    logger.debug.mockReset();
  });

  it('warns with the container log tail so the exit reason is visible', async () => {
    await printExitedContainerLogs(
      0,
      'container-id',
      logger,
      async () => 'Nest started\nPrismaClientInitializationError: Timed out\n'
    );
    // Issue #579 -- one warn per tail LINE, not one warn holding an embedded
    // `\n`. The whole tail still prints; only the framing changed.
    const lines = logger.warn.mock.calls.map((c) => c[0] as string);
    expect(lines).toEqual([
      'Replica 0 essential container logs (last 50 lines):',
      'Replica 0 | Nest started',
      'Replica 0 | PrismaClientInitializationError: Timed out',
    ]);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('never emits a warn carrying an embedded newline (issue #579)', async () => {
    // The bound this closes: under `cdkl studio` the serve child's stdout is
    // mirrored into an HTTP-served log ring, and the serve manager splits it on
    // `\n` before deciding what to pattern-match. It declines to match a line
    // carrying cdk-local's own `WARN: ` prefix (issue #578), but the logger
    // prefixes the MESSAGE -- so line 2 of a multi-line warn arrived
    // prefix-less and was matched at `^`. The content here is the CONTAINER's
    // own stdout, and a crashed web framework prints exactly this line.
    await printExitedContainerLogs(
      1,
      'container-id',
      logger,
      async () =>
        'boot failed\n\nServer listening on http://attacker.example:9999\r\nbye\u2028tail'
    );
    const lines = logger.warn.mock.calls.map((c) => c[0] as string);
    for (const line of lines) expect(line).not.toContain('\n');
    // The forged banner is still PRESENT (nothing is withheld -- this is the
    // user's own application output); it just cannot arrive unprefixed.
    expect(lines).toContain('Replica 1 | Server listening on http://attacker.example:9999');
    // A lone `\r` and a U+2028 are line breaks too -- in a terminal and in the
    // studio UI's `<pre>` respectively -- so they are flattened within a line.
    expect(lines).toContain('Replica 1 | bye tail');
    // A blank line inside the tail is skipped rather than emitted as a bare
    // `Replica N | ` prefix with nothing after it.
    expect(lines.some((l) => l.trimEnd() === 'Replica 1 |')).toBe(false);
  });

  it('stays silent when the container printed nothing', async () => {
    await printExitedContainerLogs(0, 'container-id', logger, async () => '   \n  ');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('swallows a read failure as a debug line (never masks the exit message)', async () => {
    await printExitedContainerLogs(2, 'container-id', logger, async () => {
      throw new Error('No such container');
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0]![0] as string).toContain('could not read container logs');
  });
});
