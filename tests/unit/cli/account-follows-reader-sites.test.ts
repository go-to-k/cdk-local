import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';

// go-to-k/cdkd#5001: in `workloadIdentity: 'caller'` mode the account behind
// `${AWS::AccountId}` / the placeholder task-role ARN follows where the stack
// was READ. Under `--from-cfn-stack` that is the caller; this drives every
// entry point with `fromCfnStack: true` and asserts the STS client was built
// with the CALLER triple (not the recorded role's).

const stsCtorMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(config: unknown) {
      stsCtorMock(config);
    }
    send = async () => ({ Account: '222222222222' });
    destroy = () => {};
  },
  GetCallerIdentityCommand: class {},
}));

const runTask = await import('../../../src/cli/commands/local-run-task.js');
const service = await import('../../../src/cli/commands/ecs-service-emulator.js');
const agentcore = await import('../../../src/cli/commands/local-invoke-agentcore.js');
const invoke = await import('../../../src/cli/commands/local-invoke.js');
const startApi = await import('../../../src/cli/commands/local-start-api.js');
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { recordAssumedRole, resetWorkloadIdentity } = await import(
  '../../../src/utils/workload-identity.js'
);
const { TASK_ROLE_ACCOUNT_PLACEHOLDER } = await import('../../../src/local/ecs-task-resolver.js');

const ROLE = { accessKeyId: 'AKIAROLE', secretAccessKey: 'roleSecret', sessionToken: 'roleTok' };
const CALLER = { accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' };
const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'AWS_PROFILE'] as const;

async function lastStsCredentials(): Promise<unknown> {
  expect(stsCtorMock).toHaveBeenCalled();
  const cfg = stsCtorMock.mock.calls.at(-1)![0] as { credentials?: () => Promise<unknown> };
  return cfg.credentials!();
}

function ecsStack(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Environment: [{ Name: 'ACCT', Value: { Ref: 'AWS::AccountId' } }],
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

const stateProvider = (): LocalStateProvider =>
  ({
    label: '--from-cfn-stack',
    load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
    buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
    resolveTemplateSsmParameters: vi
      .fn()
      .mockResolvedValue({ values: {}, secureStringLogicalIds: [] }),
    dispose: vi.fn(),
  }) as unknown as LocalStateProvider;

describe('the account follows where the stack was read (caller mode, --from-cfn-stack)', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    stsCtorMock.mockReset();
    resetWorkloadIdentity();
    resetEmbedConfig();
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(CALLER, ROLE);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  it('run-task buildEcsImageResolutionContext', async () => {
    await runTask.buildEcsImageResolutionContext(ecsStack(), stateProvider(), {
      fromCfnStack: true,
      region: 'us-east-1',
    } as never);
    expect(await lastStsCredentials()).toEqual(CALLER);
  });

  it('run-task buildEcsImageResolutionContext without a state source resolves the ROLE', async () => {
    await runTask.buildEcsImageResolutionContext(ecsStack(), stateProvider(), {
      region: 'us-east-1',
    } as never);
    expect(await lastStsCredentials()).toEqual(ROLE);
  });

  it('service buildEcsImageResolutionContext', async () => {
    await service.buildEcsImageResolutionContext(
      'MyStack/TaskDef',
      [ecsStack()],
      { fromCfnStack: true, region: 'us-east-1' } as never,
      stateProvider()
    );
    expect(await lastStsCredentials()).toEqual(CALLER);
  });

  it('buildAgentCoreImageContext', async () => {
    await agentcore.buildAgentCoreImageContext(
      { stackName: 'App', template: { Resources: {} }, region: 'us-east-1' } as unknown as StackInfo,
      stateProvider(),
      { fromCfnStack: true, region: 'us-east-1' } as never
    );
    expect(await lastStsCredentials()).toEqual(CALLER);
  });

  it('resolvePseudoParametersForInvoke', async () => {
    await invoke.resolvePseudoParametersForInvoke('us-east-1', { fromCfnStack: true });
    expect(await lastStsCredentials()).toEqual(CALLER);
  });

  it('resolvePseudoParametersForStartApi', async () => {
    await startApi.resolvePseudoParametersForStartApi('us-east-1', {
      fromCfnStack: true,
    } as never);
    expect(await lastStsCredentials()).toEqual(CALLER);
  });

  it('run-task placeholder task-role call site', async () => {
    const arn = `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/r`;
    const out = await runTask.resolveTaskRoleArnForOptionsForTest(arn, {
      fromCfnStack: true,
      region: 'us-east-1',
    });
    expect(out).toBe('arn:aws:iam::222222222222:role/r');
    expect(await lastStsCredentials()).toEqual(CALLER);
  });

  it('service placeholder task-role call site', async () => {
    const arn = `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/r`;
    await service.resolveTaskRoleArnForOptionsForTest(arn, {
      fromCfnStack: 'MyStack',
      region: 'us-east-1',
    });
    expect(await lastStsCredentials()).toEqual(CALLER);
  });

  it('placeholder call sites without --from-cfn-stack resolve the ROLE', async () => {
    const arn = `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/r`;
    await runTask.resolveTaskRoleArnForOptionsForTest(arn, { region: 'us-east-1' });
    expect(await lastStsCredentials()).toEqual(ROLE);
    await service.resolveTaskRoleArnForOptionsForTest(arn, { region: 'us-east-1' });
    expect(await lastStsCredentials()).toEqual(ROLE);
  });
});
