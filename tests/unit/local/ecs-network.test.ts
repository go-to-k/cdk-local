import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Mock the docker boundary (node:child_process execFile) so we can assert
// the sweep's `docker network ls` / `inspect` / `rm` choreography without
// real Docker. `promisify(execFile)` calls execFile(cmd, args, options, cb);
// we route through a single mock and return canned stdout per argv shape.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  // promisify(execFile) appends a callback as the LAST argument; callers in
  // ecs-network.ts use both the 2-arg (cmd, args) and 3-arg (cmd, args,
  // options) forms, so resolve the callback positionally rather than by a
  // fixed arity.
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const cmd = rest[0] as string;
    const args = rest[1] as string[];
    const options = rest.length > 3 ? rest[2] : undefined;
    try {
      const stdout = execFileMock(cmd, args, options) as string;
      cb(null, { stdout: stdout ?? '', stderr: '' });
    } catch (err) {
      cb(err as Error, { stdout: '', stderr: '' });
    }
  },
  spawn: vi.fn(),
}));

const {
  sweepOrphanedSvcNetworks,
  createSharedSvcNetwork,
  createTaskNetwork,
  buildMetadataEnv,
  fallbackSubnetOctets,
  isSubnetTakenError,
} = await import('../../../src/local/ecs-network.js');
const { hostname } = await import('node:os');
const { resetFinchArgvWarningsForTest } = await import('../../../src/utils/docker-cmd.js');
const { getLogger } = await import('../../../src/utils/logger.js');

/** Classify a captured execFile call by its docker sub-command shape. */
function kindOf(args: string[] | undefined): string {
  if (!args) return '<no-args>';
  if (args[0] === 'network' && args[1] === 'ls') return 'network-ls';
  if (args[0] === 'network' && args[1] === 'inspect' && String(args[4]).includes('.Labels'))
    return `network-inspect-labels:${args[2]}`;
  if (args[0] === 'network' && args[1] === 'inspect') return `network-inspect:${args[2]}`;
  if (args[0] === 'network' && args[1] === 'rm') return `network-rm:${args[2]}`;
  if (args[0] === 'network' && args[1] === 'create') return `network-create:${args[args.length - 1]}`;
  if (args[0] === 'rm') return `container-rm:${args[2]}`;
  if (args[0] === 'run') return 'sidecar-run';
  if (args[0] === 'pull') return 'pull';
  return args.join(' ');
}

describe('sweepOrphanedSvcNetworks', () => {
  beforeEach(() => execFileMock.mockReset());

  it('removes a <prefix>-svc-x whose only attached container is its own metadata sidecar', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-x\n';
      if (kind === 'network-inspect:cdkl-svc-x') return 'cdkl-svc-x-metadata \n';
      return '';
    });

    const swept = await sweepOrphanedSvcNetworks('cdkl');

    expect(swept).toEqual(['cdkl-svc-x']);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    // Sidecar force-removed by name, then the network removed.
    expect(kinds).toContain('container-rm:cdkl-svc-x-metadata');
    expect(kinds).toContain('network-rm:cdkl-svc-x');
  });

  it('treats a network with zero attached containers as orphaned', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-empty\n';
      if (kind === 'network-inspect:cdkl-svc-empty') return '\n';
      return '';
    });

    const swept = await sweepOrphanedSvcNetworks('cdkl');

    expect(swept).toEqual(['cdkl-svc-empty']);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    // The sidecar is force-removed unconditionally (by name) even when nothing
    // is attached — `docker rm -f` tolerates a not-found container.
    expect(kinds).toContain('container-rm:cdkl-svc-empty-metadata');
    expect(kinds).toContain('network-rm:cdkl-svc-empty');
  });

  it('LEAVES a <prefix>-svc-y that has a replica container attached', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-y\n';
      // metadata sidecar + a live user replica → live concurrent run.
      if (kind === 'network-inspect:cdkl-svc-y') return 'cdkl-svc-y-metadata my-app-r0 \n';
      return '';
    });

    const swept = await sweepOrphanedSvcNetworks('cdkl');

    expect(swept).toEqual([]);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    expect(kinds).not.toContain('network-rm:cdkl-svc-y');
    expect(kinds).not.toContain('container-rm:cdkl-svc-y-metadata');
  });

  it('sweeps only the orphan when both an orphan and a live network exist', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-orphan\ncdkl-svc-live\n';
      if (kind === 'network-inspect:cdkl-svc-orphan') return 'cdkl-svc-orphan-metadata \n';
      if (kind === 'network-inspect:cdkl-svc-live') return 'cdkl-svc-live-metadata app-r0 \n';
      return '';
    });

    const swept = await sweepOrphanedSvcNetworks('cdkl');

    expect(swept).toEqual(['cdkl-svc-orphan']);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    expect(kinds).toContain('network-rm:cdkl-svc-orphan');
    expect(kinds).not.toContain('network-rm:cdkl-svc-live');
  });

  it('sweeps every orphan when several leaked networks are present', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-a\ncdkl-svc-b\ncdkl-svc-c\n';
      if (kind === 'network-inspect:cdkl-svc-a') return 'cdkl-svc-a-metadata \n';
      if (kind === 'network-inspect:cdkl-svc-b') return '\n';
      if (kind === 'network-inspect:cdkl-svc-c') return 'cdkl-svc-c-metadata \n';
      return '';
    });

    const swept = await sweepOrphanedSvcNetworks('cdkl');

    expect(swept).toEqual(['cdkl-svc-a', 'cdkl-svc-b', 'cdkl-svc-c']);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    expect(kinds).toContain('network-rm:cdkl-svc-a');
    expect(kinds).toContain('network-rm:cdkl-svc-b');
    expect(kinds).toContain('network-rm:cdkl-svc-c');
  });

  it('tolerates zero matching networks (no removal calls, returns empty)', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (kindOf(args) === 'network-ls') return '\n';
      return '';
    });

    const swept = await sweepOrphanedSvcNetworks('cdkl');

    expect(swept).toEqual([]);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    expect(kinds).toEqual(['network-ls']);
  });

  it('does not throw when docker network ls fails (logs + returns empty)', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      if (kindOf(args) === 'network-ls') throw new Error('Cannot connect to the Docker daemon');
      return '';
    });

    await expect(sweepOrphanedSvcNetworks('cdkl')).resolves.toEqual([]);
  });

  it('does not throw when docker network inspect fails — skips that network', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-z\n';
      if (kind === 'network-inspect:cdkl-svc-z') throw new Error('No such network: cdkl-svc-z');
      return '';
    });

    const swept = await sweepOrphanedSvcNetworks('cdkl');

    expect(swept).toEqual([]);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    expect(kinds).not.toContain('network-rm:cdkl-svc-z');
  });
});

describe('createSharedSvcNetwork sweep ordering', () => {
  beforeEach(() => execFileMock.mockReset());

  it('runs the orphan sweep BEFORE issuing docker network create', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return ''; // no orphans to sweep
      if (kind === 'sidecar-run') return 'sidecar-container-id\n';
      return '';
    });

    // skipPull avoids the docker-pull spawn path; we only care about ordering.
    const net = await createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true });

    expect(net.networkName).toMatch(/^cdkl-svc-[0-9a-f]{8}$/);
    expect(net.ownedByCaller).toBe(true);

    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    const lsIdx = kinds.indexOf('network-ls');
    const createIdx = kinds.findIndex((k) => k.startsWith('network-create:'));
    expect(lsIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(lsIdx).toBeLessThan(createIdx);
  });

  it('reclaims a leaked orphan, then creates the new shared network', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-leaked\n';
      if (kind === 'network-inspect:cdkl-svc-leaked') return 'cdkl-svc-leaked-metadata \n';
      if (kind === 'sidecar-run') return 'sidecar-container-id\n';
      return '';
    });

    await createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true });

    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    const rmIdx = kinds.indexOf('network-rm:cdkl-svc-leaked');
    const createIdx = kinds.findIndex((k) => k.startsWith('network-create:'));
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    // Leaked network reclaimed before the fixed-subnet create.
    expect(rmIdx).toBeLessThan(createIdx);
  });
});

// Issue #749: under finch on macOS / Windows the sidecar's value-less
// credential flags reach the limactl argv as `-e KEY=<value>`. The sidecar is
// still started (credentials are warned about, not refused).
describe('createTaskNetwork under finch on macOS (issue #749)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let savedDocker: string | undefined;

  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      kindOf(args) === 'sidecar-run' ? 'sidecar-container-id\n' : ''
    );
    savedDocker = process.env['CDK_DOCKER'];
    resetFinchArgvWarningsForTest();
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedDocker;
    vi.restoreAllMocks();
  });

  const credentials = {
    accessKeyId: 'AKIAFAKEKEYID',
    secretAccessKey: 'super-secret-value-xyz',
    sessionToken: 'session-token-abc',
  };

  it('starts the sidecar and warns naming the credential keys, not their values', async () => {
    process.env['CDK_DOCKER'] = 'finch';
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    await createTaskNetwork({ prefix: 'cdkl', credentials, skipPull: true });
    expect(execFileMock.mock.calls.some((c) => kindOf(c[1] as string[]) === 'sidecar-run')).toBe(
      true
    );
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('CDK_DOCKER=finch on macOS / Windows puts the values of');
    expect(msg).toContain('AWS_SECRET_ACCESS_KEY');
    expect(msg).not.toContain('CLUSTER');
    for (const v of Object.values(credentials)) expect(msg).not.toContain(v);
  });

  it('does not warn under docker', async () => {
    process.env['CDK_DOCKER'] = 'docker';
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    await createTaskNetwork({ prefix: 'cdkl', credentials, skipPull: true });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('CDK_DOCKER=finch');
  });
});

// Issue #849: two `start-alb` / `start-service` processes started at once each
// created their shared network on 169.254.171.0/24, so the second died with
// "Pool overlaps with other one on this address space".
const POOL_OVERLAPS =
  'Error response from daemon: invalid pool request: Pool overlaps with other one on this address space';

/** Error shaped like a failed `execFile` (stderr carried on the error). */
function dockerError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: docker\n${stderr}`), { stderr });
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * A stateful fake daemon: `network create --subnet` claims the subnet
 * atomically (as the real daemon does) and fails with Pool overlaps when it
 * is already held — so concurrent creates race exactly like two processes.
 */
function installFakeDaemon(taken: Set<string>): void {
  execFileMock.mockImplementation((_cmd: string, args: string[]) => {
    const kind = kindOf(args);
    if (kind === 'network-ls') return '';
    if (kind.startsWith('network-create:')) {
      const subnet = flagValue(args, '--subnet')!;
      if (taken.has(subnet)) throw dockerError(POOL_OVERLAPS);
      taken.add(subnet);
      return 'net-id\n';
    }
    if (kind === 'sidecar-run') return `sidecar-${flagValue(args, '--ip')}\n`;
    return '';
  });
}

function createdSubnets(): string[] {
  return execFileMock.mock.calls
    .map((c) => c[1] as string[])
    .filter((a) => kindOf(a).startsWith('network-create:'))
    .map((a) => flagValue(a, '--subnet')!);
}

describe('createSharedSvcNetwork subnet selection (issue #849)', () => {
  beforeEach(() => execFileMock.mockReset());

  it('takes the preferred 169.254.171.0/24 when it is free', async () => {
    installFakeDaemon(new Set());
    const net = await createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true });
    expect(createdSubnets()).toEqual(['169.254.171.0/24']);
    expect(net.sidecarIp).toBe('169.254.171.2');
  });

  it('walks to the next free /24 when another run holds 171, and the sidecar IP follows', async () => {
    installFakeDaemon(new Set(['169.254.171.0/24']));
    const net = await createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true });

    expect(createdSubnets()).toEqual(['169.254.171.0/24', '169.254.172.0/24']);
    expect(net.sidecarIp).toBe('169.254.172.2');
    const sidecar = execFileMock.mock.calls
      .map((c) => c[1] as string[])
      .find((a) => kindOf(a) === 'sidecar-run')!;
    expect(flagValue(sidecar, '--ip')).toBe('169.254.172.2');
    expect(flagValue(sidecar, '--network')).toBe(net.networkName);
    // Everything a container derives from the network follows the /24 won.
    expect(
      buildMetadataEnv({ containerName: 'web', sidecarIp: net.sidecarIp })[
        'ECS_CONTAINER_METADATA_URI_V4'
      ]
    ).toBe('http://169.254.172.2/v4/web');
  });

  it('gives two concurrently started runs non-overlapping subnets', async () => {
    const taken = new Set<string>();
    installFakeDaemon(taken);
    const [a, b] = await Promise.all([
      createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true }),
      createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true }),
    ]);
    expect(new Set([a.sidecarIp, b.sidecarIp])).toEqual(
      new Set(['169.254.171.2', '169.254.172.2'])
    );
    expect(a.networkName).not.toBe(b.networkName);
    expect(taken).toEqual(new Set(['169.254.171.0/24', '169.254.172.0/24']));
  });

  it('stamps the owner PID and host labels on the network', async () => {
    installFakeDaemon(new Set());
    await createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true });
    const create = execFileMock.mock.calls
      .map((c) => c[1] as string[])
      .find((a) => kindOf(a).startsWith('network-create:'))!;
    expect(create).toContain(`cdk-local.owner-pid=${process.pid}`);
    expect(create).toContain(`cdk-local.owner-host=${hostname()}`);
  });

  it('does not retry a failure that is not a taken subnet', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind.startsWith('network-create:')) throw dockerError('Cannot connect to the Docker daemon');
      return '';
    });
    await expect(createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true })).rejects.toThrow(
      /docker network create failed: .*Cannot connect to the Docker daemon/
    );
    expect(createdSubnets()).toEqual(['169.254.171.0/24']);
  });

  it('fails with a hint once every candidate /24 is taken', async () => {
    const all = new Set(fallbackSubnetOctets(171).map((o) => `169.254.${o}.0/24`));
    installFakeDaemon(all);
    await expect(createSharedSvcNetwork({ prefix: 'cdkl', skipPull: true })).rejects.toThrow(
      /Pool overlaps.*every candidate link-local \/24 subnet is taken/
    );
    expect(createdSubnets()).toHaveLength(all.size);
  });
});

describe('createTaskNetwork subnet selection (issue #849)', () => {
  beforeEach(() => execFileMock.mockReset());

  it('keeps run-task pinned to 169.254.170.0/24 (no fallback)', async () => {
    installFakeDaemon(new Set(['169.254.170.0/24']));
    await expect(createTaskNetwork({ prefix: 'cdkl', skipPull: true })).rejects.toThrow(
      /Pool overlaps.*may already own subnet 169\.254\.170\.0\/24/
    );
    expect(createdSubnets()).toEqual(['169.254.170.0/24']);
  });

  it('treats an explicit octet as a preference and walks on when it is taken', async () => {
    installFakeDaemon(new Set(['169.254.173.0/24']));
    const net = await createTaskNetwork({ prefix: 'cdkl', skipPull: true, subnetOctet: 173 });
    expect(createdSubnets()).toEqual(['169.254.173.0/24', '169.254.171.0/24']);
    expect(net.sidecarIp).toBe('169.254.171.2');
  });
});

describe('fallbackSubnetOctets / isSubnetTakenError', () => {
  it('puts the preferred octet first and never offers 0, 169, 170 or 255 otherwise', () => {
    const list = fallbackSubnetOctets(171);
    expect(list[0]).toBe(171);
    expect(new Set(list).size).toBe(list.length);
    for (const bad of [0, 169, 170, 255]) expect(list).not.toContain(bad);
    expect(list).toHaveLength(84 + 168);
    expect(fallbackSubnetOctets(170)[0]).toBe(170);
  });

  it('recognises docker and podman taken-subnet messages only', () => {
    expect(isSubnetTakenError(POOL_OVERLAPS)).toBe(true);
    expect(
      isSubnetTakenError('subnet 169.254.171.0/24 is already used on the host or by another config')
    ).toBe(true);
    expect(isSubnetTakenError('Cannot connect to the Docker daemon')).toBe(false);
    expect(isSubnetTakenError('network with name cdkl-svc-1 already exists')).toBe(false);
  });
});

describe('sweepOrphanedSvcNetworks owner labels (issue #849)', () => {
  beforeEach(() => execFileMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  function sidecarOnly(labels: string): void {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-peer\n';
      if (kind === 'network-inspect:cdkl-svc-peer') return 'cdkl-svc-peer-metadata \n';
      if (kind === 'network-inspect-labels:cdkl-svc-peer') return `${labels}\n`;
      return '';
    });
  }

  it('LEAVES a sidecar-only network whose owner process is alive on this host', async () => {
    sidecarOnly(`${process.pid} ${hostname()}`);
    expect(await sweepOrphanedSvcNetworks('cdkl')).toEqual([]);
    const kinds = execFileMock.mock.calls.map((c) => kindOf(c[1] as string[]));
    expect(kinds).not.toContain('network-rm:cdkl-svc-peer');
    expect(kinds).not.toContain('container-rm:cdkl-svc-peer-metadata');
  });

  it('LEAVES a sidecar-only network created on another host', async () => {
    sidecarOnly(`12345 some-other-host-${hostname()}`);
    expect(await sweepOrphanedSvcNetworks('cdkl')).toEqual([]);
  });

  it('reclaims a sidecar-only network whose owner process is gone', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    sidecarOnly(`424242 ${hostname()}`);
    expect(await sweepOrphanedSvcNetworks('cdkl')).toEqual(['cdkl-svc-peer']);
  });

  it('LEAVES the network when the owner exists under another user (EPERM)', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    sidecarOnly(`424242 ${hostname()}`);
    expect(await sweepOrphanedSvcNetworks('cdkl')).toEqual([]);
  });

  it('skips the network when the label inspect fails', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const kind = kindOf(args);
      if (kind === 'network-ls') return 'cdkl-svc-peer\n';
      if (kind === 'network-inspect:cdkl-svc-peer') return 'cdkl-svc-peer-metadata \n';
      if (kind === 'network-inspect-labels:cdkl-svc-peer') throw dockerError('No such network');
      return '';
    });
    expect(await sweepOrphanedSvcNetworks('cdkl')).toEqual([]);
  });
});
