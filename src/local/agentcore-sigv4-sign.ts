import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { AGENTCORE_SESSION_ID_HEADER } from './agentcore-client.js';

/**
 * Client-side SigV4 signing for `cdkl invoke-agentcore --sigv4`.
 *
 * AgentCore's `InvokeAgentRuntime` API authenticates inbound `/invocations`
 * requests with IAM SigV4 when the runtime declares no
 * `customJwtAuthorizer`. The deployed cloud verifies the signature; a locally
 * running agent never does (no AWS public-key infra inside the container),
 * but an agent that introspects the `Authorization` header (e.g. via the
 * `bedrock-agentcore` SDK's request context) sees the same shape it would in
 * the cloud — header parity for debugging and local-dev of IAM-aware agents.
 *
 * Signing is OPT-IN via `--sigv4` on the command. Default behavior is
 * unchanged: no Authorization header on an unauthenticated invoke.
 */

/** AWS service name for AgentCore InvokeAgentRuntime SigV4 signing. */
export const AGENTCORE_SIGV4_SERVICE = 'bedrock-agentcore';

/** Static (or STS-issued) credentials for SigV4 signing. */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignAgentCoreInvocationOptions {
  credentials: SigV4Credentials;
  region: string;
  host: string;
  port: number;
  /** Path of the request being signed (e.g. `/invocations`). */
  path: string;
  /** Stringified request body the signature commits to. */
  body: string;
  /** AgentCore session id (sent as the session-id header AND part of the signed canonical request). */
  sessionId: string;
  /** HTTP method (default `POST`). */
  method?: string;
  /** `now()` for deterministic tests. Defaults to real `Date.now`. */
  now?: () => number;
}

/**
 * The headers an inbound SigV4-signed `/invocations` request carries. The
 * caller forwards every entry to the agent container; the agent sees the same
 * header set the cloud-side AgentCore would see.
 */
export interface SignedAgentCoreHeaders {
  /** `AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...`. */
  authorization: string;
  /** `X-Amz-Date` ISO-8601 basic timestamp used in the signature. */
  amzDate: string;
  /** `X-Amz-Content-Sha256` payload hex digest (always sent so a body-stripping proxy can't alter it). */
  amzContentSha256: string;
  /** `X-Amz-Security-Token` — only present for STS-issued credentials. */
  amzSecurityToken?: string;
}

/**
 * Build a SigV4 signature for a `POST /invocations` request to the local
 * AgentCore container. Returns the headers that must be forwarded.
 */
export async function signAgentCoreInvocation(
  opts: SignAgentCoreInvocationOptions
): Promise<SignedAgentCoreHeaders> {
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: opts.credentials.accessKeyId,
      secretAccessKey: opts.credentials.secretAccessKey,
      ...(opts.credentials.sessionToken && { sessionToken: opts.credentials.sessionToken }),
    },
    region: opts.region,
    service: AGENTCORE_SIGV4_SERVICE,
    sha256: Sha256,
  });

  const request = {
    method: opts.method ?? 'POST',
    protocol: 'http:',
    hostname: opts.host,
    port: opts.port,
    path: opts.path,
    headers: {
      'Content-Type': 'application/json',
      Host: `${opts.host}:${opts.port}`,
      [AGENTCORE_SESSION_ID_HEADER]: opts.sessionId,
    },
    body: opts.body,
  };

  const signed = await signer.sign(request, {
    ...(opts.now && { signingDate: new Date(opts.now()) }),
  });

  // Header keys come back in mixed case from @smithy/signature-v4. Read
  // case-insensitively so the rest of the command doesn't care.
  const get = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(signed.headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  };

  const authorization = get('authorization');
  const amzDate = get('x-amz-date');
  const amzContentSha256 = get('x-amz-content-sha256');
  if (!authorization || !amzDate) {
    throw new Error('SigV4 signing produced no Authorization / X-Amz-Date header — internal error');
  }

  const out: SignedAgentCoreHeaders = {
    authorization,
    amzDate,
    amzContentSha256: amzContentSha256 ?? '',
  };
  const amzSecurityToken = get('x-amz-security-token');
  if (amzSecurityToken) out.amzSecurityToken = amzSecurityToken;
  return out;
}
