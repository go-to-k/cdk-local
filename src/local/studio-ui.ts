/**
 * The studio web UI, embedded as a string so it ships inside the
 * `cdk-local` npm package (decision D9) with no asset-copy build step —
 * `tsdown` bundles this module like any other source file. Served by
 * {@link import('./studio-server.js').StudioServer} at `GET /`.
 *
 * Slice A renders the 3-pane shell (decision D6): left = target list
 * (from `GET /api/targets`), center = live timeline (from the
 * `GET /api/events` SSE stream — empty until the invoke / serve slices
 * emit invocations), right = detail panel (filled on row click). It is
 * intentionally framework-free vanilla JS (decision D7).
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
  main { display: grid; grid-template-columns: 280px 1fr 360px; height: calc(100vh - 38px); }
  .pane { overflow: auto; border-right: 1px solid #333; }
  .pane:last-child { border-right: 0; }
  .pane h2 {
    margin: 0; padding: 8px 12px; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px; color: #888; background: #151515;
    position: sticky; top: 0; border-bottom: 1px solid #2a2a2a;
  }
  .group-title { padding: 8px 12px 2px; color: #6aa9ff; font-size: 11px; }
  .target { padding: 5px 12px; cursor: default; border-bottom: 1px solid #222; }
  .target .name { color: #ddd; }
  .target .kind { color: #777; font-size: 11px; }
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
  #detail .section { padding: 8px 12px; border-bottom: 1px solid #222; }
  #detail .section h3 { margin: 0 0 6px; font-size: 11px; color: #888; text-transform: uppercase; }
  #detail pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: #cfcfcf; }
  #conn { font-size: 11px; }
  #conn.up { color: #7bd88f; }
  #conn.down { color: #e0707a; }
`;

const STUDIO_SCRIPT = `
  const KIND_LABEL = { lambda: 'Lambda', api: 'API', alb: 'ALB', ecs: 'ECS', agentcore: 'AgentCore' };
  const rowsById = new Map();

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
          const t = el('div', 'target');
          t.appendChild(el('span', 'name', entry.id));
          t.appendChild(document.createTextNode('  '));
          t.appendChild(el('span', 'kind', '(' + (KIND_LABEL[group.kind] || group.kind) + ')'));
          pane.appendChild(t);
        }
      }
      if (!total) pane.appendChild(el('div', 'empty', 'No runnable targets found.'));
    } catch (err) {
      pane.appendChild(el('div', 'empty', 'Failed to load targets: ' + err));
    }
  }

  function addInvocation(ev) {
    const timeline = document.getElementById('timeline');
    const placeholder = timeline.querySelector('.empty');
    if (placeholder) placeholder.remove();
    let row = rowsById.get(ev.id);
    if (!row) {
      row = el('div', 'row');
      row.appendChild(el('span', 'ts'));
      row.appendChild(el('span', 'label'));
      row.appendChild(el('span', 'status'));
      row.onclick = () => selectRow(ev.id);
      rowsById.set(ev.id, row);
      timeline.appendChild(row);
    }
    row._ev = Object.assign(row._ev || {}, ev);
    const d = new Date(ev.ts);
    row.querySelector('.ts').textContent = d.toLocaleTimeString();
    row.querySelector('.label').textContent = (ev.kind ? ev.target + '  ' : '') + (ev.label || '');
    row.querySelector('.status').textContent =
      ev.status != null ? ev.status + (ev.durationMs != null ? '  ' + ev.durationMs + 'ms' : '') : '...';
  }

  function selectRow(id) {
    document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'));
    const row = rowsById.get(id);
    if (row) row.classList.add('sel');
    const ev = row && row._ev;
    const detail = document.getElementById('detail');
    detail.innerHTML = '';
    if (!ev) return;
    const sec = (title, body) => {
      const s = el('div', 'section');
      s.appendChild(el('h3', null, title));
      const pre = el('pre');
      pre.textContent = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      s.appendChild(pre);
      detail.appendChild(s);
    };
    sec('Request', ev.request != null ? ev.request : '(none)');
    sec('Response', ev.response != null ? ev.response : '(pending)');
  }

  function connect() {
    const conn = document.getElementById('conn');
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => { conn.textContent = '● live'; conn.className = 'up'; });
    es.addEventListener('error', () => { conn.textContent = '● disconnected'; conn.className = 'down'; });
    es.addEventListener('invocation', (e) => addInvocation(JSON.parse(e.data)));
  }

  loadTargets();
  connect();
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
  <section class="pane" id="timeline"><h2>Timeline</h2><div class="empty">No requests yet. Invoke or serve a target to see activity.</div></section>
  <section class="pane" id="detail"><h2>Detail</h2><div class="empty">Select a request.</div></section>
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
