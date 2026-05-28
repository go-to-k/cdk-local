import { describe, it, expect } from 'vite-plus/test';
import { buildDockerRunArgs, parseHostPortOverrides } from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

describe('parseHostPortOverrides', () => {
  it('parses <containerPort>=<hostPort> pairs into a map', () => {
    expect(parseHostPortOverrides(['80=8080'])).toEqual({ 80: 8080 });
    expect(parseHostPortOverrides(['80=8080', '443=8443'])).toEqual({ 80: 8080, 443: 8443 });
  });

  it('returns an empty map for undefined / empty input', () => {
    expect(parseHostPortOverrides(undefined)).toEqual({});
    expect(parseHostPortOverrides([])).toEqual({});
  });

  it('throws on a malformed value', () => {
    expect(() => parseHostPortOverrides(['8080'])).toThrow(/Expected <containerPort>=<hostPort>/);
    expect(() => parseHostPortOverrides(['80:8080'])).toThrow(/Expected <containerPort>=<hostPort>/);
    expect(() => parseHostPortOverrides(['abc=8080'])).toThrow(/Expected <containerPort>=<hostPort>/);
  });

  it('throws on an out-of-range port', () => {
    expect(() => parseHostPortOverrides(['80=0'])).toThrow(/host port must be 1-65535/);
    expect(() => parseHostPortOverrides(['70000=8080'])).toThrow(/container port must be 1-65535/);
  });
});

function containerWithPort(): ResolvedEcsContainer {
  return {
    name: 'app',
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment: {},
    secrets: [],
    portMappings: [{ containerPort: 80, protocol: 'tcp' }],
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: [],
  } as unknown as ResolvedEcsContainer;
}

const task = { family: 'fam' } as unknown as ResolvedEcsTask;

function publishArg(hostPortOverrides?: Record<number, number>): string | undefined {
  const { args } = buildDockerRunArgs({
    task,
    container: containerWithPort(),
    image: 'public.ecr.aws/docker/library/busybox:latest',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: undefined,
    ...(hostPortOverrides && { hostPortOverrides }),
  });
  const i = args.indexOf('-p');
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildDockerRunArgs host-port publishing', () => {
  it('publishes container port on the SAME host port by default (no silent remap)', () => {
    expect(publishArg()).toBe('127.0.0.1:80:80/tcp');
  });

  it('honors a --host-port override for the matching container port', () => {
    expect(publishArg({ 80: 8080 })).toBe('127.0.0.1:8080:80/tcp');
  });

  it('ignores an override for a different container port', () => {
    expect(publishArg({ 443: 8443 })).toBe('127.0.0.1:80:80/tcp');
  });
});
