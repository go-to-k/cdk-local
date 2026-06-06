import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';

// Mock the cognito-jwt boundary so the auth-check logic is driven without a
// real OIDC discovery / JWKS fetch.
const verifyJwtViaDiscovery = vi.fn();
vi.mock('../../../src/local/cognito-jwt.js', () => ({
  createJwksCache: () => ({ __fake: 'jwks-cache' }),
  verifyJwtViaDiscovery: (...args: unknown[]) => verifyJwtViaDiscovery(...args),
}));

import { buildAgentCoreServeAuthCheck } from '../../../src/local/agentcore-serve-auth.js';
import type { AgentCoreJwtAuthorizer } from '../../../src/local/agentcore-resolver.js';

const AUTHORIZER: AgentCoreJwtAuthorizer = {
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  allowedAudience: ['aud-1'],
  allowedClients: ['client-1'],
};

describe('buildAgentCoreServeAuthCheck (issue #454)', () => {
  beforeEach(() => {
    verifyJwtViaDiscovery.mockReset();
  });

  it('--no-verify-auth: always allows, forwarding the --bearer-token default', async () => {
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, {
      noVerifyAuth: true,
      bearerToken: 'dev-token',
    });
    const result = await check({});
    expect(result.allow).toBe(true);
    expect(result.authorization).toBe('Bearer dev-token');
    // The verifier is never consulted under --no-verify-auth.
    expect(verifyJwtViaDiscovery).not.toHaveBeenCalled();
  });

  it('--no-verify-auth with no bearer: allows with no Authorization to forward', async () => {
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, { noVerifyAuth: true });
    const result = await check({});
    expect(result).toEqual({ allow: true });
  });

  it('401 when neither an inbound Authorization nor a --bearer-token is present', async () => {
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, {});
    const result = await check({});
    expect(result.allow).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/Missing Authorization/);
    expect(verifyJwtViaDiscovery).not.toHaveBeenCalled();
  });

  it('verifies the inbound Authorization and forwards it on allow', async () => {
    verifyJwtViaDiscovery.mockResolvedValue({ allow: true });
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, {});
    const result = await check({ authorization: 'Bearer caller-jwt' });
    expect(result).toEqual({ allow: true, authorization: 'Bearer caller-jwt' });
    // The authorizer config is threaded into the verifier verbatim.
    const [cfg, header] = verifyJwtViaDiscovery.mock.calls[0] as [
      { discoveryUrl: string; allowedAudience?: string[]; allowedClients?: string[] },
      string,
    ];
    expect(cfg.discoveryUrl).toBe(AUTHORIZER.discoveryUrl);
    expect(cfg.allowedAudience).toEqual(['aud-1']);
    expect(cfg.allowedClients).toEqual(['client-1']);
    expect(header).toBe('Bearer caller-jwt');
  });

  it('403 when the verifier rejects the inbound token', async () => {
    verifyJwtViaDiscovery.mockResolvedValue({ allow: false });
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, {});
    const result = await check({ authorization: 'Bearer bad-jwt' });
    expect(result.allow).toBe(false);
    expect(result.status).toBe(403);
    expect(result.message).toMatch(/rejected by the runtime's customJwtAuthorizer/);
  });

  it('falls back to the --bearer-token default when the inbound request carries none', async () => {
    verifyJwtViaDiscovery.mockResolvedValue({ allow: true });
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, { bearerToken: 'default-jwt' });
    const result = await check({});
    expect(result).toEqual({ allow: true, authorization: 'Bearer default-jwt' });
    // The default token was the one verified.
    expect((verifyJwtViaDiscovery.mock.calls[0] as [unknown, string])[1]).toBe('Bearer default-jwt');
  });

  it('prefers the inbound Authorization over the --bearer-token default', async () => {
    verifyJwtViaDiscovery.mockResolvedValue({ allow: true });
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, { bearerToken: 'default-jwt' });
    const result = await check({ authorization: 'Bearer caller-jwt' });
    expect(result.authorization).toBe('Bearer caller-jwt');
    expect((verifyJwtViaDiscovery.mock.calls[0] as [unknown, string])[1]).toBe('Bearer caller-jwt');
  });

  it('reads the first value when Authorization arrives as a duplicated header array', async () => {
    verifyJwtViaDiscovery.mockResolvedValue({ allow: true });
    const check = buildAgentCoreServeAuthCheck(AUTHORIZER, {});
    const result = await check({ authorization: ['Bearer first', 'Bearer second'] });
    expect(result.authorization).toBe('Bearer first');
  });
});
