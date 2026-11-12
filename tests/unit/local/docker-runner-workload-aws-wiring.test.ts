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

const {
  attachLoopbackForwarder,
  rememberForwardedPorts,
  removeContainer,
  runDetached,
  startNamespaceOwnerForwarder,
  withWorkloadAwsWiring,
} = await import('../../../src/local/docker-runner.js');
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

  it("removing a workload forgets its port set, so a long --watch session's map does not grow", async () => {
    const w = emulatorWiring({ mode: 'forward', scrubEnvKeys: [] });
    setActiveWorkloadAwsWiring(w);
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run' && args.includes('--pid')) return { error: new Error('no forwarder in this test') };
      if (args[0] === 'run') return { stdout: 'gone-id\n' };
      if (args[0] === 'inspect') return { stdout: 'true\n' };
      return { stdout: '' };
    });
    // First start: the task replaced the endpoint, so its remembered set is empty.
    await runDetached({ ...baseRun, env: { AWS_ENDPOINT_URL: 'http://task-declared:1', AWS_ACCESS_KEY_ID: 'K', AWS_SECRET_ACCESS_KEY: 'S' } });
    await removeContainer('gone-id');
    // The entry is gone: a later attach under the same id falls back to the
    // wiring's ports instead of the removed workload's empty set.
    await attachLoopbackForwarder('gone-id', w);
    const fwd = execFileMock.mock.calls.filter((c) => c[1][0] === 'run' && c[1].includes('--pid'));
    expect(fwd).toHaveLength(1);
    expect(fwd[0]![1]).toContain('container:gone-id');
  });
});

describe('loopback forwarder image pull', () => {
  const imageCalls = (): unknown[] => execFileMock.mock.calls.filter((c) => c[1][0] === 'image' || c[1][0] === 'pull');

  function stub(): void {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: args.includes('--pid') ? 'fwd\n' : 'workload-id\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD READY 192.168.65.254\n' };
      return { stdout: '' };
    });
  }

  it('checks for the image when a container needs a forwarder', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring());
    stub();
    await runDetached({ ...baseRun, env: {} });
    expect(imageCalls().length).toBeGreaterThan(0);
    const fwd = execFileMock.mock.calls.find((c) => c[1].includes('--pid'))!;
    expect(fwd[1]).not.toContain('never');
  });

  it('--no-pull: never inspects or pulls the forwarder image', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring({ skipPull: true }));
    stub();
    await runDetached({ ...baseRun, env: {} });
    const fwd = execFileMock.mock.calls.find((c) => c[1].includes('--pid'))!;
    expect((fwd[1] as string[]).join(' ')).toContain('--pull never');
    expect(imageCalls()).toHaveLength(0);
  });

  it('a container with no loopback port to forward never touches the image', async () => {
    setActiveWorkloadAwsWiring(emulatorWiring({ mode: 'forward', scrubEnvKeys: [], loopbackPorts: [] }));
    stub();
    await runDetached({ ...baseRun, env: { AWS_ACCESS_KEY_ID: 'K', AWS_SECRET_ACCESS_KEY: 'S' } });
    expect(imageCalls()).toHaveLength(0);
  });
});

describe('startNamespaceOwnerForwarder (issue #878)', () => {
  const namespace = {
    network: 'cdkl-task-x',
    networkAliases: ['app'],
    publish: ['127.0.0.1::8080/tcp'],
    addHosts: ['host.docker.internal:host-gateway'],
    links: [],
  };
  const calls = (): string[][] => execFileMock.mock.calls.map((c) => c[1] as string[]);
  const start = (wiring: Wiring) =>
    startNamespaceOwnerForwarder({
      name: 'cdkl-fam-app-abc-awsfwd',
      namespace,
      ports: [9297],
      wiring,
      workloadLabel: 'container app',
    });

  it('runs the owner argv, waits for READY, and resolves its id', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid123\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD READY 192.168.65.254\n' };
      return {};
    });
    await expect(start(emulatorWiring())).resolves.toBe('fid123');
    const run = calls().find((a) => a[0] === 'run')!;
    expect(run.slice(0, 6)).toEqual(['run', '-d', '--rm', '--name', 'cdkl-fam-app-abc-awsfwd', '--network']);
    expect(run).toContain('cdkl-task-x');
    expect(run).toContain('127.0.0.1::8080/tcp');
    expect(run).not.toContain('--pid');
    expect(calls().some((a) => a[0] === 'rm')).toBe(false);
  });

  it('passes the probe mode and the CA mount from the wiring', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid123\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD READY 192.168.65.254\n' };
      return {};
    });
    await start(emulatorWiring());
    const health = calls().find((a) => a[0] === 'run')!;
    expect(health).toContain('/tmp/ca/ca-bundle.pem:/cdkl-forwarder/ca.pem:ro');
    expect(health.slice(-3)).toEqual(['9297', 'health', '/cdkl-forwarder/ca.pem']);
    execFileMock.mockClear();
    await start(emulatorWiring({ probeHealth: false, caHostPath: undefined, skipPull: true }));
    const tcp = calls().find((a) => a[0] === 'run')!;
    expect(tcp.slice(-2)).toEqual(['9297', 'tcp']);
    expect(tcp).toContain('never');
    expect(tcp.join(' ')).not.toContain('ca.pem');
  });

  it('removes a forwarder that exits before reporting; --aws-emulator throws', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid123\n' };
      if (args[0] === 'logs') return { error: Object.assign(new Error('x'), { stderr: 'No such container' }) };
      return {};
    });
    await expect(start(emulatorWiring())).rejects.toThrow(/exited before reporting/);
    expect(calls()).toContainEqual(['rm', '-f', 'cdkl-fam-app-abc-awsfwd']);
  });

  it('--aws-emulator: a FAIL removes the forwarder and throws', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid123\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD FAIL 9297 ECONNREFUSED 172.17.0.1\n' };
      return {};
    });
    await expect(start(emulatorWiring())).rejects.toThrow(/cannot reach port 9297/);
    expect(calls()).toContainEqual(['rm', '-f', 'cdkl-fam-app-abc-awsfwd']);
  });

  it('forward mode: a FAIL removes the forwarder, warns, and resolves undefined', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid123\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD FAIL 9878 ECONNREFUSED 172.17.0.1\n' };
      return {};
    });
    await expect(start(emulatorWiring({ mode: 'forward' }))).resolves.toBeUndefined();
    expect(calls()).toContainEqual(['rm', '-f', 'cdkl-fam-app-abc-awsfwd']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('--aws-emulator: a failed docker run (a published port in use) names the workload and never the argv', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') {
        return { error: Object.assign(new Error('Command failed: docker run ... EMUSECRET'), { stderr: 'port is already allocated' }) };
      }
      return {};
    });
    const err = (await start(emulatorWiring()).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/loopback forwarder for container app/);
    expect(err.message).toMatch(/port is already allocated/);
    expect(err.message).not.toContain('EMUSECRET');
    expect(calls()).toContainEqual(['rm', '-f', 'cdkl-fam-app-abc-awsfwd']);
  });

  it('a remembered empty port set makes a restart attach no forwarder', async () => {
    rememberForwardedPorts('cid-own', emulatorWiring(), []);
    await attachLoopbackForwarder('cid-own', emulatorWiring());
    expect(calls().some((a) => a[0] === 'run')).toBe(false);
    await removeContainer('cid-own');
  });

  it('a host port clash is not mistaken for a name conflict: the created forwarder is removed', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') {
        return {
          error: Object.assign(new Error('Command failed'), {
            stderr: 'Bind for 127.0.0.1:8080 failed: port is already allocated; bind: address already in use',
          }),
        };
      }
      return {};
    });
    await expect(start(emulatorWiring())).rejects.toThrow(/address already in use/);
    expect(calls()).toContainEqual(['rm', '-f', 'cdkl-fam-app-abc-awsfwd']);
  });

  it('never removes a container another run holds the name of (name conflict)', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') {
        return {
          error: Object.assign(new Error('Command failed'), {
            stderr: 'Conflict. The container name "/cdkl-fam-app-abc-awsfwd" is already in use',
          }),
        };
      }
      return {};
    });
    await expect(start(emulatorWiring())).rejects.toThrow(/already in use/);
    expect(calls().some((a) => a[0] === 'rm')).toBe(false);
  });

  it('recognizes the finch (nerdctl) name-conflict wording too', async () => {
    execFileMock.mockImplementation((_c: string, args: string[]) =>
      args[0] === 'run'
        ? {
            error: Object.assign(new Error('Command failed'), {
              stderr: 'name "cdkl-fam-app-abc-awsfwd" is already used by ID "0123abcd"',
            }),
          }
        : {}
    );
    await expect(start(emulatorWiring())).rejects.toThrow(/already used by/);
    expect(calls().some((a) => a[0] === 'rm')).toBe(false);
  });
});

describe('runDetached — mixed mode (--aws-emulator + a real-aws exception)', () => {
  const RESIGN = 47297;
  function mixedWiring(): Wiring {
    return emulatorWiring({
      mode: 'forward',
      scrubEnvKeys: [],
      env: {
        AWS_ENDPOINT_URL: `https://127.0.0.1:${RESIGN}`,
        AWS_CA_BUNDLE: '/cdk-local-aws/ca-bundle.pem',
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
      },
      loopbackPorts: [9297, RESIGN],
      emulatorCredentials: undefined,
      mixed: {
        realServices: ['DYNAMODB'],
        emulatorCredentials: EMU,
        region: 'us-east-1',
        emulatorEndpoint: { url: 'https://127.0.0.1:9297', hostname: '127.0.0.1', port: 9297, loopback: true },
        resignPort: RESIGN,
        resignEndpoint: `https://127.0.0.1:${RESIGN}`,
        resignConfigHostPath: '/tmp/resign-x/resign.json',
        emulatorClientOverride: { endpoint: 'https://127.0.0.1:9297', credentials: EMU },
      },
    });
  }
  const realEnv = { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'REALSECRET' };
  const DDB_REAL = 'https://dynamodb.us-east-1.amazonaws.com';

  it('keeps the real identity for an excepted service, sends the rest through the sidecar, and starts the forwarder with it', async () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: args.includes('--pid') ? 'fwd\n' : 'workload-id\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD READY 192.168.65.254\n' };
      return { stdout: '' };
    });
    await runDetached({
      ...baseRun,
      env: { ...realEnv, AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
    });
    const calls = execFileMock.mock.calls as [string, string[], { env?: NodeJS.ProcessEnv } | undefined][];
    const run = calls.find((c) => c[1][0] === 'run' && !c[1].includes('--pid'))!;
    // The exception becomes the real regional endpoint; everything else rides the global sidecar endpoint.
    expect(run[1]).toContain(`AWS_ENDPOINT_URL_DYNAMODB=${DDB_REAL}`);
    expect(run[1]).toContain(`AWS_ENDPOINT_URL=https://127.0.0.1:${RESIGN}`);
    expect(run[2]?.env?.['AWS_SECRET_ACCESS_KEY']).toBe('REALSECRET');
    const fwd = calls.find((c) => c[1][0] === 'run' && c[1].includes('--pid'))!;
    expect(fwd[1]).toContain('/tmp/resign-x/resign.json:/cdkl-forwarder/resign.json:ro');
    const tail = fwd[1].slice(fwd[1].indexOf('-e') + 2);
    expect(tail[0]).toBe('9297');
    expect(tail.at(-1)).toBe('/cdkl-forwarder/resign.json');
    expect(fwd[1].join(' ')).not.toContain('REALSECRET');
    expect(fwd[1].join(' ')).not.toContain(EMU.secretAccessKey);
  });

  it('a sidecar failure is fatal: the workload is removed', async () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: args.includes('--pid') ? 'fwd\n' : 'workload-id\n' };
      if (args[0] === 'logs') return { stdout: `CDKL-FWD FAIL ${RESIGN} RESIGN_EADDRINUSE 192.168.65.254\n` };
      return { stdout: '' };
    });
    await expect(
      runDetached({
        ...baseRun,
        env: { ...realEnv, AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
      })
    ).rejects.toThrow(/re-signing sidecar could not start on 127\.0\.0\.1:47297.*already listens/);
    expect(execFileMock.mock.calls.some((c) => c[1][0] === 'rm' && c[1].includes('workload-id'))).toBe(true);
  });

  it('a workload without an exception still uses the sidecar, with the emulator keys only', async () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: args.includes('--pid') ? 'fwd\n' : 'workload-id\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD READY 192.168.65.254\n' };
      return { stdout: '' };
    });
    await runDetached({ ...baseRun, env: realEnv });
    const calls = execFileMock.mock.calls as [string, string[], { env?: NodeJS.ProcessEnv } | undefined][];
    const run = calls.find((c) => c[1][0] === 'run' && !c[1].includes('--pid'))!;
    expect(run[1]).toContain(`AWS_ENDPOINT_URL=https://127.0.0.1:${RESIGN}`);
    // The real identity is replaced by the emulator's keys.
    expect(run[2]?.env?.['AWS_ACCESS_KEY_ID']).toBe(EMU.accessKeyId);
    expect(run[2]?.env?.['AWS_SECRET_ACCESS_KEY']).toBe(EMU.secretAccessKey);
    expect(JSON.stringify(run)).not.toContain('REALSECRET');
    expect(calls.some((c) => c[1][0] === 'run' && c[1].includes('--pid'))).toBe(true);
  });

  it('ECS owner forwarder (startNamespaceOwnerForwarder): runs the sidecar too, and its failure is fatal', async () => {
    const owner = (ports: number[]) =>
      startNamespaceOwnerForwarder({
        name: 'cdkl-fam-app-abc-awsfwd',
        namespace: { network: 'cdkl-task-x' },
        ports,
        wiring: mixedWiring(),
        workloadLabel: 'container app',
      });
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD READY 192.168.65.254\n' };
      return {};
    });
    await expect(owner([9297, RESIGN])).resolves.toBe('fid');
    const run = execFileMock.mock.calls.map((c) => c[1] as string[]).find((a) => a[0] === 'run')!;
    expect(run).toContain('/tmp/resign-x/resign.json:/cdkl-forwarder/resign.json:ro');
    expect(run.slice(run.indexOf('-e') + 2)).toEqual([
      '9297',
      'health',
      '/cdkl-forwarder/ca.pem',
      '/cdkl-forwarder/resign.json',
    ]);
    execFileMock.mockReset();
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid\n' };
      if (args[0] === 'logs') return { stdout: `CDKL-FWD FAIL 0 RESIGN_CONFIG_ENOENT none\n` };
      return {};
    });
    await expect(owner([9297, RESIGN])).rejects.toThrow(/re-signing sidecar could not start/);
    // A literal emulator URL only (no sidecar): a failure stays a warning, as in forward mode.
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    execFileMock.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: 'fid\n' };
      if (args[0] === 'logs') return { stdout: 'CDKL-FWD FAIL 9297 ECONNREFUSED 172.17.0.1\n' };
      return {};
    });
    await expect(owner([9297])).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('refuses mixed mode on the host network (the sidecar cannot share the host loopback)', async () => {
    setActiveWorkloadAwsWiring(mixedWiring());
    await expect(
      runDetached({ ...baseRun, network: 'host', env: { ...realEnv, AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_S3: 'real-aws' } })
    ).rejects.toThrow(/cannot run on the host network/);
  });
});
