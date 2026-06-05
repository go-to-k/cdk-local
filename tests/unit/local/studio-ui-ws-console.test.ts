import { describe, it, expect, afterEach } from 'vite-plus/test';
import { createStudioHarness, type StudioHarness } from './studio-ui-harness.js';

/**
 * jsdom execution coverage for the studio WebSocket console (renderWsConsole),
 * shared by the served API Gateway WebSocket API (issue #303) and the
 * `agentcore-ws` serve. Covers two UX fixes:
 *
 *  1. An IME composition Enter (confirming a Japanese / CJK conversion
 *     candidate) must NOT send the frame — only a plain Enter does.
 *  2. The console has a Clear button that empties the displayed frame log
 *     without dropping the live socket.
 *
 * The harness exposes `renderWsConsole` via the epilogue hook; the console's
 * `wsEl(...)` selectors query `#workspace .ws-console ...`, so the rendered
 * section is appended to the page's `#workspace` before driving it. A fake
 * `WebSocket` (readyState OPEN) stands in for the browser global so `wsSend`'s
 * `activeWs.readyState === 1` guard passes with no real network handle.
 */

let harness: StudioHarness;

afterEach(() => {
  harness?.close();
});

interface WsHarness extends StudioHarness {
  window: StudioHarness['window'] & { __renderWsConsole: (url: string) => HTMLElement };
}

/** Render the WS console for a url and mount it under #workspace + a fake WebSocket. */
function mountConsole(): { node: HTMLElement; input: HTMLInputElement; pre: HTMLElement } {
  harness = createStudioHarness({
    epilogue: 'window.__renderWsConsole = renderWsConsole;',
  }) as WsHarness;
  const win = harness.window as WsHarness['window'];

  class FakeWS {
    url: string;
    readyState = 1; // OPEN — wsSend's guard checks this directly
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    send(d: string): void {
      this.sent.push(d);
    }
    close(): void {
      this.readyState = 3;
    }
  }
  (win as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

  const node = win.__renderWsConsole('ws://127.0.0.1:9/ws');
  win.document.getElementById('workspace')!.appendChild(node);

  // Connect so activeWs is OPEN and the input is enabled.
  (node.querySelector('.ws-connect') as HTMLElement & { onclick: () => void }).onclick();

  const input = node.querySelector('.ws-input') as HTMLInputElement;
  const pre = node.querySelector('.ws-frames') as HTMLElement;
  return { node, input, pre };
}

/** Invoke the input's onkeydown handler directly with an event-like literal. */
function keydown(input: HTMLInputElement, ev: Partial<KeyboardEvent>): void {
  (input as unknown as { onkeydown: (e: Partial<KeyboardEvent>) => void }).onkeydown(ev);
}

describe('studio WebSocket console (renderWsConsole)', () => {
  it('an IME composition Enter (isComposing) does NOT send the frame', () => {
    const { input, pre } = mountConsole();
    input.value = 'hello';
    keydown(input, { key: 'Enter', isComposing: true });
    // Frame is untouched — the Enter only commits the IME conversion.
    expect(input.value).toBe('hello');
    expect(pre.textContent).not.toContain('-> hello');
  });

  it('a legacy keyCode 229 Enter (IME signal) does NOT send the frame', () => {
    const { input } = mountConsole();
    input.value = 'world';
    keydown(input, { key: 'Enter', isComposing: false, keyCode: 229 });
    expect(input.value).toBe('world');
  });

  it('a plain Enter (no composition) sends the frame and clears the input', () => {
    const { input, pre } = mountConsole();
    input.value = 'hello';
    keydown(input, { key: 'Enter', isComposing: false });
    expect(input.value).toBe('');
    expect(pre.textContent).toContain('-> hello');
  });

  it('the Clear button empties the displayed frame log', () => {
    const { node, input, pre } = mountConsole();
    input.value = 'hello';
    keydown(input, { key: 'Enter', isComposing: false });
    expect(pre.textContent!.length).toBeGreaterThan(0);

    (node.querySelector('.ws-clear') as HTMLElement & { onclick: () => void }).onclick();
    expect(pre.textContent).toBe('');
  });
});
