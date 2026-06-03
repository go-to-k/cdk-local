import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

/**
 * "Started with" applied-options summary (issue #356). After a serve is
 * Started, the per-run option inputs are gone (the composer is replaced by the
 * running view), so the launch config the user chose used to silently vanish —
 * e.g. a chosen `--max-tasks` disappeared. The running workspace now renders a
 * read-only "Started with" summary from `serveApplied` (recorded at Start).
 *
 * The harness evaluates the real embedded STUDIO_SCRIPT in jsdom; the epilogue
 * exposes the inner formatter + serve maps + `renderServeWorkspace` so the
 * formatting AND the DOM render can be driven directly.
 */
const EXPOSE = `
window.__applied = {
  formatAppliedOptions: formatAppliedOptions,
  renderServeWorkspace: renderServeWorkspace,
  serveMeta: serveMeta,
  serveState: serveState,
  serveApplied: serveApplied,
};
`;

interface Exposed {
  formatAppliedOptions: (applied: unknown) => string[];
  renderServeWorkspace: (id: string, err?: string) => void;
  serveMeta: Map<string, unknown>;
  serveState: Map<string, unknown>;
  serveApplied: Map<string, unknown>;
}

const exposed = (h: ReturnType<typeof createStudioHarness>): Exposed =>
  (h.window as unknown as { __applied: Exposed }).__applied;

describe('studio serve "Started with" summary (issue #356)', () => {
  it('formats scalar / boolean / pair / env / rawArgs / imageOverride options', () => {
    const h = createStudioHarness({ epilogue: EXPOSE });
    try {
      const t = exposed(h);
      // scalar -> "flag value"
      expect(t.formatAppliedOptions({ options: { '--max-tasks': '2' } })).toEqual(['--max-tasks 2']);
      // boolean true -> flag only; false -> omitted; blank scalar -> omitted
      expect(
        t.formatAppliedOptions({ options: { '--tls': true, '--no-verify-auth': false, '--tls-cert': '' } })
      ).toEqual(['--tls']);
      // repeat-pair -> one "flag left=right" per NON-empty pair
      expect(
        t.formatAppliedOptions({
          options: { '--host-port': [{ left: '80', right: '8080' }, { left: '', right: '' }] },
        })
      ).toEqual(['--host-port 80=8080']);
      // env-kv pairs
      expect(t.formatAppliedOptions({ options: { '--env-vars': [{ left: 'K', right: 'V' }] } })).toEqual([
        '--env-vars K=V',
      ]);
      // imageOverride + rawArgs are appended after the curated options
      expect(t.formatAppliedOptions({ imageOverride: './Dockerfile', rawArgs: '--foo bar' })).toEqual([
        '--image-override ./Dockerfile',
        '--foo bar',
      ]);
      // nothing applied -> empty list (the UI shows a "(defaults)" hint)
      expect(t.formatAppliedOptions(undefined)).toEqual([]);
      expect(t.formatAppliedOptions({ options: undefined })).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('renders the chosen options in the running serve workspace', () => {
    const h = createStudioHarness({ epilogue: EXPOSE });
    try {
      const t = exposed(h);
      t.serveMeta.set('Stk/Svc', { kind: 'ecs' });
      t.serveApplied.set('Stk/Svc', {
        options: { '--max-tasks': '3', '--host-port': [{ left: '80', right: '8080' }] },
      });
      t.serveState.set('Stk/Svc', { status: 'running', endpoints: [] });
      t.renderServeWorkspace('Stk/Svc');

      expect(h.document.querySelector('.started-with')).toBeTruthy();
      const flags = Array.from(h.document.querySelectorAll('.started-flag')).map((n) => n.textContent);
      expect(flags).toContain('--max-tasks 3');
      expect(flags).toContain('--host-port 80=8080');
    } finally {
      h.close();
    }
  });

  it('shows a "(defaults)" hint when a serve was started with no options', () => {
    const h = createStudioHarness({ epilogue: EXPOSE });
    try {
      const t = exposed(h);
      t.serveMeta.set('Stk/Api', { kind: 'api' });
      t.serveApplied.set('Stk/Api', { options: undefined });
      t.serveState.set('Stk/Api', { status: 'running', endpoints: [] });
      t.renderServeWorkspace('Stk/Api');

      const sec = h.document.querySelector('.started-with');
      expect(sec).toBeTruthy();
      expect(sec?.textContent).toContain('defaults');
    } finally {
      h.close();
    }
  });

  it('does NOT render a "Started with" section before Start (composer state)', () => {
    const h = createStudioHarness({ epilogue: EXPOSE });
    try {
      const t = exposed(h);
      t.serveMeta.set('Stk/Api2', { kind: 'api' });
      t.serveState.set('Stk/Api2', { status: 'stopped', endpoints: [] });
      t.renderServeWorkspace('Stk/Api2');
      expect(h.document.querySelector('.started-with')).toBeNull();
    } finally {
      h.close();
    }
  });
});
