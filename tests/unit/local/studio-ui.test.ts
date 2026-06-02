import { describe, it, expect } from 'vite-plus/test';
import { renderStudioHtml } from '../../../src/local/studio-ui.js';

describe('renderStudioHtml', () => {
  it('renders a full HTML document branded with the CLI name', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('cdkl studio');
    expect(html).toContain('MyStack');
    // The three panes are present (targets / workspace / timeline).
    expect(html).toContain('id="targets"');
    expect(html).toContain('id="workspace"');
    expect(html).toContain('id="timeline"');
    // Slice C3: the log search box + history/search wiring are present.
    expect(html).toContain('id="log-search"');
    expect(html).toContain('/api/logs?q=');
    expect(html).toContain('/api/history');
    expect(html).toContain('/api/invocations/');
  });

  it('HTML-escapes the interpolated app label and CLI name (no injection)', () => {
    const html = renderStudioHtml('<script>alert(1)</script>', '"&<>');
    // The raw markup must never appear verbatim in the document.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&amp;&lt;&gt;');
  });
});
