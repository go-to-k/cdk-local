import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

/**
 * Session-bar re-classify coverage (issue #385). When the `--from-cfn-stack`
 * binding changes, `applyConfig` re-fetches `/api/targets` so the image-override
 * pickers (which depend on the server-side pin classification) appear / vanish
 * without restarting studio. A watch / role toggle — which does NOT change the
 * pin classification — must NOT needlessly rebuild the target pane.
 *
 * Drives the real embedded `applyConfig` in jsdom with a RESOLVING `fetch` that
 * records every call, so the post-PATCH path runs end to end. The init
 * `loadConfig` parks on the harness's never-resolving default fetch, so
 * `lastAppliedCfn` starts at its `null` default (no binding).
 */
interface FetchCall {
  method: string;
  url: string;
}

function recordingFetch(calls: FetchCall[]) {
  return (url: string, init?: { method?: string }) => {
    calls.push({ method: (init && init.method) || 'GET', url });
    if (url === '/api/targets') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ groups: [], dockerfiles: [] }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Session bar re-classify on --from-cfn-stack change (issue #385)', () => {
  it('re-fetches /api/targets after the from-cfn-stack binding changes', async () => {
    const h = createStudioHarness();
    try {
      const calls: FetchCall[] = [];
      (h.window as unknown as { fetch: unknown }).fetch = recordingFetch(calls);

      const cfn = h.document.getElementById('sess-cfn') as HTMLInputElement;
      cfn.checked = true;
      cfn.dispatchEvent(new h.window.Event('change'));
      await tick();

      // The binding was PATCHed AND the target list re-fetched so the pickers
      // refresh under the new --from-cfn-stack.
      expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/config')).toBe(true);
      expect(calls.some((c) => c.url === '/api/targets')).toBe(true);
    } finally {
      h.close();
    }
  });

  it('does NOT re-fetch /api/targets when only the watch toggle changes', async () => {
    const h = createStudioHarness();
    try {
      const calls: FetchCall[] = [];
      (h.window as unknown as { fetch: unknown }).fetch = recordingFetch(calls);

      // Toggle watch (the from-cfn-stack control stays unchecked => unchanged).
      const watch = h.document.getElementById('sess-watch') as HTMLInputElement;
      watch.checked = true;
      watch.dispatchEvent(new h.window.Event('change'));
      await tick();

      expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/config')).toBe(true);
      // No binding change => no target-pane rebuild.
      expect(calls.some((c) => c.url === '/api/targets')).toBe(false);
    } finally {
      h.close();
    }
  });
});
