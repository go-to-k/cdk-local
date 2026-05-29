import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  verifySigV4,
  type SigV4VerifyRequest,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';
import { getLogger } from '../../../src/utils/logger.js';
import { setEmbedConfig, resetEmbedConfig } from '../../../src/local/embed-config.js';

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

describe('verifySigV4 — warn-and-pass default + --strict-sigv4 opt-in', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DEFAULT: warn-and-passes a foreign access-key-id (no strict, no oac)', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadLocal, {
      now: () => NOW,
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-foreign-identity');
    const warns = warn.calls().join('\n');
    // The default pass-through must explain it's unverifiable + point at the
    // opt-in to deny, and must NOT use the OAC wording.
    expect(warns).toContain('--strict-sigv4');
    expect(warns).not.toContain('CloudFront OAC');
    warn.restore();
  });

  it('DEFAULT: warn-and-passes when local credentials cannot be resolved (no strict, no oac)', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrows, {
      now: () => NOW,
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-no-creds');
    const warns = warn.calls().join('\n');
    expect(warns).toContain('--strict-sigv4');
    expect(warns).not.toContain('CloudFront OAC');
    warn.restore();
  });

  it('STRICT: denies a foreign access-key-id when --strict-sigv4 is set', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadLocal, {
      strict: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(false);
    const warns = warn.calls().join('\n');
    expect(warns).toContain('--strict-sigv4');
    warn.restore();
  });

  it('STRICT: denies when local credentials cannot be resolved and --strict-sigv4 is set', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrows, {
      strict: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(false);
    const warns = warn.calls().join('\n');
    expect(warns).toContain('--strict-sigv4');
    warn.restore();
  });

  it('oacFronted always warn-and-passes a foreign access-key-id, even under --strict-sigv4', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest(''), loadLocal, {
      strict: true,
      oacFronted: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-foreign-identity');
    const warns = warn.calls().join('\n');
    expect(warns).toContain('CloudFront OAC');
    warn.restore();
  });

  it('oacFronted always warn-and-passes when credentials cannot be resolved, even under --strict-sigv4', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrows, {
      strict: true,
      oacFronted: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-no-creds');
    const warns = warn.calls().join('\n');
    expect(warns).toContain('CloudFront OAC');
    warn.restore();
  });

  it('SECURITY: a matching access-key-id with a BAD signature is still denied (default mode)', async () => {
    // The warn-and-pass default only covers the foreign-identity / no-creds
    // branches. A request whose Credential access-key-id MATCHES the local
    // one takes the same-identity path: the signature is recomputed and
    // compared, and a mismatch denies regardless of mode — the flip to
    // warn-and-pass must NOT weaken verification of the dev's own identity.
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest(LOCAL_CREDS.accessKeyId), loadLocal, {
      now: () => NOW,
    });
    expect(result.allow).toBe(false);
    warn.restore();
  });

  it('SECURITY: a matching access-key-id with a BAD signature is still denied even when oacFronted', async () => {
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest(LOCAL_CREDS.accessKeyId), loadLocal, {
      oacFronted: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(false);
    warn.restore();
  });
});

describe('verifySigV4 — embedConfig-driven flag polarity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // The strictness-flag wording is sourced from the active embed config, so
    // any test that overrides it MUST restore cdk-local's defaults — otherwise
    // a later test asserting `--strict-sigv4` would see the host flag leak.
    resetEmbedConfig();
  });

  it('renders the host opt-OUT flag in the foreign-id DENY message when sigV4StrictByDefault is set', async () => {
    // A host like cdkd that fails-closed by default passes its own opt-OUT
    // flag. The deny-path advice must read in the host's polarity: name the
    // host flag, never cdk-local's opt-IN `--strict-sigv4`.
    setEmbedConfig({ sigV4StrictByDefault: true, sigV4OptFlag: '--allow-unverified-sigv4' });
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadLocal, {
      strict: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(false);
    const warns = warn.calls().join('\n');
    expect(warns).toContain('--allow-unverified-sigv4');
    expect(warns).not.toContain('--strict-sigv4');
    warn.restore();
  });

  it('renders the host opt-OUT flag in the no-creds DENY message when sigV4StrictByDefault is set', async () => {
    setEmbedConfig({ sigV4StrictByDefault: true, sigV4OptFlag: '--allow-unverified-sigv4' });
    const warn = spyWarn();
    const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrows, {
      strict: true,
      now: () => NOW,
    });
    expect(result.allow).toBe(false);
    const warns = warn.calls().join('\n');
    expect(warns).toContain('--allow-unverified-sigv4');
    expect(warns).not.toContain('--strict-sigv4');
    warn.restore();
  });
});
