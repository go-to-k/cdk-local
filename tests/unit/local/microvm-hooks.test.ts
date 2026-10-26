import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MICROVM_HOOK_PATH_PREFIX,
  callRuntimeHook,
  generateMicrovmId,
  pollBuildHook,
  postHook,
  runHookBody,
  waitForAppAnswer,
  type HookPostResult,
  type MicrovmHookDeps,
} from '../../../src/local/microvm-hooks.js';

const EP = { host: '127.0.0.1', port: 9001 };

/** Fake deps answering from a script; time advances by each sleep (and 1ms per post). */
function scripted(answers: HookPostResult[], opts: { alive?: boolean } = {}) {
  let t = 0;
  const calls: { path: string; body: string | undefined; timeoutMs: number }[] = [];
  const deps: MicrovmHookDeps = {
    post: async (_h, _p, path, body, timeoutMs) => {
      calls.push({ path, body, timeoutMs });
      t += 1;
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next.kind === 'timeout') t += timeoutMs;
      return next;
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    ...(opts.alive !== undefined && { isAlive: async () => opts.alive! }),
  };
  return { deps, calls };
}

const status = (s: number, body = ''): HookPostResult => ({ kind: 'status', status: s, body });

describe('pollBuildHook', () => {
  it('retries 503 and a refused connection until 200, POSTing the hook path', async () => {
    const { deps, calls } = scripted([{ kind: 'refused' }, status(503), status(503), status(200)]);
    expect(await pollBuildHook('ready', EP, 10_000, deps)).toBe(4);
    expect(calls.map((c) => c.path)).toEqual(
      Array(4).fill(`${MICROVM_HOOK_PATH_PREFIX}ready`)
    );
    expect(calls.every((c) => c.body === undefined)).toBe(true);
  });

  it('fails with the timeout and the last answer when 200 never comes', async () => {
    const { deps } = scripted([status(503)]);
    await expect(pollBuildHook('ready', EP, 1000, deps)).rejects.toMatchObject({
      code: 'LOCAL_START_MICROVM_HOOK_TIMEOUT',
      message: expect.stringMatching(
        /The \/ready hook did not answer 200 within 1000ms \(ReadyTimeoutInSeconds.*last answer was HTTP 503/
      ),
    });
  });

  it('names the hooks port when nothing ever answered', async () => {
    const { deps } = scripted([{ kind: 'refused' }]);
    await expect(pollBuildHook('validate', EP, 500, deps)).rejects.toThrow(
      /\/validate hook did not answer 200 within 500ms \(ValidateTimeoutInSeconds.*nothing answered on 127\.0\.0\.1:9001/
    );
  });

  it('fails at once on a status other than 200 / 503, quoting the body', async () => {
    const { deps, calls } = scripted([status(500, 'boom')]);
    await expect(pollBuildHook('ready', EP, 10_000, deps)).rejects.toThrow(
      /\/ready hook answered HTTP 500; it must answer 200 when done or 503 to be retried\. Body: boom/
    );
    expect(calls).toHaveLength(1);
  });

  it('fails when the hook holds the request open until the deadline', async () => {
    const { deps } = scripted([{ kind: 'timeout' }]);
    await expect(pollBuildHook('ready', EP, 3000, deps)).rejects.toThrow(
      /held the request open for 3000ms.*Answer 503 immediately/
    );
  });

  it('fails fast once the container is gone', async () => {
    const { deps, calls } = scripted([status(503)], { alive: false });
    await expect(pollBuildHook('ready', EP, 60_000, deps)).rejects.toMatchObject({
      code: 'LOCAL_START_MICROVM_EXITED',
    });
    expect(calls).toHaveLength(4);
  });
});

describe('callRuntimeHook', () => {
  it('POSTs the body once and accepts 200', async () => {
    const { deps, calls } = scripted([status(200)]);
    await callRuntimeHook('run', EP, 2000, '{"microvmId":"mvm-1"}', deps);
    expect(calls).toEqual([
      { path: `${MICROVM_HOOK_PATH_PREFIX}run`, body: '{"microvmId":"mvm-1"}', timeoutMs: 2000 },
    ]);
  });

  it('does not retry a 503 and names every failure shape', async () => {
    await expect(callRuntimeHook('run', EP, 1, undefined, scripted([status(503)]).deps)).rejects.toThrow(
      /\/run hook answered HTTP 503; it must answer 200\./
    );
    await expect(
      callRuntimeHook('suspend', EP, 1500, undefined, scripted([{ kind: 'timeout' }]).deps)
    ).rejects.toThrow(/\/suspend hook did not answer within 1500ms \(SuspendTimeoutInSeconds/);
    await expect(
      callRuntimeHook('terminate', EP, 1, undefined, scripted([{ kind: 'refused' }]).deps)
    ).rejects.toThrow(/\/terminate hook could not be reached/);
  });
});

describe('run hook body and microvm id', () => {
  it('sends microvmId and runHookPayload, omitting an absent payload', () => {
    expect(JSON.parse(runHookBody('mvm-1', 'tenant'))).toEqual({
      microvmId: 'mvm-1',
      runHookPayload: 'tenant',
    });
    expect(JSON.parse(runHookBody('mvm-1', undefined))).toEqual({ microvmId: 'mvm-1' });
  });

  it('generates distinct cloud-shaped ids', () => {
    const a = generateMicrovmId();
    expect(a).toMatch(/^mvm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(generateMicrovmId()).not.toBe(a);
  });
});

describe('waitForAppAnswer', () => {
  it('returns on the first HTTP answer and times out naming the port', async () => {
    let t = 0;
    const outcomes = ['refused', 'answered'] as const;
    let i = 0;
    await waitForAppAnswer(EP, 1000, {
      probe: async () => outcomes[i++]!,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    expect(i).toBe(2);
    await expect(
      waitForAppAnswer(EP, 500, {
        probe: async () => 'refused',
        sleep: async (ms) => void (t += ms),
        now: () => t,
      })
    ).rejects.toThrow(/never answered HTTP on 127\.0\.0\.1:9001 within 500ms/);
  });
});

describe('waitForAppAnswer isAlive', () => {
  it('fails fast once the container is gone', async () => {
    let t = 0;
    let probes = 0;
    await expect(
      waitForAppAnswer(EP, 60_000, {
        probe: async () => {
          probes++;
          return 'refused';
        },
        sleep: async (ms) => void (t += ms),
        now: () => t,
        isAlive: async () => false,
      })
    ).rejects.toMatchObject({ code: 'LOCAL_START_MICROVM_EXITED' });
    expect(probes).toBe(4);
  });
});

describe('postHook (real HTTP)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  const listen = (handler: Parameters<typeof createServer>[1]): Promise<number> =>
    new Promise((r) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => r((server!.address() as AddressInfo).port));
    });

  it('POSTs JSON to the path and reports status and body', async () => {
    const seen: { method?: string; url?: string; type?: string; body: string } = { body: '' };
    const port = await listen((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.type = req.headers['content-type'];
      req.on('data', (c: Buffer) => (seen.body += c.toString()));
      req.on('end', () => res.writeHead(503).end('not yet'));
    });
    const r = await postHook('127.0.0.1', port, '/aws/lambda-microvms/runtime/v1/run', '{"a":1}', 2000);
    expect(r).toEqual({ kind: 'status', status: 503, body: 'not yet' });
    expect(seen).toEqual({
      method: 'POST',
      url: '/aws/lambda-microvms/runtime/v1/run',
      type: 'application/json',
      body: '{"a":1}',
    });
  });

  it('is a timeout when the hook holds the request open, refused when nothing listens', async () => {
    const port = await listen(() => undefined);
    expect(await postHook('127.0.0.1', port, '/x', undefined, 100)).toEqual({ kind: 'timeout' });
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await postHook('127.0.0.1', port, '/x', undefined, 1000)).toEqual({ kind: 'refused' });
  });
});
