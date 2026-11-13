import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

/**
 * go-to-k/cdkd#6223 — the bare `--assume-role` on `run-task` / `start-service`
 * / `start-alb` under a state source must assume the DEPLOYED task role
 * (`<Stack>-<LogicalId>-<suffix>`, which only the state record knows), not
 * the synth-time `role/<LogicalId>` placeholder.
 */

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const {
  detectEcsImageResolutionNeeds,
  fillTaskRolePlaceholders,
  resolveEcsTaskTarget,
} = await import('../../../src/local/ecs-task-resolver.js');
const { buildEcsImageResolutionContext: buildServiceContext } = await import(
  '../../../src/cli/commands/ecs-service-emulator.js'
);
const { buildEcsImageResolutionContext: buildRunTaskContext } = await import(
  '../../../src/cli/commands/local-run-task.js'
);

const DEPLOYED_ARN = 'arn:aws:iam::123456789012:role/App-TaskRole30FC0FBB-AbCdEf123456';
const DEPLOYED_NAME = 'App-TaskRole30FC0FBB-AbCdEf123456';

function stack(roleProps: Record<string, unknown> = {}): StackInfo {
  const resources: Record<string, TemplateResource> = {
    TaskRole30FC0FBB: { Type: 'AWS::IAM::Role', Properties: roleProps },
    Task: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        TaskRoleArn: { 'Fn::GetAtt': ['TaskRole30FC0FBB', 'Arn'] },
        ContainerDefinitions: [{ Name: 'app', Image: 'public.ecr.aws/x/y:1', Essential: true }],
      },
    },
  };
  return {
    stackName: 'App',
    displayName: 'App',
    artifactId: 'App',
    template: { Resources: resources },
    dependencyNames: [],
    region: 'us-east-1',
  } as unknown as StackInfo;
}

function roleRecord(attributes: Record<string, unknown>, physicalId = DEPLOYED_NAME) {
  return {
    TaskRole30FC0FBB: { physicalId, resourceType: 'AWS::IAM::Role', properties: {}, attributes },
  } as never;
}

describe('resolveEcsTaskTarget — same-stack task role against a state record', () => {
  it("returns the record's Arn attribute verbatim (cdkd --from-state shape)", () => {
    const task = resolveEcsTaskTarget('App:Task', [stack()], {
      stateResources: roleRecord({ Arn: DEPLOYED_ARN }),
    });
    expect(task.taskRoleArn).toBe(DEPLOYED_ARN);
    expect(task.taskRoleUnresolved).toBeUndefined();
  });

  it('builds the ARN from the role NAME plus Path (--from-cfn-stack shape)', () => {
    const task = resolveEcsTaskTarget('App:Task', [stack({ Path: '/svc/' })], {
      stateResources: roleRecord({}),
    });
    expect(task.taskRoleArn).toBe(
      `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/svc/${DEPLOYED_NAME}`
    );
    expect(task.taskRoleUnresolved).toBeUndefined();
  });

  it('refuses a non-literal Path and falls back to the logical-id placeholder', () => {
    const task = resolveEcsTaskTarget('App:Task', [stack({ Path: { Ref: 'P' } })], {
      stateResources: roleRecord({}),
    });
    expect(task.taskRoleArn).toBe('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/TaskRole30FC0FBB');
    expect(task.taskRoleUnresolved).toEqual({
      logicalId: 'TaskRole30FC0FBB',
      reason: 'path-not-literal',
    });
  });

  it('keeps the logical-id placeholder without state, saying why', () => {
    const task = resolveEcsTaskTarget('App:Task', [stack()]);
    expect(task.taskRoleArn).toBe('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/TaskRole30FC0FBB');
    expect(task.taskRoleUnresolved).toEqual({ logicalId: 'TaskRole30FC0FBB', reason: 'no-state' });
  });

  it('ignores the record when the context marks its IAM roles as the wrong side', () => {
    const task = resolveEcsTaskTarget('App:Task', [stack()], {
      stateResources: roleRecord({ Arn: DEPLOYED_ARN }),
      ignoreStateForRoles: true,
    });
    expect(task.taskRoleUnresolved?.reason).toBe('no-record');
  });

  it('flags the stack as needing the task-role state', () => {
    expect(detectEcsImageResolutionNeeds(stack()).needsTaskRoleState).toBe(true);
  });
});

describe('fillTaskRolePlaceholders', () => {
  it("fills the account and the caller ARN's partition", () => {
    expect(
      fillTaskRolePlaceholders(
        'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/X',
        '111122223333',
        'arn:aws-us-gov:iam::111122223333:user/u'
      )
    ).toBe('arn:aws-us-gov:iam::111122223333:role/X');
  });
});

describe.each([
  [
    'start-service / start-alb',
    (provider: unknown, options: Record<string, unknown>) =>
      buildServiceContext('App:Task', [stack()], options as never, provider as never),
  ],
  [
    'run-task',
    (provider: unknown, options: Record<string, unknown>) =>
      buildRunTaskContext(stack(), provider as never, options as never),
  ],
])('%s image context — state is loaded for the bare role flag', (_name, build) => {
  const load = vi.fn();
  const provider = { load, dispose: vi.fn(), getLastLoadError: () => undefined };

  beforeEach(() => {
    load.mockReset();
    load.mockResolvedValue({ resources: roleRecord({ Arn: DEPLOYED_ARN }), region: 'us-east-1' });
  });

  it('loads the record on a bare --assume-role, and the task resolves to the deployed role', async () => {
    const ctx = await build(provider, { assumeRole: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(resolveEcsTaskTarget('App:Task', [stack()], ctx).taskRoleArn).toBe(DEPLOYED_ARN);
  });

  it('honors the legacy bare --assume-task-role too', async () => {
    await build(provider, { assumeTaskRole: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not load state for an explicit ARN or no role flag', async () => {
    await build(provider, { assumeRole: 'arn:aws:iam::123456789012:role/Other' });
    await build(provider, {});
    expect(load).not.toHaveBeenCalled();
  });
});
