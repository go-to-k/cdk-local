import { describe, it, expect, vi, afterEach } from 'vite-plus/test';

/**
 * Issue #246 site 4 — when the ALB `authenticate-cognito` /
 * `authenticate-oidc` verifier threw (network blip, malformed JWKS
 * cache entry, etc.), the front-door used to:
 *   a) log the exception at `logger.debug` (invisible at default log level);
 *   b) return `reason: 'Auth check failed.'` to the client (generic 401
 *      message — the user can't tell whether JWKS was unreachable, the
 *      token shape was wrong, or the verifier crashed).
 *
 * Lock the bump to `logger.warn` (sticky signal mirroring `cognito-jwt.ts:133`'s
 * JWKS-unreachable shape) AND include the exception class + message head in
 * the user-facing `reason` so the client gets an actionable 401.
 */

vi.mock('../../../src/local/cognito-jwt.js', async (importActual) => {
  const actual = await importActual<object>();
  return {
    ...actual,
    verifyJwtAuthorizer: vi.fn(),
  };
});

import * as cognitoJwt from '../../../src/local/cognito-jwt.js';
import { buildAuthCheck } from '../../../src/local/front-door-auth.js';
import { createJwksCache } from '../../../src/local/cognito-jwt.js';
import type { FrontDoorAuthGuard } from '../../../src/local/elb-front-door-resolver.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';

const verifyMock = cognitoJwt.verifyJwtAuthorizer as unknown as ReturnType<typeof vi.fn>;

const COGNITO_GUARD: FrontDoorAuthGuard = {
  kind: 'authenticate-cognito',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abcDEF',
  audience: 'client-abc',
  region: 'us-east-1',
  userPoolId: 'us-east-1_abcDEF',
  sessionCookieName: 'AWSELBAuthSessionCookie',
  label: 'authenticate-cognito (UserPool=us-east-1_abcDEF)',
};

describe('buildAuthCheck — verifier throw surfaces at warn with actionable reason (issue #246)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    verifyMock.mockReset();
  });

  it('logs the exception class + message at warn (not debug)', async () => {
    class JwksFetchError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'JwksFetchError';
      }
    }
    verifyMock.mockRejectedValue(new JwksFetchError('connect ECONNREFUSED 127.0.0.1:443'));

    // Spy on the prototype so the front-door-auth's
    // `getLogger().child('front-door-auth')` (a fresh child per call)
    // trips the spy regardless of identity.
    const warnSpy = vi
      .spyOn(ConsoleLogger.prototype, 'warn')
      .mockImplementation(() => {});
    const debugSpy = vi
      .spyOn(ConsoleLogger.prototype, 'debug')
      .mockImplementation(() => {});

    const check = buildAuthCheck(COGNITO_GUARD, createJwksCache());
    const result = await check.check({ authorization: 'Bearer dummy-jwt' });

    expect(result.allow).toBe(false);
    // The user-facing reason must name the exception so the 401 surface is
    // actionable (vs the pre-fix 'Auth check failed.' that hid everything).
    expect(result.reason).toContain('JwksFetchError');
    expect(result.reason).toContain('ECONNREFUSED');

    // The warn line must include the exception class — the test pins the
    // shape so a future refactor can't silently revert to a stringly
    // 'something went wrong' message.
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    const verifierWarn = warns.find((w) => w.includes('Bearer JWT verification threw'));
    expect(verifierWarn).toBeDefined();
    expect(verifierWarn!).toContain('JwksFetchError');
    expect(verifierWarn!).toContain('ECONNREFUSED');

    // And no debug log on this path (regression guard for the pre-fix shape).
    const debugs = debugSpy.mock.calls.map((c) => String(c[0]));
    expect(debugs.join('\n')).not.toContain('auth check threw');
  });

  it('handles non-Error throws (string thrown) without crashing', async () => {
    verifyMock.mockRejectedValue('plain-string-error');
    const warnSpy = vi
      .spyOn(ConsoleLogger.prototype, 'warn')
      .mockImplementation(() => {});
    const check = buildAuthCheck(COGNITO_GUARD, createJwksCache());
    const result = await check.check({ authorization: 'Bearer dummy-jwt' });
    expect(result.allow).toBe(false);
    expect(result.reason).toContain('plain-string-error');
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    const verifierWarn = warns.find((w) => w.includes('Bearer JWT verification threw'));
    expect(verifierWarn).toBeDefined();
    expect(verifierWarn!).toContain('plain-string-error');
  });
});
