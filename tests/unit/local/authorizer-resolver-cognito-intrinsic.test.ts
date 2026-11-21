import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import {
  attachAuthorizers,
  resolveJwtAuthorizerIntrinsics,
  resolveRestV1Authorizer,
  warnUnenforcedRouteAuthSettings,
  type CognitoUserPoolAuthorizer,
  type RouteWithAuth,
} from '../../../src/local/authorizer-resolver.js';
import { verifyCognitoJwt, type JwksCache } from '../../../src/local/cognito-jwt.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { SubstitutionContext } from '../../../src/local/state-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';

// go-to-k/cdk-local#1010: CDK's `CognitoUserPoolsAuthorizer` always emits
// `ProviderARNs: [{ Fn::GetAtt: [<Pool>, 'Arn'] }]`.
const STACK_NAME = 'MyStack';
const POOL_ARN = { 'Fn::GetAtt': ['Pool', 'Arn'] };

function restStack(
  providerArns: unknown[],
  methodExtra: Record<string, unknown> = {},
  extraResources: Record<string, unknown> = {}
): StackInfo {
  return {
    stackName: STACK_NAME,
    displayName: STACK_NAME,
    artifactId: STACK_NAME,
    template: {
      Resources: {
        Auth: {
          Type: 'AWS::ApiGateway::Authorizer',
          Properties: { Type: 'COGNITO_USER_POOLS', ProviderARNs: providerArns },
        },
        Method: {
          Type: 'AWS::ApiGateway::Method',
          Properties: {
            HttpMethod: 'GET',
            AuthorizationType: 'COGNITO_USER_POOLS',
            AuthorizerId: { Ref: 'Auth' },
            ...methodExtra,
          },
        },
        ...extraResources,
      },
    } as never,
    dependencyNames: [],
  };
}

const ROUTE: DiscoveredRoute = {
  method: 'GET',
  pathPattern: '/secure',
  lambdaLogicalId: 'Handler',
  source: 'rest-v1',
  apiVersion: 'v1',
  stage: 'prod',
  declaredAt: `${STACK_NAME}/Method`,
  apiLogicalId: 'Api',
} as DiscoveredRoute;

// The `--from-cfn-stack` provider records the pool's physical id only.
const STATE: SubstitutionContext = {
  resources: {
    Pool: { physicalId: 'eu-west-1_AbC123', resourceType: 'AWS::Cognito::UserPool', properties: {} },
  },
  pseudoParameters: { region: 'eu-west-1', accountId: '123456789012', partition: 'aws' },
};

function cognitoOf(entries: readonly RouteWithAuth[], idx = 0): CognitoUserPoolAuthorizer {
  const auth = entries[idx]?.authorizer;
  if (auth?.kind !== 'cognito') throw new Error(`expected a cognito authorizer, got ${auth?.kind}`);
  return auth;
}

/** A JWKS cache that answers pass-through for the placeholder pool only. */
function fakeJwks(urls: string[]): JwksCache {
  return {
    fetchAndCache: (url) => {
      urls.push(url);
      return Promise.resolve({
        byKid: new Map(),
        expiresAt: Number.MAX_SAFE_INTEGER,
        passThrough: url.includes('placeholder'),
      });
    },
    peek: () => undefined,
    clear: () => undefined,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('REST v1 COGNITO_USER_POOLS authorizer with an intrinsic ProviderARNs entry (#1010)', () => {
  it('records the raw entries as pending and serves the placeholder pool before state loads', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const def = resolveRestV1Authorizer(
      'Auth',
      restStack([POOL_ARN]).template,
      STACK_NAME,
      `${STACK_NAME}/Method`
    );
    expect(def.kind).toBe('cognito');
    const cognito = def as CognitoUserPoolAuthorizer;
    expect(cognito.userPoolId).toBe('us-east-1_cdklplaceholderAuth');
    expect(cognito.pending).toEqual({ stackName: STACK_NAME, providerArns: [POOL_ARN] });
  });

  it('resolves the GetAtt ARN from the pool id in state and verifies against the real JWKS', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers([restStack([POOL_ARN])], [ROUTE]);
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attached, () => STATE));
    expect(auth.pending).toBeUndefined();
    expect(auth.pools).toEqual([
      {
        userPoolArn: 'arn:aws:cognito-idp:eu-west-1:123456789012:userpool/eu-west-1_AbC123',
        region: 'eu-west-1',
        userPoolId: 'eu-west-1_AbC123',
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
    // An invalid token is now rejected (the caller answers 401).
    const urls: string[] = [];
    const result = await verifyCognitoJwt(auth, 'Bearer garbage', fakeJwks(urls));
    expect(result.allow).toBe(false);
    expect(urls).toEqual([
      'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC123/.well-known/jwks.json',
    ]);
  });

  it('uses a recorded Arn attribute when the state carries one', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers([restStack([POOL_ARN])], [ROUTE]);
    const arn = 'arn:aws:cognito-idp:ap-northeast-1:111122223333:userpool/ap-northeast-1_Zz9';
    const auth = cognitoOf(
      resolveJwtAuthorizerIntrinsics(attached, () => ({
        resources: {
          Pool: {
            physicalId: 'ap-northeast-1_Zz9',
            resourceType: 'AWS::Cognito::UserPool',
            properties: {},
            attributes: { Arn: arn },
          },
        },
      }))
    );
    expect(auth.pools[0]).toEqual({
      userPoolArn: arn,
      region: 'ap-northeast-1',
      userPoolId: 'ap-northeast-1_Zz9',
    });
  });

  it('keeps the placeholder without state, still admits any token, and warns once per route', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers(
      [restStack([POOL_ARN])],
      [ROUTE, { ...ROUTE, method: 'POST' }]
    );
    const warned = new Set<string>();
    const resolved = resolveJwtAuthorizerIntrinsics(attached, () => undefined, warned);
    const auth = cognitoOf(resolved);
    expect(auth.userPoolId).toBe('us-east-1_cdklplaceholderAuth');
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(
      /MyStack\/Auth\.ProviderARNs\[0\] is an intrinsic .*no state source is loaded.*JWKS pass-through admits every Bearer token on route GET \/secure/
    );
    expect(messages[1]).toContain('on route POST /secure');
    resolveJwtAuthorizerIntrinsics(attached, () => undefined, warned);
    expect(warn).toHaveBeenCalledTimes(2);
    const result = await verifyCognitoJwt(auth, 'Bearer garbage', fakeJwks([]));
    expect(result.allow).toBe(true);
  });

  it('keeps the placeholder when the state has no record for the pool', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers([restStack([POOL_ARN])], [ROUTE]);
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attached, () => ({ resources: {} })));
    expect(auth.userPoolId).toBe('us-east-1_cdklplaceholderAuth');
    expect(auth.pending).toBeDefined();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/Pool\.Arn.*no record in the state source/);
  });

  it('keeps the placeholder when the entry resolves to something that is not a pool ARN', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers([restStack([{ Ref: 'NotAPool' }])], [ROUTE]);
    const auth = cognitoOf(
      resolveJwtAuthorizerIntrinsics(attached, () => ({
        resources: {
          NotAPool: { physicalId: 'some-bucket', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
      }))
    );
    expect(auth.userPoolId).toBe('us-east-1_cdklplaceholderAuth');
    expect(String(warn.mock.calls[0]?.[0])).toContain('not a Cognito user pool ARN');
  });

  it('keeps a literal pool beside an unresolved one and says the other pool is not accepted', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';
    const attached = attachAuthorizers([restStack([literal, POOL_ARN])], [ROUTE]);
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attached, () => undefined));
    expect(auth.pools[0]?.userPoolId).toBe('us-west-2_Lit');
    expect(auth.pools[1]?.userPoolId).toBe('us-east-1_cdklplaceholderAuth');
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /ProviderARNs\[1\].*a token from that pool is not verified \(and so not accepted\) on route GET \/secure/
    );
  });

  it('refuses an entry that is neither a string nor an intrinsic', () => {
    expect(() =>
      resolveRestV1Authorizer('Auth', restStack([42]).template, STACK_NAME, `${STACK_NAME}/Method`)
    ).toThrow(/ProviderARNs\[0\]: must be a literal string or an intrinsic \(got 42\)/);
  });
});

describe('warnUnenforcedRouteAuthSettings (#1010)', () => {
  const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';

  function messagesFor(stack: StackInfo, routes: DiscoveredRoute[] = [ROUTE]): string[] {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    warnUnenforcedRouteAuthSettings([stack], attachAuthorizers([stack], routes));
    return warn.mock.calls.map((c) => String(c[0]));
  }

  it('warns per route for ApiKeyRequired and AuthorizationScopes on a REST v1 method', () => {
    const messages = messagesFor(
      restStack([literal], { ApiKeyRequired: true, AuthorizationScopes: ['orders/read'] })
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/MyStack\/Method: ApiKeyRequired is not enforced .*route GET \/secure is served without an x-api-key check/);
    expect(messages[1]).toMatch(/AuthorizationScopes .*orders\/read.* are not checked .*route GET \/secure accepts any token/);
  });

  it('says nothing for a method that declares neither', () => {
    expect(messagesFor(restStack([literal], { ApiKeyRequired: false, AuthorizationScopes: [] }))).toEqual(
      []
    );
  });

  it('warns for a RestApi resource Policy', () => {
    const messages = messagesFor(
      restStack([literal], {}, {
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Policy: { Statement: [] } } },
      })
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/MyStack\/Api: the RestApi resource Policy is not evaluated .*route GET \/secure/);
  });

  it('warns for a TOKEN authorizer IdentityValidationExpression', () => {
    const stack: StackInfo = {
      ...restStack([literal]),
      template: {
        Resources: {
          Auth: {
            Type: 'AWS::ApiGateway::Authorizer',
            Properties: {
              Type: 'TOKEN',
              AuthorizerUri: { 'Fn::GetAtt': ['AuthFn', 'Arn'] },
              IdentityValidationExpression: '^Bearer [-0-9a-zA-Z._]*$',
            },
          },
          AuthFn: { Type: 'AWS::Lambda::Function', Properties: {} },
          Method: {
            Type: 'AWS::ApiGateway::Method',
            Properties: { AuthorizationType: 'CUSTOM', AuthorizerId: { Ref: 'Auth' } },
          },
        },
      } as never,
    };
    const messages = messagesFor(stack);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      /MyStack\/Auth: IdentityValidationExpression is not applied .*on route GET \/secure every token reaches the authorizer Lambda/
    );
  });

  it('warns for HTTP v2 route AuthorizationScopes, once across reloads', () => {
    const stack: StackInfo = {
      ...restStack([literal]),
      template: {
        Resources: {
          Auth: {
            Type: 'AWS::ApiGatewayV2::Authorizer',
            Properties: {
              AuthorizerType: 'JWT',
              JwtConfiguration: { Issuer: 'https://issuer.example.com', Audience: ['a'] },
            },
          },
          Route: {
            Type: 'AWS::ApiGatewayV2::Route',
            Properties: {
              RouteKey: 'GET /secure',
              AuthorizationType: 'JWT',
              AuthorizerId: { Ref: 'Auth' },
              AuthorizationScopes: ['admin'],
            },
          },
        },
      } as never,
    };
    const route = { ...ROUTE, source: 'http-api', apiVersion: 'v2', declaredAt: `${STACK_NAME}/Route` } as DiscoveredRoute;
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers([stack], [route]);
    const warned = new Set<string>();
    warnUnenforcedRouteAuthSettings([stack], attached, warned);
    warnUnenforcedRouteAuthSettings([stack], attached, warned);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/MyStack\/Route: AuthorizationScopes .*admin/);
  });
});
