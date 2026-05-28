import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

const { sweepOrphanedSvcNetworks, createSharedSvcNetwork } = await import(
  '../../../src/local/ecs-network.js'
);

/** Classify a captured execFile call by its docker sub-command shape. */
function kindOf(args: string[] | undefined): string {
  if (!args) return '<no-args>';
  if (args[0] === 'network' && args[1] === 'ls') return 'network-ls';
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
