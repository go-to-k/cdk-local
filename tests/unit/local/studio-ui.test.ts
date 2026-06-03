import { describe, it, expect } from 'vite-plus/test';
import { renderStudioHtml } from '../../../src/local/studio-ui.js';

describe('renderStudioHtml', () => {
  it('renders a full HTML document branded with the CLI name', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('CDK Local Studio'); // default cdkl brands as the product name
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

  it('embeds the per-target OPTION_SPECS for the UI to render controls from', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    expect(html).toContain('window.__OPTION_SPECS__ =');
    // The serialized table carries the known per-kind options.
    expect(html).toContain('"--env-vars"');
    expect(html).toContain('"--tls"');
    expect(html).toContain('"--max-tasks"');
    // `<` is escaped so a value can never close the surrounding <script>.
    expect(html).not.toMatch(/__OPTION_SPECS__ = [^;]*<\//);
  });

  it('embeds the auto-derived full flag catalog for the "All options" section (issue #301)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The full per-kind catalog is serialized for the UI.
    expect(html).toContain('window.__FLAG_CATALOG__ =');
    // It carries each runnable kind's headless command + real flags.
    expect(html).toContain('"command":"start-api"');
    expect(html).toContain('"command":"invoke-agentcore"');
    // Session-global flags are excluded from the per-target catalog.
    expect(html).not.toMatch(/__FLAG_CATALOG__ =[^;]*"--from-cfn-stack"/);
    // `<` is escaped so a flag description can never close the <script>.
    expect(html).not.toMatch(/__FLAG_CATALOG__ = [^;]*<\//);
  });

  it('renders the collapsed "All options" section with a raw extra-args input', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The builder + the collapsed <details>, the raw-args input, and the
    // read-only catalog reference are all present in the embedded script.
    expect(html).toContain('function buildAllOptions');
    expect(html).toContain("el('details', 'all-options')");
    expect(html).toContain("el('input', 'raw-args')");
    expect(html).toContain('FLAG_CATALOG = window.__FLAG_CATALOG__');
    // Raw args are collected and threaded onto the run/serve body.
    expect(html).toContain('body.rawArgs = rawArgs');
    expect(html).toContain('collectRaw');
    // A no-curated-control kind (api) collects nothing, so the option values
    // are omitted (undefined), keeping the run/serve body byte-identical to
    // before this section existed.
    expect(html).toContain('Object.keys(out).length ? out : undefined');
  });

  it('renders an image-override Dockerfile picker for a pinned ecs service (issue #301)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The picker builder + its select are present.
    expect(html).toContain('function buildImageOverridePicker');
    expect(html).toContain("el('select', 'image-override-select')");
    // Gated on the serve target being a pinned ecs service.
    expect(html).toContain("meta.kind === 'ecs' && meta.pinned");
    // The picked Dockerfile is threaded onto the serve body.
    expect(html).toContain('body.imageOverride = imageOverride');
    // The picker is populated from the boot-scanned dockerfiles carried on the
    // target list payload.
    expect(html).toContain('studioDockerfiles = Array.isArray(data.dockerfiles)');
  });

  it('makes AgentCore a single-shot invoke target with its own options (issue #303)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // AgentCore is wired as an invoke kind (event composer), alongside lambda.
    expect(html).toContain("INVOKE_KINDS = ['lambda', 'agentcore']");
    // Its per-run options are embedded in the serialized OPTION_SPECS table.
    expect(html).toContain('"--ws"');
    expect(html).toContain('"--sigv4"');
    expect(html).toContain('"--session-id"');
    // A timeline row for ANY invoke kind (Lambda OR AgentCore) reloads into the
    // re-invoke composer — gated on INVOKE_KINDS, not a lambda-only check, so an
    // AgentCore row is not mis-routed to the read-only captured-request detail.
    expect(html).toContain('INVOKE_KINDS.includes(ev.kind)');
  });

  it('embeds a WebSocket console for served WebSocket APIs (issue #303)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The console renderer + its lifecycle helpers are present.
    expect(html).toContain('function renderWsConsole');
    expect(html).toContain('new WebSocket(wsUrl)');
    // Wired into the serve workspace for a running serve with a ws:// endpoint.
    expect(html).toContain("/^wss?:/.test(u)");
    expect(html).toContain('ws.appendChild(renderWsConsole(wsEndpoint))');
    // The socket lives in module state so a log-driven serve re-render does not
    // drop the connection; navigation away AND a non-running re-render (serve
    // stopped) close it so it can't linger against a dead serve.
    expect(html).toContain('function closeActiveWs');
    expect(html).toContain('closeActiveWs();'); // called on navigation + serve stop, not just defined
    expect(html).toContain('if (!running) closeActiveWs();'); // stop-leak guard
    // A received frame may be a binary Blob (the local emulator's
    // PostToConnection path) — decode it to text rather than show a placeholder.
    expect(html).toContain("typeof d.text === 'function'");
  });

  it('renders the editable Session bar (issue #301 slice 3)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    expect(html).toContain('id="session-bar"');
    expect(html).toContain('id="sess-cfn"'); // from-cfn-stack toggle
    expect(html).toContain('id="sess-role"'); // assume-role input
    expect(html).toContain('id="sess-watch"'); // watch-mode toggle (issue #301)
    expect(html).toContain('id="sess-save"'); // Save button
    expect(html).toContain('/api/config'); // reads + writes the config endpoint
  });

  it('HTML-escapes the interpolated app label and CLI name (no injection)', () => {
    const html = renderStudioHtml('<script>alert(1)</script>', '"&<>');
    // The raw markup must never appear verbatim in the document.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&amp;&lt;&gt;');
  });
});
