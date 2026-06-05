import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

/**
 * The session-global `--watch` is appended by the serve-manager from the
 * mutable session config, not from the per-run options, so it would never show
 * up in the "Started with" summary on its own. `startServe` records the
 * Session-bar watch checkbox state at Start time so the running view reflects
 * whether THIS serve actually got `--watch` (the gap that made a watch-on serve
 * look watch-off after the toggle order tripped a user up).
 */
const EXPOSE = `
window.__t = {
  serveMeta: serveMeta,
  serveState: serveState,
  serveApplied: serveApplied,
  renderServeWorkspace: renderServeWorkspace,
  formatAppliedOptions: formatAppliedOptions,
};
window.__setShown = function (id) { shownServeId = id; };
`;

interface Harness {
  window: any;
  document: any;
  close: () => void;
}

function composeAndStart(h: Harness, watchChecked: boolean): any {
  const t = h.window.__t;
  // The session-bar watch checkbox is part of the static page; set it as a
  // PATCH-driven toggle would have.
  h.document.getElementById('sess-watch').checked = watchChecked;
  const dot = h.document.createElement('span');
  const btnSlot = h.document.createElement('span');
  t.serveMeta.set('S/Api', { dot, btnSlot, kind: 'api' });
  t.serveState.set('S/Api', { status: 'stopped', endpoints: [] });
  h.window.__setShown('S/Api');
  t.renderServeWorkspace('S/Api');
  // Click Start — startServe records serveApplied (incl. watch) synchronously
  // before it awaits fetch (the harness fetch never resolves, which is fine).
  (h.document.querySelector('#workspace .composer button') as any).click();
  return t;
}

describe('studio serve watch capture in "Started with" (watch visibility)', () => {
  it('records watch=true on the serve when the Session-bar checkbox is ON at Start', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const t = composeAndStart(h, true);
      expect(t.serveApplied.get('S/Api').watch).toBe(true);
      expect(t.formatAppliedOptions(t.serveApplied.get('S/Api'))).toContain('--watch');
    } finally {
      h.close();
    }
  });

  it('records watch=false when the checkbox is OFF — no --watch line', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const t = composeAndStart(h, false);
      expect(t.serveApplied.get('S/Api').watch).toBe(false);
      expect(t.formatAppliedOptions(t.serveApplied.get('S/Api'))).not.toContain('--watch');
    } finally {
      h.close();
    }
  });
});
