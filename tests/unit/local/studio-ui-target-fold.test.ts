import { describe, it, expect } from 'vite-plus/test';
import { renderStudioHtml } from '../../../src/local/studio-ui.js';
import { createStudioHarness } from './studio-ui-harness.js';

/**
 * Per-stack construct-path folding in the targets pane. Target ids are the
 * synthesized construct path (`<stack>/<construct>/...`); in a narrow pane the
 * shared `<stack>/` prefix ate the width and a hard right-ellipsis cut off the
 * distinguishing tail. The pane now folds each stack's `<stack>/` prefix into a
 * `.stack-sub` header (PER STACK, so different stacks never share a fold) and
 * shows only the tail per row, with the tail as a horizontal-scroll container
 * (a two-finger swipe reveals the rest) instead of an ellipsis.
 *
 * Drives the real embedded `loadTargets` in jsdom via a resolving `fetch`, then
 * asserts the rendered DOM. `loadTargets` / `applyTargetFilter` are stashed on
 * `window` by a capture epilogue (the harness's fixed return object exposes
 * only the composer builders).
 */

const EPILOGUE =
  'window.__loadTargets = loadTargets; window.__applyTargetFilter = applyTargetFilter;';

function targetsFetch(groups: unknown) {
  return (url: string) => {
    if (url === '/api/targets') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups, dockerfiles: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
}

const LAMBDA_GROUP = {
  kind: 'lambda',
  title: 'Lambda Functions',
  // Already sorted by stack then logical id (as the target lister emits).
  entries: [
    { id: 'dev-AiApi/GptLambda/GptStream', qualifiedId: 'dev-AiApi:GptStream' },
    { id: 'dev-AiApi/SttLambda/EikenFn/Default', qualifiedId: 'dev-AiApi:EikenFn' },
    { id: 'dev-AiApi/SttLambda/WordFn/Default', qualifiedId: 'dev-AiApi:WordFn' },
    { id: 'prod-AiApi/GptLambda/GptStream', qualifiedId: 'prod-AiApi:GptStream' },
  ],
};

describe('targets pane per-stack path folding', () => {
  it('folds each stack prefix into a sub-header and shows the tail per row', async () => {
    const h = createStudioHarness({ epilogue: EPILOGUE });
    try {
      (h.window as unknown as { fetch: unknown }).fetch = targetsFetch([LAMBDA_GROUP]);
      await (h.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();

      const subs = Array.from(h.document.querySelectorAll('.stack-sub')).map((n) => n.textContent);
      // One sub-header per stack, carrying the folded '<stack>/' prefix.
      expect(subs).toEqual(['dev-AiApi/', 'prod-AiApi/']);

      const names = Array.from(h.document.querySelectorAll('.target .name')).map((n) => n.textContent);
      // Rows show only the tail after their stack prefix.
      expect(names).toEqual([
        'GptLambda/GptStream',
        'SttLambda/EikenFn/Default',
        'SttLambda/WordFn/Default',
        'GptLambda/GptStream',
      ]);
    } finally {
      h.close();
    }
  });

  it('keeps the full id on the row title + data-tid (folding is display-only)', async () => {
    const h = createStudioHarness({ epilogue: EPILOGUE });
    try {
      (h.window as unknown as { fetch: unknown }).fetch = targetsFetch([LAMBDA_GROUP]);
      await (h.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();

      const first = h.document.querySelector('.target') as HTMLElement;
      const name = first.querySelector('.name') as HTMLElement;
      // Hover tooltip is the full path even though the row text is the tail.
      expect(name.getAttribute('title')).toBe('dev-AiApi/GptLambda/GptStream');
      // The filter key stays the full lowercased id.
      expect(first.getAttribute('data-tid')).toBe('dev-aiapi/gptlambda/gptstream');
    } finally {
      h.close();
    }
  });

  it('zebra-stripes alternate rows continuously across stack sections', async () => {
    const h = createStudioHarness({ epilogue: EPILOGUE });
    try {
      (h.window as unknown as { fetch: unknown }).fetch = targetsFetch([LAMBDA_GROUP]);
      await (h.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();

      const rows = Array.from(h.document.querySelectorAll('.target'));
      // Continuous .alt across the section boundary: rows 0,2 plain; 1,3 alt.
      expect(rows.map((r) => r.classList.contains('alt'))).toEqual([false, true, false, true]);
    } finally {
      h.close();
    }
  });

  it('does not fold a colon-fallback id with no construct path', async () => {
    const h = createStudioHarness({ epilogue: EPILOGUE });
    try {
      const group = {
        kind: 'lambda',
        title: 'Lambda Functions',
        entries: [{ id: 'dev-AiApi:BareLogicalId', qualifiedId: 'dev-AiApi:BareLogicalId' }],
      };
      (h.window as unknown as { fetch: unknown }).fetch = targetsFetch([group]);
      await (h.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();

      // No '/' => nothing to fold => no sub-header, full id shown.
      expect(h.document.querySelector('.stack-sub')).toBeNull();
      const name = h.document.querySelector('.target .name') as HTMLElement;
      expect(name.textContent).toBe('dev-AiApi:BareLogicalId');
    } finally {
      h.close();
    }
  });

  it('hides a stack section whose rows all filter out, keeps the matching one', async () => {
    const h = createStudioHarness({ epilogue: EPILOGUE });
    try {
      (h.window as unknown as { fetch: unknown }).fetch = targetsFetch([LAMBDA_GROUP]);
      await (h.window as unknown as { __loadTargets: () => Promise<void> }).__loadTargets();
      (h.window as unknown as { __applyTargetFilter: (q: string) => void }).__applyTargetFilter('eiken');

      const sections = Array.from(h.document.querySelectorAll('.stack-section'));
      // dev-AiApi section matches (EikenFn), prod-AiApi section is hidden.
      expect((sections[0] as HTMLElement).style.display).toBe('');
      expect((sections[1] as HTMLElement).style.display).toBe('none');
    } finally {
      h.close();
    }
  });
});

describe('targets pane construct-path CSS', () => {
  it('makes the path a horizontal-scroll container with overscroll containment', () => {
    const html = renderStudioHtml('TestStack', 'cdkl');
    expect(html).toContain('overscroll-behavior-x: contain');
    expect(html).toContain('.target .name::-webkit-scrollbar { display: none; }');
    expect(html).toContain('.stack-sub {');
  });

  it('renders the stack sub-header as a blue-tinted divider bar (distinct hue from the grey rows)', () => {
    const html = renderStudioHtml('TestStack', 'cdkl');
    // A blue-tinted bar (group-title accent family) so its HUE sets it apart
    // from the neutral-grey zebra rows — it can never read as a target row.
    expect(html).toContain('color: #9fb2d4');
    expect(html).toContain('background: #18223a; border-bottom: 1px solid #2b3c5e;');
  });
});
