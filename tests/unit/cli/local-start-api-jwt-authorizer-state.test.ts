import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';

// #1001: an HTTP v2 JWT authorizer's intrinsic Issuer / Audience resolves
// from its stack's state, so that stack's state is loaded even when no
// Lambda in it is routed, and the context comes from the SHARED bundle.

const { createProviderMock } = vi.hoisted(() => ({ createProviderMock: vi.fn() }));

vi.mock('../../../src/cli/commands/local-state-source.js', () => ({
  createLocalStateProvider: createProviderMock,
  rejectExplicitCfnStackWithMultipleStacks: vi.fn(),
  isCfnFlagPresent: vi.fn(() => false),
  deployedStackName: (_o: unknown, n: string) => n,
  deployedStackNamePseudo: (_o: unknown, n: string) => ({ stackName: n }),
  resolveCfnFallbackRegion: vi.fn(async (_o: unknown, r: string | undefined) => r),
  UNNAMED_WORKLOAD: {},
  groupWorkloadsRoutedApart: vi.fn(() => []),
}));

const { loadStateForRoutedStacks, jwtAuthorizerSubstitutionContext } =
  await import('../../../src/cli/commands/local-start-api.js');

const apiStack = {
  stackName: 'Api',
  displayName: 'Api',
  region: 'eu-west-1',
  template: { Resources: {} },
} as unknown as StackInfo;

function jwtEntry(pending: boolean): RouteWithAuth {
  return {
    route: { declaredAt: 'Api/Route', serviceIntegration: true } as never,
    authorizer: {
      kind: 'jwt',
      logicalId: 'Auth',
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cdklplaceholderAuth',
      audience: [],
      declaredAt: 'Api/Route',
      ...(pending && { pending: { stackName: 'Api', issuer: { Ref: 'Pool' }, audience: [] } }),
    },
  };
}

describe('loadStateForRoutedStacks with a JWT authorizer waiting on state', () => {
  beforeEach(() => {
    createProviderMock.mockReset();
    createProviderMock.mockReturnValue(undefined);
  });

  it("loads the authorizer's stack although no Lambda there is routed", async () => {
    await loadStateForRoutedStacks([apiStack], [], [jwtEntry(true)], {} as never, undefined);
    expect(createProviderMock.mock.calls.map((c) => c[1])).toEqual(['Api']);
  });

  it("loads a REST v1 Cognito authorizer's stack while its ProviderARNs wait on state (#1010)", async () => {
    const pool = {
      userPoolArn: 'arn:aws:cognito-idp:us-east-1:000000000000:userpool/us-east-1_cdklplaceholderAuth',
      region: 'us-east-1',
      userPoolId: 'us-east-1_cdklplaceholderAuth',
    };
    const entry: RouteWithAuth = {
      route: { declaredAt: 'Api/Method', serviceIntegration: true } as never,
      authorizer: {
        kind: 'cognito',
        logicalId: 'Auth',
        pools: [pool],
        ...pool,
        pending: { stackName: 'Api', providerArns: [{ 'Fn::GetAtt': ['Pool', 'Arn'] }] },
        declaredAt: 'Api/Method',
      },
    };
    await loadStateForRoutedStacks([apiStack], [], [entry], {} as never, undefined);
    expect(createProviderMock.mock.calls.map((c) => c[1])).toEqual(['Api']);
  });

  it('loads the stack of literal authorizers whose route scopes or validation expression wait on state (#1011)', async () => {
    const scoped: RouteWithAuth = {
      ...jwtEntry(false),
      authorizer: {
        ...(jwtEntry(false).authorizer as Extract<RouteWithAuth['authorizer'], { kind: 'jwt' }>),
        scopes: { state: 'unresolved', stackName: 'Api', raw: [{ Ref: 'Server' }], reason: 'r' },
      },
    };
    await loadStateForRoutedStacks([apiStack], [], [scoped], {} as never, undefined);
    expect(createProviderMock.mock.calls.map((c) => c[1])).toEqual(['Api']);

    createProviderMock.mockClear();
    const token: RouteWithAuth = {
      route: { declaredAt: 'Api/Method', serviceIntegration: true } as never,
      authorizer: {
        kind: 'lambda-token',
        logicalId: 'Auth',
        lambdaLogicalId: 'AuthFn',
        tokenHeader: 'authorization',
        resultTtlSeconds: 0,
        identityValidation: { state: 'unresolved', stackName: 'Api', raw: { Ref: 'P' }, reason: 'r' },
        declaredAt: 'Api/Method',
      },
    };
    await loadStateForRoutedStacks([apiStack], [], [token], {} as never, undefined);
    expect(createProviderMock.mock.calls.map((c) => c[1])).toEqual(['Api']);
  });

  it('does not load a stack whose JWT authorizer is all literal', async () => {
    await loadStateForRoutedStacks([apiStack], [], [jwtEntry(false)], {} as never, undefined);
    expect(createProviderMock).not.toHaveBeenCalled();
  });
});

describe('jwtAuthorizerSubstitutionContext', () => {
  const resources = { Pool: { physicalId: 'p', resourceType: 'AWS::Cognito::UserPool', properties: {} } };
  const state = { version: 1, stackName: 'Api', resources, outputs: {}, lastModified: 0 } as never;

  it('is undefined without a bundle or with only per-function bundles', () => {
    expect(jwtAuthorizerSubstitutionContext(undefined)).toBeUndefined();
    expect(jwtAuthorizerSubstitutionContext({ state, region: 'eu-west-1', withoutSharedState: true })).toBeUndefined();
  });

  it("derives the pseudo parameters from the state's region when none were resolved", () => {
    expect(jwtAuthorizerSubstitutionContext({ state, region: 'eu-west-1' })).toEqual({
      resources,
      pseudoParameters: expect.objectContaining({ region: 'eu-west-1', partition: 'aws' }),
    });
  });

  it('prefers the resolved pseudo parameters', () => {
    const pseudoParameters = { region: 'ap-south-1', accountId: '111111111111' };
    expect(jwtAuthorizerSubstitutionContext({ state, region: 'eu-west-1', pseudoParameters })).toEqual({
      resources,
      pseudoParameters,
    });
  });
});
