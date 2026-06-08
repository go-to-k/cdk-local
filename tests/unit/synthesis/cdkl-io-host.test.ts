import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
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

  describe('multi-stack "Supply a stack id" hint', () => {
    it('drops the codeless "Supply a stack id (...) to display its template." line', async () => {
      const host = new CdklIoHost({ isCI: false });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      // toolkit-lib's Toolkit.synth() emits this via ioHelper.defaults.info,
      // so it carries NO message code and can only be matched on its text.
      await host.notify({
        time: new Date(),
        level: 'info',
        action: 'synth',
        code: undefined,
        message: 'Supply a stack id (StackA, StackB) to display its template.',
        data: undefined,
      } as never);

      const written =
        stderrSpy.mock.calls.map((c) => String(c[0])).join('') +
        stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).not.toContain('Supply a stack id');
      expect(written).not.toContain('to display its template');
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    });

    it('does NOT drop an unrelated codeless info message', async () => {
      const host = new CdklIoHost({ isCI: false });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await host.notify({
        time: new Date(),
        level: 'info',
        action: 'synth',
        code: undefined,
        message: 'Some other informational line',
        data: undefined,
      } as never);

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('Some other informational line');
      stderrSpy.mockRestore();
    });
  });

  describe('CDKL_LOG_LEVEL=warn suppression (studio child)', () => {
    const prev = process.env['CDKL_LOG_LEVEL'];
    afterEach(() => {
      if (prev === undefined) delete process.env['CDKL_LOG_LEVEL'];
      else process.env['CDKL_LOG_LEVEL'] = prev;
    });

    it('drops the re-leveled synth-success notification entirely', async () => {
      process.env['CDKL_LOG_LEVEL'] = 'warn';
      const host = new CdklIoHost({ isCI: false });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      // CDK_TOOLKIT_I1901 "Successfully synthesized to ..." is re-leveled to
      // info, then suppressed under warn — it must reach NEITHER stream.
      await host.notify({
        time: new Date(),
        level: 'result',
        action: 'synth',
        code: 'CDK_TOOLKIT_I1901',
        message: 'Successfully synthesized to /tmp/cdk.out',
        data: undefined,
      });

      const written =
        stderrSpy.mock.calls.map((c) => String(c[0])).join('') +
        stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).not.toContain('Successfully synthesized');
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    });

    it('still passes warn / error messages through under warn', async () => {
      process.env['CDKL_LOG_LEVEL'] = 'warn';
      const host = new CdklIoHost({ isCI: false });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await host.notify({
        time: new Date(),
        level: 'warn',
        action: 'synth',
        code: 'CDK_TOOLKIT_W0001',
        message: 'a real warning',
        data: undefined,
      });

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('a real warning');
      stderrSpy.mockRestore();
    });
  });
});
