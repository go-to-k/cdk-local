import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  verifySigV4,
  type SigV4VerifyRequest,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue #246 site 2 — seven SigV4 rejection paths used to log at
 * `logger.debug` and silently return `{ allow: false }`, leaving the
 * local-dev user with only the API Gateway 403 and no actionable signal
 * in cdkl output. This file locks each path to `logger.info` (per-request
 * signal, mirroring `cognito-jwt.ts:133`'s JWKS-unreachable shape) and
 * asserts the user-facing message names the failing field + the expected
 * shape so the user can fix their request without re-reading the SigV4
 * spec.
 *
 * The seven paths under test (file-line references match issue #246
 * spec, line numbers may drift):
 *   1. Malformed Authorization header (parseAuthorizationHeader throw).
 *   2. Unsupported algorithm (parsed.algorithm !== 'AWS4-HMAC-SHA256').
 *   3. Bad credential-scope terminator
 *      (parsed.credentialTerminator !== 'aws4_request').
 *   4. Missing x-amz-date / date header.
 *   5. x-amz-date does NOT match the credential-scope date.
 *   6. x-amz-date outside the 15-minute clock-skew window.
 *   7. Signature mismatch (recomputed != parsed).
 */
const NOW = new Date('2026-01-01T00:00:00Z');

const LOCAL_CREDS: ResolvedCredentials = {
  accessKeyId: 'AKIALOCALEXAMPLE',
  secretAccessKey: 'secret',
};

const loadLocal = async (): Promise<ResolvedCredentials> => LOCAL_CREDS;

function spyInfo(): { calls: () => string[]; restore: () => void } {
  const spy = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  return {
    calls: () => spy.mock.calls.map((c) => String(c[0])),
    restore: () => spy.mockRestore(),
  };
}

function spyDebug(): { calls: () => string[]; restore: () => void } {
  const spy = vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
  return {
    calls: () => spy.mock.calls.map((c) => String(c[0])),
    restore: () => spy.mockRestore(),
  };
}

function baseHeaders(authorization: string): Record<string, string> {
  return {
    host: '127.0.0.1:65483',
    'x-amz-date': '20260101T000000Z',
    authorization,
  };
}

describe('verifySigV4 — 7 rejection paths surface at info (issue #246)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. malformed Authorization header logs at info with the parse error + expected shape', async () => {
    const info = spyInfo();
    const debug = spyDebug();
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: baseHeaders('this-is-not-a-valid-sigv4-header'),
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = info.calls().join('\n');
    // The reject-path emits info, NOT debug, so a default-level cdkl run shows it.
    expect(infos).toMatch(/malformed Authorization header/);
    expect(infos).toMatch(/AWS4-HMAC-SHA256 Credential=/);
    // The old debug-only path is gone.
    expect(debug.calls().join('\n')).not.toContain('malformed Authorization header');
    info.restore();
    debug.restore();
  });

  it('2. unsupported algorithm logs at info naming the algorithm + expected value', async () => {
    const info = spyInfo();
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: baseHeaders(
        'AWS4-HMAC-SHA512 Credential=AKID/20260101/us-east-1/execute-api/aws4_request, SignedHeaders=host, Signature=abcd'
      ),
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = info.calls().join('\n');
    expect(infos).toMatch(/unsupported Authorization algorithm/);
    expect(infos).toContain("'AWS4-HMAC-SHA512'");
    expect(infos).toContain("'AWS4-HMAC-SHA256'");
    info.restore();
  });

  it('3. invalid credential-scope terminator logs at info naming the terminator + expected', async () => {
    const info = spyInfo();
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: baseHeaders(
        'AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/execute-api/aws3_request, SignedHeaders=host, Signature=abcd'
      ),
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = info.calls().join('\n');
    expect(infos).toMatch(/invalid credential-scope terminator/);
    expect(infos).toContain("'aws3_request'");
    expect(infos).toContain("'aws4_request'");
    info.restore();
  });

  it('4. missing x-amz-date / date header logs at info with the expected shape', async () => {
    const info = spyInfo();
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: {
        host: '127.0.0.1:65483',
        // No x-amz-date and no date.
        authorization:
          'AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/execute-api/aws4_request, SignedHeaders=host, Signature=abcd',
      },
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = info.calls().join('\n');
    expect(infos).toMatch(/missing x-amz-date \/ date header/);
    expect(infos).toMatch(/YYYYMMDDTHHMMSSZ/);
    info.restore();
  });

  it('5. x-amz-date does not match credential-scope date logs at info with both values', async () => {
    const info = spyInfo();
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: {
        host: '127.0.0.1:65483',
        // Date in header = Jan 2nd, credential scope date = Jan 1st.
        'x-amz-date': '20260102T000000Z',
        authorization:
          'AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/execute-api/aws4_request, SignedHeaders=host, Signature=abcd',
      },
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = info.calls().join('\n');
    expect(infos).toMatch(/does not match/);
    expect(infos).toContain("'20260102T000000Z'");
    expect(infos).toContain("'20260101'");
    info.restore();
  });

  it('6. x-amz-date outside 15-minute skew logs at info with both timestamps', async () => {
    const info = spyInfo();
    // x-amz-date 2025-12-31 (1 day ago), local now 2026-01-01.
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: {
        host: '127.0.0.1:65483',
        'x-amz-date': '20251231T000000Z',
        authorization:
          'AWS4-HMAC-SHA256 Credential=AKID/20251231/us-east-1/execute-api/aws4_request, SignedHeaders=host, Signature=abcd',
      },
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = info.calls().join('\n');
    expect(infos).toMatch(/outside the 15-minute clock-skew window/);
    expect(infos).toContain('20251231T000000Z');
    info.restore();
  });

  it('7. signature mismatch (matching AKID, bad Signature=) logs at info with both signatures', async () => {
    const info = spyInfo();
    // Match LOCAL_CREDS.accessKeyId so we reach the "same identity"
    // recompute branch, then supply a clearly wrong Signature= so the
    // constant-time compare fails.
    const credential = `${LOCAL_CREDS.accessKeyId}/20260101/us-east-1/execute-api/aws4_request`;
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: {
        host: '127.0.0.1:65483',
        'x-amz-date': '20260101T000000Z',
        authorization:
          `AWS4-HMAC-SHA256 Credential=${credential}, ` +
          'SignedHeaders=host;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = info.calls().join('\n');
    expect(infos).toMatch(/Signature= mismatch/);
    // Both the recomputed and the offered signatures should appear so the
    // user can spot the divergence at a glance.
    expect(infos).toMatch(/recomputed/);
    expect(infos).toMatch(/0{64}/);
    info.restore();
  });
});
