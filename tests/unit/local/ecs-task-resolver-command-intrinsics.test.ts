import { describe, it, expect } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  EcsTaskResolutionError,
  applyCrossStackResolverToTask,
  assertEcsTaskCommandsResolved,
  detectEcsImageResolutionNeeds,
  resolveEcsTaskTarget,
  type EcsImageResolutionContext,
} from '../../../src/local/ecs-task-resolver.js';
import { createEcsRunState, runEcsTask } from '../../../src/local/ecs-task-runner.js';

// Issue #961: a container's Command / EntryPoint / HealthCheck.Command element
// that is an intrinsic used to be DROPPED by `pickStringArray`, so the task
// ran a different command (`--bucket` with no value, the rest shifted). Each
// element now resolves against state as Environment does, and one that does
// not resolve is recorded and refused before anything starts.

function stack(container: Record<string, unknown>, extra: Record<string, unknown> = {}): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Key: { Type: 'AWS::IAM::AccessKey', Properties: {} },
        ApiKey: { Type: 'AWS::AppSync::ApiKey', Properties: {} },
        Custom: { Type: 'Custom::Thing', Properties: {} },
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                ...container,
              },
            ],
          },
        },
        ...extra,
      },
    },
  } as unknown as StackInfo;
}

function record(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {}
): ResourceState {
  return { physicalId, resourceType, properties: {}, attributes };
}

const BUCKET_NAME = 'my-deployed-bucket';
const BUCKET_ARN = 'arn:aws:s3:::my-deployed-bucket';

function stateContext(extra: Partial<EcsImageResolutionContext> = {}): EcsImageResolutionContext {
  return {
    stateResources: {
      Bucket: record('AWS::S3::Bucket', BUCKET_NAME, { Arn: BUCKET_ARN }),
      Key: record('AWS::IAM::AccessKey', 'AKIAEXAMPLE', { SecretAccessKey: 'plaintext-secret' }),
      ApiKey: record('AWS::AppSync::ApiKey', 'apikey-id', { ApiKey: 'da2-plaintext' }),
      Custom: record('Custom::Thing', 'custom-id', { Token: '***', Value: 'custom-plaintext' }),
      Cr: record('AWS::CloudFormation::CustomResource', 'cr-id', { 'Parameter.Value': 'ssm-plaintext' }),
      Db: record('AWS::RDS::DBInstance', 'db-id', { 'MasterUserSecret.SecretArn': 'arn:secret' }),
      Nested: record('AWS::CloudFormation::Stack', 'nested-id', { 'Outputs.Pw': 'nested-plaintext' }),
    },
    pseudoParameters: { accountId: '123456789012', region: 'us-east-1', partition: 'aws' },
    ...extra,
  };
}

function resolve(container: Record<string, unknown>, context?: EcsImageResolutionContext) {
  const task = resolveEcsTaskTarget('MyStack:TaskDef', [stack(container)], context);
  return { task, container: task.containers[0]! };
}

describe('ECS container argv intrinsics (issue #961)', () => {
  it('substitutes Ref / Fn::GetAtt / Fn::Join / Fn::Sub elements against state, in place', () => {
    const { task, container } = resolve(
      {
        Command: ['--bucket', { Ref: 'Bucket' }, '--port', 8080],
        EntryPoint: [{ 'Fn::Join': ['', ['s3://', { Ref: 'Bucket' }, '/in']] }],
        HealthCheck: {
          Command: ['CMD-SHELL', { 'Fn::Sub': 'check ${Bucket.Arn} in ${AWS::Region}' }],
          Interval: 10,
        },
      },
      stateContext()
    );
    expect(container.command).toEqual(['--bucket', BUCKET_NAME, '--port', '8080']);
    expect(container.entryPoint).toEqual([`s3://${BUCKET_NAME}/in`]);
    expect(container.healthCheck?.command).toEqual(['CMD-SHELL', `check ${BUCKET_ARN} in us-east-1`]);
    expect(container.unresolvedCommandElements).toBeUndefined();
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('records an intrinsic element with no state at its position and refuses the run naming it', () => {
    const { task, container } = resolve({
      Command: ['--bucket', { Ref: 'Bucket' }, '--verbose'],
      HealthCheck: { Command: ['CMD', { 'Fn::GetAtt': ['Bucket', 'Arn'] }] },
    });
    // The position is kept: nothing after the element shifts.
    expect(container.command).toEqual(['--bucket', '', '--verbose']);
    expect(container.unresolvedCommandElements?.map((u) => [u.field, u.index])).toEqual([
      ['Command', 1],
      ['HealthCheck.Command', 1],
    ]);
    expect(container.unresolvedCommandElements?.[0]?.reason).toContain('--from-cfn-stack');
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(EcsTaskResolutionError);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Container app Command\[1\]: intrinsic-valued[\s\S]*Container app HealthCheck\.Command\[1\]/
    );
  });

  it('refuses an element whose state lookup fails, with the substitution reason', () => {
    const { task, container } = resolve(
      { EntryPoint: ['run', { Ref: 'Missing' }] },
      stateContext()
    );
    expect(container.entryPoint).toEqual(['run', '']);
    expect(container.unresolvedCommandElements).toHaveLength(1);
    expect(container.unresolvedCommandElements?.[0]).toMatchObject({ field: 'EntryPoint', index: 1 });
    expect(container.unresolvedCommandElements?.[0]?.reason).toMatch(/Missing/);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/EntryPoint\[1\]/);
  });

  it.each([
    ['a sensitive attribute name', { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] }, 'plaintext-secret'],
    ['a sensitive name inside Fn::Sub', { 'Fn::Sub': 'k=${Key.SecretAccessKey}' }, 'plaintext-secret'],
    ['a secret-valued attribute by type', { 'Fn::GetAtt': 'ApiKey.ApiKey' }, 'da2-plaintext'],
    ['a masked NoEcho attribute', { 'Fn::GetAtt': ['Custom', 'Token'] }, '***'],
    ['any custom resource attribute', { 'Fn::GetAtt': ['Cr', 'Parameter.Value'] }, 'ssm-plaintext'],
    ['a Custom:: resource attribute', { 'Fn::GetAtt': ['Custom', 'Value'] }, 'custom-plaintext'],
    ['a nested stack output', { 'Fn::GetAtt': ['Nested', 'Outputs.Pw'] }, 'nested-plaintext'],
  ])('refuses %s instead of putting it on the docker run argv', (_label, element, plaintext) => {
    const { task, container } = resolve({ Command: ['run', element] }, stateContext());
    expect(container.command).toEqual(['run', '']);
    expect(container.command).not.toContain(plaintext);
    expect(container.unresolvedCommandElements?.[0]?.reason).toContain('may be a secret');
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(EcsTaskResolutionError);
  });

  it('serves an attribute that names a secret rather than holding one (SecretArn)', () => {
    const { container } = resolve(
      { Command: ['--secret-arn', { 'Fn::GetAtt': ['Db', 'MasterUserSecret.SecretArn'] }] },
      stateContext()
    );
    expect(container.command).toEqual(['--secret-arn', 'arn:secret']);
    expect(container.unresolvedCommandElements).toBeUndefined();
  });

  it('refuses an element built from a SecureString parameter', () => {
    const { container } = resolve(
      { Command: ['--key', { Ref: 'SsmSecret' }, '--host', { Ref: 'SsmPlain' }] },
      stateContext({
        stateParameters: { SsmSecret: 's3cr3t', SsmPlain: 'db.internal' },
        stateSensitiveParameters: ['SsmSecret'],
      })
    );
    expect(container.command).toEqual(['--key', '', '--host', 'db.internal']);
    expect(container.unresolvedCommandElements).toHaveLength(1);
    expect(container.unresolvedCommandElements?.[0]?.reason).toContain('SecureString');
  });

  it('refuses an element that resolves to a dynamic reference', () => {
    const { container } = resolve(
      { Command: ['--token', { Ref: 'Dyn' }] },
      stateContext({ stateParameters: { Dyn: '{{resolve:secretsmanager:MySecret}}' } })
    );
    expect(container.command).toEqual(['--token', '']);
    expect(container.unresolvedCommandElements?.[0]?.reason).toContain('dynamic reference');
  });

  it('resolves a cross-stack element through the async post-pass, and keeps one it cannot', async () => {
    const { task, container } = resolve(
      {
        Command: ['--bucket', { 'Fn::ImportValue': 'Producer-Bucket' }],
        EntryPoint: [{ 'Fn::ImportValue': 'Producer-Missing' }],
      },
      stateContext()
    );
    expect(container.unresolvedCommandElements?.map((u) => u.field)).toEqual([
      'Command',
      'EntryPoint',
    ]);
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: {
        resolveImport: async (name) => (name === 'Producer-Bucket' ? 'imported-bucket' : undefined),
        resolveGetStackOutput: async () => undefined,
      },
    });
    expect(container.command).toEqual(['--bucket', 'imported-bucket']);
    expect(container.entryPoint).toEqual(['']);
    expect(container.unresolvedCommandElements?.map((u) => [u.field, u.index])).toEqual([
      ['EntryPoint', 0],
    ]);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/EntryPoint\[0\]/);
  });

  it('clears the record once the post-pass resolves every element', async () => {
    const { task, container } = resolve({
      HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'Producer-Url' }] },
    });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: {
        resolveImport: async () => 'http://producer/health',
        resolveGetStackOutput: async () => undefined,
      },
    });
    expect(container.healthCheck?.command).toEqual(['CMD', 'http://producer/health']);
    expect(container.unresolvedCommandElements).toBeUndefined();
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('flags an intrinsic argv element as needing state, and a cross-stack one the resolver', () => {
    const literal = detectEcsImageResolutionNeeds(stack({ Command: ['echo', 'hi'] }));
    expect(literal.needsEnvOrSecretSubstitution).toBe(false);
    expect(literal.needsCrossStackResolver).toBe(false);

    const sameStack = detectEcsImageResolutionNeeds(stack({ EntryPoint: [{ Ref: 'Bucket' }] }));
    expect(sameStack.needsEnvOrSecretSubstitution).toBe(true);
    expect(sameStack.needsCrossStackResolver).toBe(false);

    const crossStack = detectEcsImageResolutionNeeds(
      stack({ HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'X' }] } })
    );
    expect(crossStack.needsEnvOrSecretSubstitution).toBe(true);
    expect(crossStack.needsCrossStackResolver).toBe(true);
  });

  it('refuses a non-string, non-intrinsic element and stringifies a boolean', () => {
    const { container } = resolve({ Command: ['a', null, ['nested'], true] }, stateContext());
    expect(container.command).toEqual(['a', '', '', 'true']);
    expect(container.unresolvedCommandElements).toEqual([
      { field: 'Command', index: 1, reason: 'not a string or an intrinsic' },
      { field: 'Command', index: 2, reason: 'not a string or an intrinsic' },
    ]);
  });

  it('post-pass: refuses a cross-stack element that also reads a secret attribute', async () => {
    const { task, container } = resolve(
      {
        Command: [
          'run',
          { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Key', 'SecretAccessKey'] }, { 'Fn::ImportValue': 'X' }]] },
        ],
      },
      stateContext()
    );
    await applyCrossStackResolverToTask(task, {
      resources: stateContext().stateResources!,
      crossStackResolver: {
        resolveImport: async () => '-suffix',
        resolveGetStackOutput: async () => undefined,
      },
    });
    expect(container.command).toEqual(['run', '']);
    expect(container.command!.join(' ')).not.toContain('plaintext-secret');
    expect(container.unresolvedCommandElements?.[0]?.reason).toContain('may be a secret');
  });

  it('post-pass: refuses a cross-stack value that is a dynamic reference, resolved or not', async () => {
    const dynamic = '{{resolve:secretsmanager:S}}';
    const resolver = {
      resolveImport: async () => dynamic,
      resolveGetStackOutput: async () => undefined,
    };
    const first = resolve({ Command: [{ 'Fn::ImportValue': 'X' }] }, stateContext());
    await applyCrossStackResolverToTask(first.task, { resources: {}, crossStackResolver: resolver });
    expect(first.container.command).toEqual(['']);
    expect(first.container.unresolvedCommandElements?.[0]?.reason).toContain('dynamic reference');

    // With the env-only resolve hook on the context, the argv pass still must
    // not resolve the token to plaintext.
    const second = resolve({ Command: [{ 'Fn::ImportValue': 'X' }] }, stateContext());
    await applyCrossStackResolverToTask(second.task, {
      resources: {},
      crossStackResolver: resolver,
      consumerRegion: 'us-east-1',
      resolveDynamicReferences: async () => 'plaintext-from-hook',
    });
    expect(second.container.command).toEqual(['']);
    expect(second.container.unresolvedCommandElements).toHaveLength(1);
  });

  it('post-pass: refuses a cross-stack value that arrives as the secret mask', async () => {
    const { task, container } = resolve({ Command: ['--pw', { 'Fn::ImportValue': 'X' }] }, stateContext());
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: { resolveImport: async () => '***', resolveGetStackOutput: async () => undefined },
    });
    expect(container.command).toEqual(['--pw', '']);
    expect(container.unresolvedCommandElements?.[0]?.reason).toContain('secret mask');
  });

  // Issue #967: a cross-stack value recorded as the mask joined into a longer
  // element used to run `--token=***`, since only a whole-element mask was seen.
  it.each([
    [
      'Fn::Join of an Fn::ImportValue',
      { 'Fn::Join': ['', ['--token=', { 'Fn::ImportValue': 'P-Tok' }]] },
    ],
    [
      'Fn::Sub over an Fn::GetStackOutput',
      {
        'Fn::Sub': [
          '--token=${T}',
          { T: { 'Fn::GetStackOutput': { StackName: 'P', OutputName: 'Tok' } } },
        ],
      },
    ],
  ])('post-pass: refuses a mask embedded mid-element (%s)', async (_label, element) => {
    const { task, container } = resolve({ Command: ['run', element] }, stateContext());
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: {
        resolveImport: async () => '***',
        resolveGetStackOutput: async () => '***',
      },
    });
    expect(container.command).toEqual(['run', '']);
    expect(container.unresolvedCommandElements).toEqual([
      {
        field: 'Command',
        index: 1,
        reason: 'resolved a cross-stack value recorded as the secret mask (***), not the deployed value',
      },
    ]);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Container app Command\[1\]: resolved a cross-stack value recorded as the secret mask/
    );
  });

  it('post-pass: still resolves a joined cross-stack value that is not the mask', async () => {
    const { task, container } = resolve(
      {
        Command: [
          { 'Fn::Join': ['', ['--token=', { 'Fn::ImportValue': 'P-Tok' }]] },
          { 'Fn::Sub': ['--url=${U}', { U: { 'Fn::ImportValue': 'P-Url' } }] },
        ],
      },
      stateContext()
    );
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: {
        resolveImport: async (name) => (name === 'P-Tok' ? 'a***b' : 'http://p'),
        resolveGetStackOutput: async () => undefined,
      },
    });
    expect(container.command).toEqual(['--token=a***b', '--url=http://p']);
    expect(container.unresolvedCommandElements).toBeUndefined();
  });

  // Issue #967: a GetAtt target or Sub template named by a cross-stack value
  // is substituted before the sync pass, so it read the same-stack secret past
  // the literal-only secret check. CloudFormation refuses all of these shapes.
  it.each([
    [
      'Fn::GetAtt logical ID',
      { 'Fn::GetAtt': [{ 'Fn::ImportValue': 'X' }, 'SecretAccessKey'] },
      'Key',
      'Fn::GetAtt',
    ],
    [
      'Fn::GetAtt attribute name',
      { 'Fn::GetAtt': ['Key', { 'Fn::ImportValue': 'X' }] },
      'SecretAccessKey',
      'Fn::GetAtt',
    ],
    ['dotted Fn::GetAtt', { 'Fn::GetAtt': { 'Fn::ImportValue': 'X' } }, 'Key.SecretAccessKey', 'Fn::GetAtt'],
    ['Fn::Sub template', { 'Fn::Sub': { 'Fn::ImportValue': 'X' } }, '${Key.SecretAccessKey}', 'Fn::Sub'],
    [
      'Fn::Sub template with a variable map',
      { 'Fn::Sub': [{ 'Fn::ImportValue': 'X' }, {}] },
      '${Key.SecretAccessKey}',
      'Fn::Sub',
    ],
    [
      'Fn::GetAtt nested in Fn::Join',
      { 'Fn::Join': ['', ['--k=', { 'Fn::GetAtt': [{ 'Fn::ImportValue': 'X' }, 'SecretAccessKey'] }]] },
      'Key',
      'Fn::GetAtt',
    ],
  ])(
    'post-pass: refuses an attribute read built from a cross-stack value (%s)',
    async (_label, element, exported, intrinsic) => {
      const { task, container } = resolve({ Command: ['run', element] }, stateContext());
      await applyCrossStackResolverToTask(task, {
        resources: stateContext().stateResources!,
        crossStackResolver: {
          resolveImport: async () => exported,
          resolveGetStackOutput: async () => undefined,
        },
      });
      expect(container.command).toEqual(['run', '']);
      expect(container.command!.join(' ')).not.toContain('plaintext-secret');
      const reason =
        intrinsic === 'Fn::GetAtt'
          ? 'a Fn::GetAtt whose logical ID or attribute name is a cross-stack reference, which CloudFormation does not accept'
          : 'a Fn::Sub whose template is a cross-stack reference, which CloudFormation does not accept';
      expect(container.unresolvedCommandElements).toEqual([{ field: 'Command', index: 1, reason }]);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container app Command\[1\]: a Fn::/);
    }
  );

  it('post-pass: writes a resolved EntryPoint element to entryPoint, not command', async () => {
    const { task, container } = resolve(
      { Command: ['serve'], EntryPoint: ['/bin/app', { 'Fn::ImportValue': 'X' }] },
      stateContext()
    );
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: {
        resolveImport: async () => 'imported',
        resolveGetStackOutput: async () => undefined,
      },
    });
    expect(container.entryPoint).toEqual(['/bin/app', 'imported']);
    expect(container.command).toEqual(['serve']);
    expect(container.unresolvedCommandElements).toBeUndefined();
  });

  it("post-pass: resolves a same-stack name against the container's own state (mixed mode)", async () => {
    const { task, container } = resolve(
      { Command: [{ 'Fn::Join': ['/', [{ 'Fn::ImportValue': 'X' }, { Ref: 'Bucket' }]] }] },
      stateContext()
    );
    await applyCrossStackResolverToTask(
      task,
      {
        resources: {},
        crossStackResolver: {
          resolveImport: async () => 'imported',
          resolveGetStackOutput: async () => undefined,
        },
      },
      (name) =>
        name === 'app'
          ? {
              resources: { Bucket: record('AWS::S3::Bucket', 'own-bucket') },
              parameters: undefined,
              sensitiveParameters: undefined,
            }
          : undefined
    );
    expect(container.command).toEqual(['imported/own-bucket']);
  });

  it('post-pass: refuses a computed attribute read in HealthCheck.Command against the own state (mixed mode)', async () => {
    const { task, container } = resolve(
      {
        HealthCheck: {
          Command: [
            'CMD',
            {
              'Fn::GetAtt': [
                { 'Fn::GetStackOutput': { StackName: 'P', OutputName: 'Id' } },
                'SecretAccessKey',
              ],
            },
          ],
        },
      },
      stateContext()
    );
    await applyCrossStackResolverToTask(
      task,
      {
        resources: {},
        consumerRegion: 'us-east-1',
        crossStackResolver: {
          resolveImport: async () => undefined,
          resolveGetStackOutput: async () => 'Key',
        },
      },
      (name) =>
        name === 'app'
          ? {
              resources: {
                Key: record('AWS::IAM::AccessKey', 'AKIAOWN', { SecretAccessKey: 'own-plaintext' }),
              },
              parameters: undefined,
              sensitiveParameters: undefined,
            }
          : undefined
    );
    expect(container.healthCheck?.command).toEqual(['CMD', '']);
    expect(container.unresolvedCommandElements).toEqual([
      {
        field: 'HealthCheck.Command',
        index: 1,
        reason:
          'a Fn::GetAtt whose logical ID or attribute name is a cross-stack reference, which CloudFormation does not accept',
      },
    ]);
  });

  it('the runner refuses a task with an unresolved element before touching docker', async () => {
    const { task } = resolve({ Command: ['--bucket', { Ref: 'Bucket' }] });
    await expect(runEcsTask(task, {}, createEcsRunState())).rejects.toThrow(
      /Container app Command\[1\]/
    );
  });
});

// The CLI paths refuse right after the cross-stack post-pass (which may still
// resolve an element) and before any task-role credential is assumed.
describe('argv refusal wiring in run-task / start-service (issue #961)', () => {
  it.each([
    ['local-run-task.ts', 'assertEcsTaskCommandsResolved(task);'],
    ['ecs-service-emulator.ts', 'assertEcsTaskCommandsResolved(service.task);'],
  ])('%s asserts after the cross-stack post-pass and before assuming a role', async (file, call) => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL(`../../../src/cli/commands/${file}`, import.meta.url)),
      'utf-8'
    );
    const postPassIdx = source.indexOf('await applyCrossStackValuesToTask(');
    const assertIdx = source.indexOf(call);
    const assumeIdx = source.indexOf('= await assumeTaskRole(');
    expect(postPassIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(postPassIdx);
    expect(assumeIdx).toBeGreaterThan(assertIdx);
    // Unconditional: at the same depth as the post-pass's own `if`, so the
    // no-state-source run (the common refusal) reaches it too.
    const indentOf = (needle: string): number => {
      const line = source.split('\n').find((l) => l.includes(needle));
      expect(line).toBeDefined();
      return line!.length - line!.trimStart().length;
    };
    // The call is a statement of its own, not guarded on the same line.
    expect(source.split('\n').some((l) => l.trim() === call)).toBe(true);
    expect(indentOf(call)).toBe(indentOf('if (stateProvider && taskNeeds.needsCrossStackResolver)'));
  });
});
