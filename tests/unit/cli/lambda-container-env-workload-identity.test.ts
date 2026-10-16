/**
 * go-to-k/cdk-local#783 — `invoke`'s shared container-env builder under caller
 * mode: the forwarded `AWS_*` triple is the caller's, not the `--role-arn`
 * role's, and a stripped triple warns only when no `--profile` overlay filled
 * it back in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    async send(): Promise<unknown> {
      return { Account: '111111111111' };
    }
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
  AssumeRoleCommand: class {},
}));

const { resolveLambdaContainerEnv } = await import('../../../src/cli/commands/local-invoke.js');
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { recordAssumedRole, resetWorkloadIdentity } = await import(
  '../../../src/utils/workload-identity.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';

const KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;

function lambda(): ResolvedLambda {
  return {
    kind: 'zip',
    stack: {
      stackName: 'S',
      displayName: 'S',
      artifactId: 'S',
      template: { Resources: {} },
      dependencyNames: [],
      region: 'us-east-1',
    },
    logicalId: 'Fn',
    resource: {
      Type: 'AWS::Lambda::Function',
      Properties: {},
      Metadata: { 'aws:cdk:path': 'S/Fn/Resource' },
    },
    memoryMb: 128,
    timeoutSec: 3,
    layers: [],
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    codePath: '/tmp/code',
  } as unknown as ResolvedLambda;
}

describe('resolveLambdaContainerEnv — caller workload identity (go-to-k/cdk-local#783)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAROLE';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'roleSecret';
    process.env['AWS_SESSION_TOKEN'] = 'roleToken';
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetWorkloadIdentity();
    resetEmbedConfig();
    vi.restoreAllMocks();
  });

  it('caller mode restores the caller triple (not the role)', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    const { env } = await resolveLambdaContainerEnv(lambda(), {}, undefined);
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIACALLER');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('callerSecret');
    expect('AWS_SESSION_TOKEN' in env).toBe(false);
  });

  it('caller mode with no static caller triple strips the triple and warns once', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(undefined);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const { env } = await resolveLambdaContainerEnv(lambda(), {}, undefined);
    for (const k of KEYS) expect(k in env).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('--profile');
  });

  it('a stripped triple filled by a --profile overlay does NOT warn', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(undefined);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const { env } = await resolveLambdaContainerEnv(lambda(), {}, {
      accessKeyId: 'AKIAPROFILE',
      secretAccessKey: 'profileSecret',
    } as never);
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAPROFILE');
    expect(warn).not.toHaveBeenCalled();
  });

  it('role mode forwards the process env as before', async () => {
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    const { env } = await resolveLambdaContainerEnv(lambda(), {}, undefined);
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAROLE');
    expect(env['AWS_SESSION_TOKEN']).toBe('roleToken');
  });
});
