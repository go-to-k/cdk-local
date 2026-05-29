import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ContainerSpec } from '../../../src/local/container-pool.js';

// Site-level binding for issue #99: the container pool MUST forward a
// ContainerSpec's `sensitiveEnvKeys` (the SecureString-backed env keys) into
// `runDetached` so the docker layer keeps them off the argv. This is the
// sole link carrying start-api's spec.sensitiveEnvKeys to the docker runner;
// a regression that dropped the spread on either the zip or image branch
// would silently re-expose secrets. Mock the docker / RIE boundaries.

const { runDetachedMock, pickFreePortMock, removeContainerMock, waitForRieReadyMock } = vi.hoisted(
  () => ({
    runDetachedMock: vi.fn(),
    pickFreePortMock: vi.fn(),
    removeContainerMock: vi.fn(),
    waitForRieReadyMock: vi.fn(),
  })
);

vi.mock('../../../src/local/docker-runner.js', () => ({
  runDetached: runDetachedMock,
  pickFreePort: pickFreePortMock,
  removeContainer: removeContainerMock,
  streamLogs: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/local/rie-client.js', () => ({
  waitForRieReady: waitForRieReadyMock,
}));

vi.mock('../../../src/local/runtime-image.js', () => ({
  resolveRuntimeImage: vi.fn(() => 'public.ecr.aws/lambda/nodejs:20'),
  resolveRuntimeCodeMountPath: vi.fn(() => '/var/task'),
}));

const { createContainerPool } = await import('../../../src/local/container-pool.js');

function zipSpec(sensitiveEnvKeys?: ReadonlySet<string>): ContainerSpec {
  return {
    kind: 'zip',
    lambda: { logicalId: 'Fn', runtime: 'nodejs20.x', handler: 'index.handler' },
    codeDir: '/tmp/code',
    env: { API_KEY: 's3cr3t', TABLE: 't' },
    ...(sensitiveEnvKeys && { sensitiveEnvKeys }),
    containerHost: '127.0.0.1',
  } as unknown as ContainerSpec;
}

function imageSpec(sensitiveEnvKeys?: ReadonlySet<string>): ContainerSpec {
  return {
    kind: 'image',
    lambda: { logicalId: 'Fn', runtime: 'nodejs20.x', handler: 'index.handler' },
    image: 'local/img:tag',
    platform: 'linux/amd64',
    command: [],
    env: { API_KEY: 's3cr3t', TABLE: 't' },
    ...(sensitiveEnvKeys && { sensitiveEnvKeys }),
    containerHost: '127.0.0.1',
  } as unknown as ContainerSpec;
}

describe('container pool forwards spec.sensitiveEnvKeys to runDetached (issue #99)', () => {
  beforeEach(() => {
    runDetachedMock.mockReset();
    pickFreePortMock.mockReset();
    removeContainerMock.mockReset();
    waitForRieReadyMock.mockReset();
    pickFreePortMock.mockResolvedValue(9001);
    runDetachedMock.mockResolvedValue('container-id');
    waitForRieReadyMock.mockResolvedValue(undefined);
    removeContainerMock.mockResolvedValue(undefined);
  });

  it('forwards sensitiveEnvKeys on the ZIP branch', async () => {
    const keys = new Set(['API_KEY']);
    const pool = createContainerPool(new Map([['Fn', zipSpec(keys)]]), {
      perLambdaConcurrency: 1,
      streamLogs: false,
    });
    const handle = await pool.acquire('Fn');

    expect(runDetachedMock).toHaveBeenCalledTimes(1);
    expect(runDetachedMock.mock.calls[0]![0].sensitiveEnvKeys).toBe(keys);
    // Release before dispose so dispose() doesn't wait out its drain timeout.
    pool.release(handle);
    await pool.dispose();
  });

  it('forwards sensitiveEnvKeys on the IMAGE branch', async () => {
    const keys = new Set(['API_KEY']);
    const pool = createContainerPool(new Map([['Fn', imageSpec(keys)]]), {
      perLambdaConcurrency: 1,
      streamLogs: false,
    });
    const handle = await pool.acquire('Fn');

    expect(runDetachedMock).toHaveBeenCalledTimes(1);
    expect(runDetachedMock.mock.calls[0]![0].sensitiveEnvKeys).toBe(keys);
    pool.release(handle);
    await pool.dispose();
  });

  it('omits sensitiveEnvKeys when the spec has none (default behavior)', async () => {
    const pool = createContainerPool(new Map([['Fn', zipSpec()]]), {
      perLambdaConcurrency: 1,
      streamLogs: false,
    });
    const handle = await pool.acquire('Fn');

    expect(runDetachedMock).toHaveBeenCalledTimes(1);
    expect(runDetachedMock.mock.calls[0]![0].sensitiveEnvKeys).toBeUndefined();
    pool.release(handle);
    await pool.dispose();
  });
});
