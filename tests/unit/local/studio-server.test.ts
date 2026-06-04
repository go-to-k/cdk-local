import { request as httpRequest } from 'node:http';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import { StudioEventBus } from '../../../src/local/studio-events.js';
import {
  startStudioServer,
  toStudioTargetGroups,
  filterStudioTargetGroups,
  annotatePinnedEcsTargets,
  annotateAlbPinnedBackingServices,
  type RunningStudioServer,
  type StudioTargetGroup,
} from '../../../src/local/studio-server.js';
import { createStudioStore } from '../../../src/local/studio-store.js';
import type { TargetListing } from '../../../src/local/target-lister.js';

const running: RunningStudioServer[] = [];

// All HTTP here goes through a keep-alive-FREE `node:http` client
// (`agent: false`) — NOT global `fetch` (undici). undici pools the idle
// keep-alive socket after a request; the server's `closeAllConnections()`
// on teardown then destroys that pooled socket, and undici raises an
// unhandled rejection that crashes the vitest worker fork (exit 1) — seen
// ONLY under the `forks` pool on a loaded CI box, never locally, and it
// turned `main` red after the slice A and C2/C3 merges. `agent: false`
// uses a fresh socket per request that closes on response end, so nothing
// is ever pooled and there is no socket for `closeAllConnections()` to
// destroy. Mirrors the studio-proxy test's approach.

interface HttpResp {
  status: number;
  headers: { get: (k: string) => string | undefined };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

/** A keep-alive-free request (no undici pool). Mirrors a minimal `fetch`. */
function http(
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<HttpResp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqHeaders =
      opts.body != null ? { 'content-type': 'application/json', ...opts.headers } : (opts.headers ?? {});
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        agent: false,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        const finish = (): void =>
          resolve({
            status: res.statusCode ?? 0,
            headers: { get: (k) => headerValue(res.headers[k.toLowerCase()]) },
            json: () => Promise.resolve(JSON.parse(data)),
            text: () => Promise.resolve(data),
          });
        res.on('end', finish);
        res.on('error', finish);
      }
    );
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(', ') : v;
}

interface SseReader {
  read: () => Promise<{ value?: Buffer; done: boolean }>;
}
interface SseResp {
  headers: { get: (k: string) => string | undefined };
  body: { getReader: () => SseReader };
}

const sseReqs: Array<{ destroy: () => void }> = [];

/** Open an SSE stream over a keep-alive-free socket; `abort()` destroys it. */
function openSse(url: string): { res: Promise<SseResp>; abort: () => void } {
  const u = new URL(url);
  const queue: Buffer[] = [];
  let waiter: ((v: { value?: Buffer; done: boolean }) => void) | null = null;
  let ended = false;
  let resolveRes!: (r: SseResp) => void;
  const resP = new Promise<SseResp>((r) => (resolveRes = r));
  const req = httpRequest(
    { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', agent: false },
    (res) => {
      res.on('data', (c: Buffer) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: c, done: false });
        } else {
          queue.push(c);
        }
      });
      res.on('end', () => {
        ended = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ done: true });
        }
      });
      const reader: SseReader = {
        read: () =>
          new Promise((rr) => {
            if (queue.length) rr({ value: queue.shift(), done: false });
            else if (ended) rr({ done: true });
            else waiter = rr;
          }),
      };
      resolveRes({
        headers: { get: (k) => headerValue(res.headers[k.toLowerCase()]) },
        body: { getReader: () => reader },
      });
    }
  );
  req.on('error', () => undefined); // a destroy() on abort/teardown is expected
  req.end();
  const ctl = { destroy: () => req.destroy() };
  sseReqs.push(ctl);
  return { res: resP, abort: () => req.destroy() };
}

afterEach(async () => {
  // Destroy any still-open SSE client sockets BEFORE tearing the servers
  // down (they are the only long-lived sockets; everything else is
  // agent:false and already closed).
  for (const ctl of sseReqs.splice(0)) ctl.destroy();
  await Promise.all(running.splice(0).map((s) => s.close()));
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
  cloudFrontDistributions: [],
});

describe('annotatePinnedEcsTargets', () => {
  const groups = (): StudioTargetGroup[] => [
    {
      kind: 'ecs',
      title: 'ECS Services',
      entries: [
        { id: 'S/Pinned', qualifiedId: 'S:Pinned', servable: true },
        { id: 'S/Asset', qualifiedId: 'S:Asset', servable: true },
        { id: 'S/Task', qualifiedId: 'S:Task', servable: false },
      ],
    },
    { kind: 'lambda', title: 'Lambda', entries: [{ id: 'S/Fn', qualifiedId: 'S:Fn' }] },
  ];

  it('marks only the servable ecs services the classifier returns true for', () => {
    const g = groups();
    const anyPinned = annotatePinnedEcsTargets(g, (id) => id === 'S/Pinned');
    expect(anyPinned).toBe(true);
    const ecs = g[0].entries;
    expect(ecs[0].pinned).toBe(true); // S/Pinned
    expect(ecs[1].pinned).toBeUndefined(); // S/Asset (classifier false)
    expect(ecs[2].pinned).toBeUndefined(); // S/Task (not servable — never classified)
  });

  it('never classifies a non-servable entry (task definition)', () => {
    const seen: string[] = [];
    annotatePinnedEcsTargets(groups(), (id) => {
      seen.push(id);
      return false;
    });
    // The non-servable task def + the lambda are never passed to classify.
    expect(seen).toEqual(['S/Pinned', 'S/Asset']);
  });

  it('returns false (skip the Dockerfile scan) when nothing is pinned', () => {
    expect(annotatePinnedEcsTargets(groups(), () => false)).toBe(false);
  });

  it('leaves non-ecs groups untouched', () => {
    const g = groups();
    annotatePinnedEcsTargets(g, () => true);
    expect(g[1].entries[0].pinned).toBeUndefined();
  });
});

describe('annotateAlbPinnedBackingServices', () => {
  const groups = (): StudioTargetGroup[] => [
    {
      kind: 'ecs',
      title: 'ECS Services',
      entries: [{ id: 'S/Svc', qualifiedId: 'S:Svc', servable: true, pinned: true }],
    },
    {
      kind: 'alb',
      title: 'Load Balancers',
      entries: [
        { id: 'S/Alb1', qualifiedId: 'S:Alb1' },
        { id: 'S/Alb2', qualifiedId: 'S:Alb2' },
      ],
    },
  ];

  it('sets backingPinnedServices on the alb entries the resolver returns pinned services for', () => {
    const g = groups();
    const any = annotateAlbPinnedBackingServices(g, (e) =>
      e.id === 'S/Alb1' ? [{ id: 'S:Svc', label: 'S/Svc' }] : []
    );
    expect(any).toBe(true);
    expect(g[1].entries[0].backingPinnedServices).toEqual([{ id: 'S:Svc', label: 'S/Svc' }]);
    expect(g[1].entries[1].backingPinnedServices).toBeUndefined();
  });

  it('returns false + annotates nothing when no ALB fronts a pinned service', () => {
    const g = groups();
    expect(annotateAlbPinnedBackingServices(g, () => [])).toBe(false);
    expect(g[1].entries[0].backingPinnedServices).toBeUndefined();
  });

  it('only touches alb groups (ecs entries are left alone)', () => {
    const g = groups();
    annotateAlbPinnedBackingServices(g, () => [{ id: 'X', label: 'X' }]);
    expect(g[0].entries[0].backingPinnedServices).toBeUndefined();
  });
});

describe('toStudioTargetGroups', () => {
  it('projects a TargetListing into the studio groups', () => {
    const listing: TargetListing = {
      ...emptyListing(),
      lambdas: [{ qualifiedId: 'S:Fn', displayPath: 'S/Fn' }],
      apis: [{ qualifiedId: 'S:Api', displayPath: 'S/Api', kind: 'HTTP API v2' }],
      ecsServices: [{ qualifiedId: 'S:Svc' }],
      ecsTaskDefinitions: [{ qualifiedId: 'S:Task' }],
      cloudFrontDistributions: [{ qualifiedId: 'S:Dist', displayPath: 'S/Dist' }],
    };
    const groups = toStudioTargetGroups(listing);

    // ECS Services and Task Definitions are SEPARATE groups (issue #352); the
    // task-definitions group is the `ecs-task` kind (issue #366) — a [Run]
    // control (run-task), distinct from the servable `ecs` services kind.
    // CloudFront distributions are a serve target (issue #367).
    expect(groups.map((g) => g.kind)).toEqual([
      'lambda',
      'api',
      'ecs',
      'ecs-task',
      'agentcore',
      'alb',
      'cloudfront',
    ]);
    expect(groups.map((g) => g.title)).toEqual([
      'Lambda Functions',
      'APIs',
      'ECS Services',
      'ECS Task Definitions',
      'AgentCore Runtimes',
      'Load Balancers',
      'CloudFront Distributions',
    ]);
    expect(groups[0].entries).toEqual([{ id: 'S/Fn', qualifiedId: 'S:Fn' }]);
    // API surface kind is carried onto the entry.
    expect(groups[1].entries[0]).toEqual({
      id: 'S/Api',
      qualifiedId: 'S:Api',
      surface: 'HTTP API v2',
    });
    // The `ecs` services group holds the servable service; the `ecs-task` group
    // holds the task def (plain entry — no servable flag, the kind IS the run).
    expect(groups[2].entries.map((e) => e.id)).toEqual(['S:Svc']);
    expect(groups[2].entries.map((e) => e.servable)).toEqual([true]);
    expect(groups[3].entries).toEqual([{ id: 'S:Task', qualifiedId: 'S:Task' }]);
    // CloudFront distributions are a plain serve entry (no servable flag).
    expect(groups[6].entries).toEqual([{ id: 'S/Dist', qualifiedId: 'S:Dist' }]);
  });

  it('falls back to the qualified id when no display path exists', () => {
    const listing: TargetListing = {
      ...emptyListing(),
      lambdas: [{ qualifiedId: 'S:Fn' }],
    };
    expect(toStudioTargetGroups(listing)[0].entries[0]).toEqual({ id: 'S:Fn', qualifiedId: 'S:Fn' });
  });
});

describe('filterStudioTargetGroups (issue #301 slice 4)', () => {
  const groups: StudioTargetGroup[] = [
    {
      kind: 'lambda',
      title: 'Lambda Functions',
      entries: [
        { id: 'Dev/Fn', qualifiedId: 'Dev:Fn' },
        { id: 'Prod/Fn', qualifiedId: 'Prod:Fn' },
      ],
    },
    { kind: 'api', title: 'APIs', entries: [{ id: 'Dev/Api', qualifiedId: 'Dev:Api' }] },
  ];

  it('returns the groups unchanged when no globs are given', () => {
    expect(filterStudioTargetGroups(groups, undefined)).toBe(groups);
    expect(filterStudioTargetGroups(groups, [])).toBe(groups);
  });

  it('keeps only entries whose id matches a `Stack/*` glob', () => {
    const out = filterStudioTargetGroups(groups, ['Dev/*']);
    expect(out[0].entries.map((e) => e.id)).toEqual(['Dev/Fn']);
    expect(out[1].entries.map((e) => e.id)).toEqual(['Dev/Api']);
  });

  it('supports a stack-prefix glob (`dev*`-style) across groups', () => {
    const out = filterStudioTargetGroups(groups, ['Prod*']);
    expect(out[0].entries.map((e) => e.id)).toEqual(['Prod/Fn']);
    expect(out[1].entries).toEqual([]); // no Prod api
  });

  it('matches a target whose id matches ANY of multiple globs', () => {
    const out = filterStudioTargetGroups(groups, ['Dev/Api', 'Prod/*']);
    const ids = out.flatMap((g) => g.entries.map((e) => e.id));
    expect(ids.sort()).toEqual(['Dev/Api', 'Prod/Fn']);
  });

  it('treats `?` as a single-char wildcard and escapes regex specials', () => {
    const g: StudioTargetGroup[] = [
      {
        kind: 'lambda',
        title: 'L',
        entries: [
          { id: 'A.B/Fn1', qualifiedId: 'x' },
          { id: 'AxB/Fn1', qualifiedId: 'y' },
          { id: 'A.B/Fn2', qualifiedId: 'z' },
        ],
      },
    ];
    // The `.` is a literal (escaped); `?` matches the single digit.
    const out = filterStudioTargetGroups(g, ['A.B/Fn?']);
    expect(out[0].entries.map((e) => e.id).sort()).toEqual(['A.B/Fn1', 'A.B/Fn2']);
  });

  it('produces empty groups when nothing matches', () => {
    const out = filterStudioTargetGroups(groups, ['Nope/*']);
    expect(out.every((g) => g.entries.length === 0)).toBe(true);
  });
});

describe('startStudioServer', () => {
  it('serves the UI HTML at GET /', async () => {
    const server = await boot();
    const res = await http(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('CDK Local Studio'); // default cdkl brand (issue #301)
    expect(body).toContain('MyStack');
  });

  it('serves the target groups at GET /api/targets', async () => {
    const server = await boot();
    const res = await http(`${server.url}/api/targets`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const data = (await res.json()) as { groups: { kind: string; entries: unknown[] }[] };
    const lambda = data.groups.find((g) => g.kind === 'lambda');
    expect(lambda?.entries).toEqual([{ id: 'MyStack/Handler', qualifiedId: 'MyStack:Handler' }]);
  });

  it('serves the discovered dockerfiles alongside the target groups (issue #301)', async () => {
    const server = await boot({ dockerfiles: ['./Dockerfile', './svc/Dockerfile.dev'] });
    const res = await http(`${server.url}/api/targets`);
    const data = (await res.json()) as { groups: unknown[]; dockerfiles: string[] };
    expect(data.dockerfiles).toEqual(['./Dockerfile', './svc/Dockerfile.dev']);
  });

  it('defaults dockerfiles to an empty array when none were discovered', async () => {
    const server = await boot();
    const res = await http(`${server.url}/api/targets`);
    const data = (await res.json()) as { dockerfiles: string[] };
    expect(data.dockerfiles).toEqual([]);
  });

  it('passes a pinned ecs service flag through the target list', async () => {
    const server = await boot({
      targetGroups: [
        {
          kind: 'ecs',
          title: 'ECS Services',
          entries: [{ id: 'S/Svc', qualifiedId: 'S:Svc', servable: true, pinned: true }],
        },
      ],
    });
    const res = await http(`${server.url}/api/targets`);
    const data = (await res.json()) as { groups: { kind: string; entries: { pinned?: boolean }[] }[] };
    const ecs = data.groups.find((g) => g.kind === 'ecs');
    expect(ecs?.entries[0].pinned).toBe(true);
  });

  it('setTargets swaps the served target list under the live socket (issue #385)', async () => {
    const server = await boot({
      targetGroups: [
        {
          kind: 'ecs',
          title: 'ECS Services',
          entries: [{ id: 'S/Svc', qualifiedId: 'S:Svc', servable: true }],
        },
      ],
      dockerfiles: [],
    });
    // Before: not pinned, no dockerfiles.
    const before = (await (await http(`${server.url}/api/targets`)).json()) as {
      groups: { kind: string; entries: { pinned?: boolean }[] }[];
      dockerfiles: string[];
    };
    expect(before.groups.find((g) => g.kind === 'ecs')?.entries[0].pinned).toBeUndefined();
    expect(before.dockerfiles).toEqual([]);

    // Re-classification (e.g. after a Session-bar --from-cfn-stack change) marks
    // the service pinned and surfaces a Dockerfile for the override picker.
    server.setTargets(
      [
        {
          kind: 'ecs',
          title: 'ECS Services',
          entries: [{ id: 'S/Svc', qualifiedId: 'S:Svc', servable: true, pinned: true }],
        },
      ],
      ['./Dockerfile']
    );

    const after = (await (await http(`${server.url}/api/targets`)).json()) as {
      groups: { kind: string; entries: { pinned?: boolean }[] }[];
      dockerfiles: string[];
    };
    expect(after.groups.find((g) => g.kind === 'ecs')?.entries[0].pinned).toBe(true);
    expect(after.dockerfiles).toEqual(['./Dockerfile']);
  });

  it('setTargets defaults dockerfiles to an empty array when omitted', async () => {
    const server = await boot();
    server.setTargets([{ kind: 'lambda', title: 'Lambda Functions', entries: [] }]);
    const data = (await (await http(`${server.url}/api/targets`)).json()) as {
      dockerfiles: string[];
    };
    expect(data.dockerfiles).toEqual([]);
  });

  it('404s an unknown path', async () => {
    const server = await boot();
    const res = await http(`${server.url}/nope`);
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

    const res = await http(`${server.url}/api/run`, {
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
    const res = await http(`${server.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
    await res.text();
  });

  it('POST /api/run answers 400 on an invalid JSON body', async () => {
    const server = await boot({ onRun: () => Promise.resolve({}) });
    const res = await http(`${server.url}/api/run`, {
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
    const res = await http(`${server.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('dispatch blew up');
  });

  it('POST /api/reinvoke dispatches to onReinvoke and returns its result as JSON (issue #284)', async () => {
    let received: unknown;
    const onReinvoke = (body: unknown): Promise<unknown> => {
      received = body;
      return Promise.resolve({ invocationId: 'new-inv', ok: true });
    };
    const server = await boot({ onReinvoke });
    const res = await http(`${server.url}/api/reinvoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invocationId: 'src-1', payload: { a: 2 } }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { invocationId: string; ok: boolean };
    expect(data.ok).toBe(true);
    expect(data.invocationId).toBe('new-inv');
    expect(received).toEqual({ invocationId: 'src-1', payload: { a: 2 } });
  });

  it('POST /api/reinvoke answers 501 when no onReinvoke handler is wired', async () => {
    const server = await boot(); // observe-only shell
    const res = await http(`${server.url}/api/reinvoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
    await res.text();
  });

  it('POST /api/stop dispatches to onStop and returns its result as JSON', async () => {
    let received: unknown;
    const onStop = (body: unknown): Promise<unknown> => {
      received = body;
      return Promise.resolve({ stopped: 'MyApi' });
    };
    const server = await boot({ onStop });

    const res = await http(`${server.url}/api/stop`, {
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
    const res = await http(`${server.url}/api/stop`, {
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
    const res = await http(`${server.url}/api/running`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { running: { targetId: string }[] };
    expect(data.running).toEqual([{ targetId: 'MyApi', kind: 'api', status: 'running' }]);
  });

  it('GET /api/running returns an empty list when no getRunning is wired', async () => {
    const server = await boot(); // observe-only shell
    const res = await http(`${server.url}/api/running`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { running: unknown[] };
    expect(data.running).toEqual([]);
  });

  it('GET /api/history returns the store snapshot', async () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus);
    bus.emit('invocation', { id: 'a', ts: 1, target: 'T', kind: 'lambda', label: 'invoke' });
    bus.emit('log', { ts: 1, containerId: 'a', target: 'T', line: 'hello', stream: 'stdout' });
    const server = await boot({ bus, store });

    const res = await http(`${server.url}/api/history`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { invocations: { id: string }[]; logs: { line: string }[] };
    expect(data.invocations.map((i) => i.id)).toEqual(['a']);
    expect(data.logs.map((l) => l.line)).toEqual(['hello']);
  });

  it('GET /api/history returns empty when no store is wired', async () => {
    const server = await boot();
    const res = await http(`${server.url}/api/history`);
    const data = (await res.json()) as { invocations: unknown[]; logs: unknown[] };
    expect(data).toEqual({ invocations: [], logs: [] });
  });

  it('GET /api/logs?q= full-text searches the store', async () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus);
    bus.emit('log', { ts: 1, containerId: 'c', target: 'T', line: 'GET /hello 200', stream: 'stdout' });
    bus.emit('log', { ts: 2, containerId: 'c', target: 'T', line: 'unrelated', stream: 'stdout' });
    const server = await boot({ bus, store });

    const res = await http(`${server.url}/api/logs?q=${encodeURIComponent('/hello')}`);
    const data = (await res.json()) as { logs: { line: string }[] };
    expect(data.logs.map((l) => l.line)).toEqual(['GET /hello 200']);
  });

  it('GET /api/logs treats a bare target= as no filter (not target==="")', async () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus);
    bus.emit('log', { ts: 1, containerId: 'c', target: 'T', line: 'kept', stream: 'stdout' });
    const server = await boot({ bus, store });

    // A bare `target=` must NOT filter to logs whose target is the empty string.
    const res = await http(`${server.url}/api/logs?q=kept&target=`);
    const data = (await res.json()) as { logs: { line: string }[] };
    expect(data.logs.map((l) => l.line)).toEqual(['kept']);
  });

  it('GET /api/invocations/<id>/logs binds a Lambda invocation by container id', async () => {
    const bus = new StudioEventBus();
    const store = createStudioStore(bus);
    bus.emit('invocation', { id: 'inv-9', ts: 1, target: 'T', kind: 'lambda', label: 'invoke' });
    bus.emit('log', { ts: 1, containerId: 'inv-9', target: 'T', line: 'mine', stream: 'stdout' });
    bus.emit('log', { ts: 1, containerId: 'other', target: 'T', line: 'theirs', stream: 'stdout' });
    const server = await boot({ bus, store });

    const res = await http(`${server.url}/api/invocations/inv-9/logs`);
    const data = (await res.json()) as { logs: { line: string }[] };
    expect(data.logs.map((l) => l.line)).toEqual(['mine']);
  });

  it('GET /api/logs returns empty when no store is wired', async () => {
    const server = await boot();
    const res = await http(`${server.url}/api/logs?q=anything`);
    const data = (await res.json()) as { logs: unknown[] };
    expect(data.logs).toEqual([]);
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

describe('startStudioServer — session config (issue #301 slice 3)', () => {
  it('GET /api/config returns the getConfig() snapshot', async () => {
    const server = await boot({
      getConfig: () => ({ synth: { profile: 'dev', region: 'us-east-1' }, fromCfnStack: 'MyStack' }),
    });
    const res = await http(`${server.url}/api/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      synth: { profile: 'dev', region: 'us-east-1' },
      fromCfnStack: 'MyStack',
    });
  });

  it('GET /api/config returns {} when no getConfig is wired', async () => {
    const server = await boot();
    const res = await http(`${server.url}/api/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('PATCH /api/config dispatches the body to patchConfig and returns its result', async () => {
    let received: unknown;
    const server = await boot({
      patchConfig: (body) => {
        received = body;
        return Promise.resolve({ fromCfnStack: 'Patched' });
      },
    });
    const res = await http(`${server.url}/api/config`, {
      method: 'PATCH',
      body: JSON.stringify({ fromCfnStack: 'Patched' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fromCfnStack: 'Patched' });
    expect(received).toEqual({ fromCfnStack: 'Patched' });
  });

  it('PATCH /api/config returns 500 when patchConfig throws (validation error)', async () => {
    const server = await boot({
      patchConfig: () => Promise.reject(new Error('"assumeRole" must be a string or null.')),
    });
    const res = await http(`${server.url}/api/config`, {
      method: 'PATCH',
      body: JSON.stringify({ assumeRole: 42 }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('assumeRole') });
  });

  it('PATCH /api/config answers 501 when no patchConfig is wired', async () => {
    const server = await boot();
    const res = await http(`${server.url}/api/config`, { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(501);
  });
});
