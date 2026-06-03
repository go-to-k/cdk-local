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

import { buildFlagCatalog } from './studio-option-catalog.js';
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
    padding: 3px 6px; font: 12px ui-monospace, Menlo, monospace; min-width: 240px;
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
  .pane-head {
    position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
    background: #151515; border-bottom: 1px solid #2a2a2a;
  }
  .pane-head h2 { position: static; border-bottom: 0; background: transparent; flex: none; }
  .pane-head #target-search {
    flex: 1; min-width: 0; margin-right: 10px; background: #111; color: #ddd;
    border: 1px solid #333; border-radius: 3px; padding: 3px 8px;
    font: 11px ui-monospace, Menlo, monospace;
  }
  .pane-head #target-search:focus { outline: none; border-color: #4ec97a; }
  .group-title {
    padding: 7px 12px; color: #6aa9ff; font-size: 11px; cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px; background: #131313;
  }
  .group-title:hover { background: #1a1a1a; }
  .group-title .caret { color: #777; font-size: 9px; width: 9px; display: inline-block; transition: transform .1s; }
  .group-title.open .caret { transform: rotate(90deg); }
  .group-title .count { color: #666; }
  .group-body.collapsed { display: none; }
  .target {
    padding: 6px 12px; display: flex; align-items: center; gap: 8px;
  }
  /* Zebra-stripe rows so each target box reads as its own block (the borderless
     rows otherwise blur together); the kind label stays readable on both. */
  /* Zebra: alternate rows get a clearly lighter background than the base
     (#1a1a1a) so adjacent target boxes read as distinct — a 1-step shade was
     imperceptible. The kind label (#8f8f8f) still reads on both shades. */
  .group-body .target:nth-child(2n) { background: #242424; }
  .target.runnable { cursor: pointer; }
  .target.runnable:hover { background: #292929; }
  .target.sel, .group-body .target.sel:nth-child(2n) { background: #2a3550; }
  .target .name { color: #ddd; flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .target .kind { color: #8f8f8f; font-size: 11px; }
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
  .row.reinvoke .label::before { content: '\\21A9 '; color: #6aa0ff; margin-right: 2px; }
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
  .req-composer .req-row { display: flex; gap: 6px; margin-bottom: 6px; }
  .req-composer .req-method { background: #111; color: #ddd; border: 1px solid #333; border-radius: 3px;
    padding: 4px 6px; font: 12px ui-monospace, Menlo, monospace; }
  .req-composer .req-path { flex: 1; min-width: 0; background: #111; color: #ddd; border: 1px solid #333;
    border-radius: 3px; padding: 4px 6px; font: 12px ui-monospace, Menlo, monospace; }
  .req-composer textarea { width: 100%; box-sizing: border-box; min-height: 48px; resize: vertical;
    background: #111; color: #ddd; border: 1px solid #333; border-radius: 3px; padding: 5px;
    font: 12px/1.5 ui-monospace, Menlo, monospace; margin-bottom: 6px; }
  .req-composer .req-body { min-height: 70px; }
  .req-composer .hdr-editor { margin-bottom: 8px; }
  .req-composer select:focus, .req-composer input:focus, .req-composer textarea:focus {
    outline: none; border-color: #4ec97a; }
  .req-composer .req-send { display: flex; align-items: center; gap: 10px; }
  .req-composer .req-send button { margin-top: 0; padding: 4px 16px; }
  .req-composer .req-status { margin-top: 8px; font: 12px ui-monospace, Menlo, monospace; }
  .req-composer .req-result pre { background: #0e0e0e; }
  .composer button:disabled { background: #333; color: #888; cursor: default; }
  .composer .reinvoke-btn { margin-top: 6px; padding: 4px 14px; }
  .log-head { display: flex; align-items: center; justify-content: space-between; }
  .log-clear {
    background: #1d1d1d; color: #bbb; border: 1px solid #333; border-radius: 3px;
    padding: 2px 10px; font-size: 11px; cursor: pointer; margin: 0;
  }
  .log-clear:hover { background: #262626; color: #ddd; }
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
  .options select { flex: 1; background: #111; color: #ddd; border: 1px solid #333; border-radius: 3px;
    padding: 4px 6px; font: 12px ui-monospace, Menlo, monospace; min-width: 0; }
  .options select:focus { outline: none; border-color: #4ec97a; }
  details.all-options { margin: 8px 0; border-top: 1px solid #2a2a2a; padding-top: 6px; }
  details.all-options > summary { color: #8a8a8a; font-size: 12px; cursor: pointer; user-select: none; }
  details.all-options > summary:hover { color: #bbb; }
  .all-options .opt-row { display: flex; flex-direction: column; align-items: stretch; gap: 4px; margin: 6px 0; }
  .all-options input.raw-args {
    width: 100%; box-sizing: border-box; background: #111; color: #ddd; border: 1px solid #333;
    border-radius: 3px; padding: 4px 6px; font: 12px ui-monospace, Menlo, monospace;
  }
  .all-options input.raw-args:focus { outline: none; border-color: #4ec97a; }
  .opt-hint { color: #777; font-size: 11px; }
  .flag-catalog { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
  .flag-row { display: flex; gap: 8px; align-items: baseline; font-size: 11px; }
  .flag-name { color: #7bd88f; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
  .flag-desc { color: #999; }
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
  let serveLogId = null;           // serve target whose LOGS <pre> is live (issue #334)
  let serveLogPre = null;          // the live serve LOGS <pre>, updated surgically on log events
  const targetEls = new Map();     // targetId -> left-pane element
  const serveMeta = new Map();     // serve targetId -> { dot, btnSlot } row controls
  const serveState = new Map();    // serve targetId -> { status, endpoints }
  let active = null;               // { id, kind, ta, btn, msg, result }
  let shownInvId = null;           // lambda invocation whose result is in the workspace
  let shownServeId = null;         // serve target whose workspace is shown
  let shownDetailId = null;        // captured request whose read-only detail is shown
  let pendingReqPrefill = null;    // {method,path,headers,body} to seed the next serve request composer (re-invoke)
  let studioDockerfiles = [];      // Dockerfiles scanned at boot (pinned-ecs image-override picker)

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
    // The composer always shows an "All options" section (raw extra args + the
    // auto-derived flag reference), even for kinds with no curated controls.
    const wrap = el('div', 'options-wrap');
    const sec = el('div', 'section options');
    if (specs.length) {
      sec.appendChild(el('h3', null, 'Options'));
      wrap.appendChild(sec);
    }
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
    const allOpts = buildAllOptions(kind);
    wrap.appendChild(allOpts.node);
    return {
      node: wrap,
      collect: function () {
        const out = {};
        getters.forEach(function (g) { const kv = g(); out[kv[0]] = kv[1]; });
        // Omit-when-empty: a kind with no curated controls (e.g. api) collects
        // nothing, so return undefined rather than {} to keep the run/serve
        // body identical to before this section existed.
        return Object.keys(out).length ? out : undefined;
      },
      collectRaw: allOpts.collectRaw,
    };
  }

  // The collapsed "All options" section: a raw extra-args input (appended
  // verbatim to the spawned child) + the auto-derived, read-only catalog of
  // every flag the underlying command accepts. The curated controls above
  // cover the common flags with rich UI; this exposes the rest so the studio
  // UI is never strictly less capable than the headless CLI (issue #301).
  const FLAG_CATALOG = window.__FLAG_CATALOG__ || {};

  function buildAllOptions(kind) {
    const cat = FLAG_CATALOG[kind] || { command: '', flags: [] };
    const det = el('details', 'all-options');
    det.appendChild(el('summary', null, 'All options'));

    const rawRow = el('div', 'opt-row opt-col');
    rawRow.appendChild(el('span', 'opt-label', 'Raw extra args'));
    const rawIn = el('input', 'raw-args');
    rawIn.placeholder = '--flag value --other "with spaces"';
    rawRow.appendChild(rawIn);
    const hint = cat.command
      ? 'Appended verbatim to the spawned ' + cat.command + ' command. Quote values with spaces.'
      : 'Appended verbatim to the spawned command. Quote values with spaces.';
    rawRow.appendChild(el('div', 'opt-hint', hint));
    det.appendChild(rawRow);

    if (cat.flags.length) {
      const ref = el('div', 'flag-catalog');
      ref.appendChild(el('div', 'opt-label', 'Available flags'));
      cat.flags.forEach(function (f) {
        const row = el('div', 'flag-row');
        row.appendChild(el('code', 'flag-name', f.flags));
        if (f.description) row.appendChild(el('span', 'flag-desc', f.description));
        ref.appendChild(row);
      });
      det.appendChild(ref);
    }

    return {
      node: det,
      collectRaw: function () {
        const v = rawIn.value.trim();
        return v === '' ? undefined : v;
      },
    };
  }

  // Image-override picker for a pinned ECS service (issue #301): a select of
  // the Dockerfiles discovered at boot. Picking one threads an
  // --image-override flag to start-service so the deployed-registry-pinned
  // image is rebuilt from local source. Default "(keep pinned image)" => no
  // override.
  function buildImageOverridePicker() {
    const sec = el('div', 'section options');
    sec.appendChild(el('h3', null, 'Image override'));
    const row = el('div', 'opt-row');
    row.appendChild(el('span', 'opt-label', 'Local Dockerfile'));
    const sel = el('select', 'image-override-select');
    const none = el('option', null, '(keep pinned image)');
    none.value = '';
    sel.appendChild(none);
    studioDockerfiles.forEach(function (df) {
      const o = el('option', null, df);
      o.value = df;
      sel.appendChild(o);
    });
    row.appendChild(sel);
    sec.appendChild(row);
    const hint = studioDockerfiles.length
      ? 'This image is pinned to a deployed registry — local edits do not take effect. Pick a Dockerfile to rebuild it locally.'
      : 'This image is pinned to a deployed registry, but no Dockerfile was found under the app directory.';
    sec.appendChild(el('div', 'opt-hint', hint));
    return {
      node: sec,
      collect: function () {
        const v = sel.value.trim();
        return v === '' ? undefined : v;
      },
    };
  }

  // Toggle one target group's body open/closed (groups are collapsed by
  // default so a big Lambda list does not push the APIs below the fold).
  function toggleGroup(titleEl, bodyEl) {
    const open = bodyEl.classList.toggle('collapsed') === false;
    titleEl.classList.toggle('open', open);
  }

  // Filter the target rows by a case-insensitive substring of the target id.
  // While filtering, groups with a match auto-expand (so the hits are visible)
  // and groups with none are hidden; clearing the box restores the
  // collapsed-by-default view.
  function applyTargetFilter(query) {
    const q = (query || '').trim().toLowerCase();
    const pane = document.getElementById('targets');
    pane.querySelectorAll('.target-group').forEach(function (grp) {
      const title = grp.querySelector('.group-title');
      const body = grp.querySelector('.group-body');
      let matches = 0;
      body.querySelectorAll('.target').forEach(function (row) {
        const hit = q === '' || (row.getAttribute('data-tid') || '').includes(q);
        row.style.display = hit ? '' : 'none';
        if (hit) matches += 1;
      });
      if (q === '') {
        grp.style.display = '';
        body.classList.add('collapsed');
        title.classList.remove('open');
      } else {
        grp.style.display = matches ? '' : 'none';
        body.classList.toggle('collapsed', matches === 0);
        title.classList.toggle('open', matches > 0);
      }
    });
  }

  async function loadTargets() {
    const pane = document.getElementById('targets');
    try {
      const res = await fetch('/api/targets');
      const data = await res.json();
      // Dockerfiles discovered at boot — offered in a pinned ecs service's
      // image-override picker (issue #301).
      studioDockerfiles = Array.isArray(data.dockerfiles) ? data.dockerfiles : [];
      pane.querySelectorAll('.target-group,.empty').forEach((n) => n.remove());
      let total = 0;
      for (const group of data.groups) {
        if (!group.entries.length) continue;
        const grp = el('div', 'target-group');
        const title = el('div', 'group-title');
        title.appendChild(el('span', 'caret', '▶'));
        title.appendChild(el('span', 'group-name', group.title));
        title.appendChild(el('span', 'count', '(' + group.entries.length + ')'));
        const body = el('div', 'group-body collapsed'); // collapsed by default
        title.onclick = () => toggleGroup(title, body);
        grp.appendChild(title);
        grp.appendChild(body);
        for (const entry of group.entries) {
          total += 1;
          // Lambda + AgentCore targets are single-shot invokes; api / alb / ecs
          // are long-running serves. Other kinds list but are not yet runnable.
          // Within ecs, only services are servable (task defs are run-task).
          const isServe = SERVE_KINDS.includes(group.kind) && (group.kind !== 'ecs' || entry.servable === true);
          const isInvoke = INVOKE_KINDS.includes(group.kind);
          const runnable = isInvoke || isServe;
          const t = el('div', runnable ? 'target runnable' : 'target');
          t.setAttribute('data-tid', String(entry.id).toLowerCase()); // for the filter
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
            serveMeta.set(entry.id, { dot, btnSlot, kind: group.kind, pinned: entry.pinned === true });
            updateServeRow(entry.id);
          }
          body.appendChild(t);
        }
        pane.appendChild(grp);
      }
      if (!total) pane.appendChild(el('div', 'empty', 'No runnable targets found.'));
      // Re-apply any active filter (e.g. after a serve-event-driven reload).
      const search = document.getElementById('target-search');
      if (search && search.value) applyTargetFilter(search.value);
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
    // Keep a running / starting serve's row VISIBLE even though groups are
    // collapsed by default — otherwise its dot + curl-able studio-proxy port
    // would be hidden inside a collapsed group.
    if (running || starting) {
      const body = meta.dot.closest('.group-body');
      const grp = meta.dot.closest('.target-group');
      if (body) body.classList.remove('collapsed');
      if (grp) {
        const title = grp.querySelector('.group-title');
        if (title) title.classList.add('open');
      }
    }
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
    // Navigating to a composer leaves no timeline row "selected" — a stale
    // row.sel from a previously-clicked event is confusing once the middle
    // pane has moved on (issue #336).
    document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'));
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

  async function startServe(id, options, rawArgs, imageOverride) {
    // The serve kind (api / alb / ecs) drives which headless command the
    // server spawns; it is recorded on the row when the target list loads.
    const meta = serveMeta.get(id);
    const kind = meta ? meta.kind : 'api';
    serveState.set(id, { status: 'starting', endpoints: [] });
    updateServeRow(id);
    try {
      const body = { targetId: id, kind };
      if (options) body.options = options;
      if (rawArgs) body.rawArgs = rawArgs;
      if (imageOverride) body.imageOverride = imageOverride;
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
    // Drop the live LOGS <pre> ref — it is re-established below if this render
    // produces one, so a stale detached node never receives surgical updates.
    serveLogId = null;
    serveLogPre = null;
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
    let collectRaw = function () { return undefined; };
    let collectImageOverride = function () { return undefined; };
    btn.onclick = () => { if (running || starting) stopServe(id); else startServe(id, collectOpts(), collectRaw(), collectImageOverride()); };
    head.appendChild(btn);
    if (errMsg) {
      const m = el('div', 'err', errMsg);
      head.appendChild(m);
    }
    ws.appendChild(head);

    if (!running && !starting) {
      // A pinned ECS service (deployed-registry image) does not pick up local
      // source edits — offer an image-override Dockerfile picker so it can be
      // rebuilt locally (issue #301). Local-asset services hot-reload under
      // --watch and get no picker.
      if (meta && meta.kind === 'ecs' && meta.pinned) {
        const io = buildImageOverridePicker();
        ws.appendChild(io.node);
        collectImageOverride = io.collect;
      }
      const opt = buildOptions(kind);
      if (opt.node) ws.appendChild(opt.node);
      collectOpts = opt.collect;
      collectRaw = opt.collectRaw;
    }

    const isEcs = meta && meta.kind === 'ecs';
    const epSec = el('div', 'section');
    epSec.appendChild(el('h3', null, 'Endpoints'));
    if (running && st.endpoints.length) {
      for (const url of st.endpoints) {
        const link = href(url);
        epSec.appendChild(link);
      }
      // These are the studio capture-proxy URLs — the request target. curl
      // THESE and the request lands on the timeline. The serve child in the
      // Logs panel below advertises a DIFFERENT internal port (issue #325);
      // that port works too but bypasses capture, so prefer the URLs here.
      epSec.appendChild(
        el(
          'div',
          'opt-hint',
          'curl these — captured on the timeline. (The port in the Logs below is the serve child internal port; it bypasses capture.)'
        )
      );
    } else if (running && isEcs && st.hostUrl) {
      // An ecs service published via --host-port IS reachable on the host
      // (issue #322); show its host URL. No proxy fronts it, so requests are
      // not captured on the timeline.
      epSec.appendChild(href(st.hostUrl));
      epSec.appendChild(el('div', 'opt-hint', '(direct host port — not captured on the timeline)'));
    } else if (running && isEcs) {
      // A pure-compute ECS service has no host endpoint — it just runs the
      // replicas (reach them container-to-container via Cloud Map).
      epSec.appendChild(el('pre', null, '(running — pure compute service, no host endpoint)'));
    } else {
      epSec.appendChild(el('pre', null, starting ? '(starting…)' : '(not running)'));
    }
    ws.appendChild(epSec);

    // In-workspace HTTP request composer for a running api / alb (or ecs with
    // --host-port) serve (issue #322): compose a request and Send it; studio
    // relays it server-side (same-origin) so it works cross-port and, for
    // api / alb, lands on the timeline via the capture proxy.
    const httpBase = running
      ? (st.endpoints || []).find((u) => /^https?:/.test(u)) || (isEcs ? st.hostUrl : null)
      : null;
    if (httpBase) {
      const captured = (st.endpoints || []).indexOf(httpBase) >= 0;
      ws.appendChild(renderRequestComposer(id, httpBase, captured));
    }

    // A served WebSocket API exposes a ws:// endpoint — attach a WebSocket
    // console so the browser can connect + exchange frames (issue #303).
    const wsEndpoint = running ? (st.endpoints || []).find((u) => /^wss?:/.test(u)) : null;
    if (wsEndpoint) {
      ws.appendChild(renderWsConsole(wsEndpoint));
    }

    const logs = logsById.get(id) || [];
    const logSec = el('div', 'section');
    // Logs header carries a Clear button (issue #338): hammering a serve piles
    // up log lines, so let the user empty the panel (display-only — the
    // server-side store / history is untouched).
    const logHead = el('div', 'log-head');
    logHead.appendChild(el('h3', null, 'Logs'));
    const logClear = el('button', 'log-clear', 'Clear');
    logClear.onclick = function () {
      // Surgical clear (issue #334): empty the buffer + the live <pre> without
      // a full re-render that would wipe the request composer's fields.
      logsById.set(id, []);
      if (serveLogPre) serveLogPre.textContent = '(none)';
    };
    logHead.appendChild(logClear);
    logSec.appendChild(logHead);
    // A proxy-fronted serve (api / alb) streams its child start-* logs here,
    // which advertise the child internal 127.0.0.1 port — a DIFFERENT port
    // than the capture-proxy URL in Endpoints above. Flag it so the child
    // hint is not mistaken for the address to curl (issue #325).
    if (running && st.endpoints.length) {
      logSec.appendChild(
        el(
          'div',
          'opt-hint',
          'Note: any 127.0.0.1 port below is the serve child internal port. To reach this serve on the timeline, use the Endpoints above.'
        )
      );
    }
    const logPre = el('pre', null, logs.length ? logs.join('\\n') : '(none)');
    logSec.appendChild(logPre);
    ws.appendChild(logSec);
    // Register the live LOGS <pre> so streamed log events update it surgically
    // (issue #334) instead of re-rendering the whole serve workspace.
    serveLogId = id;
    serveLogPre = logPre;
  }

  // In-workspace HTTP request composer for a running serve (issue #322):
  // Method + Path + Headers + Body -> Send. The request is relayed by studio's
  // OWN server (POST /api/request) so it reaches the served port without a
  // cross-origin fetch; for an api / alb serve it flows through the capture
  // proxy and lands on the timeline.
  const REQ_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  // Headers editor with a KV / JSON toggle (issue #337), mirroring the Lambda
  // env-vars control. Returns { node, collect, prefill, jsonError }. KV mode is
  // add-row Name/value pairs; JSON mode is a raw JSON object of string values.
  // collect() yields a flat { Name: value } object; an invalid JSON object
  // surfaces via jsonError() so the Send handler can refuse rather than silently
  // drop the headers.
  function buildHeaderEditor() {
    const wrap = el('div', 'hdr-editor');
    const modes = el('div', 'envkv-modes');
    const kvBtn = el('button', 'envkv-mode active', 'KV');
    kvBtn.type = 'button';
    const jsonBtn = el('button', 'envkv-mode', 'JSON');
    jsonBtn.type = 'button';
    modes.appendChild(kvBtn);
    modes.appendChild(jsonBtn);
    wrap.appendChild(modes);

    const list = el('div', 'pair-rows');
    const pairs = [];
    function addRow(name, value) {
      const r = el('div', 'pair-row');
      const lv = el('input', 'pair-in');
      lv.placeholder = 'Header';
      lv.value = name || '';
      const rv = el('input', 'pair-in');
      rv.placeholder = 'value';
      rv.value = value || '';
      const pair = { l: lv, r: rv };
      const x = el('button', 'pair-x', 'x');
      x.type = 'button';
      x.onclick = function () {
        list.removeChild(r);
        const i = pairs.indexOf(pair);
        if (i >= 0) pairs.splice(i, 1);
      };
      r.appendChild(lv);
      r.appendChild(el('span', 'pair-sep', ':'));
      r.appendChild(rv);
      r.appendChild(x);
      list.appendChild(r);
      pairs.push(pair);
    }
    const add = el('button', 'pair-add', '+ add');
    add.type = 'button';
    add.onclick = function () { addRow(); };
    const kvPane = el('div', 'pair-wrap');
    kvPane.appendChild(list);
    kvPane.appendChild(add);
    wrap.appendChild(kvPane);

    const ta = el('textarea', 'envkv-ta');
    ta.placeholder = '{ "Authorization": "Bearer demo" }';
    ta.spellcheck = false;
    ta.style.display = 'none';
    wrap.appendChild(ta);

    let mode = 'kv';
    kvBtn.onclick = function () {
      mode = 'kv';
      kvBtn.className = 'envkv-mode active';
      jsonBtn.className = 'envkv-mode';
      kvPane.style.display = '';
      ta.style.display = 'none';
    };
    jsonBtn.onclick = function () {
      mode = 'json';
      jsonBtn.className = 'envkv-mode active';
      kvBtn.className = 'envkv-mode';
      ta.style.display = '';
      kvPane.style.display = 'none';
    };

    function parseJson() {
      const t = ta.value.trim();
      if (t === '') return { ok: true, value: {} };
      try {
        const o = JSON.parse(t);
        if (!o || typeof o !== 'object' || Array.isArray(o)) {
          return { ok: false, error: 'Headers JSON must be an object of string values.' };
        }
        const out = {};
        Object.keys(o).forEach(function (k) { out[k] = String(o[k]); });
        return { ok: true, value: out };
      } catch (e) {
        return { ok: false, error: 'Invalid headers JSON: ' + e.message };
      }
    }

    return {
      node: wrap,
      collect: function () {
        if (mode === 'json') {
          const p = parseJson();
          return p.ok ? p.value : {};
        }
        const out = {};
        pairs.forEach(function (p) {
          const k = p.l.value.trim();
          if (k) out[k] = p.r.value;
        });
        return out;
      },
      jsonError: function () {
        return mode === 'json' ? (parseJson().ok ? null : parseJson().error) : null;
      },
      prefill: function (headersObj) {
        if (!headersObj || typeof headersObj !== 'object') return;
        Object.keys(headersObj).forEach(function (k) { addRow(k, String(headersObj[k])); });
      },
    };
  }

  function renderRequestComposer(id, baseUrl, captured) {
    const sec = el('div', 'section req-composer');
    sec.appendChild(el('h3', null, 'Request'));
    const row = el('div', 'req-row');
    const method = el('select', 'req-method');
    REQ_METHODS.forEach(function (m) {
      const o = el('option', null, m);
      o.value = m;
      method.appendChild(o);
    });
    row.appendChild(method);
    const path = el('input', 'req-path');
    path.value = '/';
    path.placeholder = '/path?query';
    row.appendChild(path);
    sec.appendChild(row);

    sec.appendChild(el('div', 'opt-label', 'Headers'));
    const headerEditor = buildHeaderEditor();
    sec.appendChild(headerEditor.node);

    sec.appendChild(el('div', 'opt-label', 'Body'));
    const bodyTa = el('textarea', 'req-body');
    bodyTa.placeholder = '{ }';
    bodyTa.spellcheck = false;
    sec.appendChild(bodyTa);

    // Re-invoke prefill (issue #284): seed the fields from a captured request
    // when the user clicked [Re-invoke] on a served-request detail. The prefill
    // is address-tagged with its target; consume it UNCONDITIONALLY (so a stray
    // one from a since-stopped serve never lingers) but only APPLY it when the
    // target matches this composer.
    if (pendingReqPrefill) {
      const pending = pendingReqPrefill;
      pendingReqPrefill = null;
      if (pending.targetId === id && pending.req && typeof pending.req === 'object') {
        const pf = pending.req;
        if (pf.method) method.value = String(pf.method).toUpperCase();
        if (pf.path != null) path.value = pf.path;
        if (pf.headers && typeof pf.headers === 'object') {
          // Drop hop-by-hop / transport headers the proxy captured verbatim
          // (host / content-length / etc.) — they are noise in the editor and
          // the relay sets them itself.
          const SKIP = ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'];
          const seed = {};
          Object.keys(pf.headers).forEach(function (k) {
            if (SKIP.indexOf(k.toLowerCase()) === -1) seed[k] = pf.headers[k];
          });
          headerEditor.prefill(seed);
        }
        if (pf.body != null) {
          bodyTa.value = typeof pf.body === 'string' ? pf.body : JSON.stringify(pf.body);
        }
      }
    }

    const sendRow = el('div', 'req-send');
    const btn = el('button', null, 'Send');
    sendRow.appendChild(btn);
    sendRow.appendChild(
      el('span', 'opt-hint', captured
        ? 'Relayed via studio to ' + baseUrl + ' — captured on the timeline.'
        : 'Relayed direct to ' + baseUrl + ' (ecs host port) — not captured.')
    );
    sec.appendChild(sendRow);
    const msg = el('div', 'err');
    sec.appendChild(msg);
    const result = el('div', 'req-result');
    sec.appendChild(result);

    btn.onclick = async function () {
      msg.textContent = '';
      // Refuse a send on a malformed Headers JSON rather than silently dropping
      // the headers (issue #337).
      const hdrErr = headerEditor.jsonError();
      if (hdrErr) {
        msg.textContent = hdrErr;
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Sending…';
      result.innerHTML = '';
      // Sending a fresh request leaves no prior timeline row "selected" — the
      // new request becomes the current focus (issue #336).
      document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'));
      try {
        const payload = {
          targetId: id,
          method: method.value,
          path: path.value || '/',
          headers: headerEditor.collect(),
        };
        if (bodyTa.value !== '') payload.body = bodyTa.value;
        const res = await fetch('/api/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = 'Request failed: ' + (data.error || ('HTTP ' + res.status));
          return;
        }
        const statusLine = el('div', 'req-status');
        const cls = data.status >= 200 && data.status < 300 ? 'ok' : 'bad';
        statusLine.appendChild(
          el('span', cls, data.status + (data.durationMs != null ? ' · ' + data.durationMs + 'ms' : ''))
        );
        result.appendChild(statusLine);
        const hdrs = Object.keys(data.headers || {})
          .map(function (k) { return k + ': ' + data.headers[k]; })
          .join('\\n');
        if (hdrs) result.appendChild(el('pre', 'req-resp-headers', hdrs));
        result.appendChild(el('pre', null, data.body != null ? data.body : ''));
      } catch (err) {
        msg.textContent = 'Request failed: ' + err;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send';
      }
    };
    return sec;
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

  function renderComposer(id, kind, eventText, reinvokeOf) {
    const ws = document.getElementById('workspace');
    ws.innerHTML = '';

    const composer = el('div', 'composer');
    composer.appendChild(el('div', 'target-name', (reinvokeOf ? 'Re-invoke ' : 'Invoke ') + id));
    const ta = el('textarea');
    ta.value = eventText;
    ta.spellcheck = false;
    composer.appendChild(ta);
    // A re-invoke (issue #284) re-runs the EDITED event against the same
    // target; per-run options are not carried over, so the options section is
    // omitted (the payload is the thing being tweaked). A fresh invoke keeps
    // the per-run options (e.g. env vars) below the event, above Invoke.
    let opt = { collect: undefined, collectRaw: undefined };
    if (reinvokeOf) {
      composer.appendChild(
        el('div', 'opt-hint', 'Re-invoke runs the edited event through the same target (per-run options use defaults).')
      );
    } else {
      opt = buildOptions(kind);
      if (opt.node) composer.appendChild(opt.node);
    }
    composer.appendChild(document.createElement('br'));
    const btn = el('button', null, reinvokeOf ? 'Re-invoke' : 'Invoke');
    const msg = el('div', 'err');
    composer.appendChild(btn);
    composer.appendChild(msg);

    const result = el('div', 'result');

    ws.appendChild(composer);
    ws.appendChild(result);

    active = {
      id,
      kind,
      ta,
      btn,
      msg,
      result,
      collectOpts: opt.collect,
      collectRaw: opt.collectRaw,
      reinvokeOf: reinvokeOf || null,
    };
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
    const isReinvoke = !!active.reinvokeOf;
    msg.textContent = '';
    btn.disabled = true;
    btn.textContent = isReinvoke ? 'Re-invoking...' : 'Invoking...';
    result.innerHTML = '';
    try {
      // A re-invoke (issue #284) re-runs a recorded row by id with the edited
      // payload through POST /api/reinvoke; a fresh invoke runs the target by
      // POST /api/run with the composed options.
      let url;
      let body;
      if (isReinvoke) {
        url = '/api/reinvoke';
        body = { invocationId: active.reinvokeOf, payload: event };
      } else {
        url = '/api/run';
        body = { targetId: id, kind, event };
        const options = active.collectOpts ? active.collectOpts() : undefined;
        if (options) body.options = options;
        const rawArgs = active.collectRaw ? active.collectRaw() : undefined;
        if (rawArgs) body.rawArgs = rawArgs;
      }
      const res = await fetch(url, {
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
        const verb = isReinvoke ? 'Re-invoke' : 'Invoke';
        msg.textContent = verb + ' failed: ' + (data.error || ('HTTP ' + res.status));
      }
    } catch (err) {
      msg.textContent = 'Request failed: ' + err;
    } finally {
      btn.disabled = false;
      btn.textContent = isReinvoke ? 'Re-invoke' : 'Invoke';
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
    // A re-invoke (issue #284) row is visually linked to its source: a CSS
    // marker on the label + a tooltip naming the source invocation.
    if (merged.reinvokeOf) {
      row.classList.add('reinvoke');
      row.title = 'Re-invoke of ' + merged.reinvokeOf;
    }
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
      // re-invokable composer, pre-filled with the captured event and wired to
      // POST /api/reinvoke (issue #284) so the new row links to this source.
      shownDetailId = null;
      shownServeId = null;
      renderComposer(ev.target, ev.kind, ev.request != null ? fmt(ev.request) : '{}', id);
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
    // Re-invoke (issue #284): a captured served request is re-sent through the
    // live front door by reusing that serve's request composer. Clicking
    // navigates to the running serve and pre-fills it with this request; the
    // serve must be running (restart it first if it has stopped).
    const serveSt = serveState.get(ev.target);
    const serveRunning = serveSt && serveSt.status === 'running';
    const reBtn = el('button', 'reinvoke-btn', 'Re-invoke');
    if (serveRunning) {
      reBtn.onclick = function () {
        // Re-check running at CLICK time: the serve may have stopped since the
        // detail was rendered (the button is not re-rendered on a stop). If so,
        // do NOT seed a prefill (it would otherwise leak into the next serve
        // composer). The prefill is address-tagged with the target so a stray
        // one is dropped on mismatch (see renderRequestComposer).
        const cur = serveState.get(ev.target);
        if (!cur || cur.status !== 'running') {
          renderCapturedDetail(id); // re-render to reflect the now-stopped state
          return;
        }
        pendingReqPrefill =
          ev.request && typeof ev.request === 'object'
            ? { targetId: ev.target, req: ev.request }
            : null;
        selectTarget(ev.target, ev.kind);
      };
    } else {
      reBtn.disabled = true;
      reBtn.title = 'Start the serve to re-invoke this request.';
    }
    head.appendChild(reBtn);
    // Back to the serve's request composer for a FRESH request (issue #335) —
    // so the user does not have to re-select the target in the left pane after
    // inspecting a timeline detail.
    const newReqBtn = el('button', 'reinvoke-btn', 'New request');
    newReqBtn.onclick = function () {
      selectTarget(ev.target, ev.kind);
    };
    head.appendChild(newReqBtn);
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
      // A serve's log lines stream continuously; a FULL re-render per line
      // would wipe the in-progress request composer (its typed-in fields + the
      // last response). Update only the live LOGS <pre> surgically instead
      // (issue #334). A status change still re-renders via onServeEvent.
      if (shownServeId === ev.containerId && serveLogId === ev.containerId && serveLogPre) {
        serveLogPre.textContent = arr.join('\\n');
      }
    });
  }

  function onServeEvent(ev) {
    // A 'stopped' / 'error' transition clears the running state; otherwise
    // record the latest status + endpoints for the row + workspace.
    if (ev.status === 'stopped' || ev.status === 'error') {
      serveState.set(ev.target, { status: ev.status, endpoints: [] });
    } else {
      serveState.set(ev.target, { status: ev.status, endpoints: ev.endpoints || [], hostUrl: ev.hostUrl });
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

  // Apply the Session-bar bindings to the server immediately (no Save button) —
  // a checkbox toggle / an input change PATCHes /api/config right away so the
  // next invoke / serve picks it up. A brief "applied" flash confirms it.
  async function applyConfig() {
    const cfn = document.getElementById('sess-cfn');
    const cfnName = document.getElementById('sess-cfn-name');
    const role = document.getElementById('sess-role');
    const msg = document.getElementById('sess-msg');
    const body = {
      fromCfnStack: cfn.checked ? cfnName.value.trim() || true : null,
      assumeRole: role.value.trim() || null,
      watch: document.getElementById('sess-watch').checked,
    };
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
      msg.textContent = '✓ applied';
      setTimeout(function () { msg.textContent = ''; }, 1200);
      await loadConfig();
    } catch (err) {
      msg.textContent = 'Failed: ' + err;
    }
  }

  function wireSession() {
    const cfn = document.getElementById('sess-cfn');
    const cfnName = document.getElementById('sess-cfn-name');
    const role = document.getElementById('sess-role');
    // from-cfn-stack toggle: show/hide the name input AND apply immediately.
    cfn.addEventListener('change', function () {
      cfnName.style.display = cfn.checked ? '' : 'none';
      if (cfn.checked) cfnName.focus();
      applyConfig();
    });
    // Text inputs apply on change (blur / Enter), not on every keystroke.
    cfnName.addEventListener('change', function () { if (cfn.checked) applyConfig(); });
    role.addEventListener('change', applyConfig);
    document.getElementById('sess-watch').addEventListener('change', applyConfig);
  }

  const targetSearch = document.getElementById('target-search');
  if (targetSearch) {
    targetSearch.addEventListener('input', () => applyTargetFilter(targetSearch.value));
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
  // The auto-derived full flag catalog per runnable kind — the "All options"
  // section renders it as a read-only reference beside the raw extra-args input.
  const flagCatalogJson = JSON.stringify(buildFlagCatalog()).replace(/</g, '\\u003c');
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
  <span id="sess-msg"></span>
  <span id="sess-synth" class="sess-synth"></span>
</div>
<main>
  <section class="pane" id="targets">
    <div class="pane-head">
      <h2>Targets</h2>
      <input id="target-search" type="search" placeholder="Filter targets…" autocomplete="off" spellcheck="false" />
    </div>
  </section>
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
<script>window.__FLAG_CATALOG__ = ${flagCatalogJson};</script>
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
