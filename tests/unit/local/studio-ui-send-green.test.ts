import { describe, it, expect } from 'vite-plus/test';
import { createStudioHarness } from './studio-ui-harness.js';

// Expose the request-composer renderer so the test can mount a real Send
// button (issue #4 — the captured api/alb + direct ecs host-port composer both
// use `.req-composer`, so the one rule covers all "send" buttons).
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

describe('request-composer Send button styling (issue #4)', () => {
  it('renders the Send button inside .req-send and styles it green via the stylesheet', () => {
    const h = createStudioHarness({ epilogue: EXPOSE }) as Harness;
    try {
      const sec = h.window.__t.renderRequestComposer('S/Api', 'http://localhost:9999', true);

      // The Send button is the captured-request submit, inside `.req-send`.
      const sendBtn = sec.querySelector('.req-send button');
      expect(sendBtn).not.toBeNull();
      expect(sendBtn.textContent).toBe('Send');

      // jsdom does not resolve the full CSS cascade into computed style, so the
      // load-bearing assertion is that the embedded stylesheet now carries the
      // green rule for the `.req-composer .req-send button` selector (the same
      // #2a7d46 token the `.composer button` primary submit uses). Without this
      // rule the button falls back to the UA-default white.
      const styleText = Array.from(h.document.querySelectorAll('style'))
        .map((s: any) => s.textContent || '')
        .join('\n');
      expect(styleText).toMatch(/\.req-composer \.req-send button \{[^}]*background: #2a7d46[^}]*\}/);
      expect(styleText).toMatch(/\.req-composer \.req-send button \{[^}]*color: #fff[^}]*\}/);
      // Hover + disabled states mirror `.composer button` so the green button is
      // consistent across all states.
      expect(styleText).toMatch(/\.req-composer \.req-send button:hover \{[^}]*background: #339152[^}]*\}/);
      expect(styleText).toMatch(/\.req-composer \.req-send button:disabled \{[^}]*background: #333[^}]*color: #888[^}]*\}/);
    } finally {
      h.close();
    }
  });
});
