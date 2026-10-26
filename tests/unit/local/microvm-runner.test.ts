import { describe, expect, it, vi } from 'vite-plus/test';
import {
  DEFAULT_TERMINATE_HOOK_TIMEOUT_MS,
  LocalMicrovm,
  microvmImageTag,
  planMicrovmPorts,
} from '../../../src/local/microvm-runner.js';
import type { HookPostResult, MicrovmHookDeps } from '../../../src/local/microvm-hooks.js';
import type { MicrovmHookName, MicrovmImageConfig } from '../../../src/local/microvm-image.js';

describe('planMicrovmPorts', () => {
  it('puts 8080 first, then Hooks.Port, EXPOSE and --proxy-port, de-duplicated', () => {
    expect(planMicrovmPorts(9001, [8080, 9000], [9000, 9100])).toEqual([8080, 9001, 9000, 9100]);
    expect(planMicrovmPorts(undefined, [], [])).toEqual([8080]);
  });
});

describe('microvmImageTag', () => {
  it('is deterministic per code asset', () => {
    expect(microvmImageTag({ contextDir: '/x', assetHash: 'ABCDEF0123456789FFFF' })).toBe(
      'cdkl-microvm-abcdef0123456789'
    );
  });
});

const config = (
  hooks: Partial<Record<MicrovmHookName, { timeoutSeconds?: number }>>,
  hooksPort: number | undefined = 9001
): MicrovmImageConfig => ({
  logicalId: 'Img',
  name: 'img',
  codeKey: 'k.zip',
  architecture: 'arm64',
  environment: {},
  hooksPort,
  hooks: Object.fromEntries(
    Object.entries(hooks).map(([k, v]) => [k, { timeoutSeconds: v.timeoutSeconds }])
  ),
  unemulated: [],
});

/** A LocalMicrovm whose hook POSTs, pause and remove are recorded in one ordered log. */
function harness(
  hooks: Partial<Record<MicrovmHookName, { timeoutSeconds?: number }>>,
  answers: Partial<Record<string, HookPostResult[]>> = {},
  hooksPort?: number
) {
  const log: string[] = [];
  let t = 0;
  const hookDeps: MicrovmHookDeps = {
    post: async (_h, port, path, body, timeoutMs) => {
      const hook = path.split('/').pop()!;
      log.push(`POST ${hook} port=${port} timeout=${timeoutMs}${body ? ` body=${body}` : ''}`);
      t += 1;
      const queue = answers[hook];
      return (queue && queue.length > 0 ? queue.shift()! : { kind: 'status', status: 200, body: '' });
    },
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
  const waitForAnswer = vi.fn(async () => undefined);
  const vm = new LocalMicrovm(
    {
      microvmId: 'mvm-1',
      containerId: 'cid-1',
      ports: new Map([
        [8080, { host: '127.0.0.1', port: 40080 }],
        [9001, { host: '127.0.0.1', port: 40901 }],
      ]),
      config: config(hooks, hooksPort),
      timeoutMs: 7000,
    },
    {
      hooks: hookDeps,
      setPaused: async (_id, paused) => void log.push(paused ? 'pause' : 'unpause'),
      remove: async (id) => void log.push(`remove ${id}`),
      waitForAnswer,
    }
  );
  return { vm, log, waitForAnswer };
}

const ALL = {
  ready: { timeoutSeconds: 5 },
  validate: {},
  run: { timeoutSeconds: 2 },
  suspend: {},
  resume: {},
  terminate: {},
};

describe('LocalMicrovm', () => {
  it('boots through /ready (503 retried), /validate and /run with the payload, on the hooks port', async () => {
    const { vm, log } = harness(ALL, {
      ready: [
        { kind: 'status', status: 503, body: '' },
        { kind: 'status', status: 503, body: '' },
      ],
    });
    expect(vm.state()).not.toBe('running');
    await vm.boot('tenant-a');
    expect(log).toEqual([
      'POST ready port=40901 timeout=5000',
      'POST ready port=40901 timeout=4749',
      'POST ready port=40901 timeout=4498',
      'POST validate port=40901 timeout=7000',
      'POST run port=40901 timeout=2000 body={"microvmId":"mvm-1","runHookPayload":"tenant-a"}',
    ]);
    expect(vm.state()).toBe('running');
  });

  it('without a /ready hook, waits for the app to answer on the hooks port, else on 8080', async () => {
    const a = harness({ run: {} });
    await a.vm.boot(undefined);
    expect(a.waitForAnswer).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 40901 },
      7000,
      expect.anything()
    );
    expect(a.log).toEqual(['POST run port=40901 timeout=7000 body={"microvmId":"mvm-1"}']);

    const b = harness({}, {}, undefined);
    // No hooks at all: with no Hooks.Port the app is awaited on 8080.
    (b.vm as unknown as { opts: { config: MicrovmImageConfig } }).opts.config.hooksPort = undefined;
    await b.vm.boot(undefined);
    expect(b.waitForAnswer).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 40080 },
      7000,
      expect.anything()
    );
    expect(b.log).toEqual([]);
    expect(b.vm.state()).toBe('running');
  });

  it('a /run that does not answer 200 fails the boot and leaves the MicroVM not running', async () => {
    const { vm } = harness(ALL, { run: [{ kind: 'status', status: 500, body: 'no' }] });
    await expect(vm.boot(undefined)).rejects.toThrow(/\/run hook answered HTTP 500/);
    expect(vm.state()).not.toBe('running');
  });

  it('suspend calls /suspend then pauses; resume unpauses then calls /resume', async () => {
    const { vm, log } = harness(ALL);
    await vm.boot(undefined);
    log.length = 0;
    await vm.suspend();
    expect(vm.state()).toBe('suspended');
    await vm.resume();
    expect(vm.state()).toBe('running');
    expect(log).toEqual([
      'POST suspend port=40901 timeout=7000',
      'pause',
      'unpause',
      'POST resume port=40901 timeout=7000',
    ]);
  });

  it('refuses suspend / resume from the wrong state', async () => {
    const { vm } = harness(ALL);
    await vm.boot(undefined);
    await expect(vm.resume()).rejects.toThrow(/is running; only a suspended MicroVM can be resumed/);
    await vm.suspend();
    await expect(vm.suspend()).rejects.toThrow(/is suspended; only a running MicroVM can be suspended/);
  });

  it('concurrent resumes share one resume', async () => {
    const { vm, log } = harness(ALL);
    await vm.boot(undefined);
    await vm.suspend();
    log.length = 0;
    await Promise.all([vm.resume(), vm.resume(), vm.resume()]);
    expect(log).toEqual(['unpause', 'POST resume port=40901 timeout=7000']);
  });

  it('a failed /resume re-pauses and stays suspended', async () => {
    const { vm, log } = harness(ALL, { resume: [{ kind: 'status', status: 500, body: '' }] });
    await vm.boot(undefined);
    await vm.suspend();
    log.length = 0;
    await expect(vm.resume()).rejects.toThrow(/\/resume hook answered HTTP 500/);
    expect(vm.state()).toBe('suspended');
    expect(log).toEqual(['unpause', 'POST resume port=40901 timeout=7000', 'pause']);
  });

  it('a failed /suspend does not pause and stays running', async () => {
    const { vm, log } = harness(ALL, { suspend: [{ kind: 'timeout' }] });
    await vm.boot(undefined);
    log.length = 0;
    await expect(vm.suspend()).rejects.toThrow(/\/suspend hook did not answer/);
    expect(vm.state()).toBe('running');
    expect(log).not.toContain('pause');
  });

  it('terminate unpauses a suspended MicroVM, calls /terminate (10s default) and removes it, once', async () => {
    const onTerminated = vi.fn();
    const { vm, log } = harness(ALL);
    (vm as unknown as { opts: { onTerminated: unknown } }).opts.onTerminated = onTerminated;
    await vm.boot(undefined);
    await vm.suspend();
    log.length = 0;
    await Promise.all([vm.terminate(), vm.terminate()]);
    expect(log).toEqual([
      'unpause',
      `POST terminate port=40901 timeout=${DEFAULT_TERMINATE_HOOK_TIMEOUT_MS}`,
      'remove cid-1',
    ]);
    expect(vm.state()).toBe('terminated');
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });

  it('a failing /terminate is reported and the container is removed anyway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { vm, log } = harness(ALL, { terminate: [{ kind: 'refused' }] });
    await vm.boot(undefined);
    log.length = 0;
    await vm.terminate();
    expect(log).toEqual([
      `POST terminate port=40901 timeout=${DEFAULT_TERMINATE_HOOK_TIMEOUT_MS}`,
      'remove cid-1',
    ]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/could not be reached.*Removing its container anyway/);
    warn.mockRestore();
  });

  it('a MicroVM that never reached RUNNING is removed without its /terminate hook', async () => {
    const { vm, log } = harness(ALL);
    await vm.terminate();
    expect(log).toEqual(['remove cid-1']);
  });

  it('routes only the published ports', () => {
    const { vm } = harness(ALL);
    expect(vm.upstreamFor(8080)).toEqual({ host: '127.0.0.1', port: 40080 });
    expect(vm.upstreamFor(9000)).toBeUndefined();
    expect(vm.routablePorts()).toEqual([8080, 9001]);
  });
});
