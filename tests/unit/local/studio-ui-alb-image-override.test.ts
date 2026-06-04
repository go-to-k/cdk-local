import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the serve-workspace internals + a Dockerfile-list setter (issue #382).
const EXPOSE = `
window.__t = {
  serveMeta: serveMeta,
  serveState: serveState,
  renderServeWorkspace: renderServeWorkspace,
  formatAppliedOptions: formatAppliedOptions,
  setDockerfiles: function (d) { studioDockerfiles = d; },
};
window.__setShown = function (id) { shownServeId = id; };
`;

interface Harness {
  window: any;
  document: any;
  close: () => void;
}

function albComposer(h: Harness, backingPinnedServices: { id: string; label: string }[]) {
  const t = h.window.__t;
  t.setDockerfiles(['Dockerfile', 'api/Dockerfile']);
  const dot = h.document.createElement('span');
  const btnSlot = h.document.createElement('span');
  t.serveMeta.set('S/Alb', { dot, btnSlot, kind: 'alb', pinned: false, backingPinnedServices });
  t.serveState.set('S/Alb', { status: 'stopped', endpoints: [] });
  h.window.__setShown('S/Alb');
  t.renderServeWorkspace('S/Alb');
  return t;
}

describe('alb composer image-override picker (issue #382)', () => {
  it('renders one Dockerfile <select> per pinned backing service, labeled by service', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h, [
        { id: 'S:SvcA', label: 'S/SvcA' },
        { id: 'S:SvcB', label: 'S/SvcB' },
      ]);
      const selects = h.document.querySelectorAll('.image-override-select');
      expect(selects.length).toBe(2);
      const labels = Array.from(h.document.querySelectorAll('.opt-label')).map(
        (n: any) => n.textContent
      );
      expect(labels).toContain('S/SvcA');
      expect(labels).toContain('S/SvcB');
      // The discovered Dockerfiles are options (+ the "(keep pinned image)" default).
      const opts = Array.from((selects[0] as any).options).map((o: any) => o.value);
      expect(opts).toEqual(['', 'Dockerfile', 'api/Dockerfile']);
    } finally {
      h.close();
    }
  });

  it('threads only the chosen services into the POST body imageOverrides map', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h, [
        { id: 'S:SvcA', label: 'S/SvcA' },
        { id: 'S:SvcB', label: 'S/SvcB' },
      ]);
      const selects = h.document.querySelectorAll('.image-override-select');
      // Pick a Dockerfile for SvcA; leave SvcB on "(keep pinned image)".
      (selects[0] as any).value = 'api/Dockerfile';

      let captured: any = null;
      h.window.fetch = (_url: string, opts: any) => {
        captured = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };
      // Click Start — startServe builds the body + calls fetch synchronously.
      (h.document.querySelector('#workspace .composer button') as any).click();

      expect(captured).not.toBeNull();
      expect(captured.kind).toBe('alb');
      expect(captured.imageOverrides).toEqual({ 'S:SvcA': 'api/Dockerfile' });
    } finally {
      h.close();
    }
  });

  it('does NOT render the picker for an ALB with no pinned backing services', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h, []);
      expect(h.document.querySelectorAll('.image-override-select').length).toBe(0);
    } finally {
      h.close();
    }
  });

  it('surfaces the imageOverrides picks in the "Started with" summary (issue #356 contract)', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const lines = h.window.__t.formatAppliedOptions({
        imageOverrides: { 'S:SvcA': 'api/Dockerfile', 'S:SvcB': 'web/Dockerfile' },
      });
      expect(lines).toContain('--image-override S:SvcA=api/Dockerfile');
      expect(lines).toContain('--image-override S:SvcB=web/Dockerfile');
    } finally {
      h.close();
    }
  });
});
