import { describe, expect, it } from 'vite-plus/test';
import {
  LOOPBACK_FORWARDER_IMAGE,
  buildLoopbackForwarderDockerArgs,
  buildNamespaceOwnerForwarderDockerArgs,
  describeForwarderFailure,
  parseForwarderStatus,
} from '../../../src/local/loopback-forwarder.js';

describe('buildLoopbackForwarderDockerArgs', () => {
  it("joins the workload's network AND pid namespaces and mounts the CA read-only", () => {
    const args = buildLoopbackForwarderDockerArgs({
      workloadContainer: 'abc123',
      ports: [9297, 9400],
      probe: 'health',
      caHostPath: '/tmp/x/ca-bundle.pem',
      name: 'cdkl-awsfwd-1-aa',
    });
    expect(args.slice(0, 10)).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'cdkl-awsfwd-1-aa',
      '--network',
      'container:abc123',
      '--pid',
      'container:abc123',
      '-v',
    ]);
    expect(args[10]).toBe('/tmp/x/ca-bundle.pem:/cdkl-forwarder/ca.pem:ro');
    const img = args.indexOf(LOOPBACK_FORWARDER_IMAGE);
    expect(img).toBeGreaterThan(0);
    expect(LOOPBACK_FORWARDER_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(args.slice(img + 1, img + 2)).toEqual(['-e']);
    expect(args.slice(img + 3)).toEqual(['9297,9400', 'health', '/cdkl-forwarder/ca.pem']);
    // Never `-p` (docker refuses it with `--network container:`), never `-e KEY=`.
    expect(args).not.toContain('-p');
  });

  it('falls back to a TCP probe without a CA', () => {
    const args = buildLoopbackForwarderDockerArgs({
      workloadContainer: 'w',
      ports: [4566],
      probe: 'health',
      name: 'n',
    });
    expect(args.slice(-2)).toEqual(['4566', 'tcp']);
    expect(args).not.toContain('-v');
  });
});

describe('parseForwarderStatus', () => {
  it('parses READY and FAIL lines among other output', () => {
    expect(parseForwarderStatus('noise\nCDKL-FWD READY 192.168.65.254\n')).toEqual({
      ok: true,
      upstream: '192.168.65.254',
    });
    expect(parseForwarderStatus('CDKL-FWD FAIL 9297 ECONNREFUSED 172.17.0.1')).toEqual({
      ok: false,
      failedPort: 9297,
      reason: 'ECONNREFUSED',
      upstream: '172.17.0.1',
    });
    expect(parseForwarderStatus('CDKL-FWD FAIL 9297 NO_UPSTREAM none')).toEqual({
      ok: false,
      failedPort: 9297,
      reason: 'NO_UPSTREAM',
    });
    expect(parseForwarderStatus('starting...')).toBeUndefined();
  });
});

describe('describeForwarderFailure', () => {
  it('names the reachability fix for a refused connection', () => {
    const msg = describeForwarderFailure(
      { name: 'n', ok: false, failedPort: 9297, reason: 'ECONNREFUSED', upstream: '172.17.0.1' },
      '--aws-emulator https://127.0.0.1:9297'
    );
    expect(msg).toContain('cannot reach port 9297 on the host via 172.17.0.1:9297 (ECONNREFUSED)');
    expect(msg).toContain('-p 127.0.0.1:9297:9297');
    expect(msg).toContain('-p 127.0.0.1:9297:9297 -p 172.17.0.1:9297:9297');
    expect(msg).toContain('Do not bind 0.0.0.0');
    // Docker Desktop's host.docker.internal address is not offered as a Linux gateway.
    expect(
      describeForwarderFailure(
        { name: 'n', ok: false, failedPort: 9297, reason: 'ECONNREFUSED', upstream: '192.168.65.254' },
        'X'
      )
    ).toContain('-p <docker bridge gateway, e.g. 172.17.0.1>:9297:9297');
  });

  it('distinguishes a health / certificate failure and a port clash', () => {
    expect(
      describeForwarderFailure({ name: 'n', ok: false, failedPort: 9297, reason: 'HTTP_503' }, 'X')
    ).toMatch(/health check failed \(HTTP_503\)/);
    expect(
      describeForwarderFailure(
        { name: 'n', ok: false, failedPort: 9297, reason: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
        'X'
      )
    ).toMatch(/health check failed/);
    expect(
      describeForwarderFailure({ name: 'n', ok: false, failedPort: 8080, reason: 'LISTEN_EADDRINUSE' }, 'X')
    ).toMatch(/already uses port 8080/);
  });
});

describe('buildNamespaceOwnerForwarderDockerArgs', () => {
  it('owns the namespace on the task network with the workload network identity, no pid join', () => {
    const args = buildNamespaceOwnerForwarderDockerArgs({
      name: 'fwd',
      namespace: {
        network: 'task-net',
        networkAliases: ['app', 'app.local'],
        publish: ['127.0.0.1:8080:80/tcp'],
        addHosts: ['host.docker.internal:192.168.65.254'],
        links: ['db:database'],
      },
      ports: [9297, 4566],
      probe: 'health',
      caHostPath: '/tmp/ca.pem',
      skipPull: true,
    });
    const image = args.indexOf(LOOPBACK_FORWARDER_IMAGE);
    expect(args.slice(0, image)).toEqual([
      'run', '-d', '--rm', '--name', 'fwd', '--network', 'task-net',
      '--network-alias', 'app', '--network-alias', 'app.local',
      '-p', '127.0.0.1:8080:80/tcp',
      '--add-host', 'host.docker.internal:192.168.65.254',
      '--link', 'db:database',
      '--pull', 'never',
      '-v', '/tmp/ca.pem:/cdkl-forwarder/ca.pem:ro',
      '--entrypoint', 'node',
    ]);
    expect(args).not.toContain('--pid');
    expect(args.slice(image + 3)).toEqual(['9297,4566', 'health', '/cdkl-forwarder/ca.pem']);
  });

  it('carries only the network for a bare namespace, with a TCP probe', () => {
    const args = buildNamespaceOwnerForwarderDockerArgs({
      name: 'fwd',
      namespace: { network: 'n' },
      ports: [9297],
      probe: 'health',
    });
    const image = args.indexOf(LOOPBACK_FORWARDER_IMAGE);
    expect(args.slice(0, image)).toEqual([
      'run', '-d', '--rm', '--name', 'fwd', '--network', 'n', '--entrypoint', 'node',
    ]);
    expect(args.slice(image + 3)).toEqual(['9297', 'tcp']);
  });
});
