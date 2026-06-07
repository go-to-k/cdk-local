import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

/**
 * The studio LOGS panel re-colours warn / error lines off the WARN: / ERROR:
 * prefix the compact logger emits (the captured serve-child output carries no
 * ANSI colour, so the text prefix is the only severity signal that survives the
 * pipe). These tests drive the embedded `logLineClass` / `fillLogPre` helpers
 * via the jsdom harness and assert the per-line span class.
 */
describe('studio LOGS panel level colouring', () => {
  function withHelpers<T>(fn: (h: ReturnType<typeof createStudioHarness>) => T): T {
    // Expose the two log helpers via a window property captured by the epilogue.
    const harness = createStudioHarness({
      epilogue: 'window.__logHelpers = { logLineClass: logLineClass, fillLogPre: fillLogPre };',
    });
    try {
      return fn(harness);
    } finally {
      harness.close();
    }
  }

  it('classifies a line by its level prefix (tolerating a [module] tag)', () => {
    withHelpers((h) => {
      const { logLineClass } = (h.window as unknown as {
        __logHelpers: { logLineClass: (line: string) => string | null };
      }).__logHelpers;
      expect(logLineClass('ERROR: boom')).toBe('log-error');
      expect(logLineClass('WARN: heads up')).toBe('log-warn');
      expect(logLineClass('[docker] ERROR: boom')).toBe('log-error');
      expect(logLineClass('just info')).toBe(null);
      expect(logLineClass('contains ERROR: mid-line')).toBe(null);
    });
  });

  it('fillLogPre renders one block span per line with the level class', () => {
    withHelpers((h) => {
      const { fillLogPre } = (h.window as unknown as {
        __logHelpers: { fillLogPre: (pre: Element, lines: string[]) => void };
      }).__logHelpers;
      const pre = h.document.createElement('pre');
      fillLogPre(pre, ['booting', 'WARN: pinned image', 'ERROR: crashed']);
      const spans = pre.querySelectorAll('span.log-row');
      expect(spans.length).toBe(3);
      expect(spans[0].className).toBe('log-row');
      expect(spans[1].className).toContain('log-warn');
      expect(spans[2].className).toContain('log-error');
      expect(spans[1].textContent).toBe('WARN: pinned image');
    });
  });

  it('fillLogPre shows (none) for an empty log set', () => {
    withHelpers((h) => {
      const { fillLogPre } = (h.window as unknown as {
        __logHelpers: { fillLogPre: (pre: Element, lines: string[]) => void };
      }).__logHelpers;
      const pre = h.document.createElement('pre');
      fillLogPre(pre, []);
      expect(pre.textContent).toBe('(none)');
      expect(pre.querySelectorAll('span').length).toBe(0);
    });
  });
});
