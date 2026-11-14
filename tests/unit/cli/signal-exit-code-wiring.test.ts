import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

/**
 * Issue #893 — every long-running local command exits 130 on SIGINT and 143 on
 * SIGTERM. The numbers live in ONE place (`signalExitCode` in
 * `src/utils/shutdown-signal.ts`; its rows are in `shutdown-signal.test.ts`,
 * and the microvm / web-function / docker-runner rows pin the end-to-end code).
 * These fences pin that no command re-derives a code of its own again.
 */
const CMD = join(__dirname, '../../../src/cli/commands');
const read = (f: string): string => readFileSync(join(CMD, f), 'utf-8');

const LONG_RUNNING = [
  'ecs-service-emulator.ts', // start-service / start-alb
  'local-start-api.ts',
  'local-start-agentcore.ts',
  'local-start-cloudfront.ts',
  'local-start-microvm.ts',
  'local-start-web-function.ts',
  'local-invoke-agentcore.ts',
  'local-invoke.ts',
  'local-run-task.ts',
  'local-studio.ts',
];

describe('signal exit codes (#893)', () => {
  for (const f of LONG_RUNNING) {
    it(`${f} takes its exit code from signalExitCode, never a literal`, () => {
      const code = read(f)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      // A handler is called with the signal alone ...
      expect(code).not.toMatch(/\b(onSignal|shutdown)\('SIG(INT|TERM)',\s*\d+\)/);
      // ... and nothing next to a signal exits with a literal 130 / 143 / 0.
      expect(code).not.toMatch(/process\.exit\(\s*(130|143)\s*\)/);
      expect(code).not.toMatch(/signal === 'SIGINT' \? 130/);
    });
  }

  it('the stop handlers of start-service / start-api / start-agentcore / start-cloudfront / run-task pass the bare signal', () => {
    expect(read('ecs-service-emulator.ts')).toContain("onSignal('SIGTERM')");
    expect(read('local-run-task.ts')).toContain("onSignal('SIGTERM')");
    for (const f of ['local-start-api.ts', 'local-start-agentcore.ts', 'local-start-cloudfront.ts']) {
      expect(read(f), f).toContain("shutdown('SIGTERM')");
      expect(read(f), f).toContain("shutdown('SIGINT')");
    }
  });

  // #970: `cdkl invoke` registered SIGINT only, so SIGTERM skipped the cleanup.
  // The handler's per-signal behavior (cleanup runs, 130 / 143) is pinned in
  // shutdown-signal.test.ts; these pin that invoke routes EACH signal to it.
  it('invoke routes SIGINT to the shared shutdown handler', () => {
    const src = read('local-invoke.ts');
    expect(src).toContain('createShutdownSignalHandler({\n    cleanup,');
    expect(src).toContain("sigintHandler = (): void => onSignal('SIGINT')");
    expect(src).toContain("process.on('SIGINT', sigintHandler)");
  });

  it('invoke routes SIGTERM to the shared shutdown handler', () => {
    const src = read('local-invoke.ts');
    expect(src).toContain("sigtermHandler = (): void => onSignal('SIGTERM')");
    expect(src).toContain("process.on('SIGTERM', sigtermHandler)");
  });

  it('invoke removes its signal listeners only after the finally cleanup', () => {
    const src = read('local-invoke.ts');
    const fin = src.indexOf('  } finally {\n    // Keep the handlers installed');
    expect(fin).toBeGreaterThanOrEqual(0);
    const tail = src.slice(fin);
    const c = tail.indexOf('await cleanup()');
    expect(c).toBeGreaterThanOrEqual(0);
    expect(tail.indexOf("process.off('SIGINT'")).toBeGreaterThan(c);
    expect(tail.indexOf("process.off('SIGTERM'")).toBeGreaterThan(c);
  });

  it('studio ends with the signal exit code without calling process.exit', () => {
    const src = read('local-studio.ts');
    expect(src).toContain('process.exitCode = signalExitCode(signal)');
  });
});
