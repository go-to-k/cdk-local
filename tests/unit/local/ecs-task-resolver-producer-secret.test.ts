import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type {
  CrossStackResolver,
  JudgedCrossStackValue,
} from '../../../src/local/state-resolver.js';

// go-to-k/cdkd#6339: the ECS cross-stack post-pass (start-service / start-alb
// / run-task) reads a resolver's judged variants when it carries them, and
// keeps a value its producer stack says is a secret off the `docker run`
// argv: refused in Command / EntryPoint / HealthCheck, value-less in
// Environment, dropped as a Secrets ValueFrom. The last block drives the
// `--from-cfn-stack` resolver itself, over a mocked CloudFormation.

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@aws-sdk/client-cloudformation', () => {
  class Command {
    public readonly input: Record<string, unknown>;
    public constructor(input: Record<string, unknown> = {}) {
      this.input = input;
    }
  }
  return {
    CloudFormationClient: class {
      send = sendMock;
      destroy(): void {}
    },
    ListStackResourcesCommand: class ListStackResourcesCommand extends Command {},
    DescribeStacksCommand: class DescribeStacksCommand extends Command {},
    ListExportsCommand: class ListExportsCommand extends Command {},
    GetTemplateCommand: class GetTemplateCommand extends Command {},
  };
});

const {
  applyCrossStackResolverToTask,
  applyCrossStackValuesToTask,
  assertEcsTaskCommandsResolved,
  resolveEcsTaskTarget,
} = await import('../../../src/local/ecs-task-resolver.js');
const { buildDockerRunArgs } = await import('../../../src/local/ecs-task-runner.js');
const { substituteEnvVarsFromStateAsync } = await import('../../../src/local/state-resolver.js');
const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');

const KEY = 'da2-producerkeyproducerkey00';
const PLAIN = 'https://producer.example.com';

function stack(container: Record<string, unknown>): StackInfo {
  return {
    stackName: 'Consumer',
    region: 'us-east-1',
    template: {
      Resources: {
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
      },
    },
  } as unknown as StackInfo;
}

const CONTAINER = {
  Command: ['serve', { 'Fn::Join': ['', ['--key=', { 'Fn::ImportValue': 'P-Key' }]] }],
  EntryPoint: ['/bin/app', { 'Fn::ImportValue': 'P-Url' }],
  HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'P-Key' }] },
  Environment: [
    { Name: 'API_KEY', Value: { 'Fn::ImportValue': 'P-Key' } },
    { Name: 'URL', Value: { 'Fn::ImportValue': 'P-Url' } },
  ],
  Secrets: [
    { Name: 'FROM_KEY', ValueFrom: { 'Fn::ImportValue': 'P-Key' } },
    { Name: 'FROM_ARN', ValueFrom: { 'Fn::ImportValue': 'P-SecretArn' } },
  ],
};

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-AbCdEf';
const VALUES: Record<string, string> = { 'P-Key': KEY, 'P-Url': PLAIN, 'P-SecretArn': SECRET_ARN };

function resolveTask() {
  // A state context, so the sync pass records the cross-stack entries for the post-pass.
  const task = resolveEcsTaskTarget('Consumer:TaskDef', [stack(CONTAINER)], {
    stateResources: {},
    pseudoParameters: { accountId: '123456789012', region: 'us-east-1', partition: 'aws' },
  });
  return { task, container: task.containers[0]! };
}

/** A resolver whose judged variants say `P-Key` holds a producer secret, with `verdicts`. */
function judgedResolver(
  verdicts: Record<string, Omit<JudgedCrossStackValue, 'value'>> = { 'P-Key': { verdict: 'secret' } }
): CrossStackResolver {
  return {
    resolveImport: async (name) => VALUES[name],
    resolveGetStackOutput: async () => undefined,
    resolveImportJudged: async (name) => ({ value: VALUES[name], ...verdicts[name] }),
    resolveGetStackOutputJudged: async () => ({ value: undefined }),
  };
}

function dockerArgv(task: ReturnType<typeof resolveTask>['task']) {
  return buildDockerRunArgs({
    task,
    container: task.containers[0]!,
    image: 'public.ecr.aws/docker/library/busybox:latest',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: undefined,
  });
}

/** The full `docker run` argv, and the env it hands the docker process instead. */
function expectKeyOffArgv(task: ReturnType<typeof resolveTask>['task']): void {
  const { args, sensitiveEnv } = dockerArgv(task);
  expect(args.join('\u0000')).not.toContain(KEY);
  // Environment is value-less: `-e API_KEY`, its value in the docker process env.
  const i = args.indexOf('API_KEY');
  expect(i).toBeGreaterThan(0);
  expect(args[i - 1]).toBe('-e');
  expect(sensitiveEnv['API_KEY']).toBe(KEY);
  // The non-secret value is unchanged.
  expect(args).toContain(`URL=${PLAIN}`);
}

describe('ECS post-pass: producer-secret verdicts (go-to-k/cdkd#6339)', () => {
  it('refuses a judged value in every argv field, serves it value-less in Environment, drops it as ValueFrom', async () => {
    const { task, container } = resolveTask();
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: judgedResolver(),
    });

    expect(container.command).toEqual(['serve', '']);
    expect(container.healthCheck?.command).toEqual(['CMD', '']);
    // A non-secret value in the same task still resolves.
    expect(container.entryPoint).toEqual(['/bin/app', PLAIN]);
    const reason =
      'resolved a cross-stack value holding a secret of the producer stack, which cdkl will not put on ' +
      'the docker run command line; pass the value through Environment instead';
    expect(container.unresolvedCommandElements).toEqual([
      { field: 'Command', index: 1, reason },
      { field: 'HealthCheck.Command', index: 1, reason },
    ]);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container app Command\[1\]: resolved a cross-stack value holding a secret/);

    expect(container.environment['API_KEY']).toBe(KEY);
    expect(container.sensitiveEnvKeys).toContain('API_KEY');
    expect(container.environment['URL']).toBe(PLAIN);
    expect(container.sensitiveEnvKeys).not.toContain('URL');

    expect(container.secrets).toEqual([{ name: 'FROM_ARN', valueFrom: SECRET_ARN }]);
    expect(container.droppedSecretNames).toContain('FROM_KEY');
    const dropped =
      'Secret FROM_KEY dropped: ValueFrom resolved a cross-stack value holding a secret of the producer stack, ' +
      'rather than naming a Secrets Manager secret or an SSM parameter';
    expect(container.warnings.filter((w) => w.startsWith('Secret FROM_KEY'))).toEqual([dropped]);
    expect(task.warnings.filter((w) => w.startsWith('Container app: Secret FROM_KEY'))).toEqual([
      `Container app: ${dropped}`,
    ]);
    expect([...container.warnings, ...task.warnings].join('\n')).not.toContain(KEY);
    expect(container.unresolvedCommandElements!.map((u) => u.reason).join('\n')).not.toContain(KEY);

    expectKeyOffArgv(task);
  });

  it('serves everything as before for a resolver with no judged variants', async () => {
    const { task, container } = resolveTask();
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: {
        resolveImport: async (name) => VALUES[name],
        resolveGetStackOutput: async () => undefined,
      },
    });
    expect(container.command).toEqual(['serve', `--key=${KEY}`]);
    expect(container.healthCheck?.command).toEqual(['CMD', KEY]);
    expect(container.unresolvedCommandElements).toBeUndefined();
    expect(container.sensitiveEnvKeys).not.toContain('API_KEY');
    expect(container.secrets.map((s) => s.name).sort()).toEqual(['FROM_ARN', 'FROM_KEY']);
  });

  it('ignores a resolver carrying only one judged variant', async () => {
    const { task, container } = resolveTask();
    const { resolveGetStackOutputJudged: _dropped, ...half } = judgedResolver();
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: half,
    });
    expect(container.command).toEqual(['serve', `--key=${KEY}`]);
  });

  it('serves a judged value with no verdict like any other', async () => {
    const { task, container } = resolveTask();
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: judgedResolver({}),
    });
    expect(container.command).toEqual(['serve', `--key=${KEY}`]);
    expect(container.unresolvedCommandElements).toBeUndefined();
    expect(container.sensitiveEnvKeys).not.toContain('API_KEY');
    expect(container.secrets.map((s) => s.name).sort()).toEqual(['FROM_ARN', 'FROM_KEY']);
  });

  it.each([
    [
      'unreadable, with a detail',
      { verdict: 'unreadable' as const, detail: 'GetTemplate of Producer failed' },
      'resolved a cross-stack value cdkl could not check for secrets (GetTemplate of Producer failed), which cdkl will not put on the docker run command line; pass the value through Environment instead',
      'Secret FROM_KEY dropped: ValueFrom resolved a cross-stack value cdkl could not check for secrets (GetTemplate of Producer failed)',
    ],
    [
      'unreadable, with no detail',
      { verdict: 'unreadable' as const },
      "resolved a cross-stack value whose producer stack cdkl could not read to check it for secrets, which cdkl will not put on the docker run command line; pass the value through Environment instead",
      'Secret FROM_KEY dropped: ValueFrom resolved a cross-stack value whose producer stack cdkl could not read to check it for secrets',
    ],
    [
      'stale',
      { verdict: 'stale' as const },
      'resolved a cross-stack value the producer stack no longer exports, so cdkl could not check it for secrets, which cdkl will not put on the docker run command line; pass the value through Environment instead',
      'Secret FROM_KEY dropped: ValueFrom resolved a cross-stack value the producer stack no longer exports, so cdkl could not check it for secrets',
    ],
  ])('fails closed on a value judged %s', async (_label, verdict, argvReason, dropped) => {
    const { task, container } = resolveTask();
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: judgedResolver({ 'P-Key': verdict }),
    });
    expect(container.unresolvedCommandElements?.map((u) => u.reason)).toEqual([argvReason, argvReason]);
    expect(container.sensitiveEnvKeys).toContain('API_KEY');
    expect(container.warnings).toContain(dropped);
    expectKeyOffArgv(task);
  });

  it('lets secret outrank a fail-closed verdict read earlier in the same element', async () => {
    const { task, container } = resolveTask();
    const t = task.resource.Properties!['ContainerDefinitions'] as Record<string, unknown>[];
    t[0]!['Command'] = [
      'serve',
      { 'Fn::Join': ['', [{ 'Fn::ImportValue': 'P-Url' }, { 'Fn::ImportValue': 'P-Key' }]] },
    ];
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: judgedResolver({
        'P-Url': { verdict: 'unreadable', detail: 'x' },
        'P-Key': { verdict: 'secret' },
      }),
    });
    expect(container.unresolvedCommandElements?.[0]?.reason).toMatch(/holding a secret of the producer stack/);
  });
});

describe('producer-secret verdicts beyond Fn::ImportValue (go-to-k/cdkd#6339)', () => {
  const GSO = { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Key' } };

  it('reads the judged Fn::GetStackOutput variant, with the same three effects', async () => {
    const task = resolveEcsTaskTarget(
      'Consumer:TaskDef',
      [
        stack({
          Command: ['serve', GSO],
          Environment: [{ Name: 'API_KEY', Value: GSO }],
          Secrets: [{ Name: 'FROM_KEY', ValueFrom: GSO }],
        }),
      ],
      { stateResources: {}, pseudoParameters: { accountId: '1', region: 'us-east-1', partition: 'aws' } }
    );
    const container = task.containers[0]!;
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: {
        resolveImport: async () => undefined,
        // The plain method would serve the key unjudged: only the judged one may be read.
        resolveGetStackOutput: async () => KEY,
        resolveImportJudged: async () => ({ value: undefined }),
        resolveGetStackOutputJudged: async () => ({ value: KEY, verdict: 'secret' }),
      },
    });
    expect(container.command).toEqual(['serve', '']);
    expect(container.unresolvedCommandElements?.[0]?.reason).toMatch(/holding a secret of the producer stack/);
    expect(container.sensitiveEnvKeys).toContain('API_KEY');
    expect(container.secrets).toEqual([]);
    expect(container.droppedSecretNames).toContain('FROM_KEY');
    const { args, sensitiveEnv } = dockerArgv(task);
    expect(args.join('\u0000')).not.toContain(KEY);
    expect(args[args.indexOf('API_KEY') - 1]).toBe('-e');
    expect(sensitiveEnv['API_KEY']).toBe(KEY);
  });

  it('fails closed on a verdict this version does not know', async () => {
    const { task, container } = resolveTask();
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: judgedResolver({
        'P-Key': { verdict: 'redacted' as unknown as 'secret' },
      }),
    });
    expect(container.unresolvedCommandElements?.[0]?.reason).toMatch(
      /whose producer stack cdkl could not read to check it for secrets/
    );
    expect(container.sensitiveEnvKeys).toContain('API_KEY');
    expectKeyOffArgv(task);
  });

  it('drops a non-string detail rather than printing it', async () => {
    const { task, container } = resolveTask();
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: judgedResolver({
        'P-Key': { verdict: 'unreadable', detail: { value: KEY } as unknown as string },
      }),
    });
    expect(container.unresolvedCommandElements?.[0]?.reason).toMatch(
      /whose producer stack cdkl could not read to check it for secrets/
    );
    expect(JSON.stringify(container.unresolvedCommandElements)).not.toContain(KEY);
  });

  it("keeps the verdict for a container resolving against its own state (mixed mode)", async () => {
    const { task, container } = resolveTask();
    await applyCrossStackResolverToTask(
      task,
      { resources: {}, consumerRegion: 'us-east-1', crossStackResolver: judgedResolver() },
      () => ({ resources: {}, parameters: undefined, sensitiveParameters: undefined })
    );
    expect(container.command).toEqual(['serve', '']);
    expect(container.sensitiveEnvKeys).toContain('API_KEY');
    expect(container.droppedSecretNames).toContain('FROM_KEY');
    expectKeyOffArgv(task);
  });

  it('passes a judged Lambda / AgentCore env value value-less, and an unjudged one inline', async () => {
    const templateEnv = {
      API_KEY: { 'Fn::ImportValue': 'P-Key' },
      URL: { 'Fn::ImportValue': 'P-Url' },
    };
    const judged = await substituteEnvVarsFromStateAsync(templateEnv, {
      resources: {},
      crossStackResolver: judgedResolver(),
    });
    expect(judged.env).toEqual({ API_KEY: KEY, URL: PLAIN });
    expect(judged.audit.sensitiveKeys).toEqual(['API_KEY']);
    const plain = await substituteEnvVarsFromStateAsync(templateEnv, {
      resources: {},
      crossStackResolver: {
        resolveImport: async (name) => VALUES[name],
        resolveGetStackOutput: async () => undefined,
      },
    });
    expect(plain.env).toEqual({ API_KEY: KEY, URL: PLAIN });
    expect(plain.audit.sensitiveKeys).toEqual([]);
  });
});

describe('--from-cfn-stack resolver through the ECS post-pass (go-to-k/cdkd#6339)', () => {
  const PRODUCER = 'arn:aws:cloudformation:us-east-1:123456789012:stack/Producer/p-1';
  let getTemplateFails = false;

  beforeEach(() => {
    getTemplateFails = false;
    sendMock.mockReset();
    sendMock.mockImplementation(
      (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        if (name === 'ListExportsCommand') {
          return Promise.resolve({
            Exports: [
              { Name: 'P-Key', Value: KEY, ExportingStackId: PRODUCER },
              { Name: 'P-Url', Value: PLAIN, ExportingStackId: PRODUCER },
              { Name: 'P-SecretArn', Value: SECRET_ARN, ExportingStackId: PRODUCER },
            ],
          });
        }
        if (cmd.input['StackName'] !== PRODUCER) return Promise.reject(new Error('no such stack'));
        if (name === 'ListStackResourcesCommand') {
          return Promise.resolve({
            StackResourceSummaries: [
              {
                LogicalResourceId: 'ApiKey',
                PhysicalResourceId: `arn:aws:appsync:us-east-1:123456789012:apis/a1/apikeys/${KEY}`,
                ResourceType: 'AWS::AppSync::ApiKey',
              },
            ],
          });
        }
        if (name === 'DescribeStacksCommand') {
          return Promise.resolve({
            Stacks: [
              {
                Outputs: [
                  { OutputKey: 'Key', OutputValue: KEY, ExportName: 'P-Key' },
                  { OutputKey: 'Url', OutputValue: PLAIN, ExportName: 'P-Url' },
                  { OutputKey: 'Arn', OutputValue: SECRET_ARN, ExportName: 'P-SecretArn' },
                ],
              },
            ],
          });
        }
        if (name === 'GetTemplateCommand') {
          if (getTemplateFails) return Promise.reject(new Error('AccessDenied'));
          return Promise.resolve({
            TemplateBody: JSON.stringify({
              Resources: { ApiKey: { Type: 'AWS::AppSync::ApiKey' }, Db: { Type: 'AWS::SecretsManager::Secret' } },
              Outputs: {
                Key: { Value: { 'Fn::GetAtt': ['ApiKey', 'ApiKey'] } },
                Url: { Value: PLAIN },
                Arn: { Value: { Ref: 'Db' } },
              },
            }),
          });
        }
        return Promise.reject(new Error(`unexpected ${name}`));
      }
    );
  });

  async function run() {
    const provider = new CfnLocalStateProvider({ cfnStackName: 'Consumer', region: 'us-east-1' });
    const resolver = (await provider.buildCrossStackResolver('us-east-1'))!;
    const { task, container } = resolveTask();
    await applyCrossStackValuesToTask(task, resolver, {
      imageContext: { stateResources: {} },
      consumerRegion: 'us-east-1',
    });
    provider.dispose();
    return { task, container };
  }

  it("keeps a producer's exported ApiKey off the full docker run argv, and serves the rest", async () => {
    const { task, container } = await run();
    expect(container.command).toEqual(['serve', '']);
    expect(container.entryPoint).toEqual(['/bin/app', PLAIN]);
    expect(container.unresolvedCommandElements?.map((u) => u.field)).toEqual([
      'Command',
      'HealthCheck.Command',
    ]);
    expect(container.secrets).toEqual([{ name: 'FROM_ARN', valueFrom: SECRET_ARN }]);
    expectKeyOffArgv(task);
  });

  it('fails closed when the producer template cannot be read, serving Environment value-less', async () => {
    getTemplateFails = true;
    const { task, container } = await run();
    expect(container.entryPoint).toEqual(['/bin/app', '']);
    const reasons = Object.fromEntries(
      (container.unresolvedCommandElements ?? []).map((u) => [u.field, u.reason])
    );
    // The key is still told by its physical id; the plain value is withheld unjudged.
    expect(reasons['Command']).toMatch(/holding a secret of the producer stack/);
    expect(reasons['EntryPoint']).toMatch(
      /could not check for secrets \(GetTemplate of .*Producer\/p-1 failed: /
    );
    expect(container.sensitiveEnvKeys).toEqual(expect.arrayContaining(['API_KEY', 'URL']));
    expect(container.secrets).toEqual([]);
    const { args } = dockerArgv(task);
    expect(args.join('\u0000')).not.toContain(KEY);
    expect(args.join('\u0000')).not.toContain(PLAIN);
  });
});
