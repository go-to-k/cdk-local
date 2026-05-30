import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';

/**
 * Site-level binding test for the `--from-cfn-stack` load-failure
 * detail wiring on `cdkl start-service` / `cdkl start-alb`.
 *
 * When the state provider's `load()` returns undefined AND the provider
 * implements the optional `getLastLoadError()`, the context builder
 * MUST stash the returned message on `ctx.stateLoadFailureMessage` so
 * the downstream ECS resolver's "needs deployed state" error reports
 * what AWS actually said instead of the misleading "pass --from-cfn-stack"
 * hint (the user already passed it). Mirrors the SSM-parameter
 * binding test pattern.
 */

const { stsSendMock } = vi.hoisted(() => ({ stsSendMock: vi.fn() }));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const { buildEcsImageResolutionContext } = await import(
  '../../../src/cli/commands/local-start-service.js'
);

function ecrEnvStack(): StackInfo {
  // A TaskDef whose container image references a same-stack
  // AWS::ECR::Repository via `Ref` — triggers `needsStateResources`
  // in `detectEcsImageResolutionNeeds` so `wantsState` is true and
  // the builder reaches the `stateProvider.load()` path.
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Resources: {
        Repo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: {
                  'Fn::Join': [
                    '',
                    [
                      { 'Fn::Select': [4, { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo', 'Arn'] }] }] },
                      '.dkr.ecr.',
                      { 'Fn::Select': [3, { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo', 'Arn'] }] }] },
                      '.',
                      { Ref: 'AWS::URLSuffix' },
                      '/',
                      { Ref: 'Repo' },
                      ':latest',
                    ],
                  ],
                },
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('start-service buildEcsImageResolutionContext load-failure binding', () => {
  beforeEach(() => {
    stsSendMock.mockReset();
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
  });

  it('captures provider.getLastLoadError() into ctx.stateLoadFailureMessage when load returns undefined', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue(undefined),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      getLastLoadError: vi
        .fn()
        .mockReturnValue(
          "ListStackResources(dev-goto-Reco-App) failed: ValidationError HTTP 400: Stack with id dev-goto-Reco-App does not exist (region='ap-northeast-1')"
        ),
      dispose: vi.fn(),
    } as unknown as LocalStateProvider & {
      getLastLoadError: ReturnType<typeof vi.fn>;
    };

    const ctx = await buildEcsImageResolutionContext(
      'MyStack:TaskDef',
      [ecrEnvStack()],
      {} as never,
      provider
    );

    expect(provider.getLastLoadError).toHaveBeenCalledTimes(1);
    expect(ctx?.stateLoadFailureMessage).toContain('ListStackResources(dev-goto-Reco-App) failed:');
    expect(ctx?.stateResources).toBeUndefined();
  });

  it('leaves stateLoadFailureMessage undefined when load() succeeds', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      getLastLoadError: vi.fn().mockReturnValue(undefined),
      dispose: vi.fn(),
    } as unknown as LocalStateProvider;

    const ctx = await buildEcsImageResolutionContext(
      'MyStack:TaskDef',
      [ecrEnvStack()],
      {} as never,
      provider
    );

    expect(ctx?.stateLoadFailureMessage).toBeUndefined();
    expect(ctx?.stateResources).toEqual({});
  });

  it('omits stateLoadFailureMessage for a provider without getLastLoadError() (graceful degradation)', async () => {
    const provider = {
      label: '--from-state',
      load: vi.fn().mockResolvedValue(undefined),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      // No getLastLoadError — the optional method is absent.
      dispose: vi.fn(),
    } as unknown as LocalStateProvider;

    const ctx = await buildEcsImageResolutionContext(
      'MyStack:TaskDef',
      [ecrEnvStack()],
      {} as never,
      provider
    );
    expect(ctx?.stateLoadFailureMessage).toBeUndefined();
  });
});
