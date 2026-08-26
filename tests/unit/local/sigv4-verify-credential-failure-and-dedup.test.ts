import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  verifySigV4,
  describeCredentialLoadFailure,
  type SigV4VerifyRequest,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';
import { getLogger } from '../../../src/utils/logger.js';
import { setEmbedConfig, resetEmbedConfig } from '../../../src/local/embed-config.js';

/**
 * Issue #564 — the credential chain's own error text must not reach a `warn`.
 * Issue #561 — the foreign-access-key-id warn-dedup set must be bounded.
 *
 * Both live in `verifySigV4`, and both are asserted through `verifySigV4`
 * rather than against the helpers alone: the helpers being correct says
 * nothing about whether every message branch actually routes through them,
 * and the credential-load failure has FIVE warn spellings.
 */

const NOW = new Date('2026-01-01T00:00:00Z');

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

/**
 * The shape this test exists for. `@aws-sdk/credential-provider-process`
 * copies the rejection of `promisify(child_process.exec)` —
 * `Command failed: <command line>\n<stderr>` — into the error it throws, and
 * BOTH of those lines can carry a passphrase, which is why the fix withholds
 * the whole message rather than stripping the first one.
 *
 * The fixture builds that error DIRECTLY rather than through the real chain,
 * and deliberately so: measured against the SDK versions this repo resolves,
 * the node provider chain swallows the process provider's error and ends on
 * a generic message, so a chain-driven fixture would carry no secret and
 * could not discriminate the fix from its absence. What is under test is the
 * policy — an uncontrolled third-party error string must not reach a
 * default-level log line — so the fixture supplies the worst string that
 * policy has to hold for. See the call site in `sigv4-verify.ts` for the
 * measurement and for why the guard is kept anyway.
 */
const PASSPHRASE = 'hunter2-do-not-log';
const CHAIN_MESSAGE =
  `Command failed: /opt/bin/get-creds --vault-passphrase ${PASSPHRASE}\n` +
  `  vault: unlocked with passphrase ${PASSPHRASE}`;

/** Measured, not assumed: see the length assertions below. */
const CHAIN_MESSAGE_LENGTH = 125;

class CredentialsProviderError extends Error {
  override name = 'CredentialsProviderError';
}

const loadThrowsChainError = async (): Promise<ResolvedCredentials> => {
  throw new CredentialsProviderError(CHAIN_MESSAGE);
};

function spy(level: 'warn' | 'debug'): { calls: () => string; restore: () => void } {
  const s = vi.spyOn(getLogger(), level).mockImplementation(() => {});
  return {
    calls: () => s.mock.calls.map((c) => String(c[0])).join('\n'),
    restore: () => s.mockRestore(),
  };
}

describe('#564 — the credential chain error text never reaches a warn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetEmbedConfig();
  });

  // The five warn spellings the no-creds branch can take. Each is listed
  // explicitly rather than derived from the source: a branch DELETED from
  // the implementation must still be a case here that then fails, which a
  // table generated off the implementation could never notice.
  const branches: Array<{
    name: string;
    strictByDefault: boolean;
    opts: { strict?: boolean; oacFronted?: boolean };
    expectAllow: boolean;
    /** A literal unique to THIS spelling, proving the fixture reached it. */
    reached: string;
  }> = [
    {
      name: 'strict deny, cdk-local opt-IN polarity',
      strictByDefault: false,
      opts: { strict: true },
      expectAllow: false,
      reached: '--strict-sigv4 is set, so cdk-local denies unverifiable IAM requests',
    },
    {
      name: 'strict deny, host opt-OUT polarity',
      strictByDefault: true,
      opts: { strict: true },
      expectAllow: false,
      reached: 'cdk-local denies unverifiable IAM requests by default',
    },
    {
      name: 'warn-and-pass, cdk-local opt-IN polarity',
      strictByDefault: false,
      opts: {},
      expectAllow: true,
      reached: "cdk-local's default for unverifiable IAM requests",
    },
    {
      name: 'warn-and-pass, host opt-OUT polarity',
      strictByDefault: true,
      opts: {},
      expectAllow: true,
      reached: '--allow-unverified-sigv4 is set; passing through',
    },
    {
      name: 'warn-and-pass, CloudFront OAC wording',
      strictByDefault: false,
      opts: { strict: true, oacFronted: true },
      expectAllow: true,
      reached: 'Function URL is fronted by CloudFront OAC',
    },
  ];

  for (const branch of branches) {
    it(`withholds the chain message in the ${branch.name} spelling`, async () => {
      if (branch.strictByDefault) {
        setEmbedConfig({ sigV4StrictByDefault: true, sigV4OptFlag: '--allow-unverified-sigv4' });
      }
      const warn = spy('warn');
      const result = await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrowsChainError, {
        ...branch.opts,
        now: () => NOW,
      });
      expect(result.allow).toBe(branch.expectAllow);
      const warns = warn.calls();

      // The branch really was the one intended — otherwise a fixture that
      // silently took a different path would "pass" while fencing nothing.
      expect(warns).toContain(branch.reached);

      // The secret, and the command line carrying it, are absent.
      expect(warns).not.toContain(PASSPHRASE);
      expect(warns).not.toContain('Command failed');
      expect(warns).not.toContain('/opt/bin/get-creds');

      // And the discriminator IS present, anchored on the full literal:
      // a bare '125-character message withheld' would also be a substring
      // of '1125-character message withheld', so the '; ' delimiter and the
      // class name are part of the needle.
      expect(warns).toContain(
        `(CredentialsProviderError; ${CHAIN_MESSAGE_LENGTH}-character message withheld, ` +
          `logged at debug level under --verbose)`
      );
      warn.restore();
    });
  }

  it('routes the full chain message to debug, which --verbose is what enables', async () => {
    const debug = spy('debug');
    const warn = spy('warn');
    await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrowsChainError, { now: () => NOW });
    // The actionable detail is not destroyed, only moved to the population
    // that asked for it (`local-start-api.ts` maps `--verbose` to
    // `logger.setLevel('debug')`).
    expect(debug.calls()).toContain(CHAIN_MESSAGE);
    expect(debug.calls()).toContain(PASSPHRASE);
    expect(warn.calls()).not.toContain(PASSPHRASE);
    debug.restore();
    warn.restore();
  });

  it('measures the length it reports, and names the throwing class', () => {
    // A hard-coded pair, so the assertion cannot drift with the fixture.
    expect(describeCredentialLoadFailure(new CredentialsProviderError('abcdefghij0123456789'))).toBe(
      'CredentialsProviderError; 20-character message withheld, logged at debug level under --verbose'
    );
    // The fixture's own measured length, cross-checked against the constant
    // the branch cases assert with.
    expect(CHAIN_MESSAGE.length).toBe(CHAIN_MESSAGE_LENGTH);
    expect(describeCredentialLoadFailure(new CredentialsProviderError(CHAIN_MESSAGE))).toBe(
      `CredentialsProviderError; ${CHAIN_MESSAGE_LENGTH}-character message withheld, ` +
        `logged at debug level under --verbose`
    );
  });

  it("reports 'unknown' for a non-Error throw rather than guessing a class", () => {
    expect(describeCredentialLoadFailure('plain string throw')).toBe(
      'unknown; 18-character message withheld, logged at debug level under --verbose'
    );
    expect('plain string throw'.length).toBe(18);
  });

  it('withholds a non-Error throw at warn too', async () => {
    const warn = spy('warn');
    await verifySigV4(
      makeRequest('AKIAFOREIGN'),
      async () => {
        throw `boom ${PASSPHRASE}`;
      },
      { now: () => NOW }
    );
    const warns = warn.calls();
    expect(warns).not.toContain(PASSPHRASE);
    expect(warns).toContain('(unknown; 23-character message withheld,');
    warn.restore();
  });
});

describe('#561 — the foreign-access-key-id warn-dedup set is bounded', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetEmbedConfig();
  });

  /** Matches FOREIGN_ID_DEDUP_MAX in the implementation. */
  const CAP = 256;

  async function warnFor(
    id: string,
    warned: Set<string>,
    opts: { strict?: boolean } = {}
  ): Promise<string> {
    const warn = spy('warn');
    await verifySigV4(makeRequest(id), loadLocal, {
      warnedForeignIds: warned,
      now: () => NOW,
      ...opts,
    });
    const out = warn.calls();
    warn.restore();
    return out;
  }

  // Both `rememberWarnedForeignId` call sites are exercised separately. They
  // are textually identical, so a probe of only one answers "is EITHER site
  // bounded", not "is EACH".
  for (const [label, opts] of [
    ['warn-and-pass site', {}],
    ['strict deny site', { strict: true }],
  ] as Array<[string, { strict?: boolean }]>) {
    it(`caps the set at ${CAP} entries from the ${label}`, async () => {
      const warned = new Set<string>();
      for (let i = 0; i < CAP + 44; i++) {
        await warnFor(`AKIAFOREIGN${i}`, warned, opts);
      }
      expect(warned.size).toBe(CAP);
    });
  }

  it('still deduplicates a repeated id, and still ignores its case', async () => {
    const warned = new Set<string>();
    expect(await warnFor('AKIAFOREIGN', warned)).toContain('AKIAFOREIGN');
    expect(await warnFor('AKIAFOREIGN', warned)).toBe('');
    expect(await warnFor('akiaforeign', warned)).toBe('');
    expect(warned.size).toBe(1);
  });

  it('stores a fixed-size digest, never the caller-supplied id', async () => {
    // The id is unvalidated caller text of caller-chosen length, so an
    // entry-count cap alone would not bound the memory. Every entry is a
    // 64-character sha256 hex digest whatever arrives.
    const warned = new Set<string>();
    const huge = 'A'.repeat(4000);
    await warnFor(huge, warned);
    await warnFor('AKIAFOREIGN', warned);
    expect(warned.size).toBe(2);
    for (const entry of warned) {
      expect(entry).toMatch(/^[0-9a-f]{64}$/);
    }
    expect([...warned].join('')).not.toContain('AAAA');
  });

  it('evicts oldest-first, so eviction repeats a warning and never suppresses one', async () => {
    // The safety property of the chosen policy: the bound can only ever make
    // the code NOISIER (an evicted id warns a second time), never quieter.
    // A "stop warning once full" cap would fail the other way, silencing the
    // (cap+1)-th distinct signer — which may be the real federated identity.
    const warned = new Set<string>();
    await warnFor('AKIAFIRST', warned);
    const firstDigest = [...warned][0];

    // Fill past the cap so the very first id is evicted.
    for (let i = 0; i < CAP; i++) {
      await warnFor(`AKIAFILLER${i}`, warned);
    }
    expect(warned.has(firstDigest as string)).toBe(false);

    // The evicted id warns AGAIN — the un-deduped default, not silence.
    expect(await warnFor('AKIAFIRST', warned)).toContain('AKIAFIRST');

    // And a brand-new id past the cap is still warned about.
    expect(await warnFor('AKIANEVERSEEN', warned)).toContain('AKIANEVERSEEN');
    expect(warned.size).toBe(CAP);
  });

  it('brings an over-cap set handed in from outside back under the cap', async () => {
    const warned = new Set<string>(Array.from({ length: CAP + 10 }, (_, i) => `preexisting-${i}`));
    await warnFor('AKIAFOREIGN', warned);
    expect(warned.size).toBe(CAP);
  });
});
