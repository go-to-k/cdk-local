import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the serve-workspace internals the failure-rendering tests drive.
const EXPOSE = `
window.__t = {
  onServeEvent: onServeEvent,
  serveMeta: serveMeta,
  serveState: serveState,
  serveApplied: serveApplied,
  renderServeWorkspace: renderServeWorkspace,
};
window.__setShown = function (id) { shownServeId = id; };
`;

interface Harness {
  window: any;
  document: any;
  close: () => void;
}

// Boot a shown alb serve in the RUNNING state with a recorded "Started with".
function setupRunning(h: Harness, applied?: unknown) {
  const t = h.window.__t;
  const dot = h.document.createElement('span');
  const btnSlot = h.document.createElement('span');
  t.serveMeta.set('Stk/Alb', { kind: 'alb', dot, btnSlot });
  if (applied) t.serveApplied.set('Stk/Alb', applied);
  t.serveState.set('Stk/Alb', { status: 'running', endpoints: ['http://127.0.0.1:8080'] });
  h.window.__setShown('Stk/Alb');
  t.renderServeWorkspace('Stk/Alb');
  return t;
}

const q = (h: Harness, sel: string) => h.document.querySelector(sel);
const flagTexts = (h: Harness) =>
  Array.from(h.document.querySelectorAll('.started-flag')).map((n: any) => n.textContent);
const headBtn = (h: Harness) => h.document.querySelector('#workspace .composer button');

describe('serve workspace: failure vs clean-stop rendering', () => {
  it('a post-start crash (stopped WITH a message) surfaces the reason + keeps "Started with", no composer', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const t = setupRunning(h, { options: { '--env-vars': [{ left: 'API_KEY', right: 'secret' }] } });
      // running -> Started with shows the env-vars
      expect(flagTexts(h)).toContain('--env-vars API_KEY=secret');

      // The serve child crashes after it was running: 'stopped' WITH a message.
      t.onServeEvent({ target: 'Stk/Alb', status: 'stopped', message: 'Server process exited (code 1).' });

      // The crash reason is now visible (was silently swallowed before the fix).
      expect((q(h, '#workspace .err') as any)?.textContent).toBe('Server process exited (code 1).');
      // "Started with" is preserved (does not read as "my inputs vanished").
      expect(flagTexts(h)).toContain('--env-vars API_KEY=secret');
      // The blank composer is NOT shown; the button offers Reconfigure.
      expect(q(h, '#workspace .options-wrap')).toBeNull();
      expect((headBtn(h) as any).textContent).toBe('Reconfigure');
    } finally {
      h.close();
    }
  });

  it('a clean user stop (stopped with NO message) returns to the composer with no error banner', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const t = setupRunning(h, { options: { '--env-vars': [{ left: 'API_KEY', right: 'secret' }] } });

      // A user Stop emits 'stopped' with NO message.
      t.onServeEvent({ target: 'Stk/Alb', status: 'stopped' });

      expect(q(h, '#workspace .err')).toBeNull();
      expect(q(h, '#workspace .started-with')).toBeNull();
      expect(q(h, '#workspace .options-wrap')).not.toBeNull();
      expect((headBtn(h) as any).textContent).toBe('Start');
    } finally {
      h.close();
    }
  });

  it('a boot failure (error status WITH a message) surfaces the reason like a crash', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const t = setupRunning(h, { options: {} });

      t.onServeEvent({
        target: 'Stk/Alb',
        status: 'error',
        message: 'Server exited before listening (code 1).',
      });

      expect((q(h, '#workspace .err') as any)?.textContent).toBe('Server exited before listening (code 1).');
      expect(q(h, '#workspace .options-wrap')).toBeNull();
      expect((headBtn(h) as any).textContent).toBe('Reconfigure');
    } finally {
      h.close();
    }
  });

  it('Reconfigure clears the failed state and brings the composer back', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const t = setupRunning(h, { options: { '--env-vars': [{ left: 'API_KEY', right: 'secret' }] } });
      t.onServeEvent({ target: 'Stk/Alb', status: 'stopped', message: 'Server process exited (code 1).' });

      // Click Reconfigure.
      (headBtn(h) as any).click();

      expect(q(h, '#workspace .err')).toBeNull();
      expect(q(h, '#workspace .started-with')).toBeNull();
      expect(q(h, '#workspace .options-wrap')).not.toBeNull();
      expect((headBtn(h) as any).textContent).toBe('Start');
    } finally {
      h.close();
    }
  });
});
