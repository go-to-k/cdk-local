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
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = logger.warn.mock.calls[0]![0] as string;
    expect(msg).toContain('Replica 0 essential container logs');
    expect(msg).toContain('PrismaClientInitializationError: Timed out');
    expect(logger.debug).not.toHaveBeenCalled();
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
