import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * #1004: `runEcsServiceEmulator` resolves the front-door plan's intrinsic
 * authenticate-* guards against the state source BEFORE the front-door is
 * built. The boot is stopped at the shared-network step (the first docker
 * call after the resolver), so these tests observe what the resolver did
 * without docker: a state load that throws does not abort the boot, the
 * provider is disposed, the warning names the cause, and `--no-verify-auth`
 * skips the resolver entirely. Removing the resolver call from the boot
 * turns the load / warning assertions red.
 */

const { createSharedSvcNetwork } = vi.hoisted(() => ({
  createSharedSvcNetwork: vi.fn(),
}));

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/docker-runner.js')>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
}));
vi.mock('../../../src/local/ecs-network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/ecs-network.js')>()),
  createSharedSvcNetwork,
}));
vi.mock('../../../src/local/workload-aws-wiring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/local/workload-aws-wiring.js')>()),
  activateWorkloadAwsWiring: vi.fn(async () => undefined),
  getActiveWorkloadAwsWiring: vi.fn(() => undefined),
  resolveHostDefaultCredentials: vi.fn(async () => undefined),
}));
vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/role-arn.js')>()),
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

import { runEcsServiceEmulator } from '../../../src/cli/commands/ecs-service-emulator.js';
import { albStrategy } from '../../../src/cli/commands/local-start-alb.js';
import { LocalStateSourceError } from '../../../src/cli/commands/local-state-source.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { getLogger } from '../../../src/utils/logger.js';

const COGNITO_DEFAULT_ACTION = {
  Type: 'authenticate-cognito',
  AuthenticateCognitoConfig: {
    UserPoolArn: { 'Fn::GetAtt': ['Pool', 'Arn'] },
    UserPoolClientId: { Ref: 'Client' },
    UserPoolDomain: { Ref: 'Domain' },
  },
};

function albStack(terminal: Record<string, unknown>, extra: Record<string, unknown> = {}): StackInfo {
  return {
    stackName: 'AlbStack',
    template: {
      Resources: {
        WebLB: {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: { Type: 'application' },
        },
        Pool: { Type: 'AWS::Cognito::UserPool', Properties: {} },
        Client: { Type: 'AWS::Cognito::UserPoolClient', Properties: {} },
        WebListener: {
          Type: 'AWS::ElasticLoadBalancingV2::Listener',
          Properties: {
            LoadBalancerArn: { Ref: 'WebLB' },
            Port: 80,
            Protocol: 'HTTP',
            DefaultActions: [COGNITO_DEFAULT_ACTION, terminal],
          },
        },
        ...extra,
      },
    },
  } as unknown as StackInfo;
}

const FIXED_RESPONSE = {
  Type: 'fixed-response',
  FixedResponseConfig: { StatusCode: '200', MessageBody: 'secret' },
};

/** A front-door whose only target is a Lambda (no ECS service to boot). */
const lambdaOnlyStack = (): StackInfo =>
  albStack(
    { Type: 'forward', TargetGroupArn: { Ref: 'FnTg' } },
    {
      FnTg: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: { TargetType: 'lambda', Targets: [{ Id: { 'Fn::GetAtt': ['EchoFn', 'Arn'] } }] },
      },
      EchoFn: {
        Type: 'AWS::Lambda::Function',
        Properties: { Runtime: 'nodejs22.x', Handler: 'index.handler', Code: { ZipFile: 'x' } },
      },
    }
  );

function baseOptions(extra: Record<string, unknown> = {}): never {
  return {
    output: 'cdk.out',
    verbose: false,
    cluster: 'cdkl',
    containerHost: '127.0.0.1',
    pull: true,
    maxTasks: 3,
    restartPolicy: 'on-failure',
    app: 'node app.js',
    ...extra,
  } as never;
}

async function boot(
  stack: StackInfo,
  options: never,
  extra?: Record<string, unknown>
): Promise<unknown> {
  const synthesizer = { synthesize: async () => ({ stacks: [stack] }) };
  return runEcsServiceEmulator(
    ['AlbStack:WebLB'],
    options,
    albStrategy(options),
    extra as never,
    synthesizer as never
  ).then(
    () => undefined,
    (err: unknown) => err
  );
}

let warnSpy: ReturnType<typeof vi.spyOn>;
const warnText = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  createSharedSvcNetwork.mockReset();
  createSharedSvcNetwork.mockRejectedValue(new Error('boot stopped by the test'));
  warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runEcsServiceEmulator resolves front-door auth guards before the front-door (#1004)', () => {
  it('continues the boot when the state load throws, disposes the provider, and names the cause', async () => {
    const load = vi.fn(async () => {
      throw new Error('ExpiredToken: the security token has expired');
    });
    const dispose = vi.fn();
    const err = await boot(albStack(FIXED_RESPONSE), baseOptions({ fromFake: true }), {
      fromFake: () => ({ label: '--from-fake', load, dispose }),
    });
    // The boot went past the resolver to the next step (the shared network).
    expect(String(err)).toMatch(/boot stopped by the test/);
    expect(createSharedSvcNetwork).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('AlbStack', undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
    const text = warnText();
    expect(text).toMatch(/UserPoolArn is an intrinsic .* could not resolve/);
    expect(text).toMatch(/did not load: ExpiredToken: the security token has expired/);
    // The user already passed a state source: the hint does not ask for one.
    expect(text).not.toMatch(/--from-cfn-stack/);
  });

  it('warns (naming --from-cfn-stack) when no state source is active', async () => {
    const err = await boot(albStack(FIXED_RESPONSE), baseOptions());
    expect(String(err)).toMatch(/boot stopped by the test/);
    expect(warnText()).toMatch(/UserPoolArn is an intrinsic .* could not resolve \(no state source is active\)/);
    expect(warnText()).toMatch(/--from-cfn-stack/);
  });

  it('skips the resolver and its warnings under --no-verify-auth', async () => {
    const load = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const err = await boot(
      albStack(FIXED_RESPONSE),
      baseOptions({ fromFake: true, verifyAuth: false }),
      { fromFake: () => ({ label: '--from-fake', load, dispose }) }
    );
    expect(String(err)).toMatch(/boot stopped by the test/);
    expect(load).not.toHaveBeenCalled();
    expect(warnText()).not.toMatch(/authenticate-cognito/);
  });

  it('fails a Lambda-only front-door boot on a state-source flag error before the front-door is built', async () => {
    // Pre-#1004 the same LocalStateSourceError surfaced from the Lambda
    // target's state load inside buildFrontDoor; the guard resolver now
    // meets it first. Either way the boot stops with that error, and no
    // docker network is created.
    const err = await boot(
      lambdaOnlyStack(),
      baseOptions({ fromCfnStack: true, fromFake: true, region: 'us-east-1' }),
      { fromFake: () => ({ label: '--from-fake', load: vi.fn(), dispose: vi.fn() }) }
    );
    expect(err).toBeInstanceOf(LocalStateSourceError);
    expect(String(err)).toMatch(/mutually exclusive/);
    expect(createSharedSvcNetwork).not.toHaveBeenCalled();
  });
});
