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

const {
  applyAgentCoreCredentialEnv,
  resolveAssumeRoleArn,
  buildAgentCoreImageContext,
  resolveHostCredentialsForSigV4,
} = await import('../../../src/cli/commands/local-invoke-agentcore.js');
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { recordAssumedRole, resetWorkloadIdentity } = await import(
  '../../../src/utils/workload-identity.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { LocalStateProvider, LocalStateRecord } from '../../../src/local/local-state-provider.js';
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
  it('returns the explicit ARN for --assume-role <arn>', async () => {
    expect(await resolveAssumeRoleArn(opts('arn:aws:iam::1:role/X'), runtime(), undefined)).toBe(
      'arn:aws:iam::1:role/X'
    );
  });

  it("uses the runtime's literal RoleArn for bare --assume-role", async () => {
    expect(
      await resolveAssumeRoleArn(opts(true), runtime('arn:aws:iam::1:role/Agent'), undefined)
    ).toBe('arn:aws:iam::1:role/Agent');
  });

  it('returns undefined for bare --assume-role when RoleArn is not a literal (no state)', async () => {
    expect(
      await resolveAssumeRoleArn(opts(true), runtime(undefined), undefined)
    ).toBeUndefined();
  });

  it('returns undefined when --assume-role is absent', async () => {
    expect(
      await resolveAssumeRoleArn(opts(undefined), runtime('arn:aws:iam::1:role/Agent'), undefined)
    ).toBeUndefined();
  });
});

describe('resolveAssumeRoleArn — bare --assume-role state-miss live fallback (issue #187)', () => {
  function stateWithRuntime(opts: {
    logicalId: string;
    physicalId?: string;
    roleProperty?: unknown;
    roleResource?: { logicalId: string; arn?: string };
  }): LocalStateRecord {
    const resources: LocalStateRecord['resources'] = {};
    resources[opts.logicalId] = {
      physicalId: opts.physicalId ?? `${opts.logicalId}-physical`,
      resourceType: 'AWS::BedrockAgentCore::Runtime',
      properties: opts.roleProperty !== undefined ? { RoleArn: opts.roleProperty } : {},
      attributes: {},
      dependencies: [],
    };
    if (opts.roleResource) {
      const attrs: Record<string, unknown> = {};
      if (opts.roleResource.arn) attrs['Arn'] = opts.roleResource.arn;
      resources[opts.roleResource.logicalId] = {
        physicalId: 'role-physical',
        resourceType: 'AWS::IAM::Role',
        properties: {},
        attributes: attrs,
        dependencies: [],
      };
    }
    return { resources, outputs: {}, region: 'us-east-1' };
  }

  it('takes the state-only fast path when attributes.Arn is cached (no SDK call)', async () => {
    const state = stateWithRuntime({
      logicalId: 'ChatAgent',
      roleProperty: { 'Fn::GetAtt': ['AgentRole', 'Arn'] },
      roleResource: { logicalId: 'AgentRole', arn: 'arn:aws:iam::1:role/Agent-state-cached' },
    });
    const resolveAgentCoreRuntimeRoleArn = vi.fn();
    const stateProvider = {
      resolveAgentCoreRuntimeRoleArn,
    } as unknown as LocalStateProvider;

    const arn = await resolveAssumeRoleArn(opts(true), runtime(undefined), state, stateProvider);

    expect(arn).toBe('arn:aws:iam::1:role/Agent-state-cached');
    expect(resolveAgentCoreRuntimeRoleArn).not.toHaveBeenCalled();
  });

  it('falls back to stateProvider.resolveAgentCoreRuntimeRoleArn when state misses (issue #187)', async () => {
    const state = stateWithRuntime({
      logicalId: 'ChatAgent',
      physicalId: 'agent-runtime-abc123',
      roleProperty: { 'Fn::GetAtt': ['AgentRole', 'Arn'] },
      // AgentRole is in resources but its attributes.Arn is empty,
      // matching what `ListStackResources` produces in the CFn state
      // provider — exactly the issue #187 trigger.
      roleResource: { logicalId: 'AgentRole' },
    });
    const resolveAgentCoreRuntimeRoleArn = vi
      .fn()
      .mockResolvedValue('arn:aws:iam::1:role/Agent-live');
    const stateProvider = {
      resolveAgentCoreRuntimeRoleArn,
    } as unknown as LocalStateProvider;

    const arn = await resolveAssumeRoleArn(opts(true), runtime(undefined), state, stateProvider);

    expect(arn).toBe('arn:aws:iam::1:role/Agent-live');
    expect(resolveAgentCoreRuntimeRoleArn).toHaveBeenCalledTimes(1);
    expect(resolveAgentCoreRuntimeRoleArn).toHaveBeenCalledWith('agent-runtime-abc123');
  });

  it('warns and returns undefined when both state and live fallback miss', async () => {
    const state = stateWithRuntime({
      logicalId: 'ChatAgent',
      physicalId: 'agent-runtime-abc123',
      roleProperty: { 'Fn::GetAtt': ['AgentRole', 'Arn'] },
      roleResource: { logicalId: 'AgentRole' },
    });
    const stateProvider = {
      resolveAgentCoreRuntimeRoleArn: vi.fn().mockResolvedValue(undefined),
    } as unknown as LocalStateProvider;

    const arn = await resolveAssumeRoleArn(opts(true), runtime(undefined), state, stateProvider);

    expect(arn).toBeUndefined();
  });

  it('propagates rejections from the live fallback (caller decides recovery)', async () => {
    // The CFn provider's contract is best-effort + never-throws, but a host
    // extension implementing the optional method could violate it. The
    // helper deliberately does NOT swallow the rejection so the host bug
    // surfaces instead of silently falling back to dev creds.
    const state = stateWithRuntime({
      logicalId: 'ChatAgent',
      physicalId: 'agent-runtime-abc123',
      roleProperty: { 'Fn::GetAtt': ['AgentRole', 'Arn'] },
      roleResource: { logicalId: 'AgentRole' },
    });
    const stateProvider = {
      resolveAgentCoreRuntimeRoleArn: vi.fn().mockRejectedValue(new Error('host bug')),
    } as unknown as LocalStateProvider;

    await expect(
      resolveAssumeRoleArn(opts(true), runtime(undefined), state, stateProvider)
    ).rejects.toThrow(/host bug/);
  });

  it('does not call the live fallback when the state provider does not implement the method', async () => {
    const state = stateWithRuntime({
      logicalId: 'ChatAgent',
      physicalId: 'agent-runtime-abc123',
      roleProperty: { 'Fn::GetAtt': ['AgentRole', 'Arn'] },
      roleResource: { logicalId: 'AgentRole' },
    });
    // A state provider that does not implement
    // resolveAgentCoreRuntimeRoleArn (e.g. an S3-state provider) is
    // allowed — the optional method should not be called.
    const stateProvider = {} as unknown as LocalStateProvider;

    const arn = await resolveAssumeRoleArn(opts(true), runtime(undefined), state, stateProvider);

    expect(arn).toBeUndefined();
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

/** Restore process.env key by key (never replace the object: other holders keep their reference). */
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

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
    restoreEnv(savedEnv);
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

describe('caller workload identity (go-to-k/cdk-local#783)', () => {
  const savedEnv = { ...process.env };
  const CALLER = { accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' };

  beforeEach(() => {
    sendMock.mockReset();
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAROLE';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'roleSecret';
    process.env['AWS_SESSION_TOKEN'] = 'roleToken';
    delete process.env['AWS_PROFILE'];
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    resetWorkloadIdentity();
    resetEmbedConfig();
    vi.restoreAllMocks();
  });

  it('forwardAwsEnv: caller mode hands the container the caller triple, not the role', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(CALLER);
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {});
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIACALLER');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('callerSecret');
    expect('AWS_SESSION_TOKEN' in env).toBe(false);
  });

  it('forwardAwsEnv: caller mode with no static caller triple strips the triple and warns once', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(undefined);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {});
    expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(env).not.toHaveProperty('AWS_SESSION_TOKEN');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('--profile');
    await applyAgentCoreCredentialEnv({}, {});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('forwardAwsEnv: a stripped triple with a --profile overlay does NOT warn', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(undefined);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {
      profileCredentials: { accessKeyId: 'AKIAPROFILE', secretAccessKey: 'profileSecret' },
    });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAPROFILE');
    expect(warn).not.toHaveBeenCalled();
  });

  it('forwardAwsEnv: a --profile overlay still wins over the restored caller triple', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(CALLER);
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {
      profileCredentials: { accessKeyId: 'AKIAPROFILE', secretAccessKey: 'profileSecret' },
    });
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAPROFILE');
  });

  it('forwardAwsEnv: role mode forwards the process env as before', async () => {
    recordAssumedRole(CALLER);
    const env: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(env, {});
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAROLE');
    expect(env['AWS_SESSION_TOKEN']).toBe('roleToken');
  });

  describe('resolveHostCredentialsForSigV4 env fallback', () => {
    const call = () =>
      resolveHostCredentialsForSigV4(
        {} as never,
        runtime(),
        undefined,
        'us-east-1',
        undefined
      );

    it('caller mode signs as the caller', async () => {
      setEmbedConfig({ workloadIdentity: 'caller' });
      recordAssumedRole(CALLER);
      expect(await call()).toEqual({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
      // The process env itself is untouched (only a copy was corrected).
      expect(process.env['AWS_ACCESS_KEY_ID']).toBe('AKIAROLE');
    });

    it('caller mode with a stripped result takes the no-credentials path', async () => {
      setEmbedConfig({ workloadIdentity: 'caller' });
      recordAssumedRole(undefined);
      const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
      await expect(call()).rejects.toMatchObject({
        code: 'LOCAL_INVOKE_AGENTCORE_SIGV4_NO_CREDENTIALS',
      });
      // It throws its own error; the container-env strip warning is not its to give.
      expect(warn).not.toHaveBeenCalled();
    });

    it('role mode signs as the env triple (the role)', async () => {
      recordAssumedRole(CALLER);
      expect(await call()).toEqual({
        accessKeyId: 'AKIAROLE',
        secretAccessKey: 'roleSecret',
        sessionToken: 'roleToken',
      });
    });
  });
});
