import { describe, it, expect, afterEach } from 'vite-plus/test';
import { StudioEventBus } from '../../../src/local/studio-events.js';
import {
  startStudioServer,
  toStudioTargetGroups,
  type RunningStudioServer,
} from '../../../src/local/studio-server.js';
import type { TargetListing } from '../../../src/local/target-lister.js';

const running: RunningStudioServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
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
  });

  it('streams an emitted invocation over the SSE channel', async () => {
    const bus = new StudioEventBus();
    const server = await boot({ bus });

    const res = await fetch(`${server.url}/api/events`);
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
    await reader.cancel();

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

  it('close() resolves even with a live SSE client connected', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/api/events`);
    const reader = res.body!.getReader();
    await reader.read(); // open the stream
    // close() must not hang on the open keep-alive socket.
    await expect(server.close()).resolves.toBeUndefined();
    running.splice(running.indexOf(server), 1);
    await reader.cancel().catch(() => undefined);
  });
});
