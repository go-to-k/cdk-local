import { describe, expect, it } from 'vite-plus/test';
import {
  AGENTCORE_SIGV4_SERVICE,
  signAgentCoreInvocation,
} from '../../../src/local/agentcore-sigv4-sign.js';

/**
 * The signer delegates to the real `@smithy/signature-v4` implementation
 * against `@aws-crypto/sha256-js`. These tests pin its output for fixed
 * inputs so a future regression in the signing wiring (wrong service / region
 * / header set / session-token handling) names itself.
 */

const FIXED_NOW = (): number => Date.parse('2026-01-01T12:00:00Z');

const STATIC_CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const STS_CREDS = {
  ...STATIC_CREDS,
  sessionToken: 'session-token-EXAMPLE',
};

describe('signAgentCoreInvocation', () => {
  it('produces the SigV4 Authorization header for the bedrock-agentcore service', async () => {
    const headers = await signAgentCoreInvocation({
      credentials: STATIC_CREDS,
      region: 'us-east-1',
      host: '127.0.0.1',
      port: 9000,
      path: '/invocations',
      body: JSON.stringify({ prompt: 'hello' }),
      sessionId: 'sess-1',
      now: FIXED_NOW,
    });

    expect(headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')).toBe(true);
    expect(headers.authorization).toContain(`/us-east-1/${AGENTCORE_SIGV4_SERVICE}/aws4_request`);
    // SignedHeaders must include the session-id header (it influenced the signature).
    expect(headers.authorization.toLowerCase()).toContain(
      'x-amzn-bedrock-agentcore-runtime-session-id'
    );
    expect(headers.amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.amzContentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(headers.amzSecurityToken).toBeUndefined();
  });

  it('includes X-Amz-Security-Token when the credentials are STS-issued', async () => {
    const headers = await signAgentCoreInvocation({
      credentials: STS_CREDS,
      region: 'eu-west-1',
      host: '127.0.0.1',
      port: 9001,
      path: '/invocations',
      body: '{}',
      sessionId: 'sess-sts',
      now: FIXED_NOW,
    });
    expect(headers.amzSecurityToken).toBe('session-token-EXAMPLE');
    expect(headers.authorization).toContain('/eu-west-1/bedrock-agentcore/aws4_request');
  });

  it('binds the signature to the request body (different body -> different signature)', async () => {
    const a = await signAgentCoreInvocation({
      credentials: STATIC_CREDS,
      region: 'us-east-1',
      host: '127.0.0.1',
      port: 9000,
      path: '/invocations',
      body: '{"a":1}',
      sessionId: 's',
      now: FIXED_NOW,
    });
    const b = await signAgentCoreInvocation({
      credentials: STATIC_CREDS,
      region: 'us-east-1',
      host: '127.0.0.1',
      port: 9000,
      path: '/invocations',
      body: '{"a":2}',
      sessionId: 's',
      now: FIXED_NOW,
    });
    expect(a.authorization).not.toBe(b.authorization);
    expect(a.amzContentSha256).not.toBe(b.amzContentSha256);
  });

  it('signs a Buffer body byte-exactly (the start-agentcore --sigv4 serve path, #454)', async () => {
    // The warm serve forwards the raw request Buffer; signing the Buffer must
    // produce the SAME signature as signing its UTF-8 string form, so the
    // signed payload is byte-exact with what the proxy sends.
    const common = {
      credentials: STATIC_CREDS,
      region: 'us-east-1',
      host: '127.0.0.1',
      port: 9000,
      path: '/invocations',
      sessionId: 's',
      now: FIXED_NOW,
    };
    const asString = await signAgentCoreInvocation({ ...common, body: '{"q":"hi"}' });
    const asBuffer = await signAgentCoreInvocation({ ...common, body: Buffer.from('{"q":"hi"}', 'utf-8') });
    expect(asBuffer.amzContentSha256).toBe(asString.amzContentSha256);
    expect(asBuffer.authorization).toBe(asString.authorization);
  });

  it('binds the signature to the session id (different session -> different signature)', async () => {
    const a = await signAgentCoreInvocation({
      credentials: STATIC_CREDS,
      region: 'us-east-1',
      host: '127.0.0.1',
      port: 9000,
      path: '/invocations',
      body: '{}',
      sessionId: 'session-A',
      now: FIXED_NOW,
    });
    const b = await signAgentCoreInvocation({
      credentials: STATIC_CREDS,
      region: 'us-east-1',
      host: '127.0.0.1',
      port: 9000,
      path: '/invocations',
      body: '{}',
      sessionId: 'session-B',
      now: FIXED_NOW,
    });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('uses the requested region in the credential scope', async () => {
    const tokyo = await signAgentCoreInvocation({
      credentials: STATIC_CREDS,
      region: 'ap-northeast-1',
      host: '127.0.0.1',
      port: 9000,
      path: '/invocations',
      body: '{}',
      sessionId: 's',
      now: FIXED_NOW,
    });
    expect(tokyo.authorization).toContain('/ap-northeast-1/bedrock-agentcore/aws4_request');
  });
});
