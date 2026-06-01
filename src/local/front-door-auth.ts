import { verifyJwtAuthorizer, type JwksCache } from './cognito-jwt.js';
import type { AuthCheck } from './front-door-server.js';
import type { FrontDoorAuthGuard } from './elb-front-door-resolver.js';
import { getLogger } from '../utils/logger.js';

/**
 * Build the front-door's auth-check callback for an
 * `authenticate-cognito` / `authenticate-oidc` guard.
 *
 * Local-dev parity model: the cloud-side ALB authenticates the user via a
 * full OAuth roundtrip (redirect to the IdP's authorize endpoint, callback,
 * AWSELBAuthSessionCookie issuance). The local front-door does NOT reproduce
 * the roundtrip — it accepts EITHER a Bearer JWT (verified against the
 * Cognito JWKS / OIDC discovery URL just like API Gateway's JWT authorizer)
 * OR an `AWSELBAuthSessionCookie-*` cookie pass-through (the user is acting
 * as if already signed in via the deployed ALB — `--bearer-token` makes the
 * Bearer-JWT path the headline path; the cookie pass-through is convenience
 * for hitting the local front-door from a browser session that already
 * authenticated through the deployed ALB).
 *
 * `--no-verify-auth` (the `noVerifyAuth` flag) short-circuits everything to
 * `allow: true` — explicitly off-switching the guard for local dev where
 * you do not want to mint a Bearer token at all.
 *
 * `--bearer-token <jwt>` (the `bearerToken` arg) makes the supplied token
 * the default `Authorization` value when the inbound request has none.
 */
export function buildAuthCheck(
  guard: FrontDoorAuthGuard,
  jwksCache: JwksCache,
  opts: {
    /** When true, the check resolves `{ allow: true }` for every request. */
    noVerifyAuth?: boolean;
    /** Injected as the default `Authorization: Bearer <jwt>` when missing. */
    bearerToken?: string;
    /**
     * Shared "JWKS warn-once" Set. Lifted to caller scope so two rules
     * pointing at the same Cognito JWKS URL share the warn-on-first-request
     * de-dupe instead of each warning independently.
     */
    warned?: Set<string>;
  } = {}
): AuthCheck {
  const realm = guard.label;

  if (opts.noVerifyAuth === true) {
    return {
      realm,
      check: async () => ({ allow: true }),
    };
  }

  // De-dupe "JWKS unreachable -> pass-through" warn lines across requests for
  // the same authorizer URL (matches how start-api's JWT authorizers behave).
  // Falls back to a per-AuthCheck Set when the caller did not supply one.
  const warned = opts.warned ?? new Set<string>();
  const sessionCookiePrefix = guard.sessionCookieName;
  const injectedBearer = opts.bearerToken;

  return {
    realm,
    check: async (headers) => {
      // 1) Cookie pass-through. The deployed ALB issues
      //    `AWSELBAuthSessionCookie-N` cookies after a successful sign-in;
      //    when one is present on the request we accept it locally so the
      //    browser session that already authenticated through the cloud
      //    ALB keeps working against the local front-door.
      const cookieHeader = headerValue(headers['cookie']);
      if (cookieHeader && cookieHasSessionPrefix(cookieHeader, sessionCookiePrefix)) {
        return { allow: true };
      }

      // 2) Bearer JWT — inbound `Authorization` header wins; otherwise fall
      //    back to `--bearer-token` when supplied. A non-Bearer scheme
      //    (e.g. `Basic`) is rejected with a scheme-specific reason so the
      //    user does not assume the JWKS / iss / aud check rejected them.
      let authorization = headerValue(headers['authorization']);
      if ((!authorization || authorization === '') && injectedBearer !== undefined) {
        authorization = `Bearer ${injectedBearer}`;
      }
      if (!authorization || authorization === '') {
        return {
          allow: false,
          reason:
            'No Bearer token presented. Supply Authorization: Bearer <jwt> or pass --bearer-token <jwt>.',
        };
      }
      if (!authorization.toLowerCase().startsWith('bearer ')) {
        return {
          allow: false,
          reason:
            'Authorization scheme is not Bearer; the ALB authenticate-* guard only accepts Bearer JWTs.',
        };
      }

      // The existing `verifyJwtAuthorizer` handles both shapes — Cognito's
      // direct JWKS URL (when `region` + `userPoolId` are present) and the
      // generic OIDC-issuer discovery URL.
      try {
        const result = await verifyJwtAuthorizer(
          {
            kind: 'jwt',
            logicalId: guard.label,
            declaredAt: 'start-alb authenticate-* action',
            issuer: guard.issuer,
            audience: [guard.audience],
            ...(guard.region !== undefined && { region: guard.region }),
            ...(guard.userPoolId !== undefined && { userPoolId: guard.userPoolId }),
          },
          authorization,
          jwksCache,
          { warned }
        );
        if (result.allow) return { allow: true };
        return {
          allow: false,
          reason: 'Bearer token rejected (signature / iss / aud / exp check failed).',
        };
      } catch (err) {
        const errClass = err instanceof Error ? err.constructor.name : typeof err;
        const errMessage = err instanceof Error ? err.message : String(err);
        getLogger()
          .child('front-door-auth')
          .warn(
            `Bearer JWT verification threw (${errClass}): ${errMessage}. ` +
              `Returning 401 to client. Check the JWKS URL is reachable and the token is well-formed.`
          );
        return {
          allow: false,
          reason: `Auth check failed: ${errClass} — ${errMessage}`,
        };
      }
    },
  };
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * True iff the `Cookie` header contains a cookie whose name starts with
 * `<sessionCookiePrefix>` (ALB suffixes the cookie with `-0` / `-1` / ...
 * when the auth session payload exceeds the per-cookie size limit, so we
 * match the prefix, not an exact name).
 */
function cookieHasSessionPrefix(cookieHeader: string, sessionCookiePrefix: string): boolean {
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    if (name === sessionCookiePrefix || name.startsWith(`${sessionCookiePrefix}-`)) {
      return true;
    }
  }
  return false;
}
