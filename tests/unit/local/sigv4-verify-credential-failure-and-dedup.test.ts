import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  verifySigV4,
  type SigV4VerifyRequest,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';
// Issue #570 lifted the two #564 helpers into their own module when it found
// nine more sites of the same shape. The definitions moved unchanged EXCEPT
// for one addition, fenced at the bottom of this file: the withheld line now
// names a clamped `err.code` when the throw carries one, which changes this
// site's output too.
import { describeCredentialLoadFailure } from '../../../src/local/credential-error.js';
import { createHash } from 'node:crypto';
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

function namedError(name: string, message: string): Error {
  const e = new Error(message);
  Object.defineProperty(e, 'name', { value: name });
  return e;
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
    //
    // Issue #570 changed this assertion, and the change is the point: the
    // message arrives FLATTENED, because the debug stream is the same stdout
    // `cdkl studio` mirrors into an HTTP-served log ring, so a `\n` here would
    // forge a line there exactly as it would at `warn`. Every character is
    // still present -- only the line break became a space.
    expect(debug.calls()).toContain(CHAIN_MESSAGE.replace('\n', ' '));
    expect(debug.calls()).not.toContain(CHAIN_MESSAGE);
    expect(debug.calls()).toContain(PASSPHRASE);
    expect(debug.calls()).toContain('vault: unlocked with passphrase');
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

  it('does not print at default level -- the debug route is really gated', async () => {
    // The whole fix rests on `debug` reaching a smaller population than
    // `warn`. Assert it end-to-end through the REAL logger at its default
    // level rather than trusting the level table: spy on the console sinks
    // `ConsoleLogger.emit` writes to, and require that nothing the process
    // actually printed carries the chain message.
    const logger = getLogger();
    const before = logger.getLevel();
    logger.setLevel('info');
    const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    try {
      await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrowsChainError, { now: () => NOW });
      const printed = sinks
        .flatMap((sp) => sp.mock.calls.map((c) => String(c[0])))
        .join('\n');
      // It DID print something -- otherwise this passes for the wrong reason.
      expect(printed).toContain('could not resolve local AWS credentials');
      expect(printed).not.toContain(CHAIN_MESSAGE);
      expect(printed).not.toContain(PASSPHRASE);
    } finally {
      for (const sp of sinks) sp.mockRestore();
      logger.setLevel(before);
    }
  });

  it('clamps a name that is not a bare identifier, rather than quoting it', () => {
    // `err.name` is third-party data from the same object whose `message` is
    // withheld; a provider that derived it from input would otherwise
    // reopen #564 through the field left quoted.
    const hostile = new Error('short');
    Object.defineProperty(hostile, 'name', {
      value: `Command failed: /opt/bin/get-creds --vault-passphrase ${PASSPHRASE}`,
    });
    const out = describeCredentialLoadFailure(hostile);
    expect(out).not.toContain(PASSPHRASE);
    expect(out).toBe('unknown; 5-character message withheld, logged at debug level under --verbose');

    // A 64-character bare identifier is still quoted; 65 is not.
    expect(describeCredentialLoadFailure(namedError('A'.repeat(64), 'x'))).toContain(
      `${'A'.repeat(64)}; 1-character`
    );
    expect(describeCredentialLoadFailure(namedError('A'.repeat(65), 'x'))).toContain(
      'unknown; 1-character'
    );
    // An ordinary class name is unaffected.
    expect(describeCredentialLoadFailure(namedError('CredentialsProviderError', 'x'))).toContain(
      'CredentialsProviderError; 1-character'
    );
  });

  it('survives a throw that cannot be stringified, instead of turning it into a 500', async () => {
    // `String(Object.create(null))` raises TypeError. Before the shared
    // helper, that throw escaped this catch and rejected the whole
    // authorizer pass -- a 500 in place of the warn-and-pass the branch
    // exists to produce.
    const warn = spy('warn');
    const result = await verifySigV4(
      makeRequest('AKIAFOREIGN'),
      async () => {
        throw Object.create(null);
      },
      { now: () => NOW }
    );
    expect(result.allow).toBe(true);
    expect(result.principalId).toBe('unverified-no-creds');
    expect(warn.calls()).toContain('(unknown; 23-character message withheld,');
    warn.restore();
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
    it(`caps the set at ${CAP} entries from the ${label}, without going quiet`, async () => {
      const warned = new Set<string>();
      const total = CAP + 44;
      let warnCount = 0;
      for (let i = 0; i < total; i++) {
        if ((await warnFor(`AKIAFOREIGN${i}`, warned, opts)) !== '') warnCount++;
      }
      expect(warned.size).toBe(CAP);
      // Asserting the SIZE alone does not fence the policy this bound was
      // chosen for. Writing `&& warned.size < CAP` into this site's
      // `!warned.has(dedupKey)` guard -- i.e. going quiet once full instead
      // of evicting -- also lands the size on exactly CAP, so a size-only
      // test passes on it. A mutation probe of that variant on the
      // strict-deny site was GREEN against the size-only version of this
      // test. Every id here is distinct, so every one must warn.
      expect(warnCount).toBe(total);
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
    // Lowercased, because the id is lowercased before hashing -- an
    // uppercase needle here could never appear even if the raw id WERE
    // stored, which would make this assertion vacuous.
    expect([...warned].join('')).not.toContain('aaaaaaaa');
    // Pin the digest identity, so "it is 64 hex characters" cannot be
    // satisfied by some other 64-hex derivation.
    expect(warned.has(createHash('sha256').update('akiaforeign').digest('hex'))).toBe(true);
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

describe('#570 — the two changes the lift made to THIS site', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetEmbedConfig();
  });

  it('names a clamped err.code in the withheld line when the throw carries one', async () => {
    // The lift added this field, so #564's line is NOT byte-identical for a
    // chain error wrapping a Node system error -- and `ProviderError.from`
    // copies `code` onto the wrapper, so that combination is reachable here.
    const dns = Object.assign(
      new CredentialsProviderError('getaddrinfo ENOTFOUND sts.us-east-1.amazonaws.com'),
      { code: 'ENOTFOUND' }
    );
    const warn = spy('warn');
    await verifySigV4(makeRequest('AKIAFOREIGN'), async () => {
      throw dns;
    }, { now: () => NOW });
    expect(warn.calls()).toContain(
      'CredentialsProviderError ENOTFOUND; 49-character message withheld, ' +
        'logged at debug level under --verbose'
    );
    warn.restore();
  });

  it('flattens the debug line, because that stream is the studio ring too', async () => {
    const debug = spy('debug');
    await verifySigV4(makeRequest('AKIAFOREIGN'), loadThrowsChainError, { now: () => NOW });
    const lines = debug.calls().split('\n');
    // The chain fixture is two lines. One emitted call must stay one line.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(PASSPHRASE);
    expect(lines[0]).toContain('vault: unlocked with passphrase');
    debug.restore();
  });
});
