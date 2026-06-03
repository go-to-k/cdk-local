import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

/**
 * Session-bar regression coverage (issue #349). Drives the real embedded
 * `wireSession` / `applyConfig` flow in jsdom with a RESOLVING `fetch`, so the
 * post-PATCH path runs end to end — the exact condition the bug needed.
 *
 * The bug: `applyConfig` used to re-`loadConfig()` after a successful PATCH.
 * `--assume-role` has no "bare" server form, so a checked-but-empty assume-role
 * PATCHes `null`; the re-load read that back and immediately UN-checked the box
 * + hid the ARN input — so clicking the checkbox appeared to do nothing.
 */
describe('Session bar assume-role checkbox (issue #349)', () => {
  it('keeps the checkbox checked + reveals the ARN input after clicking it', async () => {
    const h = createStudioHarness();
    try {
      // Swap in a resolving fetch so applyConfig's PATCH completes (the init
      // loadConfig is already parked on the never-resolving default — harmless).
      (h.window as unknown as { fetch: unknown }).fetch = () =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

      const cb = h.document.getElementById('sess-role-on') as HTMLInputElement;
      const input = h.document.getElementById('sess-role') as HTMLInputElement;
      expect(cb).toBeTruthy();
      expect(input).toBeTruthy();
      // Starts hidden (unchecked).
      expect(input.style.display).toBe('none');

      // Click the checkbox (jsdom: set checked + dispatch the change event the
      // wireSession listener is bound to).
      cb.checked = true;
      cb.dispatchEvent(new h.window.Event('change'));

      // Let applyConfig's awaited PATCH settle.
      await new Promise((r) => setTimeout(r, 20));

      // The checkbox stays checked and the ARN input is revealed — not clobbered
      // by a post-apply re-load.
      expect(cb.checked).toBe(true);
      expect(input.style.display).not.toBe('none');
    } finally {
      h.close();
    }
  });

  it('hides the ARN input + clears the binding when unchecked', async () => {
    const h = createStudioHarness();
    try {
      const patched: Array<Record<string, unknown>> = [];
      (h.window as unknown as { fetch: unknown }).fetch = (_url: string, init?: { body?: string }) => {
        if (init && typeof init.body === 'string') patched.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      };

      const cb = h.document.getElementById('sess-role-on') as HTMLInputElement;
      const input = h.document.getElementById('sess-role') as HTMLInputElement;

      // Check + type an ARN.
      cb.checked = true;
      cb.dispatchEvent(new h.window.Event('change'));
      await new Promise((r) => setTimeout(r, 5));
      input.value = 'arn:aws:iam::1:role/Demo';
      input.dispatchEvent(new h.window.Event('change'));
      await new Promise((r) => setTimeout(r, 5));
      expect(patched.at(-1)).toMatchObject({ assumeRole: 'arn:aws:iam::1:role/Demo' });

      // Uncheck -> input hidden + the binding clears (null).
      cb.checked = false;
      cb.dispatchEvent(new h.window.Event('change'));
      await new Promise((r) => setTimeout(r, 20));
      expect(input.style.display).toBe('none');
      expect(patched.at(-1)).toMatchObject({ assumeRole: null });
    } finally {
      h.close();
    }
  });
});
