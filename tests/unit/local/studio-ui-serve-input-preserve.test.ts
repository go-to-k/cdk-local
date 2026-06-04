import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the serve-workspace internals + a Dockerfile-list setter so a test
// can drive a Start -> Stop -> re-render cycle and assert the composer comes
// back pre-filled with what the serve was last Started with (issue #398).
const EXPOSE = `
window.__t = {
  serveMeta: serveMeta,
  serveState: serveState,
  serveApplied: serveApplied,
  renderServeWorkspace: renderServeWorkspace,
};
window.__setShown = function (id) { shownServeId = id; };
window.__setDockerfiles = function (d) { studioDockerfiles = d; };
`;

interface Harness {
  window: any;
  document: any;
  close: () => void;
}

// Find the input whose row label matches `label`. A scalar/env row labels with
// a `.opt-label` span; a boolean row labels with a `.opt-bool` <label> whose
// text carries a leading space.
function inputForLabel(doc: any, label: string): any {
  const rows = Array.from(doc.querySelectorAll('#workspace .opt-row')) as any[];
  const row = rows.find((r) => {
    const lab = r.querySelector('.opt-label');
    if (lab && lab.textContent === label) return true;
    const boolLab = r.querySelector('.opt-bool');
    return boolLab && boolLab.textContent.trim() === label;
  });
  if (!row) return null;
  return row.querySelector('input, textarea, select');
}

// Boot an alb serve composer (stopped) with two pinned backing services + a
// couple of discovered Dockerfiles, shown in the workspace.
function albComposer(h: Harness) {
  const t = h.window.__t;
  h.window.__setDockerfiles(['Dockerfile', 'api/Dockerfile']);
  const dot = h.document.createElement('span');
  const btnSlot = h.document.createElement('span');
  t.serveMeta.set('S/Alb', {
    dot,
    btnSlot,
    kind: 'alb',
    pinned: false,
    backingPinnedServices: [
      { id: 'S:SvcA', label: 'S/SvcA' },
      { id: 'S:SvcB', label: 'S/SvcB' },
    ],
  });
  t.serveState.set('S/Alb', { status: 'stopped', endpoints: [] });
  h.window.__setShown('S/Alb');
  t.renderServeWorkspace('S/Alb');
  return t;
}

// Stub fetch so the Start click resolves; then drive the serve to 'stopped'
// and re-render the composer (the real Start -> SSE 'stopped' -> re-render).
function startThenStop(h: Harness) {
  h.window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  (h.document.querySelector('#workspace .composer button') as any).click();
  h.window.__t.serveState.set('S/Alb', { status: 'stopped', endpoints: [] });
  h.window.__t.renderServeWorkspace('S/Alb');
}

describe('serve composer input preservation across Start -> Stop (issue #398)', () => {
  it('refills the bearer-token scalar after a Start -> Stop cycle', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h);
      inputForLabel(h.document, 'Bearer token').value = 'eyJ-test-token';
      startThenStop(h);
      // serveApplied recorded the value at Start...
      expect(h.window.__t.serveApplied.get('S/Alb').options['--bearer-token']).toBe('eyJ-test-token');
      // ...and the re-rendered composer comes back filled.
      expect(inputForLabel(h.document, 'Bearer token').value).toBe('eyJ-test-token');
    } finally {
      h.close();
    }
  });

  it('refills a boolean + its showWhen-gated scalar (tls / tls-cert)', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h);
      const tls = inputForLabel(h.document, 'TLS (terminate HTTPS locally)');
      tls.checked = true;
      // Toggling the gate reveals tls-cert (showWhen).
      tls.dispatchEvent(new h.window.Event('change'));
      inputForLabel(h.document, 'TLS cert').value = './c.pem';
      startThenStop(h);
      expect(inputForLabel(h.document, 'TLS (terminate HTTPS locally)').checked).toBe(true);
      const cert = inputForLabel(h.document, 'TLS cert');
      expect(cert.value).toBe('./c.pem');
      // The gated row is visible again (not display:none) because its gate is checked.
      expect(cert.closest('.opt-row').style.display).not.toBe('none');
    } finally {
      h.close();
    }
  });

  it('refills a repeat-pair (listener port remap) row', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h);
      // Add one --lb-port row and fill it.
      const rows = Array.from(h.document.querySelectorAll('#workspace .opt-row')) as any[];
      const lbRow = rows.find((r) => {
        const lab = r.querySelector('.opt-label');
        return lab && lab.textContent === 'Listener port remap';
      });
      (lbRow.querySelector('.pair-add') as any).click();
      const ins = lbRow.querySelectorAll('.pair-in');
      ins[0].value = '443';
      ins[1].value = '8443';
      startThenStop(h);
      const rows2 = Array.from(h.document.querySelectorAll('#workspace .opt-row')) as any[];
      const lbRow2 = rows2.find((r) => {
        const lab = r.querySelector('.opt-label');
        return lab && lab.textContent === 'Listener port remap';
      });
      const ins2 = lbRow2.querySelectorAll('.pair-in');
      expect(ins2.length).toBe(2);
      expect(ins2[0].value).toBe('443');
      expect(ins2[1].value).toBe('8443');
    } finally {
      h.close();
    }
  });

  it('refills an env-kv KV row', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h);
      const rows = Array.from(h.document.querySelectorAll('#workspace .opt-row')) as any[];
      const envRow = rows.find((r) => {
        const lab = r.querySelector('.opt-label');
        return lab && lab.textContent === 'Env vars';
      });
      (envRow.querySelector('.pair-add') as any).click();
      const ins = envRow.querySelectorAll('.pair-in');
      ins[0].value = 'API_KEY';
      ins[1].value = 'secret';
      startThenStop(h);
      const rows2 = Array.from(h.document.querySelectorAll('#workspace .opt-row')) as any[];
      const envRow2 = rows2.find((r) => {
        const lab = r.querySelector('.opt-label');
        return lab && lab.textContent === 'Env vars';
      });
      const ins2 = envRow2.querySelectorAll('.pair-in');
      expect(ins2[0].value).toBe('API_KEY');
      expect(ins2[1].value).toBe('secret');
    } finally {
      h.close();
    }
  });

  it('refills the raw extra args (and opens the All options section)', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h);
      (h.document.querySelector('#workspace .raw-args') as any).value = '--no-pull';
      startThenStop(h);
      const raw = h.document.querySelector('#workspace .raw-args') as any;
      expect(raw.value).toBe('--no-pull');
      expect((raw.closest('.all-options') as any).open).toBe(true);
    } finally {
      h.close();
    }
  });

  it('refills the alb per-backing-service image-override pick', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h);
      const selects = h.document.querySelectorAll('#workspace .image-override-select');
      // Pick a Dockerfile for the first backing service; leave the second.
      (selects[0] as any).value = 'api/Dockerfile';
      startThenStop(h);
      expect(h.window.__t.serveApplied.get('S/Alb').imageOverrides).toEqual({ 'S:SvcA': 'api/Dockerfile' });
      const selects2 = h.document.querySelectorAll('#workspace .image-override-select');
      expect((selects2[0] as any).value).toBe('api/Dockerfile');
      expect((selects2[1] as any).value).toBe('');
    } finally {
      h.close();
    }
  });

  it('leaves the composer blank on the FIRST render (no prior start)', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      albComposer(h);
      // No serveApplied record yet => every input is empty / unchecked.
      expect(inputForLabel(h.document, 'Bearer token').value).toBe('');
      expect(inputForLabel(h.document, 'TLS (terminate HTTPS locally)').checked).toBe(false);
      const selects = h.document.querySelectorAll('#workspace .image-override-select');
      Array.from(selects).forEach((s: any) => expect(s.value).toBe(''));
    } finally {
      h.close();
    }
  });
});
