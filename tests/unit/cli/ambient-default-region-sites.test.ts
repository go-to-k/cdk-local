import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import { setAmbientDefaultRegion } from '../../../src/utils/ambient-default-region.js';

/**
 * go-to-k/cdk-local#963 — the CALL SITES. A host (cdkd `--aws-emulator`)
 * copies a DEFAULT region into `process.env.AWS_REGION` and records it with
 * `setAmbientDefaultRegion`. Every chain that ranks the host `AWS_REGION`
 * above a stack's `env.region` or a state record's region must rank that
 * default BELOW them: a stack pinned to `us-west-2` resolves `us-west-2`, and
 * an environment-agnostic stack resolves the default. Without a record (the
 * standalone `cdkl` case) the host `AWS_REGION` still wins, as before.
 *
 * Each site is driven separately: a helper being correct says nothing about
 * whether a given chain reads it. The command-body `consumerRegion` sites are
 * in `ambient-default-region-consumer.test.ts`.
 */

const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn() }));

/** Thrown by the mocked bundle download once it has captured its region. */
class CapturedError extends Error {}

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    // The SDK's own default region chain: the last resort, never reached here.
    config = { region: async () => 'ap-east-1' };
    send = vi.fn().mockResolvedValue({ Account: '111111111111' });
    destroy(): void {}
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('../../../src/local/agentcore-s3-bundle.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadAndExtractS3Bundle: downloadMock,
}));

const { resolveContainerRegion } = await import('../../../src/utils/profile-region.js');
const { buildEcsImageResolutionContext: buildStartServiceContext } = await import(
  '../../../src/cli/commands/local-start-service.js'
);
const { buildEcsImageResolutionContext: buildRunTaskContext } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const {
  buildAgentCoreImageContext,
  resolveAgentCoreCodeImageFromS3,
  resolveAgentCoreSigV4Context,
} = await import('../../../src/cli/commands/local-invoke-agentcore.js');
const { resolveCfnRegion } = await import('../../../src/cli/commands/local-state-source.js');
const { resolvePseudoParametersForInvoke } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolvePseudoParametersForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);

/** An ECS stack whose container env needs pseudo parameters (an SSM `Ref`). */
function ecsStack(region: string | undefined): StackInfo {
  return {
    stackName: 'MyStack',
    ...(region !== undefined && { region }),
    template: {
      Parameters: {
        SsmDbHost: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
      },
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              { Name: 'app', Environment: [{ Name: 'DB_HOST', Value: { Ref: 'SsmDbHost' } }] },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

function provider(): LocalStateProvider {
  return {
    label: '--from-state',
    load: vi.fn().mockResolvedValue(undefined),
    buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as LocalStateProvider;
}

function agentRuntime(region: string | undefined): ResolvedAgentCoreRuntime {
  return {
    stack: {
      stackName: 'App',
      ...(region !== undefined && { region }),
    } as ResolvedAgentCoreRuntime['stack'],
    logicalId: 'ChatAgent',
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    containerUri: 'repo:tag',
    environmentVariables: {},
    protocol: 'HTTP',
  } as unknown as ResolvedAgentCoreRuntime;
}

interface Site {
  name: string;
  /** The region the chain resolves for a stack (or state record) region. */
  resolve: (stackRegion: string | undefined) => Promise<string | undefined>;
  /** Whether the site's stack-side input can be absent (an env-agnostic stack). */
  agnostic: boolean;
}

const sites: Site[] = [
  {
    name: 'profile-region.ts / resolveContainerRegion',
    resolve: (stackRegion) => resolveContainerRegion({ stackRegion }),
    agnostic: true,
  },
  {
    name: 'profile-region.ts / resolveContainerRegion (state record region)',
    resolve: (stateRegion) => resolveContainerRegion({ stateRegion }),
    agnostic: true,
  },
  {
    name: 'ecs-service-emulator.ts / buildEcsImageResolutionContext',
    resolve: async (r) =>
      (
        await buildStartServiceContext(
          'MyStack:WebService',
          [ecsStack(r)],
          {} as never,
          provider()
        )
      )?.pseudoParameters?.region,
    agnostic: true,
  },
  {
    name: 'local-run-task.ts / buildEcsImageResolutionContext',
    resolve: async (r) =>
      (await buildRunTaskContext(ecsStack(r), provider(), {} as never))?.pseudoParameters?.region,
    agnostic: true,
  },
  {
    name: 'local-invoke-agentcore.ts / buildAgentCoreImageContext',
    resolve: async (r) =>
      (await buildAgentCoreImageContext(ecsStack(r), provider(), {} as never)).context
        ?.pseudoParameters?.region,
    agnostic: true,
  },
  {
    name: 'local-invoke-agentcore.ts / resolveAgentCoreSigV4Context',
    resolve: async (r) =>
      (await resolveAgentCoreSigV4Context({ sigv4: true } as never, agentRuntime(r), undefined))
        ?.region,
    agnostic: true,
  },
  {
    name: 'local-invoke-agentcore.ts / resolveAgentCoreCodeImageFromS3',
    resolve: async (r) => {
      downloadMock.mockReset().mockImplementation(async () => {
        throw new CapturedError('captured');
      });
      await resolveAgentCoreCodeImageFromS3(
        agentRuntime(r),
        { runtime: 'python3.12', entryPoint: ['app.py'] } as never,
        { bucket: 'bkt', key: 'bundle.zip' } as never,
        {} as never,
        'x86_64',
        undefined,
        undefined
      ).catch((e: unknown) => {
        if (!(e instanceof CapturedError)) throw e;
      });
      const opts = downloadMock.mock.calls[0]![1] as { region?: string };
      return opts.region;
    },
    agnostic: true,
  },
  {
    name: 'local-state-source.ts / resolveCfnRegion',
    resolve: async (r) => resolveCfnRegion({}, r),
    agnostic: true,
  },
  {
    name: 'local-invoke.ts / resolvePseudoParametersForInvoke',
    resolve: async (r) => (await resolvePseudoParametersForInvoke(r, {}))?.region,
    agnostic: true,
  },
  {
    // The state record's region: always named, so no env-agnostic case.
    name: 'local-start-api.ts / resolvePseudoParametersForStartApi',
    resolve: async (r) => (await resolvePseudoParametersForStartApi(r!, {} as never))?.region,
    agnostic: false,
  },
];

describe('region chains rank a host ambient default below the stack region (go-to-k/cdk-local#963)', () => {
  const saved = {
    AWS_REGION: process.env['AWS_REGION'],
    AWS_DEFAULT_REGION: process.env['AWS_DEFAULT_REGION'],
    AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
    AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
  };

  beforeEach(() => {
    process.env['AWS_REGION'] = 'eu-south-1';
    delete process.env['AWS_DEFAULT_REGION'];
    // `--sigv4` signs with host credentials; any non-empty pair will do.
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIDUNITTEST';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'unit-test-secret';
  });

  afterEach(() => {
    setAmbientDefaultRegion(undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe.each(sites)('$name', (site) => {
    it('a stack pinned to us-west-2 resolves us-west-2 when AWS_REGION holds the default', async () => {
      setAmbientDefaultRegion('eu-south-1');
      expect(await site.resolve('us-west-2')).toBe('us-west-2');
    });

    it.runIf(site.agnostic)(
      'an environment-agnostic stack resolves the default',
      async () => {
        setAmbientDefaultRegion('eu-south-1');
        expect(await site.resolve(undefined)).toBe('eu-south-1');
        // The placeholder cx-api reports for a stack with no `env.region`.
        expect(await site.resolve('unknown-region')).toBe('eu-south-1');
      }
    );

    it('without a recorded default (standalone cdkl) the host AWS_REGION still wins', async () => {
      expect(await site.resolve('us-west-2')).toBe('eu-south-1');
    });

    it('a region the user named in AWS_REGION still wins over the stack region', async () => {
      setAmbientDefaultRegion('eu-south-1');
      process.env['AWS_REGION'] = 'ap-south-1';
      expect(await site.resolve('us-west-2')).toBe('ap-south-1');
    });
  });
});
