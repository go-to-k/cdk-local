import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the serve-workspace internals so a test can render the composer for a
// target whose image-pin status could not be classified (pinUnresolved).
const EXPOSE = `
window.__t = {
  serveMeta: serveMeta,
  serveState: serveState,
  renderServeWorkspace: renderServeWorkspace,
  setDockerfiles: function (d) { studioDockerfiles = d; },
};
window.__setShown = function (id) { shownServeId = id; };
`;

interface Harness {
  window: any;
  document: any;
  close: () => void;
}

function composer(
  h: Harness,
  kind: 'ecs' | 'ecs-task',
  meta: { pinned?: boolean; pinUnresolved?: boolean }
) {
  const t = h.window.__t;
  t.setDockerfiles(['Dockerfile']);
  const dot = h.document.createElement('span');
  const btnSlot = h.document.createElement('span');
  t.serveMeta.set('S/Svc', {
    dot,
    btnSlot,
    kind,
    pinned: meta.pinned === true,
    pinUnresolved: meta.pinUnresolved === true,
    backingPinnedServices: [],
  });
  t.serveState.set('S/Svc', { status: 'stopped', endpoints: [] });
  h.window.__setShown('S/Svc');
  t.renderServeWorkspace('S/Svc');
  return t;
}

const HINT_TEXT = 'set --from-cfn-stack in the Session bar';

describe('studio composer pin-unresolved hint', () => {
  for (const kind of ['ecs', 'ecs-task'] as const) {
    it(`renders the Session-bar hint (no picker) for a ${kind} target that is pinUnresolved`, () => {
      const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
      try {
        composer(h, kind, { pinUnresolved: true });
        const ws = h.document.querySelector('#workspace') as any;
        // The hint is shown...
        expect(ws.textContent).toContain('Image override unavailable');
        expect(ws.textContent).toContain(HINT_TEXT);
        // ...and the Dockerfile picker is NOT (it cannot be resolved yet).
        expect(h.document.querySelectorAll('.image-override-select').length).toBe(0);
      } finally {
        h.close();
      }
    });
  }

  it('renders the Dockerfile picker (NOT the hint) for a classified-pinned target', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      // pinned wins over pinUnresolved (they are mutually exclusive in
      // practice, but assert the picker branch takes precedence).
      composer(h, 'ecs', { pinned: true, pinUnresolved: true });
      const ws = h.document.querySelector('#workspace') as any;
      expect(h.document.querySelectorAll('.image-override-select').length).toBe(1);
      expect(ws.textContent).not.toContain('Image override unavailable');
    } finally {
      h.close();
    }
  });

  it('renders neither hint nor picker for an unmarked (local-asset) target', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      composer(h, 'ecs', {});
      const ws = h.document.querySelector('#workspace') as any;
      expect(h.document.querySelectorAll('.image-override-select').length).toBe(0);
      expect(ws.textContent).not.toContain('Image override unavailable');
      expect(ws.textContent).not.toContain(HINT_TEXT);
    } finally {
      h.close();
    }
  });
});
