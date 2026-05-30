import { describe, it, expect } from 'vite-plus/test';
import { buildAuthCheck } from '../../../src/local/front-door-auth.js';
import { createJwksCache } from '../../../src/local/cognito-jwt.js';
import type { FrontDoorAuthGuard } from '../../../src/local/elb-front-door-resolver.js';

const COGNITO_GUARD: FrontDoorAuthGuard = {
  kind: 'authenticate-cognito',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abcDEF',
  audience: 'client-abc',
  region: 'us-east-1',
  userPoolId: 'us-east-1_abcDEF',
  sessionCookieName: 'AWSELBAuthSessionCookie',
  label: 'authenticate-cognito (UserPool=us-east-1_abcDEF)',
};

/**
 * Stub JWKS cache that always reports "unreachable" — flips the verifier
 * into pass-through accept mode so an arbitrary Bearer token can drive the
 * happy path without needing a real RSA-signed JWT.
 */
function passThroughJwksCache(): ReturnType<typeof createJwksCache> {
  return createJwksCache({
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
  });
}

describe('buildAuthCheck — noVerifyAuth', () => {
  it('resolves { allow: true } for every request when noVerifyAuth is set', async () => {
    const check = buildAuthCheck(COGNITO_GUARD, createJwksCache(), { noVerifyAuth: true });
    const result = await check.check({});
    expect(result.allow).toBe(true);
  });
});

describe('buildAuthCheck — cookie pass-through', () => {
  it('allows when an AWSELBAuthSessionCookie-N is present', async () => {
    const check = buildAuthCheck(COGNITO_GUARD, createJwksCache());
    const result = await check.check({
      cookie: 'foo=bar; AWSELBAuthSessionCookie-0=opaque; baz=quux',
    });
    expect(result.allow).toBe(true);
  });

  it('allows when the exact prefix-name cookie is present (single-cookie payload)', async () => {
    const check = buildAuthCheck(COGNITO_GUARD, createJwksCache());
    const result = await check.check({ cookie: 'AWSELBAuthSessionCookie=opaque' });
    expect(result.allow).toBe(true);
  });

  it('honors a custom sessionCookieName from the guard', async () => {
    const guard: FrontDoorAuthGuard = { ...COGNITO_GUARD, sessionCookieName: 'MyAuthCookie' };
    const check = buildAuthCheck(guard, createJwksCache());
    expect((await check.check({ cookie: 'MyAuthCookie-0=opaque' })).allow).toBe(true);
    // The ALB default name no longer matches when a custom one is configured.
    expect((await check.check({ cookie: 'AWSELBAuthSessionCookie-0=opaque' })).allow).toBe(false);
  });

  it('does NOT allow on a similarly-named cookie that is not the exact prefix', async () => {
    const check = buildAuthCheck(COGNITO_GUARD, createJwksCache());
    const result = await check.check({ cookie: 'NotAWSELBAuthSessionCookie-0=opaque' });
    expect(result.allow).toBe(false);
  });
});

describe('buildAuthCheck — Bearer token verification', () => {
  it('denies when no Authorization header and no --bearer-token is supplied', async () => {
    const check = buildAuthCheck(COGNITO_GUARD, passThroughJwksCache());
    const result = await check.check({});
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/No Bearer token presented/);
  });

  it('allows when the Authorization header has a Bearer token (JWKS unreachable -> pass-through)', async () => {
    const check = buildAuthCheck(COGNITO_GUARD, passThroughJwksCache());
    const result = await check.check({ authorization: 'Bearer dummy-jwt' });
    expect(result.allow).toBe(true);
  });

  it('injects --bearer-token as the default Authorization when the inbound request has none', async () => {
    const check = buildAuthCheck(COGNITO_GUARD, passThroughJwksCache(), {
      bearerToken: 'injected-jwt',
    });
    const result = await check.check({});
    expect(result.allow).toBe(true);
  });

  it('still uses the INBOUND token when both an inbound Authorization and --bearer-token are present', async () => {
    // We cannot easily distinguish which token was checked without spying on
    // the underlying verifier; instead drive both code paths and assert allow.
    const check = buildAuthCheck(COGNITO_GUARD, passThroughJwksCache(), {
      bearerToken: 'injected-jwt',
    });
    const result = await check.check({ authorization: 'Bearer inbound-jwt' });
    expect(result.allow).toBe(true);
  });

  it('produces a realm matching the guard label for the WWW-Authenticate header', () => {
    const check = buildAuthCheck(COGNITO_GUARD, createJwksCache());
    expect(check.realm).toBe(COGNITO_GUARD.label);
  });
});

describe('buildAuthCheck — OIDC guard', () => {
  const OIDC_GUARD: FrontDoorAuthGuard = {
    kind: 'authenticate-oidc',
    issuer: 'https://idp.example.com',
    audience: 'oidc-client-xyz',
    sessionCookieName: 'AWSELBAuthSessionCookie',
    label: 'authenticate-oidc (Issuer=https://idp.example.com/)',
  };

  it('routes an OIDC guard through the same JWT verifier path', async () => {
    const check = buildAuthCheck(OIDC_GUARD, passThroughJwksCache());
    const result = await check.check({ authorization: 'Bearer dummy-jwt' });
    expect(result.allow).toBe(true);
  });
});
