import type { IncomingHttpHeaders } from 'node:http';
import {
  createJwksCache,
  verifyJwtViaDiscovery,
  type JwksCache,
  type WarnedAt,
} from './cognito-jwt.js';
import type { AgentCoreJwtAuthorizer } from './agentcore-resolver.js';

/**
 * Per-request inbound-auth verdict for the `cdkl start-agentcore` warm HTTP
 * serve. The serve front door calls the {@link AgentCoreServeAuthCheck} on every
 * contract request and either forwards (with the verified / injected
 * `Authorization`) or rejects with the carried status.
 */
export interface AgentCoreServeAuthResult {
  /** Whether to forward the request to the warm container. */
  allow: boolean;
  /** HTTP status to return on deny — 401 (missing token) / 403 (invalid). */
  status?: number;
  /** Human-readable deny reason, returned in the JSON error body. */
  message?: string;
  /**
   * The `Authorization` header to forward on allow. The verified inbound token,
   * or the `--bearer-token` default when the inbound request carried none.
   */
  authorization?: string;
}

/**
 * Verify one inbound request's `Authorization` against the runtime's
 * `customJwtAuthorizer`. Reads only headers (never the body), so the serve's
 * streaming proxy stays streaming.
 */
export type AgentCoreServeAuthCheck = (
  headers: IncomingHttpHeaders
) => Promise<AgentCoreServeAuthResult>;

/** Options for {@link buildAgentCoreServeAuthCheck}. */
export interface BuildAgentCoreServeAuthCheckOptions {
  /**
   * Skip verification entirely (the `--no-verify-auth` escape hatch): every
   * request is allowed, and a `--bearer-token`, if given, is still forwarded.
   */
  noVerifyAuth?: boolean;
  /**
   * Default token (`--bearer-token`) injected as `Authorization: Bearer <jwt>`
   * when the inbound request carries no `Authorization` of its own.
   */
  bearerToken?: string;
  /** JWKS cache (defaults to a fresh one); pass a shared cache so a long-running serve reuses fetched keys. */
  jwksCache?: JwksCache;
  /** Shared "JWKS unreachable" warn re-emit window so a long serve re-surfaces degraded auth. */
  warnedAt?: WarnedAt;
}

/**
 * Build the per-request inbound-JWT gate for `cdkl start-agentcore`. The cloud
 * AgentCore Runtime verifies the CALLER's token against the
 * `customJwtAuthorizer` on every `InvokeAgentRuntime`; the warm local serve
 * mirrors that here — unlike the single-shot `cdkl invoke-agentcore`, which
 * verifies the `--bearer-token` ONCE at boot. This is the serve counterpart of
 * `front-door-auth`'s `buildAuthCheck` for the ALB (issue #454).
 *
 * Semantics (matching the cloud + `resolveInboundAuthorization`):
 *  - `--no-verify-auth` → always allow; forward `--bearer-token` if given.
 *  - inbound `Authorization` present → verify it; absent → fall back to the
 *    injected `--bearer-token`; neither → 401.
 *  - verify failure → 403. An unreachable / malformed discovery URL falls back
 *    to pass-through accept (offline-dev fallback in {@link verifyJwtViaDiscovery}).
 *
 * Exported so a unit test can drive the gate (and a host CLI can reuse it)
 * without the Docker pipeline.
 */
export function buildAgentCoreServeAuthCheck(
  authorizer: AgentCoreJwtAuthorizer,
  opts: BuildAgentCoreServeAuthCheckOptions = {}
): AgentCoreServeAuthCheck {
  const injectedBearer = opts.bearerToken ? `Bearer ${opts.bearerToken}` : undefined;

  if (opts.noVerifyAuth === true) {
    return async () => ({
      allow: true,
      ...(injectedBearer && { authorization: injectedBearer }),
    });
  }

  const jwksCache = opts.jwksCache ?? createJwksCache();
  const warnedAt: WarnedAt = opts.warnedAt ?? new Map<string, number>();

  return async (headers) => {
    const inbound = readAuthorizationHeader(headers);
    const header = inbound ?? injectedBearer;
    if (!header) {
      return {
        allow: false,
        status: 401,
        message:
          'Missing Authorization: this runtime declares a customJwtAuthorizer. ' +
          'Send a Bearer JWT, or start the serve with --bearer-token / --no-verify-auth.',
      };
    }
    const result = await verifyJwtViaDiscovery(
      {
        discoveryUrl: authorizer.discoveryUrl,
        ...(authorizer.allowedAudience && { allowedAudience: authorizer.allowedAudience }),
        ...(authorizer.allowedClients && { allowedClients: authorizer.allowedClients }),
        ...(authorizer.allowedScopes && { allowedScopes: authorizer.allowedScopes }),
        ...(authorizer.customClaims && { customClaims: authorizer.customClaims }),
      },
      header,
      jwksCache,
      { warnedAt }
    );
    if (!result.allow) {
      return {
        allow: false,
        status: 403,
        message:
          "Forbidden: the inbound JWT was rejected by the runtime's customJwtAuthorizer " +
          `(signature / issuer / expiry / audience / scope check failed against ${authorizer.discoveryUrl}).`,
      };
    }
    return { allow: true, authorization: header };
  };
}

/** Read a single `Authorization` header value (first when duplicated, undefined when empty). */
function readAuthorizationHeader(headers: IncomingHttpHeaders): string | undefined {
  const v = headers['authorization'];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
