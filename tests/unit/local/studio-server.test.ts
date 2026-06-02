import { describe, it, expect, afterEach } from 'vite-plus/test';
import { StudioEventBus } from '../../../src/local/studio-events.js';
import {
  startStudioServer,
  toStudioTargetGroups,
  type RunningStudioServer,
} from '../../../src/local/studio-server.js';
import type { TargetListing } from '../../../src/local/target-lister.js';

const running: RunningStudioServer[] = [];
// Every streaming SSE fetch is opened through an AbortController so the
// connection can be DESTROYED (not returned to undici's keep-alive pool)
// when the test is done. A pooled idle SSE socket that the server then
// tears down via `closeAllConnections()` surfaces as an unhandled
// rejection on undici's side, which crashes the vitest worker fork (Node
// exits the process on an unhandled rejection) — observed only under the
// `forks` pool on a loaded CI box, never locally. Aborting the client
// connection first sidesteps the pool entirely.
const sseControllers: AbortController[] = [];

/** Open an SSE connection whose socket is destroyed (not pooled) on abort. */
function openSse(url: string): { res: Promise<Response>; abort: () => void } {
  const ac = new AbortController();
  sseControllers.push(ac);
  return { res: fetch(url, { signal: ac.signal }), abort: () => ac.abort() };
}

afterEach(async () => {
  // Destroy any still-open client SSE connections BEFORE tearing the
  // servers down, so undici drops them from its pool rather than seeing
  // a server-side socket destroy.
  for (const ac of sseControllers.splice(0)) ac.abort();
  await Promise.all(running.splice(0).map((s) => s.close()));
  // Let undici fully unwind the aborted sockets before the worker exits.
  await new Promise((r) => setTimeout(r, 20));
});

async function boot(
  overrides: Partial<Parameters<typeof startStudioServer>[0]> = {}
): Promise<RunningStudioServer> {
  const bus = overrides.bus ?? new StudioEventBus();
  const server = await startStudioServer({
    port: 0, // 0 = let the OS pick a free port for the test
    bus,
    targetGroups: [
      {
        kind: 'lambda',
        title: 'Lambda Functions',
        entries: [{ id: 'MyStack/Handler', qualifiedId: 'MyStack:Handler' }],
      },
    ],
    appLabel: 'MyStack',
    cliName: 'cdkl',
    ...overrides,
  });
  running.push(server);
  return server;
}

const emptyListing = (): TargetListing => ({
  lambdas: [],
  apis: [],
  ecsServices: [],
  ecsTaskDefinitions: [],
  agentCoreRuntimes: [],
  loadBalancers: [],
});

describe('toStudioTargetGroups', () => {
  it('projects a TargetListing into the five studio groups', () => {
    const listing: TargetListing = {
      ...emptyListing(),
      lambdas: [{ qualifiedId: 'S:Fn', displayPath: 'S/Fn' }],
      apis: [{ qualifiedId: 'S:Api', displayPath: 'S/Api', kind: 'HTTP API v2' }],
      ecsServices: [{ qualifiedId: 'S:Svc' }],
      ecsTaskDefinitions: [{ qualifiedId: 'S:Task' }],
    };
    const groups = toStudioTargetGroups(listing);

    expect(groups.map((g) => g.kind)).toEqual(['lambda', 'api', 'ecs', 'agentcore', 'alb']);
    expect(groups[0].entries).toEqual([{ id: 'S/Fn', qualifiedId: 'S:Fn' }]);
    // API surface kind is carried onto the entry.
    expect(groups[1].entries[0]).toEqual({
      id: 'S/Api',
      qualifiedId: 'S:Api',
      surface: 'HTTP API v2',
    });
    // ECS services and task definitions fold into the one `ecs` group.
    expect(groups[2].entries.map((e) => e.id)).toEqual(['S:Svc', 'S:Task']);
  });

  it('falls back to the qualified id when no display path exists', () => {
    const listing: TargetListing = {
      ...emptyListing(),
      lambdas: [{ qualifiedId: 'S:Fn' }],
    };
    expect(toStudioTargetGroups(listing)[0].entries[0]).toEqual({ id: 'S:Fn', qualifiedId: 'S:Fn' });
  });
});

describe('startStudioServer', () => {
  it('serves the UI HTML at GET /', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('cdkl studio');
    expect(body).toContain('MyStack');
  });

  it('serves the target groups at GET /api/targets', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/api/targets`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const data = (await res.json()) as { groups: { kind: string; entries: unknown[] }[] };
    const lambda = data.groups.find((g) => g.kind === 'lambda');
    expect(lambda?.entries).toEqual([{ id: 'MyStack/Handler', qualifiedId: 'MyStack:Handler' }]);
  });

  it('404s an unknown path', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/nope`);
    expect(res.status).toBe(404);
    await res.text(); // drain the body so the connection does not linger
  });

  it('streams an emitted invocation over the SSE channel', async () => {
    const bus = new StudioEventBus();
    const server = await boot({ bus });

    const { res: resP, abort } = openSse(`${server.url}/api/events`);
    const res = await resP;
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // The server writes an opening `:ok` comment; read it so we know the
    // subscription is live before emitting.
    await reader.read();
    bus.emit('invocation', {
      id: 'sse1',
      ts: 123,
      target: 'MyStack:Handler',
      kind: 'lambda',
      label: 'invoke',
    });

    let buf = '';
    while (!buf.includes('event: invocation')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    // Destroy the connection (not pool it) now that we're done reading.
    abort();

    expect(buf).toContain('event: invocation');
    expect(buf).toContain('"id":"sse1"');
  });

  it('bumps to the next free port when the preferred port is taken', async () => {
    const first = await boot({ port: 0 });
    // Re-request the SAME concrete port the first server bound; the bump
    // logic must pick a different one rather than throwing EADDRINUSE.
    const second = await boot({ port: first.port });
    expect(second.port).not.toBe(first.port);
    expect(second.port).toBe(first.port + 1);
  });

  it('rejects when the preferred port is taken and no bumps are allowed', async () => {
    const first = await boot({ port: 0 });
    // maxPortBump: 0 => the first EADDRINUSE rejects immediately rather
    // than bumping. Exercises the give-up branch of listenWithBump.
    const bus = new StudioEventBus();
    await expect(
      startStudioServer({
        port: first.port,
        bus,
        targetGroups: [],
        appLabel: 'X',
        cliName: 'cdkl',
        maxPortBump: 0,
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('unsubscribes the bus listeners when an SSE client disconnects', async () => {
    const bus = new StudioEventBus();
    const server = await boot({ bus });

    const { res: resP, abort } = openSse(`${server.url}/api/events`);
    const res = await resP;
    const reader = res.body!.getReader();
    await reader.read(); // open the stream so the server subscribes
    // Subscribed: one invocation + one log + one serve listener.
    expect(bus.listenerCount('invocation')).toBe(1);
    expect(bus.listenerCount('log')).toBe(1);
    expect(bus.listenerCount('serve')).toBe(1);

    abort(); // client disconnect (destroys the connection)

    // The server's req/res `close` handler must unsubscribe. Poll briefly
    // since the disconnect propagates asynchronously.
    for (let i = 0; i < 40 && bus.listenerCount('invocation') > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(bus.listenerCount('invocation')).toBe(0);
    expect(bus.listenerCount('log')).toBe(0);
    expect(bus.listenerCount('serve')).toBe(0);
  });

  it('POST /api/run dispatches to onRun and returns its result as JSON', async () => {
    const onRun = (body: unknown): Promise<unknown> =>
      Promise.resolve({ echoed: body, ok: true });
    const server = await boot({ onRun });

    const res = await fetch(`${server.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 'T', kind: 'lambda', event: { a: 1 } }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { echoed: unknown; ok: boolean };
    expect(data.ok).toBe(true);
    expect(data.echoed).toEqual({ targetId: 'T', kind: 'lambda', event: { a: 1 } });
  });

  it('POST /api/run answers 501 when no onRun handler is wired', async () => {
    const server = await boot(); // observe-only shell, no onRun
    const res = await fetch(`${server.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
    await res.text();
  });

  it('POST /api/run answers 400 on an invalid JSON body', async () => {
    const server = await boot({ onRun: () => Promise.resolve({}) });
    const res = await fetch(`${server.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/invalid json/i);
  });

  it('POST /api/run answers 500 when the handler throws', async () => {
    const server = await boot({
      onRun: () => Promise.reject(new Error('dispatch blew up')),
    });
    const res = await fetch(`${server.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('dispatch blew up');
  });

  it('POST /api/stop dispatches to onStop and returns its result as JSON', async () => {
    let received: unknown;
    const onStop = (body: unknown): Promise<unknown> => {
      received = body;
      return Promise.resolve({ stopped: 'MyApi' });
    };
    const server = await boot({ onStop });

    const res = await fetch(`${server.url}/api/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 'MyApi' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stopped: string };
    expect(data.stopped).toBe('MyApi');
    expect(received).toEqual({ targetId: 'MyApi' });
  });

  it('POST /api/stop answers 501 when no onStop handler is wired', async () => {
    const server = await boot(); // observe-only shell
    const res = await fetch(`${server.url}/api/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
    await res.text();
  });

  it('GET /api/running returns the getRunning snapshot', async () => {
    const server = await boot({
      getRunning: () => ({ running: [{ targetId: 'MyApi', kind: 'api', status: 'running' }] }),
    });
    const res = await fetch(`${server.url}/api/running`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { running: { targetId: string }[] };
    expect(data.running).toEqual([{ targetId: 'MyApi', kind: 'api', status: 'running' }]);
  });

  it('GET /api/running returns an empty list when no getRunning is wired', async () => {
    const server = await boot(); // observe-only shell
    const res = await fetch(`${server.url}/api/running`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { running: unknown[] };
    expect(data.running).toEqual([]);
  });

  it('streams an emitted serve event over the SSE channel', async () => {
    const bus = new StudioEventBus();
    const server = await boot({ bus });

    const { res: resP, abort } = openSse(`${server.url}/api/events`);
    const res = await resP;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // opening `:ok`

    bus.emit('serve', {
      ts: 1,
      target: 'MyApi',
      kind: 'api',
      status: 'running',
      endpoints: ['http://127.0.0.1:51234'],
    });

    let buf = '';
    while (!buf.includes('event: serve')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    abort();

    expect(buf).toContain('event: serve');
    expect(buf).toContain('"status":"running"');
    expect(buf).toContain('http://127.0.0.1:51234');
  });

  it('close() resolves even with a live SSE client connected', async () => {
    const server = await boot();
    const { res: resP, abort } = openSse(`${server.url}/api/events`);
    const res = await resP;
    const reader = res.body!.getReader();
    await reader.read(); // open the stream
    // close() must not hang on the open keep-alive socket.
    await expect(server.close()).resolves.toBeUndefined();
    running.splice(running.indexOf(server), 1);
    abort();
  });
});
