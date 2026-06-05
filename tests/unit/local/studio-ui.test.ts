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

  it('treats agentcore-ws as a serve kind with the AgentCore WS label', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // agentcore-ws is a serve kind (Start/Stop + WebSocket console), distinct
    // from the single-shot agentcore invoke kind.
    expect(html).toContain("'agentcore-ws'");
    expect(html).toContain("'agentcore-ws': 'AgentCore WS'");
    // Its per-run serve options are serialized too.
    expect(html).toContain('"--no-verify-auth"');
  });

  it('embeds the auto-derived full flag catalog for the "All options" section (issue #301)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The full per-kind catalog is serialized for the UI.
    expect(html).toContain('window.__FLAG_CATALOG__ =');
    // It carries each runnable kind's headless command + real flags.
    expect(html).toContain('"command":"start-api"');
    expect(html).toContain('"command":"invoke-agentcore"');
    expect(html).toContain('"command":"start-agentcore"');
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
    // Gated on the serve target being a pinned ecs service OR ecs-task task
    // definition (issue #388 extended the picker to the ecs-task composer).
    expect(html).toContain("(meta.kind === 'ecs' || meta.kind === 'ecs-task') && meta.pinned");
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

  it('renders the apply-on-change Session bar (issue #301)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    expect(html).toContain('id="session-bar"');
    expect(html).toContain('id="sess-cfn"'); // from-cfn-stack toggle
    expect(html).toContain('id="sess-role"'); // assume-role input
    expect(html).toContain('id="sess-watch"'); // watch-mode toggle (issue #301)
    expect(html).toContain('/api/config'); // reads + writes the config endpoint
    // No Save button — the bindings apply immediately on change.
    expect(html).not.toContain('id="sess-save"');
    expect(html).toContain('function applyConfig');
    // The controls wire their change events to apply immediately.
    expect(html).toContain("document.getElementById('sess-watch').addEventListener('change', applyConfig)");
  });

  it('gives --assume-role a checkbox so the Session bar bindings are symmetric (issue #343)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // assume-role is now checkbox-gated like from-cfn-stack.
    expect(html).toContain('id="sess-role-on"');
    // Its ARN input is hidden until the box is checked.
    expect(html).toContain('id="sess-role" type="text" placeholder="arn:aws:iam::…:role/…" style="display:none"');
    // The binding reads the checkbox + reveals/hides the input on toggle.
    expect(html).toContain('assumeRole: roleOn.checked ? role.value.trim() || null : null');
    expect(html).toContain("role.style.display = roleOn.checked ? '' : 'none'");
  });

  it('renders the collapsible / zebra / filterable target pane (issue #301)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // Target filter box + the filter fn.
    expect(html).toContain('id="target-search"');
    expect(html).toContain('function applyTargetFilter');
    // Collapsible groups (collapsed by default) + the toggle.
    expect(html).toContain('function toggleGroup');
    expect(html).toContain("el('div', 'group-body collapsed')");
    // Zebra striping via the JS-applied .alt class (no longer :nth-child, since
    // the interleaved stack sub-headers would offset a positional count), with
    // a clearly distinct shade (issue #333 — the previous #1b1b1b was 1 step off
    // the #1a1a1a base and imperceptible).
    expect(html).toContain('.group-body .target.alt { background: #242424; }');
    // Kind-group header: a uniform dark-amber bar with a warm-gold label —
    // a warm hue that stands apart from both the neutral-grey rows and the
    // blue-navy stack sub-header below it.
    expect(html).toContain('background: #302b18;');
    expect(html).toContain('color: #e3c272;');
    expect(html).toContain('.group-title .count { color: #8a8a8a; }');
  });

  it('widens the Session-bar inputs so the placeholder is not truncated (issue #339)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    expect(html).toContain('#session-bar input[type=text]');
    expect(html).toContain('min-width: 240px;');
  });

  it('renders a Clear button on the serve LOGS panel (issue #338)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    expect(html).toContain("el('button', 'log-clear', 'Clear')");
    expect(html).toContain("logsById.set(id, []);");
    expect(html).toContain('.log-clear');
  });

  it('preserves the serve composer across streamed log events (issue #334)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // A live LOGS <pre> ref is held and updated surgically on log events,
    // instead of re-rendering the whole serve workspace (which wiped the
    // composer inputs + the last response).
    expect(html).toContain('serveLogPre');
    expect(html).toContain('serveLogId');
    expect(html).toContain('serveLogPre.textContent = arr.join(');
    // The log handler no longer full-re-renders a shown serve.
    expect(html).not.toContain('if (shownServeId === ev.containerId) renderServeWorkspace(ev.containerId)');
  });

  it('deselects the timeline and offers a back-to-composer affordance (issues #335 / #336)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // selectTarget + a fresh Send clear any stale `.row.sel`.
    expect(html).toContain("document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'))");
    // The captured-request detail offers a New request button back to the composer.
    expect(html).toContain("el('button', 'reinvoke-btn', 'New request')");
  });

  it('renders an in-workspace HTTP request composer for a running serve (issue #322)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The composer builder + its Send wiring to the same-origin relay.
    expect(html).toContain('function renderRequestComposer');
    expect(html).toContain("fetch('/api/request'");
    // Gated on a running serve having an http base URL (proxy endpoint or the
    // ecs --host-port host URL).
    expect(html).toContain('renderRequestComposer(id, httpBase, captured)');
    expect(html).toContain('isEcs ? st.hostUrl');
    // The ecs host URL is shown in Endpoints with an "not captured" note.
    expect(html).toContain('not captured on the timeline');
  });

  it('clarifies the curl-able proxy port vs the child internal port (issue #325)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The Endpoints hint names the proxy URLs as the request target and warns
    // that the Logs port is the child internal one.
    expect(html).toContain('curl these — captured on the timeline.');
    expect(html).toContain('the serve child internal port');
    // The Logs panel carries a note that its 127.0.0.1 port is internal and
    // the Endpoints above are the address to use.
    expect(html).toContain('any 127.0.0.1 port below is the serve child internal port');
    expect(html).toContain('use the Endpoints above');
  });

  it('wires the re-invoke flow into the composer + timeline (issue #284)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The composer takes a reinvoke source and posts to /api/reinvoke.
    expect(html).toContain('function renderComposer(id, kind, eventText, reinvokeOf)');
    expect(html).toContain("url = '/api/reinvoke'");
    expect(html).toContain('invocationId: active.reinvokeOf, payload: event');
    // A past invoke row reloads into the re-invokable composer with its source id.
    expect(html).toContain('renderComposer(ev.target, ev.kind, ev.request != null ? fmt(ev.request) : ');
    // Re-invoked rows are visually linked to the source.
    expect(html).toContain("row.classList.add('reinvoke')");
    expect(html).toContain('.row.reinvoke .label::before');
    // The captured serve detail offers a Re-invoke that reuses the request
    // composer via the prefill.
    expect(html).toContain('pendingReqPrefill');
    expect(html).toContain("el('button', 'reinvoke-btn', 'Re-invoke')");
  });

  it('renders a KV / JSON headers editor in the request composer (issue #337)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The editor builder + its KV/JSON modes + the collect/jsonError wiring.
    expect(html).toContain('function buildHeaderEditor()');
    expect(html).toContain('const headerEditor = buildHeaderEditor()');
    expect(html).toContain('headers: headerEditor.collect()');
    expect(html).toContain('headerEditor.jsonError()');
    // The old one-per-line textarea label is gone.
    expect(html).not.toContain('Headers (one per line: Name: value)');
  });

  it('remembers the last-used Headers editor mode across composers (issue #345)', () => {
    const html = renderStudioHtml('MyStack', 'cdkl');
    // The editor opens in the remembered mode + records the mode on toggle.
    expect(html).toContain('let lastHeaderMode');
    expect(html).toContain('lastHeaderMode = m;');
    expect(html).toContain('setMode(lastHeaderMode)');
    // Re-invoke prefill seeds the JSON pane too, so the data shows in either mode.
    expect(html).toContain('ta.value = JSON.stringify(headersObj');
  });

  it('HTML-escapes the interpolated app label and CLI name (no injection)', () => {
    const html = renderStudioHtml('<script>alert(1)</script>', '"&<>');
    // The raw markup must never appear verbatim in the document.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&amp;&lt;&gt;');
  });
});
