import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  resolveAlbFrontDoor,
  resolveFrontDoorAuthGuardIntrinsics,
  pendingAuthGuardStackNames,
  type FrontDoorAuthGuard,
} from '../../../src/local/elb-front-door-resolver.js';
import type { SubstitutionContext } from '../../../src/local/state-resolver.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * #1004: an authenticate-cognito / authenticate-oidc guard whose config is an
 * intrinsic resolves from the deployed state; when it cannot, the route keeps
 * a placeholder guard that still requires a Bearer token.
 */

const POOL_ID = 'us-east-1_AbC123xyz';

function record(physicalId: string, resourceType: string, attributes = {}): ResourceState {
  return { physicalId, resourceType, properties: {}, attributes, dependencies: [] } as ResourceState;
}

const STATE: SubstitutionContext = {
  resources: {
    Pool: record(POOL_ID, 'AWS::Cognito::UserPool'),
    Client: record('client-1234', 'AWS::Cognito::UserPoolClient'),
    Bucket: record('my-bucket', 'AWS::S3::Bucket'),
  },
  pseudoParameters: { region: 'us-east-1', partition: 'aws', urlSuffix: 'amazonaws.com' },
};

function albStack(
  authAction: Record<string, unknown>,
  ruleAuthAction?: Record<string, unknown>
): StackInfo {
  const resources: Record<string, unknown> = {
    Alb: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: { Type: 'application' },
    },
    Listener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: { Ref: 'Alb' },
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [
          authAction,
          { Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200', MessageBody: 'secret' } },
        ],
      },
    },
  };
  if (ruleAuthAction) {
    resources['Rule'] = {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: { Ref: 'Listener' },
        Priority: 1,
        Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/admin/*'] } }],
        Actions: [
          ruleAuthAction,
          { Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200', MessageBody: 'admin' } },
        ],
      },
    };
  }
  return { stackName: 'AlbStack', template: { Resources: resources } } as unknown as StackInfo;
}

const cognitoAction = (cfg: Record<string, unknown>): Record<string, unknown> => ({
  Type: 'authenticate-cognito',
  AuthenticateCognitoConfig: { UserPoolDomain: { Ref: 'Domain' }, ...cfg },
});

/** The CDK `ListenerAction.authenticateCognito` shape. */
const CDK_COGNITO = cognitoAction({
  UserPoolArn: { 'Fn::GetAtt': ['Pool', 'Arn'] },
  UserPoolClientId: { Ref: 'Client' },
});

function resolveDefault(
  stack: StackInfo,
  contextFor: (stackName: string) => SubstitutionContext | undefined,
  warned?: Set<string>
): FrontDoorAuthGuard {
  const { listeners } = resolveAlbFrontDoor(stack, 'Alb');
  return resolveFrontDoorAuthGuardIntrinsics(listeners, contextFor, warned)[0]!.defaultAuthGuard!;
}

function isPlaceholder(guard: FrontDoorAuthGuard): boolean {
  return /placeholder/.test(guard.userPoolId ?? '') && guard.pending === undefined;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});
const warnText = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

describe('resolveFrontDoorAuthGuardIntrinsics (#1004)', () => {
  it('resolves GetAtt Pool.Arn (no Arn attribute recorded) + Ref Client into the real guard', () => {
    const guard = resolveDefault(albStack(CDK_COGNITO), () => STATE);
    expect(guard).toEqual({
      kind: 'authenticate-cognito',
      issuer: `https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}`,
      audience: 'client-1234',
      region: 'us-east-1',
      userPoolId: POOL_ID,
      sessionCookieName: 'AWSELBAuthSessionCookie',
      label: `authenticate-cognito (UserPool=${POOL_ID})`,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('prefers a recorded Arn attribute over deriving it from the pool id', () => {
    const arn = 'arn:aws:cognito-idp:eu-west-1:111122223333:userpool/eu-west-1_Other1';
    const state: SubstitutionContext = {
      resources: {
        ...STATE.resources,
        Pool: record(POOL_ID, 'AWS::Cognito::UserPool', { Arn: arn }),
      },
    };
    const guard = resolveDefault(albStack(CDK_COGNITO), () => state);
    expect(guard.userPoolId).toBe('eu-west-1_Other1');
    expect(guard.region).toBe('eu-west-1');
  });

  it('resolves a literal ARN with a Ref client id (cross-field partial)', () => {
    const arn = `arn:aws:cognito-idp:us-east-1:111122223333:userpool/${POOL_ID}`;
    const guard = resolveDefault(
      albStack(cognitoAction({ UserPoolArn: arn, UserPoolClientId: { Ref: 'Client' } })),
      () => STATE
    );
    expect(guard.userPoolId).toBe(POOL_ID);
    expect(guard.audience).toBe('client-1234');
    expect(guard.pending).toBeUndefined();
  });

  it('verifies sig / iss / exp but not aud when only the client id is unresolved', () => {
    const guard = resolveDefault(
      albStack(
        cognitoAction({
          UserPoolArn: { 'Fn::GetAtt': ['Pool', 'Arn'] },
          UserPoolClientId: { Ref: 'MissingClient' },
        })
      ),
      () => STATE
    );
    expect(guard.userPoolId).toBe(POOL_ID);
    expect(guard.audience).toBeUndefined();
    expect(warnText()).toMatch(/UserPoolClientId could not be resolved/);
    expect(warnText()).toMatch(/audience is not checked/);
  });

  it('keeps the placeholder (warned, naming --from-cfn-stack then --no-verify-auth) without a state source', () => {
    const guard = resolveDefault(albStack(CDK_COGNITO), () => undefined);
    expect(isPlaceholder(guard)).toBe(true);
    const text = warnText();
    expect(text).toMatch(/UserPoolArn is an intrinsic .* could not resolve \(no deployed state was loaded/);
    expect(text.indexOf('--from-cfn-stack')).toBeGreaterThan(-1);
    expect(text.indexOf('--from-cfn-stack')).toBeLessThan(text.indexOf('--no-verify-auth'));
    expect(text).toMatch(/--watch does not rebuild the front-door/);
  });

  it('keeps the placeholder when the pool has no state record', () => {
    const guard = resolveDefault(
      albStack(
        cognitoAction({
          UserPoolArn: { 'Fn::GetAtt': ['GonePool', 'Arn'] },
          UserPoolClientId: { Ref: 'Client' },
        })
      ),
      () => STATE
    );
    expect(isPlaceholder(guard)).toBe(true);
    expect(warnText()).toMatch(/no record in the state source/);
  });

  it('keeps the placeholder when the resolved ARN fails the Cognito ARN shape', () => {
    const guard = resolveDefault(
      albStack(cognitoAction({ UserPoolArn: { Ref: 'Bucket' }, UserPoolClientId: 'client-1' })),
      () => STATE
    );
    expect(isPlaceholder(guard)).toBe(true);
    expect(warnText()).toMatch(/not in the expected/);
  });

  it('keeps the placeholder when the GetAtt target is a pool whose physical id is not a pool id', () => {
    const state: SubstitutionContext = {
      resources: { ...STATE.resources, Pool: record('not-a-pool-id', 'AWS::Cognito::UserPool') },
    };
    const guard = resolveDefault(albStack(CDK_COGNITO), () => state);
    expect(isPlaceholder(guard)).toBe(true);
  });

  it('resolves an OIDC Issuer intrinsic, and refuses a resolved non-https Issuer', () => {
    const oidc = (issuer: string): SubstitutionContext => ({
      resources: { IssuerParam: record(issuer, 'AWS::SSM::Parameter') },
    });
    const stack = albStack({
      Type: 'authenticate-oidc',
      AuthenticateOidcConfig: { Issuer: { Ref: 'IssuerParam' }, ClientId: 'oidc-client' },
    });
    const ok = resolveDefault(stack, () => oidc('https://idp.example.com/'));
    expect(ok).toEqual({
      kind: 'authenticate-oidc',
      issuer: 'https://idp.example.com',
      audience: 'oidc-client',
      sessionCookieName: 'AWSELBAuthSessionCookie',
      label: 'authenticate-oidc (Issuer=https://idp.example.com/)',
    });
    const bad = resolveDefault(stack, () => oidc('http://idp.example.com'));
    expect(isPlaceholder(bad)).toBe(true);
    expect(warnText()).toMatch(/is not an https:\/\/ URL/);
  });

  it('resolves the rule guard as well as the listener default guard', () => {
    const stack = albStack(CDK_COGNITO, CDK_COGNITO);
    const { listeners } = resolveAlbFrontDoor(stack, 'Alb');
    expect(pendingAuthGuardStackNames(listeners)).toEqual(['AlbStack']);
    const [resolved] = resolveFrontDoorAuthGuardIntrinsics(listeners, () => STATE);
    expect(resolved!.defaultAuthGuard?.userPoolId).toBe(POOL_ID);
    expect(resolved!.rules[0]!.authGuard?.userPoolId).toBe(POOL_ID);
    expect(resolved!.rules[0]!.authGuard?.audience).toBe('client-1234');
    expect(pendingAuthGuardStackNames([resolved!])).toEqual([]);
  });

  it('warns once per stack + logical id + field across repeated resolutions', () => {
    const warned = new Set<string>();
    resolveDefault(albStack(CDK_COGNITO), () => undefined, warned);
    resolveDefault(albStack(CDK_COGNITO), () => undefined, warned);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns a guard without pending unchanged', () => {
    const arn = `arn:aws:cognito-idp:us-east-1:111122223333:userpool/${POOL_ID}`;
    const { listeners } = resolveAlbFrontDoor(
      albStack(cognitoAction({ UserPoolArn: arn, UserPoolClientId: 'c' })),
      'Alb'
    );
    expect(pendingAuthGuardStackNames(listeners)).toEqual([]);
    const contextFor = vi.fn(() => STATE);
    const [resolved] = resolveFrontDoorAuthGuardIntrinsics(listeners, contextFor);
    expect(resolved!.defaultAuthGuard).toBe(listeners[0]!.defaultAuthGuard);
    expect(contextFor).not.toHaveBeenCalled();
  });
});
