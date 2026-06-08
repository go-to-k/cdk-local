import { describe, it, expect, afterEach } from 'vite-plus/test';
import { createStudioHarness, findCheckbox, type StudioHarness } from './studio-ui-harness.js';

/**
 * Execution coverage for the embedded `cdkl studio` browser UI JS (issue #305).
 *
 * The studio UI ships as an embedded `STUDIO_SCRIPT` string inside
 * `src/local/studio-ui.ts` so it bundles into the npm package with no
 * asset-copy step — which historically meant NONE of its browser JS ran under
 * unit tests (the sibling `studio-ui.test.ts` only string-asserts the rendered
 * HTML). These tests evaluate the real script in a jsdom window and drive the
 * actual `buildOptions(...)` / `buildHeaderEditor()` functions, asserting the
 * value each control collects. This is the largest untested surface in studio
 * and has twice hidden bugs (a backtick inside a comment breaking the template
 * literal; a log-event re-render wiping the composer).
 *
 * The harness stubs `fetch` / `EventSource` so the script bootstrap opens NO
 * network handles (the repo has a history of undici keep-alive crashing the
 * vitest forks worker — everything here is fully in-memory + synchronous).
 */

let harness: StudioHarness;

afterEach(() => {
  harness?.close();
});

/** Click an element's `onclick` handler (the studio code wires plain onclick). */
function click(el: Element): void {
  (el as HTMLElement & { onclick?: () => void }).onclick?.();
}

/** Fill an `<input>` value and fire a `change` event (drives `showWhen` sync). */
function setValue(input: Element, value: string): void {
  const i = input as HTMLInputElement;
  i.value = value;
  i.dispatchEvent(new harness.window.Event('change'));
}

describe('studio UI buildOptions (issue #305 jsdom execution coverage)', () => {
  it('the embedded script evaluates without throwing and exposes its functions', () => {
    harness = createStudioHarness();
    expect(typeof harness.buildOptions).toBe('function');
    expect(typeof harness.buildHeaderEditor).toBe('function');
  });

  it('collect() returns undefined for a kind with no curated controls (api)', () => {
    harness = createStudioHarness();
    // `api` has no curated OPTION_SPECS, so the curated section collects
    // nothing — collect() omits an empty object to keep the run body identical
    // to before the section existed.
    const opts = harness.buildOptions('api');
    expect(opts.collect()).toBeUndefined();
  });

  it('collects boolean checkbox + scalar input values (alb)', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('alb');
    const node = opts.node;
    // `--tls` is a boolean checkbox; `--bearer-token` a scalar input.
    const tls = node.querySelector('.opt-bool input[type="checkbox"]') as HTMLInputElement;
    expect(tls).toBeTruthy();
    tls.checked = true;

    // Find the bearer-token scalar input by its label.
    const bearerRow = [...node.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('Bearer token'),
    );
    expect(bearerRow).toBeTruthy();
    const bearerInput = bearerRow!.querySelector('input[type="text"]') as HTMLInputElement;
    bearerInput.value = 'demo-jwt';

    const collected = opts.collect()!;
    expect(collected['--tls']).toBe(true);
    expect(collected['--bearer-token']).toBe('demo-jwt');
  });

  it('hides a showWhen-gated scalar until its gate boolean is checked, then collects it (alb --tls-cert)', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('alb');
    const node = opts.node;

    // `--tls-cert` declares `showWhen: '--tls'`, so its row is hidden until the
    // `--tls` checkbox is checked.
    const certRow = [...node.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('TLS cert'),
    ) as HTMLElement;
    expect(certRow).toBeTruthy();
    expect(certRow.style.display).toBe('none'); // gated-off at first render

    // Check the `--tls` gate and fire `change` — the sync handler reveals it.
    const tls = node.querySelector('.opt-bool input[type="checkbox"]') as HTMLInputElement;
    tls.checked = true;
    tls.dispatchEvent(new harness.window.Event('change'));
    expect(certRow.style.display).toBe('flex');

    // The revealed input's value round-trips through collect().
    const certInput = certRow.querySelector('input[type="text"]') as HTMLInputElement;
    certInput.value = '/tmp/cert.pem';
    expect(opts.collect()!['--tls-cert']).toBe('/tmp/cert.pem');
  });

  it('repeat-pair add-row collects one {left,right} per row (alb --lb-port)', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('alb');
    const node = opts.node;

    const lbRow = [...node.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('Listener port remap'),
    )!;
    const pairWrap = lbRow.querySelector('.pair-wrap')!;
    const addBtn = pairWrap.querySelector('.pair-add')!;

    // No rows yet => empty list.
    expect(opts.collect()!['--lb-port']).toEqual([]);

    // Add two rows and fill them.
    click(addBtn);
    click(addBtn);
    const inputs = [...pairWrap.querySelectorAll('.pair-in')] as HTMLInputElement[];
    expect(inputs).toHaveLength(4); // 2 rows x (left, right)
    inputs[0].value = '443';
    inputs[1].value = '8443';
    inputs[2].value = '80';
    inputs[3].value = '8080';

    expect(opts.collect()!['--lb-port']).toEqual([
      { left: '443', right: '8443' },
      { left: '80', right: '8080' },
    ]);
  });

  it('repeat-pair remove-row drops the row from collect()', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('alb');
    const lbRow = [...opts.node.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('Listener port remap'),
    )!;
    const pairWrap = lbRow.querySelector('.pair-wrap')!;
    click(pairWrap.querySelector('.pair-add')!);
    click(pairWrap.querySelector('.pair-add')!);
    let inputs = [...pairWrap.querySelectorAll('.pair-in')] as HTMLInputElement[];
    inputs[0].value = 'keep-l';
    inputs[1].value = 'keep-r';
    inputs[2].value = 'drop-l';
    inputs[3].value = 'drop-r';
    // Remove the SECOND row (each row has its own `x` button).
    const removeButtons = [...pairWrap.querySelectorAll('.pair-x')] as HTMLElement[];
    click(removeButtons[1]);
    expect(opts.collect()!['--lb-port']).toEqual([{ left: 'keep-l', right: 'keep-r' }]);
  });

  describe('env-kv KV/JSON toggle (lambda --env-vars)', () => {
    function envRow(opts: ReturnType<StudioHarness['buildOptions']>): Element {
      return [...opts.node.querySelectorAll('.opt-row')].find((r) =>
        (r.textContent || '').includes('Env vars'),
      )!;
    }

    it('defaults to KV mode and collects the add-row pairs', () => {
      harness = createStudioHarness();
      const opts = harness.buildOptions('lambda');
      const row = envRow(opts);
      const pairWrap = row.querySelector('.pair-wrap')!;
      click(pairWrap.querySelector('.pair-add')!);
      const inputs = [...pairWrap.querySelectorAll('.pair-in')] as HTMLInputElement[];
      inputs[0].value = 'FOO';
      inputs[1].value = 'bar';
      // KV mode yields the raw row array (the server materializes it later).
      expect(opts.collect()!['--env-vars']).toEqual([{ left: 'FOO', right: 'bar' }]);
    });

    it('JSON mode collects the raw textarea string', () => {
      harness = createStudioHarness();
      const opts = harness.buildOptions('lambda');
      const row = envRow(opts);
      const jsonBtn = [...row.querySelectorAll('.envkv-mode')].find(
        (b) => b.textContent === 'JSON',
      )!;
      click(jsonBtn);
      const ta = row.querySelector('.envkv-ta') as HTMLTextAreaElement;
      ta.value = '{ "FOO": "bar" }';
      // JSON mode passes the textarea string through verbatim.
      expect(opts.collect()!['--env-vars']).toBe('{ "FOO": "bar" }');
    });

    it('toggling back to KV after JSON re-collects the pairs (not the JSON string)', () => {
      harness = createStudioHarness();
      const opts = harness.buildOptions('lambda');
      const row = envRow(opts);
      const jsonBtn = [...row.querySelectorAll('.envkv-mode')].find(
        (b) => b.textContent === 'JSON',
      )!;
      const kvBtn = [...row.querySelectorAll('.envkv-mode')].find((b) => b.textContent === 'KV')!;
      const pairWrap = row.querySelector('.pair-wrap')!;
      click(pairWrap.querySelector('.pair-add')!);
      const inputs = [...pairWrap.querySelectorAll('.pair-in')] as HTMLInputElement[];
      inputs[0].value = 'K';
      inputs[1].value = 'v';
      click(jsonBtn);
      (row.querySelector('.envkv-ta') as HTMLTextAreaElement).value = '{ "ignored": "1" }';
      click(kvBtn); // back to KV
      expect(opts.collect()!['--env-vars']).toEqual([{ left: 'K', right: 'v' }]);
    });
  });

  describe('agentcore options', () => {
    it('collects --ws / --sigv4 booleans and --session-id scalar', () => {
      harness = createStudioHarness();
      const opts = harness.buildOptions('agentcore');
      const node = opts.node;
      const checks = [...node.querySelectorAll('.opt-bool')] as HTMLElement[];
      const wsLabel = checks.find((l) => (l.textContent || '').includes('WebSocket'))!;
      findCheckbox(wsLabel).checked = true;
      const sigLabel = checks.find((l) => (l.textContent || '').includes('SigV4'))!;
      findCheckbox(sigLabel).checked = true;

      const sessRow = [...node.querySelectorAll('.opt-row')].find((r) =>
        (r.textContent || '').includes('Session id'),
      )!;
      (sessRow.querySelector('input[type="text"]') as HTMLInputElement).value = 'sess-42';

      const c = opts.collect()!;
      expect(c['--ws']).toBe(true);
      expect(c['--sigv4']).toBe(true);
      expect(c['--session-id']).toBe('sess-42');
    });
  });

  describe('All options raw extra-args (collectRaw)', () => {
    it('returns undefined when the raw input is empty, the trimmed string otherwise', () => {
      harness = createStudioHarness();
      const opts = harness.buildOptions('api');
      expect(opts.collectRaw()).toBeUndefined();
      const raw = opts.node.querySelector('.raw-args') as HTMLInputElement;
      raw.value = '  --debug --foo "with spaces"  ';
      expect(opts.collectRaw()).toBe('--debug --foo "with spaces"');
    });
  });
});

describe('studio UI buildHeaderEditor (issue #305)', () => {
  it('KV mode collects trimmed-key name/value pairs and drops blank keys', () => {
    harness = createStudioHarness();
    const editor = harness.buildHeaderEditor();
    const add = editor.node.querySelector('.pair-add')!;
    click(add);
    click(add);
    const inputs = [...editor.node.querySelectorAll('.pair-in')] as HTMLInputElement[];
    inputs[0].value = '  X-One  '; // trimmed key
    inputs[1].value = 'v1';
    inputs[2].value = ''; // blank key -> dropped
    inputs[3].value = 'orphan';
    expect(editor.collect()).toEqual({ 'X-One': 'v1' });
    expect(editor.jsonError()).toBeNull(); // KV mode never reports a JSON error
  });

  it('JSON mode collects an object of string values', () => {
    harness = createStudioHarness();
    const editor = harness.buildHeaderEditor();
    const jsonBtn = [...editor.node.querySelectorAll('.envkv-mode')].find(
      (b) => b.textContent === 'JSON',
    )!;
    click(jsonBtn);
    const ta = editor.node.querySelector('.envkv-ta') as HTMLTextAreaElement;
    ta.value = '{ "Authorization": "Bearer demo", "X-Num": 7 }';
    // Values are coerced to strings (the deployed header contract is string-valued).
    expect(editor.collect()).toEqual({ Authorization: 'Bearer demo', 'X-Num': '7' });
    expect(editor.jsonError()).toBeNull();
  });

  it('jsonError() surfaces malformed JSON and collect() yields {} rather than throwing', () => {
    harness = createStudioHarness();
    const editor = harness.buildHeaderEditor();
    const jsonBtn = [...editor.node.querySelectorAll('.envkv-mode')].find(
      (b) => b.textContent === 'JSON',
    )!;
    click(jsonBtn);
    const ta = editor.node.querySelector('.envkv-ta') as HTMLTextAreaElement;
    ta.value = '{ not valid json ';
    expect(editor.jsonError()).toMatch(/Invalid headers JSON/);
    expect(editor.collect()).toEqual({});
  });

  it('jsonError() rejects a non-object JSON (array / scalar)', () => {
    harness = createStudioHarness();
    const editor = harness.buildHeaderEditor();
    const jsonBtn = [...editor.node.querySelectorAll('.envkv-mode')].find(
      (b) => b.textContent === 'JSON',
    )!;
    click(jsonBtn);
    const ta = editor.node.querySelector('.envkv-ta') as HTMLTextAreaElement;
    ta.value = '[1, 2, 3]';
    expect(editor.jsonError()).toMatch(/must be an object/);
  });

  it('empty JSON textarea is valid and collects {}', () => {
    harness = createStudioHarness();
    const editor = harness.buildHeaderEditor();
    const jsonBtn = [...editor.node.querySelectorAll('.envkv-mode')].find(
      (b) => b.textContent === 'JSON',
    )!;
    click(jsonBtn);
    expect(editor.jsonError()).toBeNull();
    expect(editor.collect()).toEqual({});
  });

  it('prefill() seeds both the KV rows and the JSON pane', () => {
    harness = createStudioHarness();
    const editor = harness.buildHeaderEditor();
    editor.prefill({ Authorization: 'Bearer t', 'X-Trace': '123' });
    // KV pane: one row per header (mode defaults to kv at session start).
    expect(editor.collect()).toEqual({ Authorization: 'Bearer t', 'X-Trace': '123' });
    // JSON pane is seeded too, so switching to JSON shows the same data.
    const ta = editor.node.querySelector('.envkv-ta') as HTMLTextAreaElement;
    expect(JSON.parse(ta.value)).toEqual({ Authorization: 'Bearer t', 'X-Trace': '123' });
  });

  it('remembers lastHeaderMode session-wide: a second editor opens in the prior mode (issue #345)', () => {
    harness = createStudioHarness();
    // First editor: switch to JSON, which records lastHeaderMode = 'json'.
    const first = harness.buildHeaderEditor();
    const jsonBtn = [...first.node.querySelectorAll('.envkv-mode')].find(
      (b) => b.textContent === 'JSON',
    )!;
    click(jsonBtn);
    const firstTa = first.node.querySelector('.envkv-ta') as HTMLTextAreaElement;
    expect(firstTa.style.display).toBe(''); // JSON pane visible

    // A SECOND editor (e.g. a re-invoke composer) opens in JSON mode too.
    const second = harness.buildHeaderEditor();
    const secondTa = second.node.querySelector('.envkv-ta') as HTMLTextAreaElement;
    const secondKvPane = second.node.querySelector('.pair-wrap') as HTMLElement;
    expect(secondTa.style.display).toBe(''); // opens in JSON
    expect(secondKvPane.style.display).toBe('none');
    // And its JSON collect() works straight away.
    secondTa.value = '{ "A": "b" }';
    expect(second.collect()).toEqual({ A: 'b' });
  });
});

describe('studio UI "All options" auto-rendered controls (all-options-controls slice)', () => {
  // buildOptions(...) returns collectCatalog alongside collect/collectRaw; the
  // shared harness type predates it, so read it through a widened shape.
  type WithCatalog = ReturnType<StudioHarness['buildOptions']> & {
    collectCatalog: () => Record<string, boolean | string> | undefined;
  };

  it('auto-renders a checkbox for a boolean flag and an input for a value flag, then collects them (cloudfront)', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('cloudfront') as WithCatalog;
    const node = opts.node;
    // The controls live inside the collapsed "All options" <details>, under
    // the .flag-controls container.
    const controls = node.querySelector('details.all-options .flag-controls');
    expect(controls).toBeTruthy();

    // --no-pull is a renderable boolean -> checkbox labeled with the bare flag.
    const noPullRow = [...controls!.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('--no-pull'),
    )!;
    const noPull = noPullRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(noPull).toBeTruthy();
    noPull.checked = true;

    // --stack-region is a renderable value flag -> text input.
    const regionRow = [...controls!.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('--stack-region'),
    )!;
    const regionInput = regionRow.querySelector('input.flag-control') as HTMLInputElement;
    expect(regionInput).toBeTruthy();
    regionInput.value = 'us-west-2';

    const collected = opts.collectCatalog()!;
    expect(collected['--no-pull']).toBe(true);
    expect(collected['--stack-region']).toBe('us-west-2');
    // A curated flag (none for cloudfront beyond --tls/--origin) / managed flag
    // is NOT rendered here — only renderable residual flags.
    expect(collected['--watch']).toBeUndefined();
  });

  it('omits unset controls (unchecked box / blank input) from the collected map', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('cloudfront') as WithCatalog;
    // Nothing touched -> no catalog args posted (keeps the run body minimal).
    expect(opts.collectCatalog()).toBeUndefined();
  });

  it('auto-renders a <select> for a .choices() flag and collects the picked value (agentcore --platform)', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('agentcore') as WithCatalog;
    const controls = opts.node.querySelector('details.all-options .flag-controls')!;

    const platformRow = [...controls.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('--platform'),
    )!;
    const select = platformRow.querySelector('select.flag-control') as HTMLSelectElement;
    expect(select).toBeTruthy();
    // The options are the (default) sentinel + the two declared choices.
    const optionValues = [...select.options].map((o) => o.value);
    expect(optionValues).toEqual(['', 'linux/amd64', 'linux/arm64']);

    // Blank (default) selection -> omitted.
    expect(opts.collectCatalog()).toBeUndefined();
    // Pick a choice -> collected.
    select.value = 'linux/arm64';
    expect(opts.collectCatalog()!['--platform']).toBe('linux/arm64');
  });

  it('prefills the controls from a recorded catalogArgs map and opens the panel', () => {
    harness = createStudioHarness();
    // buildOptions(kind, prefill, rawPrefill, catalogPrefill) — the harness type
    // only declares the kind arg, so call through a widened signature.
    const build = harness.buildOptions as unknown as (
      kind: string,
      prefill?: unknown,
      rawPrefill?: unknown,
      catalogPrefill?: Record<string, boolean | string>,
    ) => WithCatalog;
    const opts = build('cloudfront', undefined, undefined, {
      '--no-pull': true,
      '--stack-region': 'eu-west-1',
    });
    const details = opts.node.querySelector('details.all-options') as HTMLDetailsElement;
    // A prefilled value auto-expands the collapsed panel.
    expect(details.open).toBe(true);
    // The recorded values round-trip back out of the re-rendered controls.
    const collected = opts.collectCatalog()!;
    expect(collected['--no-pull']).toBe(true);
    expect(collected['--stack-region']).toBe('eu-west-1');
  });

  it('renders the image-override build-input flags as controls (alb --image-build-secret)', () => {
    harness = createStudioHarness();
    const opts = harness.buildOptions('alb') as WithCatalog;
    const controls = opts.node.querySelector('details.all-options .flag-controls')!;
    // The Dockerfile picker only threads --image-override, so the build-input
    // pass-throughs must auto-render here (else they'd be raw-args-only).
    const secretRow = [...controls.querySelectorAll('.opt-row')].find((r) =>
      (r.textContent || '').includes('--image-build-secret'),
    )!;
    expect(secretRow).toBeTruthy();
    const secretInput = secretRow.querySelector('input.flag-control') as HTMLInputElement;
    expect(secretInput).toBeTruthy();
    secretInput.value = 'npmrc=./.npmrc';
    expect(opts.collectCatalog()!['--image-build-secret']).toBe('npmrc=./.npmrc');
    // The override-selection flag --image-override is NOT auto-rendered (picker).
    // Match on the control LABEL, not textContent — the build-input descriptions
    // mention "--image-override", which would falsely match a substring search.
    const labels = [...controls.querySelectorAll('.opt-label')].map((l) => (l.textContent || '').trim());
    expect(labels).not.toContain('--image-override');
  });
});
