import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the request-composer renderer so the test can mount a real Send
// button and assert the inline result frames the response as a "Response"
// section (status badge + headers + body), shared by the captured api/alb and
// the direct ecs --host-port composer.
const EXPOSE = `
window.__t = {
  renderRequestComposer: renderRequestComposer,
};
`;

interface Harness {
  window: any;
  document: any;
  close: () => void;
}

/** Flush pending microtasks / timer callbacks the async Send handler queues. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('request-composer Send result framing', () => {
  it('renders a "Response" section (status badge + headers + body) after Send', async () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      // Stub /api/request to resolve a 200 with headers + an HTML body — the
      // ecs directory-listing shape that prompted this (a raw blob under Send).
      (h.window as any).fetch = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '42' },
              body: '<html><body>Directory listing for /</body></html>',
              durationMs: 7,
            }),
        });

      const sec = h.window.__t.renderRequestComposer('S/Svc', 'http://127.0.0.1:8080', false);
      h.document.body.appendChild(sec);

      const sendBtn = sec.querySelector('.req-send button');
      expect(sendBtn).not.toBeNull();
      sendBtn.click();
      await flush();

      // The inline result frames the response as a "Response" section, not a
      // bare status line + pre dump.
      const respSec = sec.querySelector('.req-result .req-resp');
      expect(respSec).not.toBeNull();
      const heading = respSec.querySelector('h3');
      expect(heading).not.toBeNull();
      expect(heading.textContent).toContain('Response');
      // The status badge rides the heading (ok class for a 2xx).
      const badge = heading.querySelector('.ok');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('200');
      expect(badge.textContent).toContain('7ms');

      // Headers + body still render below the heading.
      const headerPre = respSec.querySelector('pre.req-resp-headers');
      expect(headerPre).not.toBeNull();
      expect(headerPre.textContent).toContain('content-type: text/html');
      const pres = respSec.querySelectorAll('pre');
      expect(pres[pres.length - 1].textContent).toContain('Directory listing for /');
    } finally {
      h.close();
    }
  });

  it('marks a non-2xx response with the bad status class', async () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      (h.window as any).fetch = () =>
        Promise.resolve({
          ok: true,
          status: 404,
          json: () =>
            Promise.resolve({ status: 404, headers: {}, body: 'Not found', durationMs: 3 }),
        });

      const sec = h.window.__t.renderRequestComposer('S/Svc', 'http://127.0.0.1:8080', false);
      h.document.body.appendChild(sec);
      sec.querySelector('.req-send button').click();
      await flush();

      const badge = sec.querySelector('.req-result .req-resp h3 .bad');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('404');
    } finally {
      h.close();
    }
  });

  it('echoes the sent Request (method/path + headers + body) above the Response', async () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      (h.window as any).fetch = () =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ status: 201, headers: {}, body: 'ok', durationMs: 2 }),
        });

      const sec = h.window.__t.renderRequestComposer('S/Svc', 'http://127.0.0.1:8080', false);
      h.document.body.appendChild(sec);
      // Compose a POST /orders with a body so the echo has all three parts.
      sec.querySelector('.req-method').value = 'POST';
      sec.querySelector('.req-path').value = '/orders';
      sec.querySelector('.req-body').value = '{"item":"x"}';
      sec.querySelector('.req-send button').click();
      await flush();

      // A "Request" section echoes the sent request as a counterpart to Response.
      const reqSec = sec.querySelector('.req-result .req-req');
      expect(reqSec).not.toBeNull();
      expect(reqSec.querySelector('h3').textContent).toContain('Request');
      // The request-line carries method + path.
      const reqLine = reqSec.querySelector('pre.req-line');
      expect(reqLine).not.toBeNull();
      expect(reqLine.textContent).toBe('POST /orders');
      // The request body is echoed (and pretty-printed, being JSON).
      const reqBodyPre = reqSec.querySelector('pre.req-resp-body');
      expect(reqBodyPre).not.toBeNull();
      expect(reqBodyPre.textContent).toContain('"item": "x"');
      // The Response section is still present below it.
      expect(sec.querySelector('.req-result .req-resp h3').textContent).toContain('Response');
    } finally {
      h.close();
    }
  });

  it('pretty-prints a JSON response body but leaves HTML/text verbatim', async () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      (h.window as any).fetch = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"a":1,"b":[2,3]}',
              durationMs: 5,
            }),
        });

      const sec = h.window.__t.renderRequestComposer('S/Api', 'http://127.0.0.1:8080', true);
      h.document.body.appendChild(sec);
      sec.querySelector('.req-send button').click();
      await flush();

      const bodyPre = sec.querySelector('.req-result .req-resp pre.req-resp-body');
      expect(bodyPre).not.toBeNull();
      // JSON.stringify(parsed, null, 2): newlines + 2-space indentation.
      expect(bodyPre.textContent).toContain('\n  "a": 1');
      expect(bodyPre.textContent).toContain('\n  "b": [');
    } finally {
      h.close();
    }
  });
});
