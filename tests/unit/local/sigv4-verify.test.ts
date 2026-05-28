import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  verifySigV4,
  type SigV4VerifyRequest,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';
import { getLogger } from '../../../src/utils/logger.js';

const NOW = new Date('2026-01-01T00:00:00Z');

/**
 * Build a request whose Authorization header parses cleanly and resolves to
 * the given access-key-id in the credential scope. The signature value is
 * irrelevant for the foreign-identity / no-creds branches (they never
 * recompute it).
 */
function makeRequest(accessKeyId: string): SigV4VerifyRequest {
  const credential = `${accessKeyId}/20260101/ap-northeast-1/cloudfront/aws4_request`;
  return {
    method: 'POST',
    rawUrl: '/',
    headers: {
      host: '127.0.0.1:65483',
      'x-amz-date': '20260101T000000Z',
      authorization:
        `AWS4-HMAC-SHA256 Credential=${credential}, ` +
        `SignedHeaders=host;x-amz-date, Signature=abcdef0123456789`,
    },
    body: Buffer.alloc(0),
  };
}

const LOCAL_CREDS: ResolvedCredentials = {
  accessKeyId: 'AKIALOCALEXAMPLE',
  secretAccessKey: 'secret',
};

const loadLocal = async (): Promise<ResolvedCredentials> => LOCAL_CREDS;
const loadThrows = async (): Promise<ResolvedCredentials> => {
  throw new Error('no credentials');
};

function spyWarn(): { calls: () => string[]; restore: () => void } {
  const spy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  return {
    calls: () => spy.mock.calls.map((c) => String(c[0])),
    restore: () => spy.mockRestore(),
  };
}

describe('verifySigV4 — oacFronted relaxation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through a foreign (empty) access-key-id when oacFronted, without the flag wording', async () => {
    const warn = spyWarn();
    // Mirrors how the http-server calls it for OAC routes: allowUnverified
    // forced on AND oacFronted set.
    const result = await verifySigV4(makeRequest(''), loadLocal, {
      allowUnverified: true,
      oacFronted: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-foreign-identity');
    const warns = warn.calls().join('\n');
    expect(warns).toContain('CloudFront OAC');
    expect(warns).not.toContain('--allow-unverified-sigv4');
    warn.restore();
  });

  it('passes through when local credentials cannot be resolved and oacFronted is set', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrows, {
      allowUnverified: true,
      oacFronted: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-no-creds');
    const warns = warn.calls().join('\n');
    expect(warns).toContain('CloudFront OAC');
    expect(warns).not.toContain('--allow-unverified-sigv4');
    warn.restore();
  });

  it('uses the --allow-unverified-sigv4 wording when allowUnverified is set WITHOUT oacFronted', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadLocal, {
      allowUnverified: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-foreign-identity');
    const warns = warn.calls().join('\n');
    expect(warns).toContain('--allow-unverified-sigv4 is set');
    expect(warns).not.toContain('CloudFront OAC');
    warn.restore();
  });

  it('still fail-closes a foreign access-key-id by default (no oacFronted, no flag)', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest(''), loadLocal, {
      now: () => NOW,
    });
    expect(result.allow).toBe(false);
    expect(warn.calls().join('\n')).toContain('Denying');
    warn.restore();
  });
});
