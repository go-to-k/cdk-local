import { generateKeyPairSync, createSign } from 'node:crypto';
import { http } from '../../helpers/agentless-http.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { startApiServer } from '../../../src/local/http-server.js';
import type {
  AuthorizerInfo,
  CognitoUserPoolAuthorizer,
  JwtAuthorizer,
  LambdaTokenAuthorizer,
  RouteWithAuth,
} from '../../../src/local/authorizer-resolver.js';
import { createAuthorizerCache } from '../../../src/local/authorizer-cache.js';
import { createJwksCache } from '../../../src/local/cognito-jwt.js';
import type { ContainerPool } from '../../../src/local/container-pool.js';

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
  invokeRieStreaming: vi.fn(),
}));
import * as rieClient from '../../../src/local/rie-client.js';
const invokeRieMock = rieClient.invokeRie as unknown as ReturnType<typeof vi.fn>;

// go-to-k/cdk-local#1011 / #1012 / #1015: the per-route claim checks and the
// rejection statuses, each as measured against a deployed API Gateway
// (throwaway REST v1 + HTTP v2 APIs on a Cognito user pool, 2026-11-21).

const POOL_ID = 'us-east-1_x';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}`;
const CLIENT_ID = 'client123';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { kid: 'k1', ...(publicKey.export({ format: 'jwk' }) as Record<string, string>) };

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function sign(payload: Record<string, unknown>): string {
  const input = `${b64(JSON.stringify({ alg: 'RS256', kid: 'k1' }))}.${b64(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${b64(signer.sign(privateKey))}`;
}

const exp = (): number => Math.floor(Date.now() / 1000) + 3600;
// The claim key sets the deployed Cognito pool issued.
const ID_TOKEN = sign({ sub: 'u1', iss: ISSUER, aud: CLIENT_ID, token_use: 'id', exp: exp() });
const ACCESS_TOKEN = sign({
  sub: 'u1',
  iss: ISSUER,
  client_id: CLIENT_ID,
  token_use: 'access',
  scope: 'aws.cognito.signin.user.admin orders/read',
  exp: exp(),
});

function tamper(token: string): string {
  const [h, p, s] = token.split('.') as [string, string, string];
  const mid = Math.floor(s.length / 2);
  return `${h}.${p}.${s.slice(0, mid)}${s[mid] === 'A' ? 'B' : 'A'}${s.slice(mid + 1)}`;
}

function makePool(): ContainerPool {
  return {
    acquire: vi.fn(async () => ({
      containerId: 'c1',
      containerHost: '127.0.0.1',
      hostPort: 1234,
      logicalId: 'X',
      release: vi.fn(),
    })),
    release: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } as unknown as ContainerPool;
}

const COGNITO: CognitoUserPoolAuthorizer = {
  kind: 'cognito',
  logicalId: 'Auth',
  pools: [
    { userPoolArn: `arn:aws:cognito-idp:us-east-1:111:userpool/${POOL_ID}`, region: 'us-east-1', userPoolId: POOL_ID },
  ],
  userPoolArn: `arn:aws:cognito-idp:us-east-1:111:userpool/${POOL_ID}`,
  region: 'us-east-1',
  userPoolId: POOL_ID,
  declaredAt: 'S/Method',
};

const JWT: JwtAuthorizer = {
  kind: 'jwt',
  logicalId: 'Auth',
  issuer: ISSUER,
  audience: [CLIENT_ID],
  region: 'us-east-1',
  userPoolId: POOL_ID,
  declaredAt: 'S/Route',
};

function route(path: string, authorizer: AuthorizerInfo, apiVersion: 'v1' | 'v2' = 'v1'): RouteWithAuth {
  return {
    route: {
      method: 'GET',
      pathPattern: path,
      lambdaLogicalId: 'HandlerFn',
      source: apiVersion === 'v1' ? 'rest-v1' : 'http-api',
      apiVersion,
      stage: apiVersion === 'v1' ? 'prod' : '$default',
      declaredAt: `S/${path}`,
    },
    authorizer,
  };
}

async function serve(
  routes: RouteWithAuth[],
  jwksReachable = true
): Promise<{ url: (p: string) => string; close: () => Promise<void> }> {
  const jwksCache = createJwksCache({
    fetchImpl: async () => {
      if (!jwksReachable) throw new Error('unreachable');
      return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [JWK] }) };
    },
  });
  const server = await startApiServer({
    state: { routes, pool: makePool(), corsConfigByApiId: new Map() },
    rieTimeoutMs: 1000,
    host: '127.0.0.1',
    port: 0,
    jwksCache,
    authorizerCache: createAuthorizerCache(),
  });
  return { url: (p) => `http://${server.host}:${server.port}${p}`, close: () => server.close() };
}

async function get(url: string, authorization?: string): Promise<{ status: number; body: string }> {
  const r = await http(url, { headers: authorization === undefined ? {} : { authorization } });
  return { status: r.status, body: await r.text() };
}

const UNAUTHORIZED = { status: 401, body: '{"message":"Unauthorized"}' };

beforeEach(() => {
  invokeRieMock.mockReset();
  invokeRieMock.mockImplementation(async (_h, _p, event) => {
    if ((event as { type?: string }).type === 'TOKEN') {
      return {
        raw: '',
        payload: {
          principalId: 'u',
          policyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Resource: 'arn:aws:execute-api:local:123456789012:local/prod/GET/token',
              },
            ],
          },
        },
      };
    }
    return { raw: '', payload: { statusCode: 200, body: 'ok' } };
  });
});

describe('REST v1 COGNITO_USER_POOLS rejection status (#1012)', () => {
  let srv: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => {
    srv = await serve([route('/plain', COGNITO)]);
  });
  afterEach(async () => srv.close());

  it('answers a garbage token 401 Unauthorized, not 403', async () => {
    expect(await get(srv.url('/plain'), 'Bearer garbage.garbage.garbage')).toEqual(UNAUTHORIZED);
    expect(await get(srv.url('/plain'), 'garbage')).toEqual(UNAUTHORIZED);
  });

  it('answers a missing token 401', async () => {
    expect(await get(srv.url('/plain'))).toEqual(UNAUTHORIZED);
  });

  it('answers a token whose signature does not verify 403 Access Denied', async () => {
    expect(await get(srv.url('/plain'), `Bearer ${tamper(ID_TOKEN)}`)).toEqual({
      status: 403,
      body: '{"Message":"Access Denied"}',
    });
  });

  it('answers an expired token 401 "The incoming token has expired"', async () => {
    const expired = sign({ iss: ISSUER, aud: CLIENT_ID, token_use: 'id', exp: 1 });
    expect(await get(srv.url('/plain'), `Bearer ${expired}`)).toEqual({
      status: 401,
      body: '{"message":"The incoming token has expired"}',
    });
  });

  it('answers a foreign-issuer or unsigned (alg none) token 401 Unauthorized', async () => {
    const foreign = sign({ iss: `${ISSUER}other`, aud: CLIENT_ID, token_use: 'id', exp: exp() });
    const [, payload] = ID_TOKEN.split('.');
    const unsigned = `${b64(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${payload}.`;
    expect(await get(srv.url('/plain'), `Bearer ${foreign}`)).toEqual(UNAUTHORIZED);
    expect(await get(srv.url('/plain'), `Bearer ${unsigned}`)).toEqual(UNAUTHORIZED);
  });

  it('accepts an ID token with or without the Bearer prefix (#1015)', async () => {
    expect((await get(srv.url('/plain'), `Bearer ${ID_TOKEN}`)).status).toBe(200);
    expect((await get(srv.url('/plain'), ID_TOKEN)).status).toBe(200);
  });

  it('answers an access token 401 on a method without AuthorizationScopes (#1011)', async () => {
    expect(await get(srv.url('/plain'), `Bearer ${ACCESS_TOKEN}`)).toEqual(UNAUTHORIZED);
  });
});

describe('Cognito / JWT authorizer cache key', () => {
  it('shares one entry between "Bearer <t>" and a bare "<t>", and keeps a different token apart', async () => {
    let fetches = 0;
    let verifies = 0;
    const jwksCache = createJwksCache({
      fetchImpl: async () => {
        fetches++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [JWK] }) };
      },
    });
    // Count signature verifications through a JWKS cache whose entry is
    // re-read on every verification (the verdict cache sits in front of it).
    const countingJwks = {
      ...jwksCache,
      fetchAndCache: async (url: string) => {
        verifies++;
        return jwksCache.fetchAndCache(url);
      },
    };
    const authorizerCache = createAuthorizerCache();
    const server = await startApiServer({
      state: {
        routes: [route('/rest', COGNITO), route('/http', JWT, 'v2')],
        pool: makePool(),
        corsConfigByApiId: new Map(),
      },
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
      jwksCache: countingJwks,
      authorizerCache,
    });
    const url = (p: string): string => `http://${server.host}:${server.port}${p}`;
    try {
      expect((await get(url('/rest'), `Bearer ${ID_TOKEN}`)).status).toBe(200);
      expect((await get(url('/rest'), ID_TOKEN)).status).toBe(200);
      expect((await get(url('/rest'), `bearer  ${ID_TOKEN}`)).status).toBe(200);
      expect(verifies).toBe(1);
      expect(authorizerCache.get('Auth', ID_TOKEN)).toBeDefined();
      expect(authorizerCache.get('Auth', `Bearer ${ID_TOKEN}`)).toBeUndefined();

      const otherIdToken = sign({ sub: 'u2', iss: ISSUER, aud: CLIENT_ID, token_use: 'id', exp: exp() });
      expect((await get(url('/rest'), `Bearer ${otherIdToken}`)).status).toBe(200);
      expect(verifies).toBe(2);
      // A tampered token is not served the cached Allow of the real one.
      expect((await get(url('/rest'), `Bearer ${tamper(ID_TOKEN)}`)).status).toBe(403);

      verifies = 0;
      expect((await get(url('/http'), `Bearer ${ACCESS_TOKEN}`)).status).toBe(200);
      expect((await get(url('/http'), ACCESS_TOKEN)).status).toBe(200);
      expect(verifies).toBe(1);
      const otherAccess = sign({ sub: 'u2', iss: ISSUER, client_id: CLIENT_ID, token_use: 'access', exp: exp() });
      expect((await get(url('/http'), `Bearer ${otherAccess}`)).status).toBe(200);
      expect(verifies).toBe(2);
      expect(fetches).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe('REST v1 COGNITO_USER_POOLS AuthorizationScopes (#1011)', () => {
  let srv: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => {
    srv = await serve([
      route('/hit', { ...COGNITO, scopes: { state: 'enforced', value: ['orders/write', 'orders/read'] } }),
      route('/miss', { ...COGNITO, scopes: { state: 'enforced', value: ['other/scope'] } }),
      route('/pending', {
        ...COGNITO,
        scopes: { state: 'unresolved', stackName: 'S', raw: [{ Ref: 'X' }], reason: 'r' },
      }),
    ]);
  });
  afterEach(async () => srv.close());

  it('accepts an access token carrying at least one listed scope', async () => {
    expect((await get(srv.url('/hit'), `Bearer ${ACCESS_TOKEN}`)).status).toBe(200);
  });

  it('answers 401 for an access token carrying none — after a cache hit on another route too', async () => {
    // /hit caches the token's Allow under the authorizer; /miss must still
    // check.
    expect((await get(srv.url('/hit'), ACCESS_TOKEN)).status).toBe(200);
    expect(await get(srv.url('/miss'), ACCESS_TOKEN)).toEqual(UNAUTHORIZED);
  });

  it('answers 401 for an ID token, which carries no scope', async () => {
    expect(await get(srv.url('/hit'), `Bearer ${ID_TOKEN}`)).toEqual(UNAUTHORIZED);
  });

  it('accepts any access token while the scopes stay unresolved, and still refuses an ID token', async () => {
    expect((await get(srv.url('/pending'), `Bearer ${ACCESS_TOKEN}`)).status).toBe(200);
    expect(await get(srv.url('/pending'), `Bearer ${ID_TOKEN}`)).toEqual(UNAUTHORIZED);
  });
});

describe('REST v1 COGNITO_USER_POOLS IdentityValidationExpression (#1011)', () => {
  it('matches the whole aud claim', async () => {
    const srv = await serve([
      route('/exact', { ...COGNITO, identityValidation: { state: 'enforced', value: CLIENT_ID } }),
      route('/prefix', {
        ...COGNITO,
        identityValidation: { state: 'enforced', value: CLIENT_ID.slice(0, -1) },
      }),
    ]);
    try {
      expect((await get(srv.url('/exact'), `Bearer ${ID_TOKEN}`)).status).toBe(200);
      expect(await get(srv.url('/prefix'), `Bearer ${ID_TOKEN}`)).toEqual(UNAUTHORIZED);
    } finally {
      await srv.close();
    }
  });
});

describe('JWKS pass-through skips the claim checks', () => {
  it('admits a garbage token on a scoped, validated Cognito method', async () => {
    const srv = await serve(
      [
        route('/scoped', {
          ...COGNITO,
          scopes: { state: 'enforced', value: ['orders/read'] },
          identityValidation: { state: 'enforced', value: 'nomatch' },
        }),
      ],
      false
    );
    try {
      expect((await get(srv.url('/scoped'), 'Bearer garbage')).status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});

describe('JWKS pass-through skips the claim checks for a parsed token too', () => {
  it('admits a signed ID token on a scoped, validated Cognito method, and an HTTP route missing its scope', async () => {
    const srv = await serve(
      [
        route('/rest', {
          ...COGNITO,
          scopes: { state: 'enforced', value: ['orders/read'] },
          identityValidation: { state: 'enforced', value: 'nomatch' },
        }),
        route('/http', { ...JWT, scopes: { state: 'enforced', value: ['other/scope'] } }, 'v2'),
      ],
      false
    );
    try {
      expect((await get(srv.url('/rest'), `Bearer ${ID_TOKEN}`)).status).toBe(200);
      expect((await get(srv.url('/http'), `Bearer ${ACCESS_TOKEN}`)).status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});

describe('HTTP v2 JWT AuthorizationScopes — unresolved and scp (#1011)', () => {
  it('accepts any valid token while the scopes stay unresolved', async () => {
    const srv = await serve([
      route(
        '/pending',
        { ...JWT, scopes: { state: 'unresolved', stackName: 'S', raw: [{ Ref: 'X' }], reason: 'r' } },
        'v2'
      ),
    ]);
    try {
      expect((await get(srv.url('/pending'), `Bearer ${ID_TOKEN}`)).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('reads the scp claim, as a string or an array, as the deployed JWT authorizer does', async () => {
    const srv = await serve([
      route('/scp', { ...JWT, scopes: { state: 'enforced', value: ['orders/read'] } }, 'v2'),
    ]);
    const base = { sub: 'u1', iss: ISSUER, aud: CLIENT_ID, exp: exp() };
    try {
      expect((await get(srv.url('/scp'), `Bearer ${sign({ ...base, scp: 'a orders/read' })}`)).status).toBe(200);
      expect((await get(srv.url('/scp'), `Bearer ${sign({ ...base, scp: ['orders/read'] })}`)).status).toBe(200);
      expect((await get(srv.url('/scp'), `Bearer ${sign({ ...base, scp: ['other'] })}`)).status).toBe(403);
    } finally {
      await srv.close();
    }
  });
});

describe('HTTP v2 JWT AuthorizationScopes (#1011)', () => {
  let srv: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => {
    srv = await serve([
      route('/hit', { ...JWT, scopes: { state: 'enforced', value: ['orders/read'] } }, 'v2'),
      route('/miss', { ...JWT, scopes: { state: 'enforced', value: ['other/scope'] } }, 'v2'),
      route('/plain', JWT, 'v2'),
    ]);
  });
  afterEach(async () => srv.close());

  it('accepts a token carrying a listed scope, and either token type without scopes', async () => {
    expect((await get(srv.url('/hit'), `Bearer ${ACCESS_TOKEN}`)).status).toBe(200);
    expect((await get(srv.url('/plain'), `Bearer ${ID_TOKEN}`)).status).toBe(200);
    expect((await get(srv.url('/plain'), `Bearer ${ACCESS_TOKEN}`)).status).toBe(200);
  });

  it('checks the scopes on a cache hit from another route', async () => {
    expect((await get(srv.url('/hit'), ACCESS_TOKEN)).status).toBe(200);
    expect((await get(srv.url('/miss'), ACCESS_TOKEN)).status).toBe(403);
  });

  it('answers 403 Forbidden for a token without one — the ID token included', async () => {
    const forbidden = { status: 403, body: '{"message":"Forbidden"}' };
    expect(await get(srv.url('/miss'), `Bearer ${ACCESS_TOKEN}`)).toEqual(forbidden);
    expect(await get(srv.url('/hit'), `Bearer ${ID_TOKEN}`)).toEqual(forbidden);
  });

  it('keeps 401 for a garbage token, and accepts a raw token without Bearer (#1015)', async () => {
    expect(await get(srv.url('/plain'), 'Bearer garbage')).toEqual(UNAUTHORIZED);
    expect((await get(srv.url('/plain'), ACCESS_TOKEN)).status).toBe(200);
  });
});

describe('REST v1 TOKEN IdentityValidationExpression (#1011)', () => {
  const TOKEN: LambdaTokenAuthorizer = {
    kind: 'lambda-token',
    logicalId: 'TokAuth',
    lambdaLogicalId: 'AuthFn',
    tokenHeader: 'authorization',
    resultTtlSeconds: 0,
    identityValidation: { state: 'enforced', value: 'abc' },
    declaredAt: 'S/Method',
  };
  const tokenInvocations = (): number =>
    invokeRieMock.mock.calls.filter((c) => (c[2] as { type?: string }).type === 'TOKEN').length;

  it('answers 401 without invoking the Lambda unless the WHOLE value matches', async () => {
    const srv = await serve([route('/token', TOKEN)]);
    try {
      expect(await get(srv.url('/token'), 'xabcx')).toEqual(UNAUTHORIZED);
      expect(await get(srv.url('/token'), 'abcd')).toEqual(UNAUTHORIZED);
      expect(tokenInvocations()).toBe(0);
      expect((await get(srv.url('/token'), 'abc')).status).toBe(200);
      expect(tokenInvocations()).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('invokes the Lambda for every token while the expression stays unresolved', async () => {
    const srv = await serve([
      route('/token', {
        ...TOKEN,
        identityValidation: { state: 'unresolved', stackName: 'S', raw: { Ref: 'P' }, reason: 'r' },
      }),
    ]);
    try {
      expect((await get(srv.url('/token'), 'xabcx')).status).toBe(200);
      expect(tokenInvocations()).toBe(1);
    } finally {
      await srv.close();
    }
  });
});
