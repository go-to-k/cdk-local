import { describe, it, expect, afterEach } from 'vite-plus/test';
import { createStudioHarness, type StudioHarness } from './studio-ui-harness.js';

/**
 * jsdom coverage for the studio `agentcore-ws` serve workspace after issue #454
 * generalized `cdkl start-agentcore` from a /ws-only bridge to a warm serve of
 * the agent's native protocol contract. The serve workspace must now render the
 * api/alb-style HTTP request composer for the contract (`POST /invocations` |
 * `POST /mcp` | `POST /`), and ADDITIONALLY the WebSocket console only for
 * HTTP / AGUI runtimes (which expose `/ws`) — MCP / A2A get the composer but no
 * console.
 *
 * The serve workspace reads module-state `serveState` / `serveMeta`, so the
 * epilogue exposes those maps (and `renderServeWorkspace`) and the test seeds a
 * running serve before rendering into the page's `#workspace`.
 */

const EXPOSE = `
window.__t = {
  renderServeWorkspace: renderServeWorkspace,
  renderRequestComposer: renderRequestComposer,
  loadTargets: loadTargets,
  serveState: serveState,
  serveMeta: serveMeta,
};
`;

interface AcHarness extends StudioHarness {
  window: StudioHarness['window'] & {
    __t: {
      renderServeWorkspace: (id: string, err?: string) => void;
      renderRequestComposer: (
        id: string,
        baseUrl: string,
        captured: boolean,
        defaults?: { method?: string; path?: string }
      ) => HTMLElement;
      loadTargets: () => Promise<void>;
      serveState: Map<string, unknown>;
      serveMeta: Map<string, { agentCoreHasWs?: boolean; agentCoreContractPath?: string | null }>;
    };
  };
}

let harness: AcHarness;

afterEach(() => {
  harness?.close();
});

/** Seed a running agentcore-ws serve and render its workspace into #workspace. */
function renderServe(opts: {
  id: string;
  endpoints: string[];
  hasWs: boolean;
  contractPath: string;
}): HTMLElement {
  harness = createStudioHarness({ epilogue: EXPOSE }) as AcHarness;
  const t = harness.window.__t;
  t.serveMeta.set(opts.id, {
    dot: harness.document.createElement('span'),
    btnSlot: harness.document.createElement('span'),
    kind: 'agentcore-ws',
    pinned: false,
    backingPinnedServices: [],
    agentCoreHasWs: opts.hasWs,
    agentCoreContractPath: opts.contractPath,
  });
  t.serveState.set(opts.id, { status: 'running', endpoints: opts.endpoints });
  t.renderServeWorkspace(opts.id);
  return harness.document.getElementById('workspace') as HTMLElement;
}

describe('studio agentcore-ws serve workspace (issue #454)', () => {
  it('renders the HTTP composer (POST + contract path) AND the WS console for an HTTP/AGUI runtime', () => {
    const ws = renderServe({
      id: 'S/HttpAgent',
      endpoints: ['ws://127.0.0.1:49160/ws', 'http://127.0.0.1:61234'],
      hasWs: true,
      contractPath: '/invocations',
    });

    const composer = ws.querySelector('.req-composer');
    expect(composer).not.toBeNull();
    // The composer is pre-filled with the contract's POST method + path so a
    // one-click invoke hits the warm container's /invocations endpoint.
    expect((composer!.querySelector('.req-method') as HTMLSelectElement).value).toBe('POST');
    expect((composer!.querySelector('.req-path') as HTMLInputElement).value).toBe('/invocations');

    // HTTP / AGUI expose /ws, so the interactive WebSocket console renders too.
    expect(ws.querySelector('.ws-console')).not.toBeNull();
  });

  it('renders the HTTP composer (POST /mcp) but NO WS console for an MCP runtime', () => {
    const ws = renderServe({
      id: 'S/McpAgent',
      endpoints: ['http://127.0.0.1:61234'],
      hasWs: false,
      contractPath: '/mcp',
    });

    const composer = ws.querySelector('.req-composer');
    expect(composer).not.toBeNull();
    expect((composer!.querySelector('.req-method') as HTMLSelectElement).value).toBe('POST');
    expect((composer!.querySelector('.req-path') as HTMLInputElement).value).toBe('/mcp');

    // MCP has no /ws — the console must NOT render (no ws:// endpoint).
    expect(ws.querySelector('.ws-console')).toBeNull();
  });

  it('renderRequestComposer seeds method + path from the defaults arg (A2A POST /)', () => {
    harness = createStudioHarness({ epilogue: EXPOSE }) as AcHarness;
    const sec = harness.window.__t.renderRequestComposer('S/A2a', 'http://127.0.0.1:61234', true, {
      method: 'POST',
      path: '/',
    });
    expect((sec.querySelector('.req-method') as HTMLSelectElement).value).toBe('POST');
    expect((sec.querySelector('.req-path') as HTMLInputElement).value).toBe('/');
  });

  it('renderRequestComposer with no defaults stays GET / (other serve kinds)', () => {
    harness = createStudioHarness({ epilogue: EXPOSE }) as AcHarness;
    const sec = harness.window.__t.renderRequestComposer('S/Api', 'http://127.0.0.1:9999', true);
    expect((sec.querySelector('.req-method') as HTMLSelectElement).value).toBe('GET');
    expect((sec.querySelector('.req-path') as HTMLInputElement).value).toBe('/');
  });

  it('loadTargets copies agentCoreHasWs + agentCoreContractPath from the target JSON into serveMeta', async () => {
    // Covers the entry -> serveMeta hop the direct-seed tests above bypass: the
    // `/api/targets` projection carries agentCoreHasWs + agentCoreContractPath,
    // and the targets-pane render must thread them onto serveMeta so the serve
    // workspace can gate the WS console + seed the composer path per protocol.
    harness = createStudioHarness({ epilogue: EXPOSE }) as AcHarness;
    const win = harness.window as AcHarness['window'];
    (win as unknown as { fetch: unknown }).fetch = (url: string) => {
      if (url === '/api/targets') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              groups: [
                {
                  kind: 'agentcore-ws',
                  title: 'AgentCore (serve)',
                  entries: [
                    {
                      id: 'S/Http',
                      qualifiedId: 'S:Http',
                      agentCoreHasWs: true,
                      agentCoreContractPath: '/invocations',
                    },
                    {
                      id: 'S/Mcp',
                      qualifiedId: 'S:Mcp',
                      agentCoreHasWs: false,
                      agentCoreContractPath: '/mcp',
                    },
                  ],
                },
              ],
              dockerfiles: [],
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };

    await win.__t.loadTargets();

    const http = win.__t.serveMeta.get('S/Http');
    const mcp = win.__t.serveMeta.get('S/Mcp');
    expect(http?.agentCoreHasWs).toBe(true);
    expect(http?.agentCoreContractPath).toBe('/invocations');
    expect(mcp?.agentCoreHasWs).toBe(false);
    expect(mcp?.agentCoreContractPath).toBe('/mcp');
  });
});
