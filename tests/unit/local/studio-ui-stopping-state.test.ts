import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the serve-workspace internals so tests can drive the Stop/Start
// lifecycle and assert the transient button states (issue #394).
const EXPOSE = `
window.__t = {
  serveMeta: serveMeta,
  serveState: serveState,
  stoppingSince: stoppingSince,
  renderServeWorkspace: renderServeWorkspace,
  updateServeRow: updateServeRow,
  onServeEvent: onServeEvent,
};
window.__setShown = function (id) { shownServeId = id; };
`;

interface Harness {
  window: any;
  document: any;
  close: () => void;
}

function setup(h: Harness, status: string) {
  const t = h.window.__t;
  const dot = h.document.createElement('span');
  const btnSlot = h.document.createElement('span');
  t.serveMeta.set('S/Svc', { dot, btnSlot, kind: 'ecs', pinned: false, backingPinnedServices: [] });
  t.serveState.set('S/Svc', { status, endpoints: [] });
  h.window.__setShown('S/Svc');
  t.updateServeRow('S/Svc'); // populate the row button (btnSlot)
  t.renderServeWorkspace('S/Svc');
  return t;
}

const headBtn = (h: Harness) => h.document.querySelector('#workspace .composer button');
const rowBtn = (t: any) => t.serveMeta.get('S/Svc').btnSlot.querySelector('button');

describe('Stop button "Stopping..." / "Starting..." transients (issue #394)', () => {
  it('clicking Stop flips the row + workspace button to "Stopping..." (disabled)', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      // A never-resolving fetch keeps the Stop in flight (the SSE event, not the
      // fetch resolution, clears the transient).
      (h.window as any).fetch = () => new Promise(() => {});
      const t = setup(h, 'running');
      expect(headBtn(h).textContent).toBe('Stop');

      headBtn(h).click(); // -> stopServe -> stoppingIds.add + re-render

      expect(headBtn(h).textContent).toBe('Stopping…');
      expect(headBtn(h).disabled).toBe(true);
      expect(rowBtn(t).textContent).toBe('Stopping…');
      expect(rowBtn(t).disabled).toBe(true);
    } finally {
      h.close();
    }
  });

  it('a stopped serve event AFTER the min-visible window reverts the button to Start', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      (h.window as any).fetch = () => new Promise(() => {});
      const t = setup(h, 'running');
      headBtn(h).click();
      expect(headBtn(h).textContent).toBe('Stopping…');

      // Pretend the Stop has been in flight longer than the min-visible window,
      // so the terminal event settles immediately (no lingering "Stopping...").
      t.stoppingSince.set('S/Svc', Date.now() - 100000);
      // The SSE 'stopped' event arrives (clean user stop — no message).
      t.onServeEvent({ target: 'S/Svc', status: 'stopped' });

      expect(headBtn(h).textContent).toBe('Start');
      expect(rowBtn(t).textContent).toBe('Start');
    } finally {
      h.close();
    }
  });

  it('a near-instant stop keeps "Stopping..." up for the min-visible window, then reverts', async () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      (h.window as any).fetch = () => new Promise(() => {});
      const t = setup(h, 'running');
      headBtn(h).click();
      expect(headBtn(h).textContent).toBe('Stopping…');

      // A start-api / pure-S3 cloudfront serve tears down in tens of ms — the
      // 'stopped' event arrives almost immediately. The button must NOT flip
      // straight to Start (that is the bug: the Stop looked like it did nothing).
      t.onServeEvent({ target: 'S/Svc', status: 'stopped' });
      expect(headBtn(h).textContent).toBe('Stopping…');
      expect(headBtn(h).disabled).toBe(true);

      // After the min-visible window the pending timer clears it and reverts.
      await new Promise((r) => setTimeout(r, 700));
      expect(headBtn(h).textContent).toBe('Start');
      expect(rowBtn(t).textContent).toBe('Start');
    } finally {
      h.close();
    }
  });

  it('a late running re-emit during a Stop does NOT cancel "Stopping..."', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      (h.window as any).fetch = () => new Promise(() => {});
      const t = setup(h, 'running');
      headBtn(h).click();
      expect(headBtn(h).textContent).toBe('Stopping…');

      // A stray 'running' re-emit (e.g. a late hostUrl from issue #392) must not
      // clear the in-progress stop indicator.
      t.onServeEvent({ target: 'S/Svc', status: 'running', endpoints: [] });

      expect(headBtn(h).textContent).toBe('Stopping…');
      expect(headBtn(h).disabled).toBe(true);
    } finally {
      h.close();
    }
  });

  it('a starting serve shows "Starting..." (disabled) instead of Stop', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const t = setup(h, 'starting');
      expect(headBtn(h).textContent).toBe('Starting…');
      expect(headBtn(h).disabled).toBe(true);
      expect(rowBtn(t).textContent).toBe('Starting…');
      expect(rowBtn(t).disabled).toBe(true);
    } finally {
      h.close();
    }
  });
});
