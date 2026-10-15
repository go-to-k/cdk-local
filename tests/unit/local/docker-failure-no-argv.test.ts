import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdk-local#794: a docker CLI failure with an EMPTY stderr must not
// fall back to execFile's `err.message`, which carries the whole argv — here
// a `--opt o=...,password=...` volume option and the sidecar's `-e` values.
const { calls, failOn } = vi.hoisted(() => ({
  calls: [] as string[][],
  failOn: { verb: '' as string },
}));

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    optsOrCb: unknown,
    maybeCb?: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    calls.push(args);
    if (failOn.verb !== '' && args.join(' ').startsWith(failOn.verb)) {
      cb(
        Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
          code: 125,
          stderr: '',
        })
      );
      return;
    }
    cb(null, { stdout: 'id\n', stderr: '' });
  },
  spawn: vi.fn(),
}));

const { realizeDockerVolumes } = await import('../../../src/local/ecs-task-runner.js');
const { createTaskNetwork } = await import('../../../src/local/ecs-network.js');

const SECRET = 'nfs-password-SENTINEL';

afterEach(() => {
  calls.length = 0;
  failOn.verb = '';
});

describe('docker failures with an empty stderr carry no argv', () => {
  it('docker volume create', async () => {
    failOn.verb = 'volume create';
    const state = { network: undefined, dockerVolumeNames: [], startedContainers: [], logStoppers: [] };
    const err = await realizeDockerVolumes(
      [
        {
          name: 'data',
          kind: 'docker',
          dockerVolumeConfig: { driver: 'local', driverOpts: { o: `addr=10.0.0.1,password=${SECRET}` } },
        } as never,
      ],
      state as never
    ).catch((e: unknown) => e);
    // Premise: the option really was on the argv.
    expect(calls.some((a) => a.join(' ').includes(SECRET))).toBe(true);
    expect((err as Error).message).toContain("docker volume create failed for 'data': exited with code 125");
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('the metadata-endpoints sidecar docker run', async () => {
    failOn.verb = 'run';
    const err = await createTaskNetwork({
      skipPull: true,
      credentials: { accessKeyId: 'AKIA', secretAccessKey: SECRET, sessionToken: 'tok' },
    } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Failed to start metadata-endpoints sidecar: exited with code 125');
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).not.toContain('Command failed');
  });
});
