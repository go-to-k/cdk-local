import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Command } from 'commander';
import type { CdkAppSynthesizer } from '../../../src/synthesis/synthesizer.js';

/**
 * A host synthesizer may set `SynthesisResult.checkSelectedStacks`; each serve
 * command must call it exactly once at boot, with only the stacks its target
 * resolved to (never an unrelated stack in the assembly), before any state read
 * or docker work. The hook here throws, so a command that reaches past the
 * selection point instead of exiting would show up as a missing exit.
 */

const state = vi.hoisted(() => ({ createLocalStateProvider: undefined as unknown }));

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  const createLocalStateProvider = vi.fn(() => undefined);
  state.createLocalStateProvider = createLocalStateProvider;
  return { ...actual, createLocalStateProvider };
});

const { createLocalStartAgentCoreCommand } = await import(
  '../../../src/cli/commands/local-start-agentcore.js'
);
const { createLocalStartCloudFrontCommand } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
);
const { createLocalStartServiceCommand } = await import(
  '../../../src/cli/commands/local-start-service.js'
);
const { createLocalStartAlbCommand } = await import('../../../src/cli/commands/local-start-alb.js');
const { createLocalStartWebFunctionCommand } = await import(
  '../../../src/cli/commands/local-start-web-function.js'
);
const { createLocalStartMicrovmCommand } = await import(
  '../../../src/cli/commands/local-start-microvm.js'
);

type Factory = (opts: { synthesizer?: CdkAppSynthesizer }) => Command;

class Exit extends Error {}

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(`exit ${code}`);
  }) as never);
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stack(name: string, resources: Record<string, unknown>): Record<string, unknown> {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    region: 'us-east-1',
    dependencyNames: [],
    template: { Resources: resources },
  };
}

/** An unrelated stack, listed FIRST so a "first stack" shortcut would pick it. */
const other = (): Record<string, unknown> =>
  stack('Other', { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } });

const ecsService = (container: string): Record<string, unknown> => ({
  Type: 'AWS::ECS::Service',
  Properties: { LoadBalancers: [{ ContainerName: container, ContainerPort: 80 }] },
});

/** Runs the command against a host synthesizer whose hook records and throws. */
async function runWithHook(
  factory: Factory,
  stacks: Record<string, unknown>[],
  args: string[]
): Promise<{ calls: (readonly string[])[] }> {
  const calls: (readonly string[])[] = [];
  const host = {
    async synthesize() {
      return {
        stacks,
        checkSelectedStacks: (names: readonly string[]) => {
          calls.push(names);
          throw new Error('STOP: checked');
        },
      };
    },
  } as unknown as CdkAppSynthesizer;
  const cmd = factory({ synthesizer: host });
  cmd.exitOverride();
  await expect(cmd.parseAsync(['node', 'cdkl', ...args, '--app', 'node app.js'])).rejects.toThrow(
    Exit
  );
  // The hook's error reached the command's error path.
  expect(lines.join('\n')).toContain('STOP: checked');
  return { calls };
}

describe('checkSelectedStacks at boot', () => {
  it('start-agentcore: only the runtime stack, before the state provider is created', async () => {
    const runtime = {
      Type: 'AWS::BedrockAgentCore::Runtime',
      Properties: {
        AgentRuntimeName: 'my-agent',
        RoleArn: 'arn:aws:iam::123456789012:role/AgentRole',
        ProtocolConfiguration: 'HTTP',
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:v1',
          },
        },
      },
    };
    const { calls } = await runWithHook(
      createLocalStartAgentCoreCommand,
      [other(), stack('Agents', { Agent: runtime })],
      ['Agents:Agent']
    );
    expect(calls).toEqual([['Agents']]);
    expect(state.createLocalStateProvider).not.toHaveBeenCalled();
  });

  it('start-cloudfront: only the distribution stack', async () => {
    const dist = {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Origins: [
            {
              Id: 'o1',
              DomainName: { 'Fn::GetAtt': ['SiteBucket', 'RegionalDomainName'] },
              S3OriginConfig: { OriginAccessIdentity: '' },
            },
          ],
          DefaultCacheBehavior: { TargetOriginId: 'o1', ViewerProtocolPolicy: 'allow-all' },
        },
      },
    };
    const { calls } = await runWithHook(
      createLocalStartCloudFrontCommand,
      [
        other(),
        stack('Site', { SiteBucket: { Type: 'AWS::S3::Bucket', Properties: {} }, Dist: dist }),
      ],
      ['Site:Dist']
    );
    expect(calls).toEqual([['Site']]);
  });

  it('start-service: the stack of every chosen service, never the unrelated one', async () => {
    const { calls } = await runWithHook(
      createLocalStartServiceCommand,
      [
        other(),
        stack('SvcA', { ServiceA: ecsService('a') }),
        stack('SvcB', { ServiceB: ecsService('b') }),
      ],
      ['SvcA:ServiceA', 'SvcB:ServiceB']
    );
    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual(['SvcA', 'SvcB']);
  });

  // The front-door resolver reads an ALB's listeners, target groups, services and
  // Lambdas from the ALB's own stack, so the cross-stack part of the union is the
  // multi-target case: two ALBs in two stacks, one carrying a Lambda target group.
  it('start-alb: the stack of every chosen ALB (services and Lambda targets included)', async () => {
    const alb = (tgLogicalId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
      Alb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application' } },
      Listener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'Alb' },
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: tgLogicalId } }],
        },
      },
      ...extra,
    });
    const front = stack(
      'Front',
      alb('EcsTg', {
        EcsTg: {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: { Port: 80, Protocol: 'HTTP', TargetType: 'ip' },
        },
        Service: {
          Type: 'AWS::ECS::Service',
          Properties: {
            LoadBalancers: [{ ContainerName: 'web', ContainerPort: 80, TargetGroupArn: { Ref: 'EcsTg' } }],
          },
        },
      })
    );
    const back = stack(
      'Back',
      alb('FnTg', {
        FnTg: {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: { TargetType: 'lambda', Targets: [{ Id: { 'Fn::GetAtt': ['Fn', 'Arn'] } }] },
        },
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Handler: 'index.handler', Runtime: 'nodejs20.x', Code: { ZipFile: '' } },
        },
      })
    );
    const { calls } = await runWithHook(
      createLocalStartAlbCommand,
      [other(), front, back],
      ['Front:Alb', 'Back:Alb']
    );
    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual(['Back', 'Front']);
  });

  it('start-web-function: only the web function stack', async () => {
    const resources = {
      WebFn: { Type: 'AWS::Lambda::WebFunction', Properties: { FunctionName: 'my-web' } },
      Rev: {
        Type: 'AWS::Lambda::WebFunctionRevision',
        Properties: {
          FunctionName: { Ref: 'WebFn' },
          BuildConfig: {
            CodeConfig: { S3Object: { Bucket: 'b', Key: 'abc123.zip' } },
            RuntimeConfig: { Runtime: 'nodejs24.x' },
          },
        },
      },
      Ep: {
        Type: 'AWS::Lambda::WebFunctionEndpoint',
        Properties: {
          FunctionName: { Ref: 'WebFn' },
          EndpointName: 'main',
          EndpointType: 'HomeRegion',
          AuthType: 'ApplicationManaged',
          RevisionWeights: [{ RevisionId: { 'Fn::GetAtt': ['Rev', 'RevisionId'] }, Weight: 100 }],
        },
      },
    };
    const { calls } = await runWithHook(
      createLocalStartWebFunctionCommand,
      [other(), stack('Web', resources)],
      ['Web:Ep']
    );
    expect(calls).toEqual([['Web']]);
  });

  it('start-microvm: only the MicroVM image stack', async () => {
    const image = {
      Type: 'AWS::Lambda::MicrovmImage',
      Properties: {
        Name: 'my-image',
        CodeArtifact: { Uri: 's3://bucket/abc123.zip' },
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        Hooks: { Port: 9001 },
      },
    };
    const { calls } = await runWithHook(
      createLocalStartMicrovmCommand,
      [other(), stack('Vm', { Img: image })],
      ['Vm:Img']
    );
    expect(calls).toEqual([['Vm']]);
  });
});
