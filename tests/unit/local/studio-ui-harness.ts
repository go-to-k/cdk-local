import { JSDOM } from 'jsdom';
import { renderStudioHtml } from '../../../src/local/studio-ui.js';

/**
 * jsdom execution harness for the embedded `cdkl studio` browser UI JS
 * (issue #305). The studio UI ships as an embedded `STUDIO_SCRIPT` string
 * inside `src/local/studio-ui.ts` so it bundles into the npm package with no
 * asset-copy step — which means none of its browser JS runs under unit tests.
 *
 * This harness renders the real page via `renderStudioHtml`, evaluates the
 * embedded script inside a jsdom `window` (with `fetch` / `EventSource`
 * stubbed so the bootstrap opens NO network handles), and exposes the script's
 * top-level functions so tests can drive `buildOptions(...)` /
 * `buildHeaderEditor()` round-trips and assert their collected values.
 *
 * We intentionally do NOT edit the source `STUDIO_SCRIPT` string to make it
 * testable: the no-backticks rule applies to that string, and a test should
 * exercise the shipped artifact as-is. Instead the script body is extracted
 * from the rendered HTML and a capture epilogue (added only at eval time, never
 * in the source) returns the function references we want to drive.
 */

/** The studio script functions this harness exposes to tests. */
export interface StudioHarness {
  /** The jsdom window the script ran inside. */
  window: Window & typeof globalThis;
  /** The jsdom document. */
  document: Document;
  /** `buildOptions(kind)` -> `{ node, collect, collectRaw }`. */
  buildOptions: (kind: string) => {
    node: HTMLElement;
    collect: () => Record<string, unknown> | undefined;
    collectRaw: () => string[];
  };
  /** `buildHeaderEditor()` -> the KV/JSON Headers editor. */
  buildHeaderEditor: () => {
    node: HTMLElement;
    collect: () => Record<string, string>;
    jsonError: () => string | null;
    prefill: (headers: Record<string, unknown>) => void;
  };
  /** Tear down the jsdom window (closes its timers). */
  close: () => void;
}

/** Records of `fetch` calls made by the script bootstrap, for assertions. */
export interface HarnessOptions {
  /** Extra script source appended after STUDIO_SCRIPT, before the capture epilogue. */
  epilogue?: string;
}

/**
 * Pull every `<script>...</script>` body out of the rendered HTML, in order.
 * Index 0/1 are the `window.__OPTION_SPECS__` / `window.__FLAG_CATALOG__`
 * data scripts; the last is the big STUDIO_SCRIPT.
 */
function extractScripts(html: string): string[] {
  const bodies: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

/**
 * Render the studio page and evaluate its embedded script inside a jsdom
 * window with `fetch` / `EventSource` stubbed (no real network).
 */
export function createStudioHarness(opts: HarnessOptions = {}): StudioHarness {
  const html = renderStudioHtml('TestStack', 'cdkl');
  // `runScripts: 'outside-only'` gives the document a live DOM + a window
  // whose `Function` constructor compiles code in the jsdom realm, but does
  // NOT auto-run the page's own <script> tags — we run them ourselves so we
  // can (a) inject the data globals and (b) capture the script's functions.
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const window = dom.window as unknown as Window & typeof globalThis;

  // Stub the network boundaries the bootstrap touches. `fetch` returns a
  // promise that never resolves (the bootstrap `await`s it; an unresolved
  // promise simply parks those async functions — no handles, no real I/O).
  // `EventSource` is an inert stub: `connect()` constructs one and registers
  // listeners synchronously, then returns.
  (window as unknown as { fetch: () => Promise<unknown> }).fetch = () =>
    new Promise<unknown>(() => {
      /* never resolves — keeps the bootstrap inert with no open handles */
    });
  class FakeEventSource {
    addEventListener(): void {
      /* inert */
    }
    close(): void {
      /* inert */
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

  const scripts = extractScripts(html);
  // The two data scripts set window globals the main script reads at load.
  for (const data of scripts.slice(0, scripts.length - 1)) {
    window.eval(data);
  }
  const studioScript = scripts[scripts.length - 1];

  // Capture epilogue — appended ONLY here at eval time, never in the source.
  // After the script's own bootstrap runs, return the function references the
  // tests drive. Both are top-level `function` declarations in STUDIO_SCRIPT,
  // so they are in scope at the end of the body.
  const epilogue =
    (opts.epilogue ?? '') +
    '\nreturn { buildOptions: buildOptions, buildHeaderEditor: buildHeaderEditor };';

  // Compile + run in the jsdom realm so `document` / `window` resolve to the
  // jsdom ones. `window.Function` is the realm's Function constructor.
  const factory = new window.Function(studioScript + epilogue) as () => {
    buildOptions: StudioHarness['buildOptions'];
    buildHeaderEditor: StudioHarness['buildHeaderEditor'];
  };
  const captured = factory.call(window);

  return {
    window,
    document: window.document,
    buildOptions: captured.buildOptions,
    buildHeaderEditor: captured.buildHeaderEditor,
    close: () => window.close(),
  };
}

/** Find the first `<input type="checkbox">` inside a node (for boolean opts). */
export function findCheckbox(node: ParentNode): HTMLInputElement {
  const cb = node.querySelector('input[type="checkbox"]');
  if (!cb) throw new Error('no checkbox in node');
  return cb as HTMLInputElement;
}
