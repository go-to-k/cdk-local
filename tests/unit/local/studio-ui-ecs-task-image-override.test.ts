import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the serve-workspace internals + a Dockerfile-list setter (issue #388).
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

function ecsTaskComposer(h: Harness, pinned: boolean) {
  const t = h.window.__t;
  t.setDockerfiles(['Dockerfile', 'task/Dockerfile']);
  const dot = h.document.createElement('span');
  const btnSlot = h.document.createElement('span');
  t.serveMeta.set('S/Task', { dot, btnSlot, kind: 'ecs-task', pinned, backingPinnedServices: [] });
  t.serveState.set('S/Task', { status: 'stopped', endpoints: [] });
  h.window.__setShown('S/Task');
  t.renderServeWorkspace('S/Task');
  return t;
}

describe('ecs-task composer image-override picker (issue #388)', () => {
  it('renders the Dockerfile picker for a pinned task definition', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      ecsTaskComposer(h, true);
      const selects = h.document.querySelectorAll('.image-override-select');
      expect(selects.length).toBe(1);
      const opts = Array.from((selects[0] as any).options).map((o: any) => o.value);
      expect(opts).toEqual(['', 'Dockerfile', 'task/Dockerfile']);
    } finally {
      h.close();
    }
  });

  it('marks the picker section with the image-override class (the boxed amber prominence treatment)', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      ecsTaskComposer(h, true);
      const section = (h.document.querySelector('.image-override-select') as any).closest('.section');
      expect(section.classList.contains('image-override')).toBe(true);
    } finally {
      h.close();
    }
  });

  it('does NOT render the picker for a local-asset task definition', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      ecsTaskComposer(h, false);
      expect(h.document.querySelectorAll('.image-override-select').length).toBe(0);
    } finally {
      h.close();
    }
  });

  it('threads the chosen Dockerfile as the single imageOverride into the run body', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      ecsTaskComposer(h, true);
      const sel = h.document.querySelector('.image-override-select') as any;
      sel.value = 'task/Dockerfile';

      let captured: any = null;
      h.window.fetch = (_url: string, opts: any) => {
        captured = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };
      // Click Run — startServe builds the body + calls fetch synchronously.
      (h.document.querySelector('#workspace .composer button') as any).click();

      expect(captured).not.toBeNull();
      expect(captured.kind).toBe('ecs-task');
      expect(captured.imageOverride).toBe('task/Dockerfile');
    } finally {
      h.close();
    }
  });
});
