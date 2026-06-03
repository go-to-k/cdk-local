import { describe, it, expect } from 'vite-plus/test';
import {
  buildDockerRunArgs,
  resolvePrivilegedHostPortRemaps,
} from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// buildDockerRunArgs / resolvePrivilegedHostPortRemaps read only a bounded
// subset of the container/task shapes, so a cast partial keeps fixtures small.
function container(
  name: string,
  portMappings: Array<{ containerPort: number; hostPort?: number; protocol: string }>
): ResolvedEcsContainer {
  return {
    name,
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment: {},
    sensitiveEnvKeys: [],
    secrets: [],
    portMappings,
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: [],
  } as unknown as ResolvedEcsContainer;
}

const taskWith = (containers: ResolvedEcsContainer[]): ResolvedEcsTask =>
  ({ family: 'fam', containers }) as unknown as ResolvedEcsTask;

/** A deterministic free-port allocator: hands out 50000, 50001, ... */
function fakeAllocator(): () => Promise<number> {
  let next = 50000;
  return () => Promise.resolve(next++);
}

describe('resolvePrivilegedHostPortRemaps (issue #357)', () => {
  it('remaps a privileged declared host port the user did not pin', async () => {
    const remaps = await resolvePrivilegedHostPortRemaps({
      task: taskWith([container('web', [{ containerPort: 80, protocol: 'tcp' }])]),
      userOverrides: undefined,
      ephemeralPorts: new Set(),
      allocate: fakeAllocator(),
    });
    expect(remaps).toEqual({ 80: 50000 });
  });

  it('uses the DECLARED host port (hostPort ?? containerPort) for the privileged check', async () => {
    // containerPort is high (8080) but the declared hostPort is privileged (80).
    const remaps = await resolvePrivilegedHostPortRemaps({
      task: taskWith([container('web', [{ containerPort: 8080, hostPort: 80, protocol: 'tcp' }])]),
      userOverrides: undefined,
      ephemeralPorts: new Set(),
      allocate: fakeAllocator(),
    });
    expect(remaps).toEqual({ 8080: 50000 });
  });

  it('does NOT remap a non-privileged port', async () => {
    const remaps = await resolvePrivilegedHostPortRemaps({
      task: taskWith([container('web', [{ containerPort: 8080, protocol: 'tcp' }])]),
      userOverrides: undefined,
      ephemeralPorts: new Set(),
      allocate: fakeAllocator(),
    });
    expect(remaps).toEqual({});
  });

  it('does NOT remap a port the user pinned via --host-port', async () => {
    const remaps = await resolvePrivilegedHostPortRemaps({
      task: taskWith([container('web', [{ containerPort: 80, protocol: 'tcp' }])]),
      userOverrides: { 80: 8080 },
      ephemeralPorts: new Set(),
      allocate: fakeAllocator(),
    });
    expect(remaps).toEqual({});
  });

  it('does NOT remap an ephemeral front-door port', async () => {
    const remaps = await resolvePrivilegedHostPortRemaps({
      task: taskWith([container('web', [{ containerPort: 80, protocol: 'tcp' }])]),
      userOverrides: undefined,
      ephemeralPorts: new Set([80]),
      allocate: fakeAllocator(),
    });
    expect(remaps).toEqual({});
  });

  it('remaps each distinct privileged container port across containers', async () => {
    const remaps = await resolvePrivilegedHostPortRemaps({
      task: taskWith([
        container('web', [{ containerPort: 80, protocol: 'tcp' }]),
        container('admin', [{ containerPort: 443, protocol: 'tcp' }]),
      ]),
      userOverrides: undefined,
      ephemeralPorts: new Set(),
      allocate: fakeAllocator(),
    });
    expect(remaps).toEqual({ 80: 50000, 443: 50001 });
  });
});

describe('buildDockerRunArgs privileged-port auto-remap publish (issue #357)', () => {
  it('publishes the remapped host port for an auto-remapped container port', () => {
    const { args, publishedEndpoints } = buildDockerRunArgs({
      task: taskWith([]),
      container: container('web', [{ containerPort: 80, protocol: 'tcp' }]),
      image: 'public.ecr.aws/docker/library/busybox:latest',
      network: 'net',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
      hostPortOverrides: { 80: 50000 },
      autoRemappedContainerPorts: new Set([80]),
    });

    // The publish binds the remapped HIGH host port, never the privileged 80.
    const i = args.indexOf('-p');
    expect(i).toBeGreaterThan(-1);
    expect(args).toContain('127.0.0.1:50000:80/tcp');
    expect(args.some((a) => a === '127.0.0.1:80:80/tcp')).toBe(false);

    const ep = publishedEndpoints.find((e) => e.containerPort === 80);
    expect(ep?.hostPort).toBe(50000);
    expect(ep?.overridden).toBe(true);
  });
});
