import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// The process-wide AWS wiring applied at the docker-run layer: emulator
// credentials ride the value-from-process-env path (never argv), the host
// profile-credentials mount is dropped under --aws-emulator, the CA mount
// is added, and the loopback forwarder is started after the workload.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    options: unknown,
    cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const callback = (typeof options === 'function' ? options : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const out = execFileMock(cmd, args, typeof options === 'function' ? undefined : options) as
      | { stdout?: string; stderr?: string; error?: Error }
      | undefined;
    if (out?.error) callback(out.error, { stdout: '', stderr: '' });
    else callback(null, { stdout: out?.stdout ?? '', stderr: out?.stderr ?? '' });
  },
  spawn: vi.fn(),
}));

const { defaultChainMock } = vi.hoisted(() => ({ defaultChainMock: vi.fn() }));
vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: vi.fn(() => defaultChainMock) }));

const { attachLoopbackForwarder, runDetached, withWorkloadAwsWiring } = await import(
  '../../../src/local/docker-runner.js'
);
const { resetWorkloadAwsWiringForTest, setActiveWorkloadAwsWiring } = await import(
  '../../../src/local/workload-aws-wiring.js'
);
const { resetLoopbackForwarderForTest } = await import('../../../src/local/loopback-forwarder.js');
const { getLogger } = await import('../../../src/utils/logger.js');
type Wiring = import('../../../src/local/workload-aws-wiring.js').WorkloadAwsWiring;

const EMU = { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'EMUSECRETVALUE' };

function emulatorWiring(overrides: Partial<Wiring> = {}): Wiring {
  return {
    mode: 'emulator',
    emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_CA_BUNDLE: '/cdk-local-aws/ca-bundle.pem' },
    scrubEnvKeys: ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE'],
    mounts: [{ hostPath: '/tmp/ca/ca-bundle.pem', containerPath: '/cdk-local-aws/ca-bundle.pem' }],
    loopbackPorts: [9297],
    probeHealth: true,
    caHostPath: '/tmp/ca/ca-bundle.pem',
    emulatorCredentials: EMU,
    dispose: () => undefined,
    ...overrides,
  };
}

const baseRun = {
  image: 'public.ecr.aws/lambda/nodejs:22',
  mounts: [{ hostPath: '/code', containerPath: '/var/task', readOnly: true }],
  cmd: ['index.handler'],
  hostPort: 9001,
};

beforeEach(() => {
  execFileMock.mockReset();
  defaultChainMock.mockReset();
  resetWorkloadAwsWiringForTest();
  resetLoopbackForwarderForTest();
});
afterEach(() => resetWorkloadAwsWiringForTest());

describe('withWorkloadAwsWiring', () => {
  it('emulator: drops the host profile-credentials mount and adds the CA mount read-only', async () => {
    const out = await withWorkloadAwsWiring(
      {
        ...baseRun,
        env: { AWS_PROFILE: 'prod', AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real' },
        extraMounts: [
          { hostPath: '/tmp/creds/credentials', containerPath: '/cdk-local-aws/credentials', readOnly: true },
          { hostPath: '/layers', containerPath: '/opt', readOnly: true },
        ],
      },
      emulatorWiring()
    );
    expect(out.extraMounts).toEqual([
      { hostPath: '/layers', containerPath: '/opt', readOnly: true },
      { hostPath: '/tmp/ca/ca-bundle.pem', containerPath: '/cdk-local-aws/ca-bundle.pem', readOnly: true },
    ]);
    expect(out.env['AWS_PROFILE']).toBeUndefined();
    expect(out.env['AWS_ACCESS_KEY_ID']).toBe(EMU.accessKeyId);
    expect(defaultChainMock).not.toHaveBeenCalled();
  });

  it("emulator: appends the Java trust store to the function's JAVA_TOOL_OPTIONS and mounts it read-only", async () => {
    const out = await withWorkloadAwsWiring(
      { ...baseRun, env: { JAVA_TOOL_OPTIONS: '-Xmx256m' } },
      emulatorWiring({
        env: {
          AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
          JAVA_TOOL_OPTIONS:
            '-Djavax.net.ssl.trustStore=/cdk-local-aws/truststore.p12 -Djavax.net.ssl.trustStoreType=PKCS12',
        },
        mounts: [{ hostPath: '/tmp/ts/truststore.p12', containerPath: '/cdk-local-aws/truststore.p12' }],
      })
    );
    expect(out.env['JAVA_TOOL_OPTIONS']).toBe(
      '-Xmx256m -Djavax.net.ssl.trustStore=/cdk-local-aws/truststore.p12 -Djavax.net.ssl.trustStoreType=PKCS12'
    );
    expect(out.extraMounts).toContainEqual({
      hostPath: '/tmp/ts/truststore.p12',
      containerPath: '/cdk-local-aws/truststore.p12',
      readOnly: true,
    });
  });

  it('forward: keeps the profile mount and fills default-chain credentials only when absent', async () => {
    defaultChainMock.mockResolvedValue({ accessKeyId: 'CHAINKEY', secretAccessKey: 'chainsecret' });
    const forward = emulatorWiring({ mode: 'forward', scrubEnvKeys: [], loopbackPorts: [] });
    const filled = await withWorkloadAwsWiring(
      {
        ...baseRun,
        env: {},
        extraMounts: [{ hostPath: '/c', containerPath: '/cdk-local-aws/credentials', readOnly: true }],
      },
      forward
    );
    expect(filled.env['AWS_ACCESS_KEY_ID']).toBe('CHAINKEY');
    expect(filled.extraMounts?.[0]?.containerPath).toBe('/cdk-local-aws/credentials');
    const kept = await withWorkloadAwsWiring(
      { ...baseRun, env: { AWS_ACCESS_KEY_ID: 'PROFILEKEY', AWS_SECRET_ACCESS_KEY: 'p' } },
      forward
    );
    expect(kept.env['AWS_ACCESS_KEY_ID']).toBe('PROFILEKEY');
  });
});

describe('runDetached with an active wiring', () => {
  it('keeps emulator credentials off argv and starts the forwarder in the workload namespaces', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run' && args.includes('--pid')) return { stdout: 'fwd-id\n' };
      if (args[0] === 'run') return { stdout: 'workload-id\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD READY 192.168.65.254\n' };
      return { stdout: '' };
    });
    const id = await runDetached({ ...baseRun, env: { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'r' } });
    expect(id).toBe('workload-id');
    const calls = execFileMock.mock.calls as [string, string[], { env?: NodeJS.ProcessEnv } | undefined][];
    const run = calls.find((c) => c[1][0] === 'run' && !c[1].includes('--pid'))!;
    expect(run[1].join(' ')).not.toContain(EMU.secretAccessKey);
    expect(run[1].join(' ')).not.toContain('AKIAREAL');
    expect(run[1]).toContain('AWS_ENDPOINT_URL=https://127.0.0.1:9297');
    expect(run[2]?.env?.['AWS_SECRET_ACCESS_KEY']).toBe(EMU.secretAccessKey);
    const fwd = calls.find((c) => c[1][0] === 'run' && c[1].includes('--pid'))!;
    expect(fwd[1]).toContain('container:workload-id');
    expect(fwd[1].join(' ')).not.toContain(EMU.secretAccessKey);
  });

  it('emulator: an unreachable endpoint removes the workload and throws the actionable message', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: args.includes('--pid') ? 'fwd\n' : 'workload-id\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD FAIL 9297 ECONNREFUSED 172.17.0.1\n' };
      return { stdout: '' };
    });
    await expect(runDetached({ ...baseRun, env: {} })).rejects.toThrow(/cannot reach port 9297/);
    expect(execFileMock.mock.calls.some((c) => c[1][0] === 'rm' && c[1].includes('workload-id'))).toBe(true);
  });

  it('runs unchanged (no forwarder) when no wiring is active', async () => {
    execFileMock.mockReturnValue({ stdout: 'plain-id\n' });
    await expect(runDetached({ ...baseRun, env: {} })).resolves.toBe('plain-id');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('runDetached forwarder failure policy', () => {
  it('forward mode: a forwarder that cannot start only warns, and the workload keeps running', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring({ mode: 'forward', scrubEnvKeys: [] }));
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run' && args.includes('--pid')) return { error: new Error('pull access denied') };
      if (args[0] === 'run') return { stdout: 'workload-id\n' };
      if (args[0] === 'inspect') return { stdout: 'true\n' };
      return { stdout: '' };
    });
    await expect(
      runDetached({ ...baseRun, env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_ACCESS_KEY_ID: 'K', AWS_SECRET_ACCESS_KEY: 'S' } })
    ).resolves.toBe('workload-id');
    expect(warn).toHaveBeenCalled();
    expect(execFileMock.mock.calls.some((c) => c[1][0] === 'rm')).toBe(false);
    warn.mockRestore();
  });

  it('a workload that already exited is left alone (no error, no removal)', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run' && args.includes('--pid')) return { error: new Error('cannot join a non running container') };
      if (args[0] === 'run') return { stdout: 'short-task\n' };
      if (args[0] === 'inspect') return { stdout: 'false\n' };
      return { stdout: '' };
    });
    await expect(runDetached({ ...baseRun, env: {} })).resolves.toBe('short-task');
    expect(execFileMock.mock.calls.some((c) => c[1][0] === 'rm')).toBe(false);
  });

  it('host network: emulator env and scrub still apply, but no forwarder starts', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    execFileMock.mockReturnValue({ stdout: 'host-net\n' });
    await runDetached({ ...baseRun, network: 'host', env: { AWS_PROFILE: 'prod' } });
    const runs = execFileMock.mock.calls.filter((c) => c[1][0] === 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0]![1]).toContain('AWS_ENDPOINT_URL=https://127.0.0.1:9297');
    expect(runs[0]![1].some((a: string) => a.startsWith('AWS_PROFILE'))).toBe(false);
  });

  it('a port the final env no longer points at gets no forwarder', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring({ mode: 'forward', scrubEnvKeys: [] }));
    execFileMock.mockReturnValue({ stdout: 'id\n' });
    await runDetached({ ...baseRun, env: { AWS_ENDPOINT_URL: 'http://task-declared:1', AWS_ACCESS_KEY_ID: 'K', AWS_SECRET_ACCESS_KEY: 'S' } });
    expect(execFileMock.mock.calls.some((c) => c[1].includes('--pid'))).toBe(false);
  });

  it('a restart re-attaches the same port set the first start used', async () => {
    const w = emulatorWiring({ mode: 'forward', scrubEnvKeys: [] });
    setActiveWorkloadAwsWiring(w);
    execFileMock.mockReturnValue({ stdout: 'restart-id\n' });
    // First start: the task replaced the endpoint, so no forwarder.
    await runDetached({ ...baseRun, env: { AWS_ENDPOINT_URL: 'http://task-declared:1', AWS_ACCESS_KEY_ID: 'K', AWS_SECRET_ACCESS_KEY: 'S' } });
    // Soft reload re-attach with no explicit ports: still none.
    await attachLoopbackForwarder('restart-id', w);
    expect(execFileMock.mock.calls.some((c) => c[1].includes('--pid'))).toBe(false);
  });
});
