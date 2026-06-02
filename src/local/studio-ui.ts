/**
 * The studio web UI, embedded as a string so it ships inside the
 * `cdk-local` npm package (decision D9) with no asset-copy build step —
 * `tsdown` bundles this module like any other source file. Served by
 * the studio HTTP server (`startStudioServer`) at `GET /`.
 *
 * 3-pane shell (decision D6), framework-free vanilla JS (decision D7):
 *   - left   = target list (from `GET /api/targets`); each Lambda has an
 *     [Invoke] button, each API a [Start] / [Stop] serve control with a
 *     `running ● :port` indicator (slice C1), plus a selected-highlight.
 *   - center = the WORKSPACE for the selected target: for a Lambda, an
 *     event composer (textarea + Invoke button) with the latest run's
 *     Request / Response / Logs shown below; for an API, a Start/Stop
 *     control with the served endpoints + streaming logs.
 *   - right  = the timeline (history) of every invocation AND every
 *     captured serve request (slice C2); clicking a Lambda row reloads
 *     it into the composer, clicking a captured request row opens a
 *     read-only Request / Response detail.
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
  .target .stop-btn {
    padding: 2px 10px; font: 11px ui-monospace, Menlo, monospace; font-weight: 700;
    color: #2a0d0d; background: #e0707a; border: 0; border-radius: 3px; cursor: pointer;
  }
  .target .stop-btn:hover { background: #ec8a92; }
  .target .run-dot { color: #7bd88f; font-size: 11px; white-space: nowrap; }
  .target .run-dot.starting { color: #e0b54e; }
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
  .endpoint { display: block; color: #6aa9ff; text-decoration: none; padding: 2px 0; }
  .endpoint:hover { text-decoration: underline; }
  .searchbar { padding: 6px 10px; border-bottom: 1px solid #2a2a2a; background: #151515;
    position: sticky; top: 28px; z-index: 1; }
  .searchbar input {
    width: 100%; background: #111; color: #ddd; border: 1px solid #333; border-radius: 3px;
    padding: 5px 8px; font: 12px ui-monospace, Menlo, monospace;
  }
  .searchbar input:focus { outline: none; border-color: #4ec97a; }
  #log-results { display: none; }
  #log-results.active { display: block; }
  .log-hit { padding: 4px 12px; border-bottom: 1px solid #222; white-space: pre-wrap;
    word-break: break-word; }
  .log-hit .lt { color: #777; }
  .log-hit .lg { color: #6aa9ff; }
  .log-hits-meta { padding: 6px 12px; color: #888; font-size: 11px; }
  #conn { font-size: 11px; }
  #conn.up { color: #7bd88f; }
  #conn.down { color: #e0707a; }
`;

const STUDIO_SCRIPT = `
  const KIND_LABEL = { lambda: 'Lambda', api: 'API', alb: 'ALB', ecs: 'ECS', agentcore: 'AgentCore' };
  const rowsById = new Map();      // invocationId -> timeline row element
  const invById = new Map();       // invocationId -> latest invocation event
  const logsById = new Map();      // invocationId / serve targetId -> [log lines]
  const targetEls = new Map();     // targetId -> left-pane element
  const serveMeta = new Map();     // serve targetId -> { dot, btnSlot } row controls
  const serveState = new Map();    // serve targetId -> { status, endpoints }
  let active = null;               // { id, kind, ta, btn, msg, result }
  let shownInvId = null;           // lambda invocation whose result is in the workspace
  let shownServeId = null;         // serve target whose workspace is shown
  let shownDetailId = null;        // captured request whose read-only detail is shown

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
          // Lambda targets are single-shot invokes; API targets are
          // long-running serves (slice C1). Other kinds list but are not
          // yet runnable.
          const runnable = group.kind === 'lambda' || group.kind === 'api';
          const t = el('div', runnable ? 'target runnable' : 'target');
          const name = el('span', 'name', entry.id);
          name.title = entry.id; // full path on hover even when truncated
          t.appendChild(name);
          t.appendChild(el('span', 'kind', '(' + (KIND_LABEL[group.kind] || group.kind) + ')'));
          if (group.kind === 'lambda') {
            const btn = el('button', 'invoke-btn', 'Invoke');
            btn.onclick = (e) => { e.stopPropagation(); selectTarget(entry.id, 'lambda'); };
            t.appendChild(btn);
            t.onclick = () => selectTarget(entry.id, 'lambda');
            targetEls.set(entry.id, t);
          } else if (group.kind === 'api') {
            // A serve target: a running-state dot + a Start/Stop button
            // slot, both refreshed by updateServeRow on serve events.
            const dot = el('span', 'run-dot');
            const btnSlot = el('span', 'btn-slot');
            t.appendChild(dot);
            t.appendChild(btnSlot);
            t.onclick = () => selectTarget(entry.id, 'api');
            targetEls.set(entry.id, t);
            serveMeta.set(entry.id, { dot, btnSlot });
            updateServeRow(entry.id);
          }
          pane.appendChild(t);
        }
      }
      if (!total) pane.appendChild(el('div', 'empty', 'No runnable targets found.'));
    } catch (err) {
      pane.appendChild(el('div', 'empty', 'Failed to load targets: ' + err));
    }
  }

  // Pull any already-running serves (e.g. after a UI reload) so the rows
  // and workspace reflect them without waiting for a fresh serve event.
  async function loadRunning() {
    try {
      const res = await fetch('/api/running');
      const data = await res.json();
      for (const s of (data.running || [])) {
        serveState.set(s.targetId, { status: s.status, endpoints: s.endpoints || [] });
        updateServeRow(s.targetId);
      }
    } catch (err) {
      /* best-effort; the serve SSE stream still drives live updates */
    }
  }

  function firstPort(endpoints) {
    const u = (endpoints || [])[0];
    if (!u) return '';
    const m = /:(\\d+)/.exec(u);
    return m ? ':' + m[1] : '';
  }

  function updateServeRow(id) {
    const meta = serveMeta.get(id);
    if (!meta) return;
    const st = serveState.get(id);
    const status = st ? st.status : 'stopped';
    const running = status === 'running';
    const starting = status === 'starting';
    meta.dot.textContent = running ? '● ' + firstPort(st.endpoints) : starting ? '○ starting' : '';
    meta.dot.className = 'run-dot' + (starting ? ' starting' : '');
    meta.btnSlot.innerHTML = '';
    const btn = running || starting
      ? el('button', 'stop-btn', 'Stop')
      : el('button', 'invoke-btn', 'Start');
    btn.onclick = (e) => {
      e.stopPropagation();
      if (running || starting) stopServe(id); else startServe(id);
    };
    meta.btnSlot.appendChild(btn);
    // Refresh the workspace if it is showing this serve.
    if (shownServeId === id) renderServeWorkspace(id);
  }

  function highlightTarget(id) {
    document.querySelectorAll('.target.sel').forEach((n) => n.classList.remove('sel'));
    const t = targetEls.get(id);
    if (t) t.classList.add('sel');
  }

  function selectTarget(id, kind) {
    highlightTarget(id);
    shownDetailId = null;
    if (kind === 'api') {
      shownServeId = id;
      shownInvId = null;
      active = null;
      renderServeWorkspace(id);
    } else {
      shownServeId = null;
      renderComposer(id, kind, '{}');
    }
  }

  async function startServe(id) {
    serveState.set(id, { status: 'starting', endpoints: [] });
    updateServeRow(id);
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id, kind: 'api' }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Roll back the optimistic 'starting' on a rejected start.
        serveState.set(id, { status: 'error', endpoints: [] });
        updateServeRow(id);
        if (shownServeId === id) renderServeWorkspace(id, data.error || ('HTTP ' + res.status));
      }
      // On success the serve SSE 'running' event fills in the endpoints.
    } catch (err) {
      serveState.set(id, { status: 'error', endpoints: [] });
      updateServeRow(id);
      if (shownServeId === id) renderServeWorkspace(id, String(err));
    }
  }

  async function stopServe(id) {
    try {
      await fetch('/api/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id }),
      });
      // The serve SSE 'stopped' event clears the running state.
    } catch (err) {
      /* the stop SSE event (or a later refresh) reconciles state */
    }
  }

  function renderServeWorkspace(id, errMsg) {
    const ws = document.getElementById('workspace');
    ws.innerHTML = '';
    const st = serveState.get(id) || { status: 'stopped', endpoints: [] };
    const running = st.status === 'running';
    const starting = st.status === 'starting';

    const head = el('div', 'composer');
    head.appendChild(el('div', 'target-name', 'Serve ' + id));
    const btn = running || starting
      ? el('button', null, 'Stop')
      : el('button', null, starting ? 'Starting…' : 'Start');
    btn.onclick = () => { if (running || starting) stopServe(id); else startServe(id); };
    head.appendChild(btn);
    if (errMsg) {
      const m = el('div', 'err', errMsg);
      head.appendChild(m);
    }
    ws.appendChild(head);

    const epSec = el('div', 'section');
    epSec.appendChild(el('h3', null, 'Endpoints'));
    if (running && st.endpoints.length) {
      for (const url of st.endpoints) {
        const link = href(url);
        epSec.appendChild(link);
      }
    } else {
      epSec.appendChild(el('pre', null, starting ? '(starting…)' : '(not running)'));
    }
    ws.appendChild(epSec);

    const logs = logsById.get(id) || [];
    const logSec = el('div', 'section');
    logSec.appendChild(el('h3', null, 'Logs'));
    logSec.appendChild(el('pre', null, logs.length ? logs.join('\\n') : '(none)'));
    ws.appendChild(logSec);
  }

  // Build an <a> that opens an http(s) endpoint in a new tab; ws:// URLs
  // are shown as plain text (not navigable in a browser tab).
  function href(url) {
    if (/^https?:/.test(url)) {
      const a = el('a', 'endpoint', url);
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      return a;
    }
    return el('div', 'endpoint', url);
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
    shownDetailId = null;
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
    const timeline = document.getElementById('timeline-rows');
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

    // Live-refresh the workspace if it is showing this invocation.
    if (shownInvId === ev.id) renderResult(ev.id);
    if (shownDetailId === ev.id) renderCapturedDetail(ev.id);
  }

  function loadInvocation(id) {
    const ev = invById.get(id);
    if (!ev) return;
    document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'));
    const row = rowsById.get(id);
    if (row) row.classList.add('sel');
    highlightTarget(ev.target);
    if (ev.kind === 'lambda') {
      // A Lambda invocation row reloads into the re-invokable composer.
      shownDetailId = null;
      shownServeId = null;
      renderComposer(ev.target, ev.kind, ev.request != null ? fmt(ev.request) : '{}');
      shownInvId = id;
      renderResult(id);
    } else {
      // A captured serve request (slice C2) opens a READ-ONLY detail —
      // re-invoking a captured request is Phase 3.
      shownInvId = null;
      shownServeId = null;
      active = null;
      renderCapturedDetail(id);
    }
  }

  // Read-only Request / Response detail for a captured serve request.
  function renderCapturedDetail(id) {
    shownDetailId = id;
    const ev = invById.get(id);
    const ws = document.getElementById('workspace');
    ws.innerHTML = '';
    if (!ev) return;

    const head = el('div', 'composer');
    head.appendChild(el('div', 'target-name', (ev.label || 'request') + '  —  ' + (ev.target || '')));
    ws.appendChild(head);

    const reqSec = el('div', 'section');
    reqSec.appendChild(el('h3', null, 'Request'));
    reqSec.appendChild(el('pre', null, ev.request != null ? fmt(ev.request) : '(none)'));
    ws.appendChild(reqSec);

    const respSec = el('div', 'section');
    const h = el('h3', null, 'Response');
    if (ev.status != null) {
      const cls = ev.status >= 200 && ev.status < 300 ? 'ok' : 'bad';
      h.appendChild(el('span', cls, '  ' + ev.status + (ev.durationMs != null ? ' · ' + ev.durationMs + 'ms' : '')));
    }
    respSec.appendChild(h);
    respSec.appendChild(el('pre', null, ev.response != null ? fmt(ev.response) : '(pending…)'));
    ws.appendChild(respSec);

    // Logs bound to THIS request at CloudWatch granularity (D5), fetched
    // from the server store.
    const logSec = el('div', 'section');
    logSec.appendChild(el('h3', null, 'Logs'));
    const logPre = el('pre', null, '(loading…)');
    logSec.appendChild(logPre);
    ws.appendChild(logSec);
    fetchInvocationLogs(id, logPre);
  }

  async function fetchInvocationLogs(id, pre) {
    try {
      const res = await fetch('/api/invocations/' + encodeURIComponent(id) + '/logs');
      const data = await res.json();
      const lines = (data.logs || []).map((l) => l.line);
      if (shownDetailId === id) pre.textContent = lines.length ? lines.join('\\n') : '(none)';
    } catch (err) {
      if (shownDetailId === id) pre.textContent = '(failed to load logs)';
    }
  }

  // Full-text log search over the server store. A non-empty query shows
  // matching log lines INSTEAD of the timeline rows; clearing restores them.
  let searchTimer = null;
  function wireLogSearch() {
    const input = document.getElementById('log-search');
    const rows = document.getElementById('timeline-rows');
    const results = document.getElementById('log-results');
    input.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runLogSearch(input.value.trim(), rows, results), 180);
    });
  }

  async function runLogSearch(query, rows, results) {
    if (query === '') {
      results.classList.remove('active');
      rows.style.display = '';
      results.innerHTML = '';
      return;
    }
    rows.style.display = 'none';
    results.classList.add('active');
    try {
      const res = await fetch('/api/logs?q=' + encodeURIComponent(query));
      const data = await res.json();
      const hits = data.logs || [];
      results.innerHTML = '';
      results.appendChild(el('div', 'log-hits-meta', hits.length + ' match' + (hits.length === 1 ? '' : 'es')));
      for (const h of hits) {
        const row = el('div', 'log-hit');
        row.appendChild(el('span', 'lt', new Date(h.ts).toLocaleTimeString() + '  '));
        row.appendChild(el('span', 'lg', (h.target || '') + '  '));
        row.appendChild(document.createTextNode(h.line));
        results.appendChild(row);
      }
    } catch (err) {
      results.innerHTML = '';
      results.appendChild(el('div', 'log-hits-meta', 'Search failed: ' + err));
    }
  }

  // Pull retained history on (re)connect so the timeline + logs reflect the
  // whole session, not just events since this page loaded.
  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      for (const log of (data.logs || [])) {
        const arr = logsById.get(log.containerId) || [];
        arr.push(log.line);
        logsById.set(log.containerId, arr);
      }
      for (const inv of (data.invocations || [])) addInvocation(inv);
    } catch (err) {
      /* live SSE still drives the timeline; history is best-effort */
    }
  }

  function connect() {
    const conn = document.getElementById('conn');
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => { conn.textContent = '● live'; conn.className = 'up'; });
    es.addEventListener('error', () => { conn.textContent = '● disconnected'; conn.className = 'down'; });
    es.addEventListener('invocation', (e) => addInvocation(JSON.parse(e.data)));
    es.addEventListener('serve', (e) => onServeEvent(JSON.parse(e.data)));
    es.addEventListener('log', (e) => {
      const ev = JSON.parse(e.data);
      const arr = logsById.get(ev.containerId) || [];
      arr.push(ev.line);
      logsById.set(ev.containerId, arr);
      if (shownInvId === ev.containerId) renderResult(ev.containerId);
      if (shownServeId === ev.containerId) renderServeWorkspace(ev.containerId);
    });
  }

  function onServeEvent(ev) {
    // A 'stopped' / 'error' transition clears the running state; otherwise
    // record the latest status + endpoints for the row + workspace.
    if (ev.status === 'stopped' || ev.status === 'error') {
      serveState.set(ev.target, { status: ev.status, endpoints: [] });
    } else {
      serveState.set(ev.target, { status: ev.status, endpoints: ev.endpoints || [] });
    }
    updateServeRow(ev.target);
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

  loadTargets().then(loadRunning);
  loadHistory();
  connect();
  initSplitters();
  wireLogSearch();
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
  <section class="pane" id="workspace"><div class="empty">Pick a Lambda to invoke, or an API to serve, on the left.</div></section>
  <div class="splitter" id="split-right"></div>
  <section class="pane" id="timeline">
    <h2>Timeline</h2>
    <div class="searchbar"><input id="log-search" type="search" placeholder="Search logs…" autocomplete="off" spellcheck="false" /></div>
    <div id="timeline-rows"><div class="empty">No requests yet.</div></div>
    <div id="log-results"></div>
  </section>
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
