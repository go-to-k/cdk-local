import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import {
  attachAuthorizers,
  resolveJwtAuthorizerIntrinsics,
  type JwtAuthorizer,
  type RouteWithAuth,
} from '../../../src/local/authorizer-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { SubstitutionContext } from '../../../src/local/state-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';

// #1001: `HttpUserPoolAuthorizer` emits the issuer as a Fn::Join over
// `Ref AWS::Region` + `Ref <UserPool>` and the audience as `Ref <Client>`.
const STACK_NAME = 'MyStack';
const COGNITO_ISSUER = {
  'Fn::Join': [
    '',
    ['https://cognito-idp.', { Ref: 'AWS::Region' }, '.amazonaws.com/', { Ref: 'Pool' }],
  ],
};

function stack(jwtConfiguration: Record<string, unknown>): StackInfo {
  return {
    stackName: STACK_NAME,
    displayName: STACK_NAME,
    artifactId: STACK_NAME,
    template: {
      Resources: {
        Auth: {
          Type: 'AWS::ApiGatewayV2::Authorizer',
          Properties: { ApiId: { Ref: 'Api' }, AuthorizerType: 'JWT', JwtConfiguration: jwtConfiguration },
        },
        Route: {
          Type: 'AWS::ApiGatewayV2::Route',
          Properties: {
            ApiId: { Ref: 'Api' },
            RouteKey: 'GET /secure',
            AuthorizationType: 'JWT',
            AuthorizerId: { Ref: 'Auth' },
          },
        },
      },
    } as never,
    dependencyNames: [],
  };
}

const ROUTE: DiscoveredRoute = {
  method: 'GET',
  pathPattern: '/secure',
  lambdaLogicalId: 'Handler',
  source: 'http-api',
  apiVersion: 'v2',
  stage: '$default',
  declaredAt: `${STACK_NAME}/Route`,
} as DiscoveredRoute;

const STATE: SubstitutionContext = {
  resources: {
    Pool: { physicalId: 'eu-west-1_AbC123', resourceType: 'AWS::Cognito::UserPool', properties: {} },
    Client: { physicalId: 'client123', resourceType: 'AWS::Cognito::UserPoolClient', properties: {} },
  },
  pseudoParameters: { region: 'eu-west-1' },
};

function jwtOf(entries: readonly RouteWithAuth[]): JwtAuthorizer {
  const auth = entries[0]?.authorizer;
  if (auth?.kind !== 'jwt') throw new Error(`expected a jwt authorizer, got ${auth?.kind}`);
  return auth;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP v2 JWT authorizer with an intrinsic Issuer / Audience (#1001)', () => {
  it('attaches the HttpUserPoolAuthorizer shape instead of refusing the stack', () => {
    const attached = attachAuthorizers(
      [stack({ Issuer: COGNITO_ISSUER, Audience: [{ Ref: 'Client' }] })],
      [ROUTE]
    );
    const jwt = jwtOf(attached);
    expect(jwt.issuer).toBe('https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cdklplaceholderAuth');
    expect(jwt.audience).toEqual([]);
    expect(jwt.pending).toEqual({ stackName: STACK_NAME, issuer: COGNITO_ISSUER, audience: [{ Ref: 'Client' }] });
  });

  it('resolves the issuer, pool and audience from state', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers(
      [stack({ Issuer: COGNITO_ISSUER, Audience: [{ Ref: 'Client' }, 'literal-aud'] })],
      [ROUTE]
    );
    const jwt = jwtOf(resolveJwtAuthorizerIntrinsics(attached, (s) => (s === STACK_NAME ? STATE : undefined)));
    expect(jwt.issuer).toBe('https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC123');
    expect(jwt.region).toBe('eu-west-1');
    expect(jwt.userPoolId).toBe('eu-west-1_AbC123');
    expect(jwt.audience).toEqual(['client123', 'literal-aud']);
    expect(jwt.pending).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the placeholder and warns once per authorizer without state', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers(
      [stack({ Issuer: COGNITO_ISSUER, Audience: [{ Ref: 'Client' }] })],
      [ROUTE, { ...ROUTE, method: 'POST' }]
    );
    const resolved = resolveJwtAuthorizerIntrinsics(attached, () => undefined);
    expect(jwtOf(resolved).issuer).toContain('placeholderAuth');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /JwtConfiguration\.Issuer is an intrinsic .*no state source is loaded.*JWKS pass-through admits every token/
    );
  });

  it('keeps the placeholder when state lacks the pool record', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers([stack({ Issuer: COGNITO_ISSUER, Audience: [] })], [ROUTE]);
    const resolved = resolveJwtAuthorizerIntrinsics(attached, () => ({
      resources: {},
      pseudoParameters: { region: 'eu-west-1' },
    }));
    expect(jwtOf(resolved).issuer).toContain('placeholderAuth');
    expect(String(warn.mock.calls[0]?.[0])).toContain('JwtConfiguration.Issuer is an intrinsic');
  });

  it('verifies without an audience check when only an audience entry is unresolved', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers(
      [stack({ Issuer: COGNITO_ISSUER, Audience: ['literal-aud', { Ref: 'Missing' }] })],
      [ROUTE]
    );
    const jwt = jwtOf(resolveJwtAuthorizerIntrinsics(attached, () => STATE));
    expect(jwt.issuer).toBe('https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC123');
    expect(jwt.audience).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /Audience \[1\] could not be resolved \(.*Missing.*\)/
    );
  });

  it('drops a non-string literal audience entry as the all-literal path does', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const attached = attachAuthorizers(
      [stack({ Issuer: COGNITO_ISSUER, Audience: [{ Ref: 'Client' }, 42] })],
      [ROUTE]
    );
    expect(jwtOf(resolveJwtAuthorizerIntrinsics(attached, () => STATE)).audience).toEqual(['client123']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once across calls sharing a warned set (--watch reloads)', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const warned = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const attached = attachAuthorizers([stack({ Issuer: COGNITO_ISSUER })], [ROUTE]);
      resolveJwtAuthorizerIntrinsics(attached, () => undefined, warned);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('resolves a literal issuer with an intrinsic audience', () => {
    const attached = attachAuthorizers(
      [stack({ Issuer: 'https://issuer.example.com', Audience: [{ Ref: 'Client' }] })],
      [ROUTE]
    );
    const jwt = jwtOf(resolveJwtAuthorizerIntrinsics(attached, () => STATE));
    expect(jwt.issuer).toBe('https://issuer.example.com');
    expect(jwt.audience).toEqual(['client123']);
  });

  it('leaves a fully literal authorizer untouched', () => {
    const attached = attachAuthorizers(
      [stack({ Issuer: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_X', Audience: ['a'] })],
      [ROUTE]
    );
    expect(jwtOf(attached).pending).toBeUndefined();
    const resolved = resolveJwtAuthorizerIntrinsics(attached, () => undefined);
    expect(resolved[0]).toBe(attached[0]);
    expect(jwtOf(resolved).userPoolId).toBe('us-west-2_X');
  });

  it('still refuses an empty or non-string, non-intrinsic issuer', () => {
    for (const Issuer of ['', 42, ['x']]) {
      expect(() => attachAuthorizers([stack({ Issuer })], [ROUTE])).toThrow(
        /JwtConfiguration\.Issuer must be a string or an intrinsic/
      );
    }
  });
});
