import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = sendMock;
    destroy(): void {}
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { applyAgentCoreCredentialEnv, resolveAssumeRoleArn, buildAgentCoreImageContext } =
  await import('../../../src/cli/commands/local-invoke-agentcore.js');
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function runtime(roleArn?: string): ResolvedAgentCoreRuntime {
  return {
    stack: { stackName: 'App' } as ResolvedAgentCoreRuntime['stack'],
    logicalId: 'ChatAgent',
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    containerUri: 'repo:tag',
    environmentVariables: {},
    protocol: 'HTTP',
    ...(roleArn !== undefined && { roleArn }),
  };
}

// Cast helper for the command's options bag (only assumeRole matters here).
const opts = (assumeRole: string | boolean | undefined): Parameters<typeof resolveAssumeRoleArn>[0] =>
  ({ assumeRole }) as unknown as Parameters<typeof resolveAssumeRoleArn>[0];

describe('resolveAssumeRoleArn — three --assume-role forms', () => {
  it('returns the explicit ARN for --assume-role <arn>', () => {
    expect(resolveAssumeRoleArn(opts('arn:aws:iam::1:role/X'), runtime(), undefined)).toBe(
      'arn:aws:iam::1:role/X'
    );
  });

  it("uses the runtime's literal RoleArn for bare --assume-role", () => {
    expect(resolveAssumeRoleArn(opts(true), runtime('arn:aws:iam::1:role/Agent'), undefined)).toBe(
      'arn:aws:iam::1:role/Agent'
    );
  });

  it('returns undefined for bare --assume-role when RoleArn is not a literal (no state)', () => {
    expect(resolveAssumeRoleArn(opts(true), runtime(undefined), undefined)).toBeUndefined();
  });

  it('returns undefined when --assume-role is absent', () => {
    expect(
      resolveAssumeRoleArn(opts(undefined), runtime('arn:aws:iam::1:role/Agent'), undefined)
    ).toBeUndefined();
  });
});

describe('buildAgentCoreImageContext', () => {
  beforeEach(() => sendMock.mockReset());

  const candidate = (): StackInfo =>
    ({
      stackName: 'App',
      displayName: 'App',
      artifactId: 'App',
      template: { Resources: {} },
      dependencyNames: [],
      region: 'us-east-1',
    }) as unknown as StackInfo;

  const provider = (over: Record<string, unknown> = {}) =>
    ({
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: { T: { physicalId: 't1' } }, region: 'us-east-1', outputs: {} }),
      resolveTemplateSsmParameters: vi
        .fn()
        .mockResolvedValue({ values: { Secret: 's3cr3t' }, secureStringLogicalIds: ['Secret'] }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      ...over,
    }) as never;

  const opt = { region: 'us-east-1' } as never;

  it('builds pseudo params (with STS account), state resources, and SSM params', async () => {
    sendMock.mockResolvedValue({ Account: '123456789012' });
    const { context, loaded } = await buildAgentCoreImageContext(candidate(), provider(), opt);
    expect(context?.pseudoParameters).toMatchObject({
      accountId: '123456789012',
      region: 'us-east-1',
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
    expect(context?.stateResources).toEqual({ T: { physicalId: 't1' } });
    expect(context?.stateParameters).toEqual({ Secret: 's3cr3t' });
    expect(context?.stateSensitiveParameters).toEqual(['Secret']);
    expect(loaded).toBeDefined();
  });

  it('omits stateResources when the state record is absent', async () => {
    sendMock.mockResolvedValue({ Account: '1' });
    const { context, loaded } = await buildAgentCoreImageContext(
      candidate(),
      provider({ load: vi.fn().mockResolvedValue(undefined) }),
      opt
    );
    expect(context?.stateResources).toBeUndefined();
    expect(loaded).toBeUndefined();
  });
});

describe('applyAgentCoreCredentialEnv', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    delete process.env['AWS_SESSION_TOKEN'];
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('injects STS temp credentials when an assume-role ARN is given', async () => {
    sendMock.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIAASSUMED',
        SecretAccessKey: 'secretAssumed',
        SessionToken: 'tokenAssumed',
      },
    });
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {
      assumeRoleArn: 'arn:aws:iam::1:role/Agent',
      region: 'us-east-1',
    });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAASSUMED');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('secretAssumed');
    expect(env['AWS_SESSION_TOKEN']).toBe('tokenAssumed');
    expect(env['AWS_REGION']).toBe('us-east-1');
  });

  it('forwards dev shell credentials when no assume-role is set', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIADEV';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secretDev';
    process.env['AWS_REGION'] = 'eu-west-1';
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {});
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIADEV');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('secretDev');
    expect(env['AWS_REGION']).toBe('eu-west-1');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('overlays --profile credentials and points the SDK at the bind-mounted creds file', async () => {
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {
      profileCredentials: {
        accessKeyId: 'AKIAPROFILE',
        secretAccessKey: 'secretProfile',
        sessionToken: 'tokenProfile',
      },
      profileCredsFile: { containerPath: '/tmp/creds', profileName: 'dev' },
    });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAPROFILE');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('secretProfile');
    expect(env['AWS_SESSION_TOKEN']).toBe('tokenProfile');
    expect(env['AWS_SHARED_CREDENTIALS_FILE']).toBe('/tmp/creds');
    expect(env['AWS_PROFILE']).toBe('dev');
  });

  it('falls back to dev credentials when STS AssumeRole fails', async () => {
    sendMock.mockRejectedValue(new Error('access denied'));
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIADEV';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'secretDev';
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, { assumeRoleArn: 'arn:aws:iam::1:role/Agent' });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIADEV');
  });
});
