/**
 * The studio web UI, embedded as a string so it ships inside the
 * `cdk-local` npm package (decision D9) with no asset-copy build step —
 * `tsdown` bundles this module like any other source file. Served by
 * the studio HTTP server (`startStudioServer`) at `GET /`.
 *
 * 3-pane shell (decision D6), framework-free vanilla JS (decision D7):
 *   - left   = target list (from `GET /api/targets`); each Lambda or
 *     AgentCore runtime has an [Invoke] button, each API a [Start] / [Stop]
 *     serve control with a `running ● :port` indicator (slice C1), plus a
 *     selected-highlight.
 *   - center = the WORKSPACE for the selected target: for a Lambda or an
 *     AgentCore runtime, an event composer (textarea + Invoke button) with
 *     the latest run's Request / Response / Logs shown below; for an API, a
 *     Start/Stop control with the served endpoints + streaming logs. A served
 *     API Gateway WebSocket API additionally gets a WebSocket console
 *     (connect / send frame / received-frame log) wired straight to its ws://
 *     endpoint (issue #303).
 *   - right  = the timeline (history) of every invocation AND every
 *     captured serve request (slice C2); clicking a Lambda row reloads
 *     it into the composer, clicking a captured request row opens a
 *     read-only Request / Response detail.
 *
 * The center workspace is deliberately adjacent to the left target list
 * (short eye-travel: pick a target -> compose right next to it), and is
 * the primary surface — the timeline is secondary history.
 */

import { OPTION_SPECS } from './studio-option-specs.js';

const STUDIO_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e6e6e6; background: #1a1a1a; height: 100vh; overflow: hidden;
    display: flex; flex-direction: column;
  }
  header {
    padding: 8px 14px; background: #111; border-bottom: 1px solid #333;
    display: flex; align-items: center; gap: 10px;
  }
  header .brand { font-weight: 700; color: #fff; }
  header .meta { color: #888; font-size: 12px; }
  #session-bar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 5px 14px; background: #141414; border-bottom: 1px solid #2a2a2a;
    font-size: 12px;
  }
  #session-bar .sess-bind { color: #bbb; display: inline-flex; align-items: center; gap: 4px; }
  #session-bar input[type=text] {
    background: #111; color: #ddd; border: 1px solid #333; border-radius: 3px;
    padding: 3px 6px; font: 12px ui-monospace, Menlo, monospace; min-width: 180px;
  }
  #session-bar input:focus { outline: none; border-color: #4ec97a; }
  #session-bar button {
    background: #2a3a2c; color: #7bd88f; border: 1px solid #2f4030; border-radius: 3px;
    cursor: pointer; padding: 3px 12px; font: 12px ui-monospace, monospace;
  }
  #session-bar button:hover { background: #314b34; }
  #session-bar #sess-msg { color: #7bd88f; min-width: 40px; }
  #session-bar .sess-synth { color: #777; margin-left: auto; }
  main {
    display: grid; grid-template-columns: 280px 5px 1fr 5px 320px;
    /* Body is a flex column (header + session-bar + main); main fills the
       rest so the height is computed — no magic constant, wrap-safe. */
    flex: 1; min-height: 0;
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
  .ws-console .ws-status { font-size: 12px; color: #888; margin-left: 8px; font-weight: 400; }
  .ws-console .ws-status.on { color: #4ec97a; }
  .ws-row { display: flex; gap: 6px; align-items: center; margin: 6px 0; }
  .ws-row .ws-input { flex: 1; min-width: 0; background: #1a1a1a; border: 1px solid #333;
    color: #ddd; border-radius: 4px; padding: 5px 7px; font: inherit; }
  .ws-row .ws-input:focus { outline: none; border-color: #4ec97a; }
  .ws-row button { background: #2a4636; color: #cfe; border: 0; border-radius: 4px;
    padding: 5px 12px; cursor: pointer; }
  .ws-row button:disabled { background: #2a2a2a; color: #666; cursor: default; }
  .ws-frames { max-height: 180px; overflow: auto; background: #141414; border: 1px solid #262626;
    border-radius: 4px; padding: 6px 8px; margin-top: 4px; min-height: 22px; }
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
  .options .opt-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .options .opt-row.opt-col { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
  .opt-label { color: #aaa; font-size: 12px; min-width: 120px; }
  .opt-bool { color: #ddd; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
  .options input[type=text], .options input[type=number] {
    flex: 1; background: #111; color: #ddd; border: 1px solid #333; border-radius: 3px;
    padding: 4px 6px; font: 12px ui-monospace, Menlo, monospace; min-width: 0;
  }
  .options input:focus, .envkv-ta:focus { outline: none; border-color: #4ec97a; }
  .pair-wrap { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .pair-row { display: flex; align-items: center; gap: 6px; }
  .pair-in { width: 1px; flex: 1; background: #111; color: #ddd; border: 1px solid #333;
    border-radius: 3px; padding: 4px 6px; font: 12px ui-monospace, Menlo, monospace; min-width: 0; }
  .pair-sep { color: #888; }
  .pair-x { background: #2a2a2a; color: #bbb; border: none; border-radius: 3px; cursor: pointer;
    padding: 2px 7px; font: 12px ui-monospace, monospace; }
  .pair-x:hover { background: #3a2a2a; color: #e0707a; }
  .pair-add { align-self: flex-start; background: #1d1d1d; color: #7bd88f; border: 1px solid #2f4030;
    border-radius: 3px; cursor: pointer; padding: 3px 9px; font: 12px ui-monospace, monospace; }
  .pair-add:hover { background: #243024; }
  .envkv-modes { display: flex; gap: 0; }
  .envkv-mode { background: #1a1a1a; color: #999; border: 1px solid #333; cursor: pointer;
    padding: 3px 12px; font: 11px ui-monospace, monospace; }
  .envkv-mode:first-child { border-radius: 3px 0 0 3px; }
  .envkv-mode:last-child { border-radius: 0 3px 3px 0; border-left: none; }
  .envkv-mode.active { background: #2a3a2c; color: #7bd88f; }
  .envkv-ta { width: 100%; box-sizing: border-box; min-height: 70px; resize: vertical;
    background: #111; color: #ddd; border: 1px solid #333; border-radius: 3px; padding: 6px 8px;
    font: 12px ui-monospace, Menlo, monospace; }
`;

const STUDIO_SCRIPT = `
  const KIND_LABEL = { lambda: 'Lambda', api: 'API', alb: 'ALB', ecs: 'ECS', agentcore: 'AgentCore' };
  const SERVE_KINDS = ['api', 'alb', 'ecs']; // long-running serve targets
  const INVOKE_KINDS = ['lambda', 'agentcore']; // single-shot invoke targets (event composer)
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

  // Per-target run options (issue #301 slice 2). The descriptor table is
  // serialized into the page by the server; we render a control per option
  // and return { node, collect } so the caller places the section and reads
  // the values when the user clicks Invoke / Start.
  const OPTION_SPECS = window.__OPTION_SPECS__ || {};

  function buildOptions(kind) {
    const specs = OPTION_SPECS[kind] || [];
    if (!specs.length) return { node: null, collect: function () { return undefined; } };
    const sec = el('div', 'section options');
    sec.appendChild(el('h3', null, 'Options'));
    const getters = [];
    const bools = {};

    // Shared add-row pair list (used by repeat-pair AND the env-kv KV pane).
    function pairList(spec) {
      const list = el('div', 'pair-rows');
      const pairs = [];
      const addRow = function () {
        const r = el('div', 'pair-row');
        const lv = el('input');
        lv.placeholder = spec.leftPlaceholder;
        lv.className = 'pair-in';
        const rv = el('input');
        rv.placeholder = spec.rightPlaceholder;
        rv.className = 'pair-in';
        const pair = { l: lv, r: rv };
        const x = el('button', 'pair-x', 'x');
        x.type = 'button';
        x.onclick = function () {
          list.removeChild(r);
          const i = pairs.indexOf(pair);
          if (i >= 0) pairs.splice(i, 1);
        };
        r.appendChild(lv);
        r.appendChild(el('span', 'pair-sep', spec.sep));
        r.appendChild(rv);
        r.appendChild(x);
        list.appendChild(r);
        pairs.push(pair);
      };
      const add = el('button', 'pair-add', '+ add');
      add.type = 'button';
      add.onclick = addRow;
      const wrap = el('div', 'pair-wrap');
      wrap.appendChild(list);
      wrap.appendChild(add);
      return {
        node: wrap,
        rows: function () {
          return pairs.map(function (p) { return { left: p.l.value, right: p.r.value }; });
        },
      };
    }

    specs.forEach(function (spec) {
      const row = el('div', 'opt-row');
      if (spec.kind === 'boolean') {
        const cb = el('input');
        cb.type = 'checkbox';
        const lab = el('label', 'opt-bool');
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' ' + spec.label));
        row.appendChild(lab);
        bools[spec.flag] = cb;
        getters.push(function () { return [spec.flag, cb.checked]; });
      } else if (spec.kind === 'scalar') {
        row.appendChild(el('span', 'opt-label', spec.label));
        const inp = el('input');
        inp.type = spec.inputType === 'number' ? 'number' : 'text';
        if (spec.placeholder) inp.placeholder = spec.placeholder;
        row.appendChild(inp);
        if (spec.showWhen) {
          const gate = bools[spec.showWhen];
          const sync = function () { row.style.display = gate && gate.checked ? 'flex' : 'none'; };
          if (gate) gate.addEventListener('change', sync);
          sync();
        }
        getters.push(function () { return [spec.flag, inp.value]; });
      } else if (spec.kind === 'env-kv') {
        // Two input modes — KV add-rows or a raw JSON object; the server
        // materializes either into a SAM-shape temp file for --env-vars.
        row.className = 'opt-row opt-col';
        row.appendChild(el('span', 'opt-label', spec.label));
        const modes = el('div', 'envkv-modes');
        const kvBtn = el('button', 'envkv-mode active', 'KV');
        kvBtn.type = 'button';
        const jsonBtn = el('button', 'envkv-mode', 'JSON');
        jsonBtn.type = 'button';
        modes.appendChild(kvBtn);
        modes.appendChild(jsonBtn);
        row.appendChild(modes);
        const pl = pairList(spec);
        row.appendChild(pl.node);
        const ta = el('textarea', 'envkv-ta');
        ta.placeholder = '{ "KEY": "value" }';
        ta.spellcheck = false;
        ta.style.display = 'none';
        row.appendChild(ta);
        let mode = 'kv';
        kvBtn.onclick = function () {
          mode = 'kv';
          kvBtn.className = 'envkv-mode active';
          jsonBtn.className = 'envkv-mode';
          pl.node.style.display = '';
          ta.style.display = 'none';
        };
        jsonBtn.onclick = function () {
          mode = 'json';
          jsonBtn.className = 'envkv-mode active';
          kvBtn.className = 'envkv-mode';
          ta.style.display = '';
          pl.node.style.display = 'none';
        };
        getters.push(function () {
          return mode === 'json' ? [spec.flag, ta.value] : [spec.flag, pl.rows()];
        });
      } else {
        // repeat-pair: an add-row list of left<sep>right inputs.
        row.appendChild(el('span', 'opt-label', spec.label));
        const pl = pairList(spec);
        row.appendChild(pl.node);
        getters.push(function () { return [spec.flag, pl.rows()]; });
      }
      sec.appendChild(row);
    });
    return {
      node: sec,
      collect: function () {
        const out = {};
        getters.forEach(function (g) { const kv = g(); out[kv[0]] = kv[1]; });
        return out;
      },
    };
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
          // Lambda + AgentCore targets are single-shot invokes; api / alb / ecs
          // are long-running serves. Other kinds list but are not yet runnable.
          // Within ecs, only services are servable (task defs are run-task).
          const isServe = SERVE_KINDS.includes(group.kind) && (group.kind !== 'ecs' || entry.servable === true);
          const isInvoke = INVOKE_KINDS.includes(group.kind);
          const runnable = isInvoke || isServe;
          const t = el('div', runnable ? 'target runnable' : 'target');
          const name = el('span', 'name', entry.id);
          name.title = entry.id; // full path on hover even when truncated
          t.appendChild(name);
          t.appendChild(el('span', 'kind', '(' + (KIND_LABEL[group.kind] || group.kind) + ')'));
          if (isInvoke) {
            const btn = el('button', 'invoke-btn', 'Invoke');
            btn.onclick = (e) => { e.stopPropagation(); selectTarget(entry.id, group.kind); };
            t.appendChild(btn);
            t.onclick = () => selectTarget(entry.id, group.kind);
            targetEls.set(entry.id, t);
          } else if (isServe) {
            // A serve target: a running-state dot + a Start/Stop button
            // slot, both refreshed by updateServeRow on serve events.
            const dot = el('span', 'run-dot');
            const btnSlot = el('span', 'btn-slot');
            t.appendChild(dot);
            t.appendChild(btnSlot);
            t.onclick = () => selectTarget(entry.id, group.kind);
            targetEls.set(entry.id, t);
            serveMeta.set(entry.id, { dot, btnSlot, kind: group.kind });
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
    // A serve with a host endpoint shows the dot + :port; a pure-compute
    // ecs service has no endpoint, so just the dot + running.
    const port = running ? firstPort(st.endpoints) : '';
    meta.dot.textContent = running ? (port ? '● ' + port : '● running') : starting ? '○ starting' : '';
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
    // Navigating to any target closes a WebSocket console socket left open on
    // a previously-shown serve (a log-driven re-render keeps it, an explicit
    // navigation drops it — see renderWsConsole).
    closeActiveWs();
    highlightTarget(id);
    shownDetailId = null;
    if (SERVE_KINDS.includes(kind)) {
      shownServeId = id;
      shownInvId = null;
      active = null;
      renderServeWorkspace(id);
    } else {
      shownServeId = null;
      renderComposer(id, kind, '{}');
    }
  }

  async function startServe(id, options) {
    // The serve kind (api / alb / ecs) drives which headless command the
    // server spawns; it is recorded on the row when the target list loads.
    const meta = serveMeta.get(id);
    const kind = meta ? meta.kind : 'api';
    serveState.set(id, { status: 'starting', endpoints: [] });
    updateServeRow(id);
    try {
      const body = { targetId: id, kind };
      if (options) body.options = options;
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
    // A NON-running render (serve stopped / starting) tears down any open
    // WebSocket-console socket: its endpoint is gone, and leaving it open would
    // show "● connected" against a dead serve if the same target is restarted.
    // A RUNNING re-render (a streamed log line) keeps the socket alive — the
    // console re-syncs from module state, so the connection survives.
    if (!running) closeActiveWs();

    const meta = serveMeta.get(id);
    const kind = meta ? meta.kind : 'api';

    const head = el('div', 'composer');
    head.appendChild(el('div', 'target-name', 'Serve ' + id));
    const btn = running || starting
      ? el('button', null, 'Stop')
      : el('button', null, starting ? 'Starting…' : 'Start');
    // Per-run options are only set before a start; collected on the Start click.
    let collectOpts = function () { return undefined; };
    btn.onclick = () => { if (running || starting) stopServe(id); else startServe(id, collectOpts()); };
    head.appendChild(btn);
    if (errMsg) {
      const m = el('div', 'err', errMsg);
      head.appendChild(m);
    }
    ws.appendChild(head);

    if (!running && !starting) {
      const opt = buildOptions(kind);
      if (opt.node) ws.appendChild(opt.node);
      collectOpts = opt.collect;
    }

    const isEcs = meta && meta.kind === 'ecs';
    const epSec = el('div', 'section');
    epSec.appendChild(el('h3', null, 'Endpoints'));
    if (running && st.endpoints.length) {
      for (const url of st.endpoints) {
        const link = href(url);
        epSec.appendChild(link);
      }
    } else if (running && isEcs) {
      // A pure-compute ECS service has no host endpoint — it just runs the
      // replicas (reach them container-to-container via Cloud Map).
      epSec.appendChild(el('pre', null, '(running — pure compute service, no host endpoint)'));
    } else {
      epSec.appendChild(el('pre', null, starting ? '(starting…)' : '(not running)'));
    }
    ws.appendChild(epSec);

    // A served WebSocket API exposes a ws:// endpoint — attach a WebSocket
    // console so the browser can connect + exchange frames (issue #303).
    const wsEndpoint = running ? (st.endpoints || []).find((u) => /^wss?:/.test(u)) : null;
    if (wsEndpoint) {
      ws.appendChild(renderWsConsole(wsEndpoint));
    }

    const logs = logsById.get(id) || [];
    const logSec = el('div', 'section');
    logSec.appendChild(el('h3', null, 'Logs'));
    logSec.appendChild(el('pre', null, logs.length ? logs.join('\\n') : '(none)'));
    ws.appendChild(logSec);
  }

  // Build an <a> that opens an http(s) endpoint in a new tab; ws:// URLs
  // are shown as plain text (not navigable in a browser tab — the WebSocket
  // console below connects to them instead).
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

  // --- WebSocket console (issue #303) ----------------------------------------
  // A served API Gateway WebSocket API exposes a ws:// endpoint (handed through
  // un-proxied by the serve manager). The console connects the BROWSER straight
  // to it so you can send frames + watch received frames, without leaving the
  // studio tab.
  //
  // The serve workspace re-renders on every streamed log line (line ~931), so
  // the socket + the frame log live in MODULE state (not the rebuilt DOM): the
  // socket's callbacks update the CURRENT DOM via wsEl() selectors, and
  // renderWsConsole repopulates from wsFrames + the live socket state on each
  // rebuild. So a log-triggered re-render never drops the connection.
  let activeWs = null;
  let wsFrames = [];
  let wsConsoleUrl = null;

  function wsEl(sel) {
    return document.querySelector('#workspace .ws-console ' + sel);
  }
  function wsSyncUi() {
    const on = !!activeWs && activeWs.readyState === 1;
    const status = wsEl('.ws-status');
    if (status) {
      status.textContent = on ? '● connected' : '○ disconnected';
      status.className = 'ws-status' + (on ? ' on' : '');
    }
    const cb = wsEl('.ws-connect');
    if (cb) cb.textContent = activeWs ? 'Disconnect' : 'Connect';
    const inp = wsEl('.ws-input');
    if (inp) inp.disabled = !on;
    const sb = wsEl('.ws-send');
    if (sb) sb.disabled = !on;
  }
  function wsAppend(dir, text) {
    wsFrames.push(dir + ' ' + text);
    if (wsFrames.length > 200) wsFrames = wsFrames.slice(-200);
    const pre = wsEl('.ws-frames');
    if (pre) {
      pre.textContent = wsFrames.join('\\n');
      pre.scrollTop = pre.scrollHeight;
    }
  }
  function closeActiveWs() {
    if (activeWs) {
      try {
        activeWs.onclose = null;
        activeWs.close();
      } catch (e) {
        /* already closing */
      }
      activeWs = null;
    }
  }
  function wsConnect(wsUrl) {
    if (activeWs) {
      closeActiveWs();
      wsAppend('--', 'disconnected');
      wsSyncUi();
      return;
    }
    let sock;
    try {
      sock = new WebSocket(wsUrl);
    } catch (err) {
      wsAppend('!!', 'could not open: ' + err);
      return;
    }
    activeWs = sock;
    wsConsoleUrl = wsUrl;
    wsAppend('--', 'connecting to ' + wsUrl + ' …');
    wsSyncUi();
    sock.onopen = function () { if (activeWs === sock) { wsAppend('--', 'connected'); wsSyncUi(); } };
    sock.onmessage = function (e) {
      if (activeWs !== sock) return; // ignore a late frame from a replaced socket
      // A frame arrives as a string (text) or — the local emulator's
      // PostToConnection path sends binary — a Blob / ArrayBuffer. Decode the
      // binary forms to text so the console shows the payload, not a placeholder.
      // (A binary Blob decodes async via .text(), so two rapid binary frames
      // could append slightly out of receive order — fine for a dev console.)
      const d = e.data;
      if (typeof d === 'string') wsAppend('<-', d);
      else if (d && typeof d.text === 'function') d.text().then(function (t) { wsAppend('<-', t); });
      else if (d && d.byteLength !== undefined) wsAppend('<-', new TextDecoder().decode(d));
      else wsAppend('<-', '[binary frame]');
    };
    sock.onerror = function () { wsAppend('!!', 'socket error'); };
    sock.onclose = function () { if (activeWs === sock) { activeWs = null; wsAppend('--', 'closed'); wsSyncUi(); } };
  }
  function wsSend() {
    const inp = wsEl('.ws-input');
    if (activeWs && activeWs.readyState === 1 && inp && inp.value) {
      activeWs.send(inp.value);
      wsAppend('->', inp.value);
      inp.value = '';
    }
  }

  function renderWsConsole(wsUrl) {
    // A fresh target's console starts with a clean frame log; same-url
    // re-renders (log streaming) keep it so the history survives.
    if (wsConsoleUrl !== wsUrl) wsFrames = [];
    const on = !!activeWs && activeWs.readyState === 1;

    const sec = el('div', 'section ws-console');
    const h = el('h3', null, 'WebSocket');
    h.appendChild(el('span', 'ws-status' + (on ? ' on' : ''), on ? '● connected' : '○ disconnected'));
    sec.appendChild(h);

    const connectBtn = el('button', 'invoke-btn ws-connect', activeWs ? 'Disconnect' : 'Connect');
    connectBtn.onclick = function () { wsConnect(wsUrl); };
    const input = el('input', 'ws-input');
    input.placeholder = '{ "action": "sendMessage", "text": "hi" }';
    input.disabled = !on;
    input.onkeydown = function (e) { if (e.key === 'Enter') wsSend(); };
    const sendBtn = el('button', 'ws-send', 'Send');
    sendBtn.disabled = !on;
    sendBtn.onclick = wsSend;

    const row = el('div', 'ws-row');
    row.appendChild(connectBtn);
    row.appendChild(input);
    row.appendChild(sendBtn);
    sec.appendChild(row);

    const frames = el('pre', 'ws-frames', wsFrames.join('\\n'));
    sec.appendChild(frames);
    return sec;
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
    // Per-run options (e.g. env vars) below the event, above Invoke.
    const opt = buildOptions(kind);
    if (opt.node) composer.appendChild(opt.node);
    composer.appendChild(document.createElement('br'));
    const btn = el('button', null, 'Invoke');
    const msg = el('div', 'err');
    composer.appendChild(btn);
    composer.appendChild(msg);

    const result = el('div', 'result');

    ws.appendChild(composer);
    ws.appendChild(result);

    active = { id, kind, ta, btn, msg, result, collectOpts: opt.collect };
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
      const body = { targetId: id, kind, event };
      const options = active.collectOpts ? active.collectOpts() : undefined;
      if (options) body.options = options;
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
    closeActiveWs(); // navigating to a timeline row leaves any serve WS console
    document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'));
    const row = rowsById.get(id);
    if (row) row.classList.add('sel');
    highlightTarget(ev.target);
    if (INVOKE_KINDS.includes(ev.kind)) {
      // A single-shot invocation row (Lambda or AgentCore) reloads into the
      // re-invokable composer.
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

  // Session config (issue #301 slice 3): synth-time context is read-only;
  // the run-time bindings (from-cfn-stack / assume-role) are editable and
  // apply to subsequent invokes / serves.
  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const c = await res.json();
      const cfn = document.getElementById('sess-cfn');
      const cfnName = document.getElementById('sess-cfn-name');
      const role = document.getElementById('sess-role');
      const on = c.fromCfnStack !== undefined && c.fromCfnStack !== false;
      cfn.checked = on;
      cfnName.value = typeof c.fromCfnStack === 'string' ? c.fromCfnStack : '';
      cfnName.style.display = on ? '' : 'none';
      role.value = c.assumeRole || '';
      document.getElementById('sess-watch').checked = c.watch === true;
      const s = c.synth || {};
      const parts = [];
      if (s.profile) parts.push('profile=' + s.profile);
      if (s.region) parts.push('region=' + s.region);
      if (s.app) parts.push('app=' + s.app);
      document.getElementById('sess-synth').textContent = parts.length ? '(' + parts.join(' \\u00b7 ') + ')' : '';
    } catch (err) {
      /* best-effort; the session bar is non-critical */
    }
  }

  async function saveConfig() {
    const cfn = document.getElementById('sess-cfn');
    const cfnName = document.getElementById('sess-cfn-name');
    const role = document.getElementById('sess-role');
    const msg = document.getElementById('sess-msg');
    const body = {
      fromCfnStack: cfn.checked ? cfnName.value.trim() || true : null,
      assumeRole: role.value.trim() || null,
      watch: document.getElementById('sess-watch').checked,
    };
    msg.textContent = 'Saving...';
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(function () { return {}; });
        msg.textContent = 'Error: ' + (e.error || ('HTTP ' + res.status));
        return;
      }
      msg.textContent = 'Saved';
      setTimeout(function () { msg.textContent = ''; }, 1500);
      await loadConfig();
    } catch (err) {
      msg.textContent = 'Failed: ' + err;
    }
  }

  function wireSession() {
    const cfn = document.getElementById('sess-cfn');
    const cfnName = document.getElementById('sess-cfn-name');
    cfn.addEventListener('change', function () {
      cfnName.style.display = cfn.checked ? '' : 'none';
      if (cfn.checked) cfnName.focus();
    });
    document.getElementById('sess-save').onclick = saveConfig;
  }

  loadTargets().then(loadRunning);
  loadHistory();
  loadConfig();
  connect();
  initSplitters();
  wireLogSearch();
  wireSession();
`;

/**
 * Render the full studio HTML document. `appLabel` is shown in the
 * header (the CDK app / stack context); `cliName` brands the title for
 * host CLIs that rebrand `cdkl`.
 */
export function renderStudioHtml(appLabel: string, cliName: string): string {
  const safeApp = escapeHtml(appLabel);
  const safeCli = escapeHtml(cliName);
  // Header title. The default `cdkl` binary brands as the friendlier product
  // name "CDK Local Studio"; a host CLI that rebrands `cdkl` keeps its own
  // "<cliName> studio" so the embed stays on-brand for the host.
  const brand = cliName === 'cdkl' ? 'CDK Local Studio' : `${safeCli} studio`;
  // The per-target option descriptors, serialized for the embedded UI to
  // render controls from. `<` is escaped so a value can never close the
  // surrounding <script> tag.
  const optionSpecsJson = JSON.stringify(OPTION_SPECS).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${brand}</title>
<style>${STUDIO_CSS}</style>
</head>
<body>
<header>
  <span class="brand">${brand}</span>
  <span class="meta">${safeApp}</span>
  <span id="conn" class="down">● connecting</span>
</header>
<div id="session-bar">
  <label class="sess-bind"><input type="checkbox" id="sess-watch" /> watch</label>
  <label class="sess-bind"><input type="checkbox" id="sess-cfn" /> from-cfn-stack</label>
  <input id="sess-cfn-name" type="text" placeholder="stack name (blank = auto)" style="display:none" />
  <label class="sess-bind" for="sess-role">assume-role</label>
  <input id="sess-role" type="text" placeholder="arn:aws:iam::…:role/…" />
  <button id="sess-save" type="button">Save</button>
  <span id="sess-msg"></span>
  <span id="sess-synth" class="sess-synth"></span>
</div>
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
<script>window.__OPTION_SPECS__ = ${optionSpecsJson};</script>
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
