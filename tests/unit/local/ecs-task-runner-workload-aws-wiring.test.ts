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
    const { args } = build({ AWS_ENDPOINT_URL: 'http://task-declared:1' });
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
      scrubEnvKeys: ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE'],
      emulatorCredentials: { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'EMUSECRET' },
    });
    const { args, sensitiveEnv } = build({ AWS_ENDPOINT_URL: 'https://real.example.com' });
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
