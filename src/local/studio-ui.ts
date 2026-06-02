/**
 * The studio web UI, embedded as a string so it ships inside the
 * `cdk-local` npm package (decision D9) with no asset-copy build step —
 * `tsdown` bundles this module like any other source file. Served by
 * the studio HTTP server (`startStudioServer`) at `GET /`.
 *
 * 3-pane shell (decision D6), framework-free vanilla JS (decision D7):
 *   - left   = target list (from `GET /api/targets`); each runnable
 *     Lambda has an [Invoke] button and a selected-highlight.
 *   - center = the WORKSPACE for the selected target: an event composer
 *     (textarea + Invoke button) with the latest run's Request /
 *     Response / Logs shown BELOW it, so you can edit and re-invoke
 *     repeatedly without losing the composer.
 *   - right  = the timeline (history) of every invocation; clicking a
 *     row loads it back into the workspace.
 *
 * The center workspace is deliberately adjacent to the left target list
 * (short eye-travel: pick a target -> compose right next to it), and is
 * the primary surface — the timeline is secondary history.
 */

const STUDIO_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e6e6e6; background: #1a1a1a; height: 100vh; overflow: hidden;
  }
  header {
    padding: 8px 14px; background: #111; border-bottom: 1px solid #333;
    display: flex; align-items: center; gap: 10px;
  }
  header .brand { font-weight: 700; color: #fff; }
  header .meta { color: #888; font-size: 12px; }
  main {
    display: grid; grid-template-columns: 280px 5px 1fr 5px 320px;
    height: calc(100vh - 38px);
  }
  .pane { overflow: auto; }
  .splitter { background: #2a2a2a; cursor: col-resize; }
  .splitter:hover, .splitter.dragging { background: #4ec97a; }
  .pane h2 {
    margin: 0; padding: 8px 12px; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px; color: #888; background: #151515;
    position: sticky; top: 0; border-bottom: 1px solid #2a2a2a; z-index: 1;
  }
  .group-title { padding: 8px 12px 2px; color: #6aa9ff; font-size: 11px; }
  .target {
    padding: 6px 12px; border-bottom: 1px solid #222; display: flex;
    align-items: center; gap: 8px;
  }
  .target.runnable { cursor: pointer; }
  .target.runnable:hover { background: #202020; }
  .target.sel { background: #2a3550; }
  .target .name { color: #ddd; flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .target .kind { color: #777; font-size: 11px; }
  .target .invoke-btn {
    padding: 2px 10px; font: 11px ui-monospace, Menlo, monospace; font-weight: 700;
    color: #0d1f12; background: #4ec97a; border: 0; border-radius: 3px; cursor: pointer;
  }
  .target .invoke-btn:hover { background: #6fe097; }
  .target.sel .invoke-btn { background: #6fe097; }
  .empty { padding: 16px 12px; color: #666; }
  .row {
    padding: 5px 12px; border-bottom: 1px solid #222; cursor: pointer;
    display: flex; gap: 8px; white-space: nowrap;
  }
  .row:hover { background: #222; }
  .row.sel { background: #2a3550; }
  .row .ts { color: #777; }
  .row .label { color: #ddd; flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .row .status { color: #7bd88f; }
  .row .status.err { color: #e0707a; }
  #workspace { padding: 0 0 24px; }
  .composer { padding: 10px 12px; border-bottom: 1px solid #2a2a2a; }
  .composer .target-name { color: #fff; font-weight: 700; margin-bottom: 6px; }
  .composer textarea {
    width: 100%; min-height: 130px; resize: vertical; background: #111; color: #ddd;
    border: 1px solid #333; border-radius: 3px; padding: 6px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .composer button {
    margin-top: 8px; padding: 6px 18px; background: #2a7d46; color: #fff;
    border: 0; border-radius: 3px; cursor: pointer; font: inherit; font-weight: 700;
  }
  .composer button:hover { background: #339152; }
  .composer button:disabled { background: #333; color: #888; cursor: default; }
  .composer .err { color: #e0707a; margin-top: 6px; min-height: 18px; }
  .section { padding: 8px 12px; border-bottom: 1px solid #222; }
  .section h3 { margin: 0 0 6px; font-size: 11px; color: #888; text-transform: uppercase; }
  .section h3 .ok { color: #7bd88f; }
  .section h3 .bad { color: #e0707a; }
  .section pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: #cfcfcf; }
  #conn { font-size: 11px; }
  #conn.up { color: #7bd88f; }
  #conn.down { color: #e0707a; }
`;

const STUDIO_SCRIPT = `
  const KIND_LABEL = { lambda: 'Lambda', api: 'API', alb: 'ALB', ecs: 'ECS', agentcore: 'AgentCore' };
  const rowsById = new Map();      // invocationId -> timeline row element
  const invById = new Map();       // invocationId -> latest invocation event
  const logsById = new Map();      // invocationId -> [log lines]
  const targetEls = new Map();     // targetId -> left-pane element
  let active = null;               // { id, kind, ta, btn, msg, result }
  let shownInvId = null;           // invocation whose result is in the workspace

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function loadTargets() {
    const pane = document.getElementById('targets');
    try {
      const res = await fetch('/api/targets');
      const data = await res.json();
      pane.querySelectorAll('.group-title,.target,.empty').forEach((n) => n.remove());
      let total = 0;
      for (const group of data.groups) {
        if (!group.entries.length) continue;
        pane.appendChild(el('div', 'group-title', group.title));
        for (const entry of group.entries) {
          total += 1;
          // Slice B: only Lambda targets are runnable from the UI (single-shot
          // invoke). Other kinds list but are not yet selectable.
          const runnable = group.kind === 'lambda';
          const t = el('div', runnable ? 'target runnable' : 'target');
          const name = el('span', 'name', entry.id);
          name.title = entry.id; // full path on hover even when truncated
          t.appendChild(name);
          t.appendChild(el('span', 'kind', '(' + (KIND_LABEL[group.kind] || group.kind) + ')'));
          if (runnable) {
            const btn = el('button', 'invoke-btn', 'Invoke');
            btn.onclick = (e) => { e.stopPropagation(); selectTarget(entry.id, group.kind); };
            t.appendChild(btn);
            t.onclick = () => selectTarget(entry.id, group.kind);
            targetEls.set(entry.id, t);
          }
          pane.appendChild(t);
        }
      }
      if (!total) pane.appendChild(el('div', 'empty', 'No runnable targets found.'));
    } catch (err) {
      pane.appendChild(el('div', 'empty', 'Failed to load targets: ' + err));
    }
  }

  function highlightTarget(id) {
    document.querySelectorAll('.target.sel').forEach((n) => n.classList.remove('sel'));
    const t = targetEls.get(id);
    if (t) t.classList.add('sel');
  }

  function selectTarget(id, kind) {
    highlightTarget(id);
    renderComposer(id, kind, '{}');
  }

  function renderComposer(id, kind, eventText) {
    const ws = document.getElementById('workspace');
    ws.innerHTML = '';

    const composer = el('div', 'composer');
    composer.appendChild(el('div', 'target-name', 'Invoke ' + id));
    const ta = el('textarea');
    ta.value = eventText;
    ta.spellcheck = false;
    composer.appendChild(ta);
    composer.appendChild(document.createElement('br'));
    const btn = el('button', null, 'Invoke');
    const msg = el('div', 'err');
    composer.appendChild(btn);
    composer.appendChild(msg);

    const result = el('div', 'result');

    ws.appendChild(composer);
    ws.appendChild(result);

    active = { id, kind, ta, btn, msg, result };
    btn.onclick = () => runInvoke();
    shownInvId = null;
    ta.focus();
  }

  async function runInvoke() {
    if (!active) return;
    const { id, kind, ta, btn, msg, result } = active;
    let event;
    try {
      event = ta.value.trim() === '' ? {} : JSON.parse(ta.value);
    } catch (err) {
      msg.textContent = 'Invalid JSON: ' + err.message;
      return;
    }
    msg.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Invoking...';
    result.innerHTML = '';
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id, kind, event }),
      });
      const data = await res.json();
      if (data.invocationId) {
        shownInvId = data.invocationId;
        renderResult(shownInvId);
      }
      if (!res.ok || data.ok === false) {
        msg.textContent = 'Invoke failed: ' + (data.error || ('HTTP ' + res.status));
      }
    } catch (err) {
      msg.textContent = 'Request failed: ' + err;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Invoke';
    }
  }

  function fmt(body) {
    return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  }

  function renderResult(invId) {
    if (!active) return;
    const result = active.result;
    result.innerHTML = '';
    const ev = invById.get(invId);
    if (!ev) return;

    const reqSec = el('div', 'section');
    reqSec.appendChild(el('h3', null, 'Request'));
    reqSec.appendChild(el('pre', null, ev.request != null ? fmt(ev.request) : '(none)'));
    result.appendChild(reqSec);

    const respSec = el('div', 'section');
    const h = el('h3', null, 'Response');
    if (ev.status != null) {
      const cls = ev.status >= 200 && ev.status < 300 ? 'ok' : 'bad';
      const meta = el('span', cls, '  ' + ev.status + (ev.durationMs != null ? ' · ' + ev.durationMs + 'ms' : ''));
      h.appendChild(meta);
    }
    respSec.appendChild(h);
    respSec.appendChild(el('pre', null, ev.response != null ? fmt(ev.response) : '(pending…)'));
    result.appendChild(respSec);

    const logs = logsById.get(invId) || [];
    const logSec = el('div', 'section');
    logSec.appendChild(el('h3', null, 'Logs'));
    logSec.appendChild(el('pre', null, logs.length ? logs.join('\\n') : '(none)'));
    result.appendChild(logSec);
  }

  function addInvocation(ev) {
    invById.set(ev.id, Object.assign(invById.get(ev.id) || {}, ev));
    const timeline = document.getElementById('timeline');
    const placeholder = timeline.querySelector('.empty');
    if (placeholder) placeholder.remove();

    let row = rowsById.get(ev.id);
    if (!row) {
      row = el('div', 'row');
      row.appendChild(el('span', 'ts'));
      row.appendChild(el('span', 'label'));
      row.appendChild(el('span', 'status'));
      row.onclick = () => loadInvocation(ev.id);
      rowsById.set(ev.id, row);
      timeline.insertBefore(row, timeline.querySelector('.row')); // newest on top
    }
    const merged = invById.get(ev.id);
    const d = new Date(merged.ts);
    row.querySelector('.ts').textContent = d.toLocaleTimeString();
    row.querySelector('.label').textContent = (merged.target || '') + '  ' + (merged.label || '');
    const statusEl = row.querySelector('.status');
    statusEl.textContent =
      merged.status != null
        ? merged.status + (merged.durationMs != null ? '  ' + merged.durationMs + 'ms' : '')
        : '…';
    statusEl.className = 'status' + (merged.status != null && (merged.status < 200 || merged.status >= 300) ? ' err' : '');

    // Live-refresh the workspace result if it is showing this invocation.
    if (shownInvId === ev.id) renderResult(ev.id);
  }

  function loadInvocation(id) {
    const ev = invById.get(id);
    if (!ev) return;
    document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'));
    const row = rowsById.get(id);
    if (row) row.classList.add('sel');
    highlightTarget(ev.target);
    renderComposer(ev.target, ev.kind, ev.request != null ? fmt(ev.request) : '{}');
    shownInvId = id;
    renderResult(id);
  }

  function connect() {
    const conn = document.getElementById('conn');
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => { conn.textContent = '● live'; conn.className = 'up'; });
    es.addEventListener('error', () => { conn.textContent = '● disconnected'; conn.className = 'down'; });
    es.addEventListener('invocation', (e) => addInvocation(JSON.parse(e.data)));
    es.addEventListener('log', (e) => {
      const ev = JSON.parse(e.data);
      const arr = logsById.get(ev.containerId) || [];
      arr.push(ev.line);
      logsById.set(ev.containerId, arr);
      if (shownInvId === ev.containerId) renderResult(ev.containerId);
    });
  }

  function initSplitters() {
    const main = document.querySelector('main');
    let left = 280, right = 320;
    const apply = () => {
      main.style.gridTemplateColumns = left + 'px 5px 1fr 5px ' + right + 'px';
    };
    const wire = (splitterId, onMove) => {
      const s = document.getElementById(splitterId);
      s.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const l0 = left, r0 = right;
        s.classList.add('dragging');
        document.body.style.userSelect = 'none';
        const move = (ev) => { onMove(ev.clientX - startX, l0, r0); apply(); };
        const up = () => {
          s.classList.remove('dragging');
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    };
    const clamp = (v) => Math.max(160, Math.min(760, v));
    wire('split-left', (dx, l0) => { left = clamp(l0 + dx); });
    wire('split-right', (dx, l0, r0) => { right = clamp(r0 - dx); });
  }

  loadTargets();
  connect();
  initSplitters();
`;

/**
 * Render the full studio HTML document. `appLabel` is shown in the
 * header (the CDK app / stack context); `cliName` brands the title for
 * host CLIs that rebrand `cdkl`.
 */
export function renderStudioHtml(appLabel: string, cliName: string): string {
  const safeApp = escapeHtml(appLabel);
  const safeCli = escapeHtml(cliName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeCli} studio</title>
<style>${STUDIO_CSS}</style>
</head>
<body>
<header>
  <span class="brand">${safeCli} studio</span>
  <span class="meta">${safeApp}</span>
  <span id="conn" class="down">● connecting</span>
</header>
<main>
  <section class="pane" id="targets"><h2>Targets</h2></section>
  <div class="splitter" id="split-left"></div>
  <section class="pane" id="workspace"><div class="empty">Pick a Lambda on the left to invoke it.</div></section>
  <div class="splitter" id="split-right"></div>
  <section class="pane" id="timeline"><h2>Timeline</h2><div class="empty">No requests yet.</div></section>
</main>
<script>${STUDIO_SCRIPT}</script>
</body>
</html>`;
}

/** Minimal HTML-escape for the few interpolated text values. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
