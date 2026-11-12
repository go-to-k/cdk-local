import { afterEach, describe, expect, it } from 'vite-plus/test';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';
import {
  resetWorkloadAwsWiringForTest,
  setActiveWorkloadAwsWiring,
  type WorkloadAwsWiring,
} from '../../../src/local/workload-aws-wiring.js';

function container(environment: Record<string, string>): ResolvedEcsContainer {
  return {
    name: 'app',
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment,
    sensitiveEnvKeys: [],
    secrets: [],
    portMappings: [],
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: [],
  } as unknown as ResolvedEcsContainer;
}

function build(environment: Record<string, string>) {
  return buildDockerRunArgs({
    task: { family: 'fam' } as unknown as ResolvedEcsTask,
    container: container(environment),
    image: 'busybox',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: 'us-east-1',
    profileCredentialsFile: {
      hostPath: '/tmp/p/credentials',
      containerPath: '/cdk-local-aws/credentials',
      profileName: 'prod',
      dispose: async () => undefined,
    },
  });
}

const base: WorkloadAwsWiring = {
  mode: 'forward',
  env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_CA_BUNDLE: '/cdk-local-aws/ca-bundle.pem' },
  scrubEnvKeys: [],
  mounts: [{ hostPath: '/tmp/ca/ca-bundle.pem', containerPath: '/cdk-local-aws/ca-bundle.pem' }],
  loopbackPorts: [9297],
  probeHealth: false,
  dispose: () => undefined,
};

afterEach(() => resetWorkloadAwsWiringForTest());

describe('buildDockerRunArgs with the AWS wiring', () => {
  it('forward: adds the CA mount and endpoint below the task-declared env', () => {
    setActiveWorkloadAwsWiring(base);
    const { args, loopbackPorts } = build({ AWS_ENDPOINT_URL: 'http://task-declared:1' });
    // The task replaced the forwarded loopback endpoint: no forwarder needed.
    expect(loopbackPorts).toEqual([]);
    expect(args).toContain('/tmp/ca/ca-bundle.pem:/cdk-local-aws/ca-bundle.pem:ro');
    expect(args).toContain('/tmp/p/credentials:/cdk-local-aws/credentials:ro');
    expect(args).toContain('AWS_ENDPOINT_URL=http://task-declared:1');
    expect(args).toContain('AWS_CA_BUNDLE=/cdk-local-aws/ca-bundle.pem');
    expect(args).toContain('AWS_DEFAULT_REGION=us-east-1');
  });

  it('emulator: forces the endpoint, scrubs the profile, drops the profile mount, keeps keys off argv', () => {
    setActiveWorkloadAwsWiring({
      ...base,
      mode: 'emulator',
      scrubEnvKeys: ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE'],
      emulatorCredentials: { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'EMUSECRET' },
    });
    const { args, sensitiveEnv, loopbackPorts } = build({
      AWS_ENDPOINT_URL: 'https://real.example.com',
      AWS_PROFILE: 'task-declared',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/x',
    });
    expect(loopbackPorts).toEqual([9297]);
    expect(args.some((a) => a.startsWith('AWS_WEB_IDENTITY_TOKEN_FILE'))).toBe(false);
    expect(args).not.toContain('/tmp/p/credentials:/cdk-local-aws/credentials:ro');
    expect(args).toContain('AWS_ENDPOINT_URL=https://127.0.0.1:9297');
    expect(args.some((a) => a.startsWith('AWS_PROFILE'))).toBe(false);
    expect(args.some((a) => a.startsWith('AWS_SHARED_CREDENTIALS_FILE'))).toBe(false);
    expect(args.join(' ')).not.toContain('EMUSECRET');
    expect(sensitiveEnv['AWS_SECRET_ACCESS_KEY']).toBe('EMUSECRET');
    expect(sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe('EMULATOR0123456789AB');
  });

  it('no wiring: unchanged (profile mount + profile env, no CA)', () => {
    const { args } = build({});
    expect(args).toContain('/tmp/p/credentials:/cdk-local-aws/credentials:ro');
    expect(args).toContain('AWS_PROFILE=prod');
    expect(args.some((a) => a.includes('ca-bundle'))).toBe(false);
  });
});

// Issue #883: with no credential flag, run-task passes the host default chain
// as container env. It fills only an env that names no credentials of its own,
// stays off argv, and never survives --aws-emulator full mode.
describe('buildDockerRunArgs with default-chain credentials (#883)', () => {
  const chain = {
    accessKeyId: 'AKIDCHAIN0000000883',
    secretAccessKey: 'CHAINSECRET883',
    sessionToken: 'CHAINTOKEN883',
  };
  function buildDefault(environment: Record<string, string>, envOverrides?: object) {
    return buildDockerRunArgs({
      task: { family: 'fam' } as unknown as ResolvedEcsTask,
      container: container(environment),
      image: 'busybox',
      network: 'net',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: envOverrides as never,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: 'us-east-1',
      defaultCredentials: chain,
    });
  }

  it('sets the chain as AWS_* env, values off argv, no credentials file', () => {
    const { args, sensitiveEnv } = buildDefault({});
    expect(sensitiveEnv).toEqual({
      AWS_ACCESS_KEY_ID: chain.accessKeyId,
      AWS_SECRET_ACCESS_KEY: chain.secretAccessKey,
      AWS_SESSION_TOKEN: chain.sessionToken,
    });
    const argv = args.join(' ');
    for (const v of Object.values(chain)) expect(argv).not.toContain(v);
    expect(args).toContain('AWS_ACCESS_KEY_ID');
    expect(args.some((a) => a.startsWith('AWS_SHARED_CREDENTIALS_FILE'))).toBe(false);
    expect(args.some((a) => a.startsWith('AWS_CONTAINER_CREDENTIALS'))).toBe(false);
  });

  it('a task-declared key pair or AWS_PROFILE wins as a whole', () => {
    const declared = buildDefault({ AWS_ACCESS_KEY_ID: 'TASKKEY', AWS_SECRET_ACCESS_KEY: 'TASKSECRET' });
    expect(declared.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe('TASKKEY');
    expect(declared.sensitiveEnv['AWS_SECRET_ACCESS_KEY']).toBe('TASKSECRET');
    expect(declared.sensitiveEnv['AWS_SESSION_TOKEN']).toBeUndefined();
    const profile = buildDefault({ AWS_PROFILE: 'baked' });
    expect(profile.sensitiveEnv['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(profile.args).toContain('AWS_PROFILE=baked');
  });

  it('an --env-vars key wins over the chain', () => {
    const { sensitiveEnv } = buildDefault({}, { app: { AWS_ACCESS_KEY_ID: 'OVERRIDEKEY' } });
    expect(sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe('OVERRIDEKEY');
    expect(sensitiveEnv['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('a chain without a session token drops a stale task-declared one', () => {
    const { sessionToken: _t, ...noToken } = chain;
    const { sensitiveEnv } = buildDockerRunArgs({
      task: { family: 'fam' } as unknown as ResolvedEcsTask,
      container: container({ AWS_SESSION_TOKEN: 'STALE' }),
      image: 'busybox',
      network: 'net',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: 'us-east-1',
      defaultCredentials: noToken,
    });
    expect(sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(chain.accessKeyId);
    expect(sensitiveEnv['AWS_SESSION_TOKEN']).toBeUndefined();
  });

  it('emulator full mode: only the emulator keys reach the container', () => {
    setActiveWorkloadAwsWiring({
      ...base,
      mode: 'emulator',
      scrubEnvKeys: ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE'],
      emulatorCredentials: { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'EMUSECRET' },
    });
    const { args, sensitiveEnv } = buildDefault({});
    expect(sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe('EMULATOR0123456789AB');
    expect(sensitiveEnv['AWS_SECRET_ACCESS_KEY']).toBe('EMUSECRET');
    expect(sensitiveEnv['AWS_SESSION_TOKEN']).toBeUndefined();
    expect(JSON.stringify({ args, sensitiveEnv })).not.toContain('CHAIN');
  });

  it('forward (mixed) mode keeps the real chain', () => {
    setActiveWorkloadAwsWiring(base);
    const { sensitiveEnv } = buildDefault({});
    expect(sensitiveEnv['AWS_ACCESS_KEY_ID']).toBe(chain.accessKeyId);
  });
});
