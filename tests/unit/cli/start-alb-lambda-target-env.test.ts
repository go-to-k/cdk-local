import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { FrontDoorPlan } from '../../../src/cli/commands/ecs-service-emulator.js';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';

// Issue #380 — lock the binding that threads each ALB `TargetType: lambda`
// target group's container env (resolved the same way `cdkl invoke` does)
// into its front-door RIE runner. Mock the two boundaries `buildFrontDoor`
// drives for a Lambda target — the shared env resolver and the runner factory
// — and assert the env options + resolved env reach them. The front-door HTTP
// server still binds a real ephemeral socket (closed in the test).
const { resolveContainerEnvMock, createRunnerMock } = vi.hoisted(() => ({
  resolveContainerEnvMock: vi.fn(),
  createRunnerMock: vi.fn(),
}));

vi.mock('../../../src/cli/commands/local-invoke.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/cli/commands/local-invoke.js')>();
  return { ...actual, resolveLambdaContainerEnv: resolveContainerEnvMock };
});
vi.mock('../../../src/local/front-door-lambda-runner.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../../src/local/front-door-lambda-runner.js')>();
  return { ...actual, createFrontDoorLambdaRunner: createRunnerMock };
});

const { buildFrontDoor } = await import('../../../src/cli/commands/ecs-service-emulator.js');

const lambda = { logicalId: 'EchoFn', functionName: 'echo' } as unknown as ResolvedLambda;

/** A one-listener plan whose default action forwards to a single Lambda target. */
function lambdaPlan(): FrontDoorPlan {
  return {
    listeners: [
      {
        listenerPort: 80,
        hostPort: 0, // ephemeral — no privileged bind in the unit test
        protocol: 'HTTP',
        defaultAction: {
          kind: 'forward',
          targets: [
            {
              kind: 'lambda',
              lambda,
              targetGroupArn: 'AlbStack:WebTargetGroup',
              multiValueHeaders: false,
              weight: 1,
            },
          ],
        },
        rules: [],
      },
    ],
  };
}

const logger = { info: () => {}, warn: () => {} } as never;
const extraStateProviders = { marker: 'providers' } as never;

beforeEach(() => {
  resolveContainerEnvMock.mockReset();
  createRunnerMock.mockReset();
  resolveContainerEnvMock.mockResolvedValue({
    env: { TABLE_NAME: 'deployed-table', AWS_LAMBDA_FUNCTION_NAME: 'EchoFn' },
    sensitiveEnvKeys: ['DB_SECRET'],
    assumeRoleApplied: true,
  });
  createRunnerMock.mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    invoke: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildFrontDoor — ALB Lambda-target container env (issue #380)', () => {
  it('resolves each Lambda target env via the shared resolver and threads it into the runner', async () => {
    const options = {
      containerHost: '127.0.0.1',
      pull: true,
      fromCfnStack: 'MyStack',
      assumeRole: true,
      region: 'us-east-1',
      stackRegion: 'us-west-2',
      envVars: '/tmp/env.json',
    } as never;

    const { servers, lambdaRunners } = await buildFrontDoor(
      lambdaPlan(),
      options,
      logger,
      extraStateProviders
    );
    try {
      // The shared resolver was called once for the backing Lambda, with the
      // state-source + assume-role + env-vars options collapsed from the ALB
      // flags, plus the emulator's state providers.
      expect(resolveContainerEnvMock).toHaveBeenCalledTimes(1);
      const [passedLambda, envOptions, profileCreds, passedProviders] =
        resolveContainerEnvMock.mock.calls[0]!;
      expect((passedLambda as ResolvedLambda).logicalId).toBe('EchoFn');
      expect(envOptions).toEqual({
        fromCfnStack: 'MyStack',
        assumeRole: true,
        region: 'us-east-1',
        stackRegion: 'us-west-2',
        envVars: '/tmp/env.json',
      });
      expect(profileCreds).toBeUndefined(); // no --profile -> shell creds
      expect(passedProviders).toBe(extraStateProviders);

      // The resolved env + sensitive keys reached the runner factory.
      expect(createRunnerMock).toHaveBeenCalledTimes(1);
      const runnerOpts = createRunnerMock.mock.calls[0]![1] as {
        containerEnv?: Record<string, string>;
        sensitiveEnvKeys?: Set<string>;
      };
      expect(runnerOpts.containerEnv).toEqual({
        TABLE_NAME: 'deployed-table',
        AWS_LAMBDA_FUNCTION_NAME: 'EchoFn',
      });
      expect(runnerOpts.sensitiveEnvKeys).toEqual(new Set(['DB_SECRET']));
      expect(lambdaRunners).toHaveLength(1);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });

  it('resolves env ONCE per unique backing Lambda across multiple rules', async () => {
    const plan = lambdaPlan();
    // A second rule forwarding to the SAME Lambda must not re-resolve its env.
    plan.listeners[0]!.rules.push({
      priority: 10,
      pathPatterns: ['/api/*'],
      hostPatterns: [],
      httpHeaderConditions: [],
      httpRequestMethods: [],
      queryStringConditions: [],
      sourceIpCidrs: [],
      action: {
        kind: 'forward',
        targets: [
          {
            kind: 'lambda',
            lambda,
            targetGroupArn: 'AlbStack:WebTargetGroup',
            multiValueHeaders: false,
            weight: 1,
          },
        ],
      },
    });

    const { servers } = await buildFrontDoor(
      plan,
      { containerHost: '127.0.0.1', pull: true } as never,
      logger,
      undefined
    );
    try {
      expect(resolveContainerEnvMock).toHaveBeenCalledTimes(1);
      expect(createRunnerMock).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });

  it('does not resolve any Lambda env for an ECS-only plan (start-service path)', async () => {
    const plan: FrontDoorPlan = {
      listeners: [
        {
          listenerPort: 80,
          hostPort: 0,
          protocol: 'HTTP',
          defaultAction: {
            kind: 'forward',
            targets: [
              {
                kind: 'ecs',
                serviceTarget: 'S:Web',
                targetContainerName: 'web',
                targetContainerPort: 80,
                weight: 1,
              },
            ],
          },
          rules: [],
        },
      ],
    };
    const { servers } = await buildFrontDoor(
      plan,
      { containerHost: '127.0.0.1', pull: true } as never,
      logger,
      undefined
    );
    try {
      expect(resolveContainerEnvMock).not.toHaveBeenCalled();
      expect(createRunnerMock).not.toHaveBeenCalled();
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });
});
