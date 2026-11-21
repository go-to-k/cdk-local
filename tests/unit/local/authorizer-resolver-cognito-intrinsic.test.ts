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

/** An unsigned JWT carrying `payload` (signature is not checked on these paths). */
function unsignedJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(payload)}.c2ln`;
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
    // A real token from the deployed pool is admitted too: no issuer can match
    // the stand-in, so the iss match is skipped (code review on #1013).
    const realIss = unsignedJwt({ iss: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC123', sub: 'u1' });
    const real = await verifyCognitoJwt(auth, `Bearer ${realIss}`, fakeJwks([]));
    expect(real.allow).toBe(true);
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

  it('drops an unresolved pool beside a real one, so a token naming the stand-in is rejected', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';
    const attached = attachAuthorizers([restStack([literal, POOL_ARN])], [ROUTE]);
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attached, () => undefined));
    expect(auth.pools.map((p) => p.userPoolId)).toEqual(['us-west-2_Lit']);
    expect(auth.pending).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /ProviderARNs\[1\].*a token from that pool is rejected on route GET \/secure/
    );
    // The stand-in issuer is predictable; it must not open a pass-through.
    const forged = unsignedJwt({
      iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cdklplaceholderAuth',
    });
    const result = await verifyCognitoJwt(auth, `Bearer ${forged}`, fakeJwks([]));
    expect(result.allow).toBe(false);
  });

  it('clears pending once every pool of a multi-pool authorizer resolves', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';
    const attached = attachAuthorizers([restStack([literal, POOL_ARN])], [ROUTE]);
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attached, () => STATE));
    expect(auth.pools.map((p) => p.userPoolId)).toEqual(['us-west-2_Lit', 'eu-west-1_AbC123']);
    expect(auth.pending).toBeUndefined();
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

  it('warns per route for ApiKeyRequired, and enforces literal AuthorizationScopes without a warning (#1011)', () => {
    const stack = restStack([literal], { ApiKeyRequired: true, AuthorizationScopes: ['orders/read'] });
    const messages = messagesFor(stack);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/MyStack\/Method: ApiKeyRequired is not enforced .*route GET \/secure is served without an x-api-key check/);
    expect(cognitoOf(attachAuthorizers([stack], [ROUTE])).scopes).toEqual({
      state: 'enforced',
      value: ['orders/read'],
    });
  });

  it('resolves intrinsic AuthorizationScopes from state and enforces them (#1011)', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const stack = restStack([literal], {
      AuthorizationScopes: [{ 'Fn::Join': ['', [{ Ref: 'Server' }, '/read']] }, 'admin'],
    });
    const context: SubstitutionContext = {
      resources: {
        Server: {
          physicalId: 'orders',
          resourceType: 'AWS::Cognito::UserPoolResourceServer',
          properties: {},
        },
      },
    };
    const resolved = resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [ROUTE]), () => context);
    expect(cognitoOf(resolved).scopes).toEqual({ state: 'enforced', value: ['orders/read', 'admin'] });
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    warnUnenforcedRouteAuthSettings([stack], resolved);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns per route, and enforces no scope, when one AuthorizationScopes entry stays unresolved (#1011)', () => {
    const stack = restStack([literal], {
      AuthorizationScopes: [{ 'Fn::Join': ['', [{ Ref: 'Server' }, '/read']] }, 'admin'],
    });
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const resolved = resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [ROUTE]), () => undefined);
    // All-or-nothing: enforcing only 'admin' would reject an orders/read token the deployed API accepts.
    expect(cognitoOf(resolved).scopes?.state).toBe('unresolved');
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    warnUnenforcedRouteAuthSettings([stack], resolved);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /MyStack\/Method: AuthorizationScopes .* could not be resolved .*no state source is loaded.*route GET \/secure accepts any token/
    );
  });

  it('says nothing for a method that declares neither', () => {
    expect(messagesFor(restStack([literal], { ApiKeyRequired: false, AuthorizationScopes: [] }))).toEqual(
      []
    );
  });

  it('says nothing for a mock-CORS route, which no authorizer pass reaches', () => {
    const messages = messagesFor(restStack([literal], { ApiKeyRequired: true }), [
      { ...ROUTE, mockCors: { statusCode: 204, headers: {} } } as DiscoveredRoute,
    ]);
    expect(messages).toEqual([]);
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

  function tokenStack(identityValidationExpression: unknown): StackInfo {
    return {
      ...restStack([literal]),
      template: {
        Resources: {
          Auth: {
            Type: 'AWS::ApiGateway::Authorizer',
            Properties: {
              Type: 'TOKEN',
              AuthorizerUri: { 'Fn::GetAtt': ['AuthFn', 'Arn'] },
              IdentityValidationExpression: identityValidationExpression,
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
  }

  it('enforces a literal TOKEN authorizer IdentityValidationExpression without a warning (#1011)', () => {
    const stack = tokenStack('^Bearer [-0-9a-zA-Z._]*$');
    expect(messagesFor(stack)).toEqual([]);
    const auth = attachAuthorizers([stack], [ROUTE])[0]?.authorizer;
    expect(auth?.kind === 'lambda-token' && auth.identityValidation).toEqual({
      state: 'enforced',
      value: '^Bearer [-0-9a-zA-Z._]*$',
    });
  });

  it('warns for an IdentityValidationExpression that stays an unresolved intrinsic (#1011)', () => {
    const messages = messagesFor(tokenStack({ Ref: 'TokenPattern' }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      /MyStack\/Auth: IdentityValidationExpression could not be applied .*no state source is loaded.*on route GET \/secure every token reaches the authorizer Lambda/
    );
  });

  it('resolves an intrinsic IdentityValidationExpression from state (#1011)', () => {
    const stack = tokenStack({ Ref: 'TokenPattern' });
    const resolved = resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [ROUTE]), () => ({
      resources: {},
      parameters: { TokenPattern: '^Bearer .+$' },
    }));
    const auth = resolved[0]?.authorizer;
    expect(auth?.kind === 'lambda-token' && auth.identityValidation).toEqual({
      state: 'enforced',
      value: '^Bearer .+$',
    });
  });

  it('warns for an IdentityValidationExpression the local server cannot compile (#1011)', () => {
    const messages = messagesFor(tokenStack('(unclosed'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/IdentityValidationExpression could not be applied .*is not a pattern/);
  });

  it('warns for unresolved HTTP v2 route AuthorizationScopes, once across reloads', () => {
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
              AuthorizationScopes: [{ Ref: 'ScopeParam' }],
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
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /MyStack\/Route: AuthorizationScopes .*ScopeParam.* could not be resolved/
    );
  });
});

describe('route auth settings through the state-resolution rebuild (#1011)', () => {
  const SERVER_SCOPE = { 'Fn::Join': ['', [{ Ref: 'Server' }, '/read']] };
  const SERVER_STATE: SubstitutionContext = {
    ...STATE,
    resources: {
      ...STATE.resources,
      Server: { physicalId: 'orders', resourceType: 'AWS::Cognito::UserPoolResourceServer', properties: {} },
    },
  };

  function cognitoStack(authExtra: Record<string, unknown>, methodExtra: Record<string, unknown>): StackInfo {
    const stack = restStack([POOL_ARN], methodExtra);
    const resources = (stack.template as { Resources: Record<string, { Properties: Record<string, unknown> }> })
      .Resources;
    Object.assign(resources['Auth']!.Properties, authExtra);
    return stack;
  }

  it('keeps scopes and IdentityValidationExpression when an intrinsic ProviderARNs pool resolves', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const stack = cognitoStack({ IdentityValidationExpression: 'client123' }, { AuthorizationScopes: ['admin'] });
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [ROUTE]), () => STATE));
    expect(auth.userPoolId).toBe('eu-west-1_AbC123');
    expect(auth.scopes).toEqual({ state: 'enforced', value: ['admin'] });
    expect(auth.identityValidation).toEqual({ state: 'enforced', value: 'client123' });
  });

  it('keeps them when the intrinsic pool stays unresolved too', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const stack = cognitoStack({ IdentityValidationExpression: 'client123' }, { AuthorizationScopes: ['admin'] });
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [ROUTE]), () => undefined));
    expect(auth.scopes).toEqual({ state: 'enforced', value: ['admin'] });
    expect(auth.identityValidation).toEqual({ state: 'enforced', value: 'client123' });
  });

  it('resolves intrinsic scopes beside an intrinsic pool from the same state', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const stack = cognitoStack({}, { AuthorizationScopes: [SERVER_SCOPE] });
    const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [ROUTE]), () => SERVER_STATE));
    expect(auth.scopes).toEqual({ state: 'enforced', value: ['orders/read'] });
  });

  it('keeps an HTTP v2 route scopes when an intrinsic JWT issuer resolves', () => {
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const stack: StackInfo = {
      ...restStack([]),
      template: {
        Resources: {
          Auth: {
            Type: 'AWS::ApiGatewayV2::Authorizer',
            Properties: {
              AuthorizerType: 'JWT',
              JwtConfiguration: {
                Issuer: { 'Fn::Join': ['', ['https://cognito-idp.eu-west-1.amazonaws.com/', { Ref: 'Pool' }]] },
                Audience: ['aud'],
              },
            },
          },
          Route: {
            Type: 'AWS::ApiGatewayV2::Route',
            Properties: {
              RouteKey: 'GET /secure',
              AuthorizationType: 'JWT',
              AuthorizerId: { Ref: 'Auth' },
              AuthorizationScopes: ['admin', SERVER_SCOPE],
            },
          },
        },
      } as never,
    };
    const route = { ...ROUTE, source: 'http-api', apiVersion: 'v2', declaredAt: `${STACK_NAME}/Route` } as DiscoveredRoute;
    const auth = resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [route]), () => SERVER_STATE)[0]
      ?.authorizer;
    if (auth?.kind !== 'jwt') throw new Error('expected jwt');
    expect(auth.issuer).toBe('https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC123');
    expect(auth.scopes).toEqual({ state: 'enforced', value: ['admin', 'orders/read'] });
  });

  it('reads a Cognito authorizer IdentityValidationExpression from the template, and warns with the aud wording when unresolved', () => {
    const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';
    const stack = restStack([literal]);
    const resources = (stack.template as { Resources: Record<string, { Properties: Record<string, unknown> }> })
      .Resources;
    resources['Auth']!.Properties['IdentityValidationExpression'] = { Ref: 'ClientPattern' };
    const attached = attachAuthorizers([stack], [ROUTE]);
    expect(cognitoOf(attached).identityValidation?.state).toBe('unresolved');
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    warnUnenforcedRouteAuthSettings([stack], attached);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /MyStack\/Auth: IdentityValidationExpression could not be applied .*route GET \/secure a token's aud claim is not matched against it/
    );
  });

  it('names why scopes stay unresolved: a list intrinsic, a scalar, an unresolvable or non-string entry', () => {
    const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';
    const reasonFor = (scopes: unknown, context: SubstitutionContext): string => {
      const auth = cognitoOf(
        resolveJwtAuthorizerIntrinsics(
          attachAuthorizers([restStack([literal], { AuthorizationScopes: scopes })], [ROUTE]),
          () => context
        )
      );
      if (auth.scopes?.state !== 'unresolved') throw new Error(`expected unresolved, got ${JSON.stringify(auth.scopes)}`);
      return auth.scopes.reason;
    };
    expect(reasonFor({ 'Fn::Split': [',', 'a,b'] }, SERVER_STATE)).toBe('the list itself is an intrinsic');
    expect(reasonFor('admin', SERVER_STATE)).toBe('it is not a list');
    expect(reasonFor([{ Ref: 'Missing' }], SERVER_STATE)).not.toBe('no state source is loaded for the stack');
    expect(
      reasonFor([{ Ref: 'Num' }], { resources: {}, parameters: { Num: 42 } } as unknown as SubstitutionContext)
    ).toBe('an entry resolved to a non-string');
  });

  it('warns that AuthorizationScopes on a Lambda authorizer are not checked', () => {
    const stack: StackInfo = {
      ...restStack([]),
      template: {
        Resources: {
          Auth: {
            Type: 'AWS::ApiGateway::Authorizer',
            Properties: { Type: 'TOKEN', AuthorizerUri: { 'Fn::GetAtt': ['AuthFn', 'Arn'] } },
          },
          AuthFn: { Type: 'AWS::Lambda::Function', Properties: {} },
          Method: {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              AuthorizationType: 'CUSTOM',
              AuthorizerId: { Ref: 'Auth' },
              AuthorizationScopes: ['orders/read'],
            },
          },
        },
      } as never,
    };
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    warnUnenforcedRouteAuthSettings([stack], attachAuthorizers([stack], [ROUTE]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /AuthorizationScopes .*orders\/read.* are not checked .*\(they apply to a COGNITO_USER_POOLS authorizer only\).*route GET \/secure/
    );
  });

  it('names why an IdentityValidationExpression stays unresolved', () => {
    const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';
    const reasonFor = (raw: unknown, context: SubstitutionContext | undefined): string => {
      const stack = restStack([literal]);
      const resources = (stack.template as { Resources: Record<string, { Properties: Record<string, unknown> }> })
        .Resources;
      resources['Auth']!.Properties['IdentityValidationExpression'] = raw;
      const auth = cognitoOf(resolveJwtAuthorizerIntrinsics(attachAuthorizers([stack], [ROUTE]), () => context));
      if (auth.identityValidation?.state !== 'unresolved') throw new Error('expected unresolved');
      return auth.identityValidation.reason;
    };
    expect(reasonFor({ Ref: 'P' }, undefined)).toBe('no state source is loaded for the stack');
    expect(reasonFor({ Ref: 'Missing' }, { resources: {} })).not.toBe('no state source is loaded for the stack');
    expect(reasonFor({ Ref: 'P' }, { resources: {}, parameters: { P: 42 } } as unknown as SubstitutionContext)).toBe(
      'it resolved to a non-string'
    );
    expect(reasonFor({ Ref: 'P' }, { resources: {}, parameters: { P: '(open' } } as unknown as SubstitutionContext)).toMatch(
      /is not a pattern .* can evaluate/
    );
  });

  it('refuses, rather than mis-enforces, a pattern that would break the anchoring or uses Java-only syntax', () => {
    const literal = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_Lit';
    for (const pattern of ['a)|(b', '^Bearer \\p{Alnum}+$', '\\Aabc\\z']) {
      const stack = restStack([literal]);
      const resources = (stack.template as { Resources: Record<string, { Properties: Record<string, unknown> }> })
        .Resources;
      resources['Auth']!.Properties['IdentityValidationExpression'] = pattern;
      const setting = cognitoOf(attachAuthorizers([stack], [ROUTE])).identityValidation;
      expect(setting?.state, pattern).toBe('unresolved');
      // One rendered copy of the pattern: the engine's echo is stripped.
      if (setting?.state === 'unresolved') expect(setting.reason).not.toContain('Invalid regular expression');
    }
  });
});
