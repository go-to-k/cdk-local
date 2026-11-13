import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

/**
 * go-to-k/cdkd#6223 — the bare `--assume-role` on `run-task` / `start-service`
 * / `start-alb` under a state source must assume the DEPLOYED task role
 * (`<Stack>-<LogicalId>-<suffix>`, which only the state record knows), not
 * the synth-time `role/<LogicalId>` placeholder.
 */

const { wiring, iamRoutedToEmulator, warnMock } = vi.hoisted(() => ({
  wiring: { current: undefined as unknown },
  iamRoutedToEmulator: { current: false },
  warnMock: vi.fn(),
}));

vi.mock('../../../src/local/workload-aws-wiring.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveWorkloadAwsWiring: () => wiring.current,
}));

vi.mock('../../../src/utils/aws-proxy.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isAwsServiceRoutedToEmulator: (service: string) =>
    service === 'IAM' ? iamRoutedToEmulator.current : false,
}));

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const orig = await importOriginal<{ getLogger: () => object }>();
  return {
    ...orig,
    getLogger: () => Object.assign(Object.create(orig.getLogger()), { warn: warnMock }),
  };
});

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
const {
  buildEcsImageResolutionContext: buildServiceContext,
  warnIfTaskRoleIsLogicalId,
} = await import('../../../src/cli/commands/ecs-service-emulator.js');
const { createMixedModeStateProvider } = await import(
  '../../../src/local/aws-emulator-mixed-mode.js'
);
const { buildEcsImageResolutionContext: buildRunTaskContext } = await import(
  '../../../src/cli/commands/local-run-task.js'
);

const DEPLOYED_ARN = 'arn:aws:iam::123456789012:role/App-TaskRole30FC0FBB-AbCdEf123456';
const DEPLOYED_NAME = 'App-TaskRole30FC0FBB-AbCdEf123456';

function stack(roleProps: Record<string, unknown> = {}, envFromState = false): StackInfo {
  const resources: Record<string, TemplateResource> = {
    TaskRole30FC0FBB: { Type: 'AWS::IAM::Role', Properties: roleProps },
    Task: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        TaskRoleArn: { 'Fn::GetAtt': ['TaskRole30FC0FBB', 'Arn'] },
        ContainerDefinitions: [
          {
            Name: 'app',
            Image: 'public.ecr.aws/x/y:1',
            Essential: true,
            ...(envFromState && {
              Environment: [{ Name: 'ROLE', Value: { Ref: 'TaskRole30FC0FBB' } }],
            }),
          },
        ],
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
    (provider: unknown, options: Record<string, unknown>, s: StackInfo = stack()) =>
      buildServiceContext('App:Task', [s], options as never, provider as never),
  ],
  [
    'run-task',
    (provider: unknown, options: Record<string, unknown>, s: StackInfo = stack()) =>
      buildRunTaskContext(s, provider as never, options as never),
  ],
])('%s image context — state is loaded for the bare role flag', (_name, build) => {
  const load = vi.fn();
  const provider = { load, dispose: vi.fn(), getLastLoadError: () => undefined };

  beforeEach(() => {
    wiring.current = undefined;
    iamRoutedToEmulator.current = false;
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

  it('mixed mode with IAM on the emulator: no state load for the role alone', async () => {
    wiring.current = { mode: 'forward', mixed: {} };
    iamRoutedToEmulator.current = true;
    expect(await build(provider, { assumeRole: true })).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('mixed mode with IAM on the emulator: a record loaded for env is ignored for the role', async () => {
    wiring.current = { mode: 'forward', mixed: {} };
    iamRoutedToEmulator.current = true;
    const s = stack({}, true);
    const ctx = await build(provider, { assumeRole: true }, s);
    expect(load).toHaveBeenCalledTimes(1);
    expect(ctx?.ignoreStateForRoles).toBe(true);
    const task = resolveEcsTaskTarget('App:Task', [s], ctx);
    expect(task.taskRoleArn).not.toBe(DEPLOYED_ARN);
    expect(task.taskRoleUnresolved?.reason).toBe('no-record');
  });

  it('mixed mode with IAM excepted: the real-side record is used', async () => {
    wiring.current = { mode: 'forward', mixed: {} };
    iamRoutedToEmulator.current = false;
    const ctx = await build(provider, { assumeRole: true });
    expect(ctx?.ignoreStateForRoles).toBeUndefined();
    expect(resolveEcsTaskTarget('App:Task', [stack()], ctx).taskRoleArn).toBe(DEPLOYED_ARN);
  });

  it('a record whose real side was unread is ignored for the role', async () => {
    load.mockResolvedValue({
      resources: roleRecord({ Arn: 'arn:aws:iam::000000000000:role/emulator-role' }),
      region: 'us-east-1',
      realSideUnread: true,
    });
    const ctx = await build(provider, { assumeRole: true });
    expect(ctx?.ignoreStateForRoles).toBe(true);
    expect(ctx?.roleRecordRealSideUnread).toBe(true);
    const task = resolveEcsTaskTarget('App:Task', [stack()], ctx);
    expect(task.taskRoleArn).not.toContain('emulator-role');
    expect(task.taskRoleUnresolved?.reason).toBe('no-record');
  });
});

describe('createMixedModeStateProvider — real side unread (go-to-k/cdkd#6223)', () => {
  function fake(record: unknown) {
    return {
      label: 'x',
      load: vi.fn().mockResolvedValue(record),
      dispose: vi.fn(),
      getLastLoadError: () => 'AccessDenied',
      buildCrossStackResolver: vi.fn(),
    };
  }
  const emulatorRecord = { resources: roleRecord({ Arn: 'arn:aws:iam::000000000000:role/e' }), outputs: {}, region: 'us-east-1' };

  it('marks the emulator record realSideUnread when real AWS is unread', async () => {
    const p = createMixedModeStateProvider({
      emulator: fake(emulatorRecord) as never,
      real: fake(undefined) as never,
      realServices: ['IAM'],
    });
    expect((await p.load('App', 'us-east-1'))?.realSideUnread).toBe(true);
  });

  it('does not mark it when real AWS is read', async () => {
    const p = createMixedModeStateProvider({
      emulator: fake(emulatorRecord) as never,
      real: fake({ resources: roleRecord({ Arn: DEPLOYED_ARN }), outputs: {}, region: 'us-east-1' }) as never,
      realServices: ['IAM'],
    });
    expect((await p.load('App', 'us-east-1'))?.realSideUnread).toBeUndefined();
  });
});

describe('warnIfTaskRoleIsLogicalId — one cause per branch', () => {
  beforeEach(() => {
    warnMock.mockReset();
    wiring.current = undefined;
    iamRoutedToEmulator.current = false;
  });
  const task = (reason: 'no-state' | 'no-record' | 'path-not-literal') => ({
    taskRoleUnresolved: { logicalId: 'R', reason },
  });
  const said = (): string => String(warnMock.mock.calls[0]?.[0] ?? '');

  it('is silent when the role resolved', () => {
    warnIfTaskRoleIsLogicalId({}, {});
    expect(warnMock).not.toHaveBeenCalled();
  });
  it('no state source', () => {
    warnIfTaskRoleIsLogicalId(task('no-state'), undefined);
    expect(said()).toMatch(/without a state-source flag/);
  });
  it('real side unread', () => {
    warnIfTaskRoleIsLogicalId(task('no-record'), {}, {
      ignoreStateForRoles: true,
      roleRecordRealSideUnread: true,
    });
    expect(said()).toMatch(/could not be read from real AWS/);
  });
  it('mixed mode, IAM on the emulator', () => {
    wiring.current = { mode: 'forward', mixed: {} };
    iamRoutedToEmulator.current = true;
    warnIfTaskRoleIsLogicalId(task('no-record'), {});
    expect(said()).toMatch(/IAM roles are the emulator's/);
  });
  it('non-literal Path', () => {
    warnIfTaskRoleIsLogicalId(task('path-not-literal'), {});
    expect(said()).toMatch(/not a literal IAM path/);
  });
  it('no record', () => {
    warnIfTaskRoleIsLogicalId(task('no-record'), {});
    expect(said()).toMatch(/has no record of it/);
  });
});
