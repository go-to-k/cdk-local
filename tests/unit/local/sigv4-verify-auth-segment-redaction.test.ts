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
  type SigV4VerifyRequest,
  type ResolvedCredentials,
} from '../../../src/local/sigv4-verify.js';
import { getLogger } from '../../../src/utils/logger.js';

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
    expect(infos).toContain('expected 5 slash-separated segments');
    expect(infos).toContain('got 2');
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

  it('still prints BOTH signatures on a Signature= mismatch (deliberate, see the in-code note)', async () => {
    // Reached only when the request's access-key id matches the credentials
    // cdk-local resolved locally, so the signature is provably the
    // developer's own. Printing it beside the recomputed one IS the
    // diagnostic; this case is what stops a later sweep from "fixing" it.
    const offered = '0'.repeat(64);
    const infos = await infoOnReject(
      `AWS4-HMAC-SHA256 Credential=${LOCAL_CREDS.accessKeyId}/20260101/us-east-1/execute-api/aws4_request, ` +
        `SignedHeaders=host;x-amz-date, Signature=${offered}`
    );
    expect(infos).toContain('Signature= mismatch');
    expect(infos).toContain(`got '${offered}'`);
    expect(infos).toMatch(/recomputed '[0-9a-f]{64}'/);
    expect(infos).not.toMatch(WITHHELD);
  });
});
