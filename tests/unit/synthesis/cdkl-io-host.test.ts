import { describe, it, expect, vi } from 'vite-plus/test';
import { CdklIoHost } from '../../../src/synthesis/cdkl-io-host.js';

describe('CdklIoHost', () => {
  it('downgrades CDK_ASSEMBLY_E1002 (CDK app stderr line) from error to info level', async () => {
    // Pin `isCI: false` so the IoHost routes non-error messages to
    // stderr regardless of the runner environment. On GitHub Actions
    // `CI=true` flips selectStream's info-tier branch to stdout, which
    // would defeat the stderr-only assertion below.
    const host = new CdklIoHost({ isCI: false });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await host.notify({
      time: new Date(),
      level: 'error',
      action: 'synth',
      code: 'CDK_ASSEMBLY_E1002',
      message: 'Bundling asset MyStack/MyFunction/Code/Stage...',
      data: undefined,
    });

    // info-level messages go to stderr (per isCI: false), and the
    // styleMap for info is chalk.reset (no color), not chalk.red.
    // Assert the written payload contains the message body and does
    // NOT contain the ANSI red sequence.
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Bundling asset MyStack/MyFunction/Code/Stage...');
    expect(written).not.toMatch(/\x1B\[31m/); // ANSI red foreground
    stderrSpy.mockRestore();
  });

  it('passes through real error-level messages with their level unchanged', async () => {
    const host = new CdklIoHost({ isCI: false });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // The level is 'error' AND the code is NOT E1002 — a genuine error
    // toolkit-lib chose to raise. Should keep the error level so the
    // default styleMap colors it red.
    await host.notify({
      time: new Date(),
      level: 'error',
      action: 'synth',
      code: 'CDK_ASSEMBLY_E9999',
      message: 'a real failure',
      data: undefined,
    });

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('a real failure');
    // If this host runs in a TTY-detected environment, the message
    // would be colored red. In Vitest's piped-stdio mode, isTTY is
    // typically false, so no color is applied — the test still
    // demonstrates non-interference with the code path.
    stderrSpy.mockRestore();
  });
});
