/**
 * Issue #555 site 3 — the SigV4 rejection messages log at `info`, so they
 * print on a plain `cdkl start-api` run rather than only under `--verbose`.
 * Each names a POSITION in the `Authorization` header, and a position holds
 * only its own short token while the header's delimiters sit where the
 * parser expects them. When they do not — a hand-written header using
 * spaces where AWS wants commas — the split sweeps the REST of the header
 * into the final segment, and the message prints the `Signature=` component
 * at default level.
 *
 * Every case here pairs the negative ("the swept-in material is absent")
 * with a POSITIVE marker. "The signature did not appear" on its own is a
 * confluence point: a request rejected earlier, a mock that never ran, or a
 * message that lost the diagnostic entirely all satisfy it while fencing
 * nothing. So each case also asserts the withheld-marker / count that only
 * the intended branch produces.
 *
 * The last two cases fence the OTHER direction — over-redaction. Issue #246
 * added these messages so a developer can fix their request without
 * re-reading the SigV4 spec, and a blanket redaction would take that back.
 */

import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  verifySigV4,
  redactAuthorizationSegment,
  redactSignature,
  type SigV4VerifyRequest,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';
import { getLogger } from '../../../src/utils/logger.js';
import { setEmbedConfig, resetEmbedConfig } from '../../../src/local/embed-config.js';

const NOW = new Date('2026-01-01T00:00:00Z');

const LOCAL_CREDS: ResolvedCredentials = {
  accessKeyId: 'AKIALOCALEXAMPLE',
  secretAccessKey: 'secret',
};

const loadLocal = async (): Promise<ResolvedCredentials> => LOCAL_CREDS;

/**
 * A distinctive stand-in for the `Signature=` component. Long enough to be
 * a real SigV4 signature (64 hex characters) and unique enough that a
 * `not.toContain` on it cannot be satisfied by coincidence.
 */
const SIGNATURE = 'f00dfeed'.repeat(8);

/** The `<withheld: N characters ...>` shape `redactAuthorizationSegment` emits. */
const WITHHELD = /<withheld: \d+ characters of unparsed header material>/;

/**
 * Drive one `Authorization` header through `verifySigV4` and return every
 * `info` line it produced, joined. Fails the test if the request is
 * ALLOWED — otherwise a change that stopped rejecting would make every
 * absence assertion below pass while fencing nothing.
 */
async function infoOnReject(authorization: string): Promise<string> {
  const spy = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  const req: SigV4VerifyRequest = {
    method: 'POST',
    rawUrl: '/',
    headers: {
      host: '127.0.0.1:65483',
      'x-amz-date': '20260101T000000Z',
      authorization,
    },
    body: Buffer.alloc(0),
  };
  const result = await verifySigV4(req, loadLocal, { now: () => NOW });
  expect(result.allow).toBe(false);
  const joined = spy.mock.calls.map((c) => String(c[0])).join('\n');
  spy.mockRestore();
  // A rejection that logged nothing would also satisfy every `not.toContain`.
  expect(joined).toContain('AWS_IAM authorizer: rejecting request');
  return joined;
}

/**
 * Drive one `Authorization` header through `verifySigV4` and return every
 * `warn` line it produced. Fails the test if the request is DENIED — the
 * foreign-access-key-id path warn-and-PASSES by default, so a denial means
 * the case tripped some earlier guard instead.
 */
async function warnOnForeignId(
  authorization: string,
  opts: { strict?: boolean; oacFronted?: boolean } = {}
): Promise<string> {
  const spy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  const req: SigV4VerifyRequest = {
    method: 'POST',
    rawUrl: '/',
    headers: {
      host: '127.0.0.1:65483',
      'x-amz-date': '20260101T000000Z',
      authorization,
    },
    body: Buffer.alloc(0),
  };
  const result = await verifySigV4(req, loadLocal, { now: () => NOW, ...opts });
  // Only `--strict-sigv4` on a non-OAC route denies; the other two
  // warn-and-PASS. Asserting the expected outcome keeps a case that tripped
  // some earlier guard from looking like a clean run of this branch.
  expect(result.allow).toBe(!(opts.strict === true && opts.oacFronted !== true));
  const joined = spy.mock.calls.map((c) => String(c[0])).join('\n');
  spy.mockRestore();
  expect(joined).toContain('access-key-id');
  return joined;
}

describe('redactAuthorizationSegment — the quote/withhold boundary (issue #555)', () => {
  it('quotes a short single-token segment verbatim', () => {
    expect(redactAuthorizationSegment('aws3_request')).toBe('aws3_request');
    expect(redactAuthorizationSegment('AWS4-HMAC-SHA512')).toBe('AWS4-HMAC-SHA512');
  });

  it('quotes at exactly 32 characters and withholds at 33', () => {
    expect(redactAuthorizationSegment('a'.repeat(32))).toBe('a'.repeat(32));
    expect(redactAuthorizationSegment('a'.repeat(33))).toBe(
      '<withheld: 33 characters of unparsed header material>'
    );
  });

  it('withholds a segment carrying whitespace (the comma-vs-space sweep-in)', () => {
    const swept = `aws4_request SignedHeaders=host Signature=${SIGNATURE}`;
    const out = redactAuthorizationSegment(swept);
    expect(out).not.toContain(SIGNATURE);
    expect(out).toBe(`<withheld: ${swept.length} characters of unparsed header material>`);
  });

  it("withholds a segment carrying '=' even when it is short", () => {
    expect(redactAuthorizationSegment('Signature=abcd')).toBe(
      '<withheld: 14 characters of unparsed header material>'
    );
  });

  it('withholds on whitespace ALONE — short, and with no \'=\' to fall back on', () => {
    // Fences the whitespace half of the `/[\s=]/` disjunction on its own.
    // Every other case here also trips the length bound or the `=` clause,
    // so rewriting the predicate to `/=/` would leave them all green.
    expect(redactAuthorizationSegment('aws4_request foo')).toBe(
      '<withheld: 16 characters of unparsed header material>'
    );
  });
});

describe('redactSignature — the offered Signature= value (issue #555)', () => {
  it('quotes a real 64-character lowercase-hex signature verbatim', () => {
    const real = 'f00dfeed'.repeat(8);
    expect(real).toHaveLength(64);
    expect(redactSignature(real)).toBe(real);
  });

  it('withholds anything past 64 characters, or not lowercase hex, or empty', () => {
    expect(redactSignature('a'.repeat(65))).toBe(
      '<withheld: 65 characters that are not a signature>'
    );
    // The parser lowercases before this runs, so uppercase is unreachable
    // in production; the predicate states the requirement explicitly.
    expect(redactSignature('DEADBEEF')).toBe('<withheld: 8 characters that are not a signature>');
    expect(redactSignature('')).toBe('<withheld: 0 characters that are not a signature>');
  });

  it('withholds the sweep-in shape a trailing parameter produces', () => {
    const swept = `${SIGNATURE} x-anything=foo`;
    const out = redactSignature(swept);
    expect(out).not.toContain(SIGNATURE);
    expect(out).toBe(`<withheld: ${swept.length} characters that are not a signature>`);
  });
});

describe('verifySigV4 — no unparsed Authorization material at info (issue #555)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('withholds the terminator when a space-delimited header sweeps the signature into it', async () => {
    // One comma missing — the shape a hand-written `curl -H` header takes.
    // `Credential=`'s value absorbs the `Signature=` parameter that should
    // have followed it, so the 5th slash-separated segment (the terminator)
    // becomes `aws4_request Signature=<hex>` while the header still parses
    // far enough to reach the terminator check.
    const infos = await infoOnReject(
      `AWS4-HMAC-SHA256 Credential=AKIALOCALEXAMPLE/20260101/us-east-1/execute-api/aws4_request ` +
        `Signature=${SIGNATURE}, SignedHeaders=host, Signature=abcd`
    );
    expect(infos).toContain('invalid credential-scope terminator');
    expect(infos).toMatch(WITHHELD);
    expect(infos).not.toContain(SIGNATURE);
    // The remedy the message points at must survive the withholding.
    expect(infos).toContain("Expected 'aws4_request'");
  });

  it('reports the Credential segment COUNT instead of the value', async () => {
    // Two slash-separated segments, the second of which has swallowed the
    // `Signature=` component.
    const infos = await infoOnReject(
      `AWS4-HMAC-SHA256 Credential=AKIALOCALEXAMPLE/x Signature=${SIGNATURE}, ` +
        `SignedHeaders=host, Signature=${SIGNATURE}`
    );
    expect(infos).toContain('malformed Authorization header');
    // Anchored through to the count: `expected 5 slash-separated segments`
    // on its own is a SUBSTRING of the message this replaces
    // (`malformed Credential '<value>' (expected 5 slash-separated
    // segments)`), so it would pass on exactly the form it rejects.
    expect(infos).toContain('expected 5 slash-separated segments, got 2');
    expect(infos).not.toContain(SIGNATURE);
  });

  it('reports the POSITION of a parameter with no \'=\', never its content', async () => {
    // `Authorization: Basic <base64>` sent to an AWS_IAM route arrives as
    // exactly one such part; so does a trailing paste. Quoting it would put
    // the credential on the terminal at default level.
    const basic = 'dXNlcjpodW50ZXIy';
    const infos = await infoOnReject(
      'AWS4-HMAC-SHA256 Credential=AKIALOCALEXAMPLE/20260101/us-east-1/execute-api/aws4_request, ' +
        `SignedHeaders=host, ${basic}`
    );
    expect(infos).toContain('malformed Authorization header');
    expect(infos).toContain('malformed parameter 3 of 3');
    expect(infos).not.toContain(basic);
  });

  it('withholds an algorithm token too long to be a scheme name', async () => {
    // The algorithm is `value.slice(0, indexOf(' '))` — whatever precedes
    // the first space. A pasted opaque token followed by anything the
    // parameter parser accepts therefore lands in the algorithm position.
    const infos = await infoOnReject(
      `${SIGNATURE}xyz Credential=AKIALOCALEXAMPLE/20260101/us-east-1/execute-api/aws4_request, ` +
        'SignedHeaders=host, Signature=abcd'
    );
    expect(infos).toContain('unsupported Authorization algorithm');
    expect(infos).toMatch(WITHHELD);
    expect(infos).not.toContain(SIGNATURE);
  });

  it('withholds a credential-date segment that swallowed the signature', async () => {
    // Five segments, so the length check passes; the 2nd one is not a date.
    const infos = await infoOnReject(
      `AWS4-HMAC-SHA256 Credential=AKIALOCALEXAMPLE/x Signature=${SIGNATURE}/us-east-1/execute-api/aws4_request, ` +
        'SignedHeaders=host, Signature=abcd'
    );
    expect(infos).toContain('malformed credential date');
    expect(infos).toMatch(WITHHELD);
    expect(infos).not.toContain(SIGNATURE);
    expect(infos).toContain('expected YYYYMMDD');
  });

  it('withholds an access-key-id segment that swallowed the signature (warn level)', async () => {
    // `warn` is LESS gated than the `info` sites above, so scoping the fix
    // to `info` would have inverted its own visibility argument. The
    // foreign-identity path warn-and-passes by default, so this line prints
    // on a request that is then SERVED.
    const header =
      `AWS4-HMAC-SHA256 Credential=AKIALOCAL Signature=${SIGNATURE}/20260101/us-east-1/execute-api/aws4_request, ` +
      'SignedHeaders=host, Signature=abcd';
    // FIVE separate interpolations produce this warn, and a single case
    // leaves four of them unfenced. Two axes multiply: the route mode
    // (default warn-and-pass / `--strict-sigv4` deny / CloudFront-OAC pass)
    // and the host's `sigV4StrictByDefault`, which selects a different
    // wording of the same line. A per-occurrence mutation probe found the
    // two `sigV4StrictByDefault: true` spellings still green when only the
    // three route modes were covered.
    for (const strictByDefault of [false, true]) {
      setEmbedConfig(
        strictByDefault
          ? { sigV4StrictByDefault: true, sigV4OptFlag: '--allow-unverified-sigv4' }
          : {}
      );
      try {
        for (const opts of [{}, { strict: true }, { oacFronted: true, strict: true }]) {
          const warns = await warnOnForeignId(header, opts);
          expect(warns).toMatch(WITHHELD);
          expect(warns).not.toContain(SIGNATURE);
        }
      } finally {
        resetEmbedConfig();
      }
    }
  });

  it('withholds an offered Signature= that swallowed a trailing parameter', async () => {
    // The access-key id matches the local credentials, so this reaches the
    // mismatch message — where `Signature=` is the LAST parameter and
    // therefore a sweep position of its own.
    const infos = await infoOnReject(
      `AWS4-HMAC-SHA256 Credential=${LOCAL_CREDS.accessKeyId}/20260101/us-east-1/execute-api/aws4_request, ` +
        `SignedHeaders=host;x-amz-date, Signature=${SIGNATURE} X-Anything=foo`
    );
    expect(infos).toContain('Signature= mismatch');
    expect(infos).toContain('characters that are not a signature');
    expect(infos).not.toContain(SIGNATURE);
  });
});

describe('verifySigV4 — the diagnostics issue #246 added are NOT over-redacted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still quotes a short terminator and a short algorithm verbatim', async () => {
    const term = await infoOnReject(
      'AWS4-HMAC-SHA256 Credential=AKIALOCALEXAMPLE/20260101/us-east-1/execute-api/aws3_request, ' +
        'SignedHeaders=host, Signature=abcd'
    );
    // Delimiter-anchored: `'aws3_request'` alone is also a substring of
    // `'aws3_request '` + anything a future sweep-in might append.
    expect(term).toContain("terminator 'aws3_request'.");

    const alg = await infoOnReject(
      'AWS4-HMAC-SHA512 Credential=AKIALOCALEXAMPLE/20260101/us-east-1/execute-api/aws4_request, ' +
        'SignedHeaders=host, Signature=abcd'
    );
    expect(alg).toContain("algorithm 'AWS4-HMAC-SHA512'.");
  });

  it('still quotes an RFC 1123 x-amz-date in full (deliberately not redacted)', async () => {
    // `x-amz-date` is left raw on purpose (see the note at the site): no
    // delimiter mistake can sweep an `Authorization` segment into it, and
    // its legal spellings carry spaces and run long, so any shape-based
    // bound would withhold the valid-but-mismatched timestamp this message
    // exists to show. This case is what stops a later sweep from applying
    // `redactAuthorizationSegment` here by analogy.
    const rfcDate = 'Mon, 02 Jan 2006 15:04:05 GMT';
    const spy = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const req: SigV4VerifyRequest = {
      method: 'POST',
      rawUrl: '/',
      headers: {
        host: '127.0.0.1:65483',
        'x-amz-date': rfcDate,
        authorization:
          'AWS4-HMAC-SHA256 Credential=AKIALOCALEXAMPLE/20260101/us-east-1/execute-api/aws4_request, ' +
          'SignedHeaders=host, Signature=abcd',
      },
      body: Buffer.alloc(0),
    };
    const result = await verifySigV4(req, loadLocal, { now: () => NOW });
    expect(result.allow).toBe(false);
    const infos = spy.mock.calls.map((c) => String(c[0])).join('\n');
    spy.mockRestore();
    expect(infos).toContain(`x-amz-date '${rfcDate}'`);
    expect(infos).not.toMatch(WITHHELD);
  });

  it('prints the OFFERED signature and withholds the RECOMPUTED one', async () => {
    // The offered value is the caller's own, so echoing it back to a local
    // terminal discloses nothing they did not send, and it is what makes
    // the mismatch actionable (issue #246). The recomputed value is an HMAC
    // under the developer's real secret access key over a string-to-sign
    // the CALLER chose, and this branch needs only a matching access-key id
    // — an identifier, not a secret — so printing it would hand out valid
    // signatures for arbitrary AWS calls.
    const offered = '0'.repeat(64);
    const infos = await infoOnReject(
      `AWS4-HMAC-SHA256 Credential=${LOCAL_CREDS.accessKeyId}/20260101/us-east-1/execute-api/aws4_request, ` +
        `SignedHeaders=host;x-amz-date, Signature=${offered}`
    );
    expect(infos).toContain('Signature= mismatch');
    expect(infos).toContain(`got '${offered}'`);
    expect(infos).toContain('the recomputed signature is withheld');
    // The positive half of the negative: exactly ONE 64-hex run in the
    // whole output, and it is the one the caller supplied. A bare
    // `not.toContain(<recomputed>)` would need the recomputed value, which
    // the test cannot see — and "no hex at all" would also pass if the
    // message lost the offered signature too.
    const hexRuns = infos.match(/[0-9a-f]{64}/g) ?? [];
    expect(hexRuns).toEqual([offered]);
  });
});
