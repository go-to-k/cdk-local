import { describe, expect, it } from 'vite-plus/test';
import {
  formatAuthority,
  formatHostForAuthority,
  hostFromAuthority,
} from '../../../src/utils/url-authority.js';

/**
 * Issue go-to-k/cdk-local#599 — the helper is fenced as a CLASSIFIER, not
 * against a handful of remembered values.
 *
 * Every row below is crossed with a port and put through the SAME three
 * assertions, and the parse / round-trip assertions are opt-OUT (`parses:
 * false`) rather than opt-in. A spelling nobody imagined therefore fails by
 * default: adding a row without deciding what it should do cannot pass.
 */
interface HostRow {
  /** What a caller hands the helper (a `--container-host` value, a bind address). */
  readonly host: string;
  /** The host token the helper must render inside an authority. */
  readonly expected: string;
  /** Why this row exists — read out in the test name. */
  readonly why: string;
  /**
   * Opt out of "the composed authority is a URL". The ONLY row that may is a
   * host that is not a host: the helper composes an authority, it does not
   * invent one, so an empty host stays empty and the result does not parse.
   */
  readonly parses?: false;
  /**
   * What `URL.hostname` reads back, when the parser NORMALISES the token the
   * helper wrote. Defaults to {@link expected}; set only where the two
   * legitimately differ. The helper is a composer, not a normaliser — it
   * preserves the case it was handed, and the WHATWG parser lowercases an
   * IPv6 literal. Making that explicit per row beats a case-insensitive
   * compare, which would also hide a helper that started mangling case.
   */
  readonly parsedAs?: string;
}

const HOSTS: readonly HostRow[] = [
  { host: '::', expected: '[::]', why: 'the IPv6 wildcard — the bug in the issue' },
  { host: '::1', expected: '[::1]', why: 'IPv6 loopback' },
  { host: 'fe80::1', expected: '[fe80::1]', why: 'a link-local literal' },
  { host: '[::1]', expected: '[::1]', why: 'ALREADY bracketed — must not double-bracket' },
  {
    host: 'FE80::1',
    expected: '[FE80::1]',
    parsedAs: '[fe80::1]',
    why: 'uppercase hex is a legal literal; the PARSER lowercases, the helper does not',
  },
  {
    host: '2001:DB8::1',
    expected: '[2001:DB8::1]',
    parsedAs: '[2001:db8::1]',
    why: 'mixed-case documentation prefix',
  },
  {
    // The one input that is BOTH already bracketed and unparseable. An early
    // return on "already bracketed" bypasses the zone-drop and emits
    // `http://[fe80::1%en0]:8080`, which `new URL` rejects — precisely the
    // failure this helper exists to prevent.
    host: '[fe80::1%en0]',
    expected: '[fe80::1]',
    why: 'bracketed WITH a zone — the zone must still be dropped',
  },
  {
    host: 'fe80::1%en0',
    expected: '[fe80::1]',
    why: 'a zone id — dropped, since no URL parser accepts one',
  },
  { host: '0.0.0.0', expected: '0.0.0.0', why: 'the IPv4 wildcard — the spelling that already worked' },
  { host: '127.0.0.1', expected: '127.0.0.1', why: 'IPv4 loopback, the default everywhere' },
  { host: 'localhost', expected: 'localhost', why: 'a registered name' },
  { host: 'example.com', expected: 'example.com', why: 'a dotted registered name' },
  { host: '', expected: '', why: 'no host at all — the caller has a bug, not the helper', parses: false },
  {
    // The ALB redirect writer fills its host from an `#{host}` template or a
    // configured literal, and a CRLF-injection attempt arrives there
    // FLATTENED (`front-door-server`'s raw-socket case), colon and all. It is
    // not an address, so it must pass through rather than gain brackets it
    // never had — which is why the classifier is a character-class test and
    // not "contains a colon".
    host: 'example.test  x-injected: yes',
    expected: 'example.test  x-injected: yes',
    why: 'a colon in something that CANNOT be an address',
    parses: false,
  },
];

const PORT = 8080;

describe('formatHostForAuthority / formatAuthority (issue #599)', () => {
  for (const row of HOSTS) {
    describe(`host '${row.host}' (${row.why})`, () => {
      it(`renders as '${row.expected}'`, () => {
        expect(formatHostForAuthority(row.host)).toBe(row.expected);
        expect(formatAuthority(row.host, PORT)).toBe(`${row.expected}:${PORT}`);
      });

      it('is idempotent', () => {
        const once = formatHostForAuthority(row.host);
        expect(formatHostForAuthority(once)).toBe(once);
      });

      if (row.parses === false) {
        it('does NOT parse as a URL, and that is the documented answer', () => {
          expect(() => new URL(`http://${formatAuthority(row.host, PORT)}`)).toThrow();
        });
      } else {
        it('composes a URL the WHATWG parser accepts, whose hostname round-trips', () => {
          const parsedAs = row.parsedAs ?? row.expected;
          const authority = formatAuthority(row.host, PORT);
          const url = new URL(`http://${authority}`);
          expect(url.port).toBe(String(PORT));
          expect(url.hostname).toBe(parsedAs);
          // The round trip that matters in practice: a caller often feeds a
          // parsed `URL.hostname` (already bracketed for IPv6) straight back
          // into the helper. Re-composing from it must be a FIXED POINT — on
          // the parsed spelling, since that is the value a caller actually
          // holds once a URL has been through the parser.
          expect(formatAuthority(url.hostname, url.port)).toBe(`${parsedAs}:${PORT}`);
          expect(new URL(`http://${formatAuthority(url.hostname, url.port)}`).hostname).toBe(
            parsedAs
          );
        });
      }
    });
  }

  it('accepts a string port as well as a number', () => {
    expect(formatAuthority('::1', '8080')).toBe('[::1]:8080');
    expect(formatAuthority('127.0.0.1', '8080')).toBe('127.0.0.1:8080');
  });

  it('survives a hostname the URL parser NORMALISES, without double-bracketing', () => {
    // `::ffff:127.0.0.1` re-serialises as `[::ffff:7f00:1]`. The point is not
    // the normalisation (that is the parser's business) but that feeding the
    // parser's answer back in is safe.
    const first = formatAuthority('::ffff:127.0.0.1', PORT);
    const url = new URL(`http://${first}`);
    expect(url.hostname).toBe('[::ffff:7f00:1]');
    expect(formatAuthority(url.hostname, url.port)).toBe(`[::ffff:7f00:1]:${PORT}`);
  });

  it('leaves a `%` that is not a zone id alone, since it is not an IPv6 literal', () => {
    // No `:`, so it is a registered name as far as an authority is concerned.
    expect(formatHostForAuthority('weird%name')).toBe('weird%name');
  });

  it('brackets only what could BE an address, not merely what contains a colon', () => {
    // Bracketed: every character is legal in an IPv6 literal.
    for (const h of ['::', '::1', 'fe80::1', '::ffff:127.0.0.1', 'a:b:c'])
      expect(formatHostForAuthority(h), h).toBe(`[${h}]`);
    // Untouched: a colon inside something no address could be.
    for (const h of ['host:name', 'example.test  x-injected: yes', 'http://x', 'a:b/c'])
      expect(formatHostForAuthority(h), h).toBe(h);
    // A degenerate all-legal-characters input still brackets. The classifier
    // separates address-SHAPED from not-address-shaped; it does not validate
    // an address, and a caller with `:` for a host has the same bug as one
    // with `''` (see the table's `parses: false` rows).
    expect(formatHostForAuthority(':')).toBe('[:]');
  });
});

/**
 * The inverse: read a host back OUT of an authority. Same table, so the two
 * directions cannot drift — every host that composes must decompose to itself.
 */
describe('hostFromAuthority (issue #599)', () => {
  // Scoped to the rows that compose a WELL-FORMED authority. The two
  // `parses: false` rows are not hosts (the empty string; a flattened
  // injection attempt), so their authority has no unambiguous split back and
  // no round trip is claimed — see the explicit case at the end.
  for (const row of HOSTS.filter((r) => r.parses !== false)) {
    // Derived from the row's EXPECTED authority token rather than from its
    // input: a zone id is dropped on the way in, so the round trip lands on
    // the scope-free literal. Stated, not skipped.
    const expectedBare = row.expected.startsWith('[')
      ? row.expected.slice(1, -1)
      : row.expected;

    it(`recovers '${expectedBare}' from the authority built for '${row.host}'`, () => {
      expect(hostFromAuthority(formatAuthority(row.host, PORT))).toBe(expectedBare);
    });

    it(`round-trips '${row.host}' back through formatAuthority unchanged`, () => {
      const authority = formatAuthority(row.host, PORT);
      expect(formatAuthority(hostFromAuthority(authority), PORT)).toBe(authority);
    });
  }

  it('reads a bare host with no port', () => {
    expect(hostFromAuthority('example.com')).toBe('example.com');
    expect(hostFromAuthority('[::1]')).toBe('::1');
    expect(hostFromAuthority('')).toBe('');
  });

  it('refuses to guess at a malformed authority, on BOTH arms', () => {
    // One case list for both branches, because the defect was the same shape
    // twice and fixing one arm is what left the other visible.
    //
    // UNBRACKETED: formerly `split(':')[0]`, which only LOOKED like a refusal
    // for a value starting with a colon — the leading empty fragment. Every
    // other spelling handed back a fragment that is not the host named:
    // `fe80::1:8080` -> 'fe80', `2001:db8::1` -> '2001', `a:b:c:8080` -> 'a'.
    //
    // BRACKETED: the worse direction, because the guess PARSES. `[evil.example`
    // came back as `evil.example`, so an ALB `#{host}` redirect emitted a
    // VALID `Location` to a host the client only half-named — where the
    // malformed input should have produced nothing at all. `[a:b]junk` dropped
    // its trailing junk silently, and `[x:y` returned a multi-colon value as a
    // host, which is exactly what the unbracketed arm refuses.
    //
    // This is an attacker-reachable parser (the request `Host` header feeds
    // that substitution), so it refuses rather than guesses.
    for (const a of [
      // unbracketed
      '::1:8080',
      'fe80::1:8080',
      '2001:db8::1',
      'a:b:c:8080',
      'example.test  x-injected: yes:8080',
      '::',
      // bracketed
      '[evil.example',
      '[a:b]junk',
      '[x:y',
      '[::1]:80x',
      '[::1]junk:8080',
    ]) {
      expect(hostFromAuthority(a), a).toBe('');
    }
  });

  it('still accepts a WELL-FORMED bracketed authority, with or without a port', () => {
    // The other direction of the same rule — the refusal must not have eaten
    // the shape it exists to read.
    expect(hostFromAuthority('[::1]')).toBe('::1');
    expect(hostFromAuthority('[::1]:8080')).toBe('::1');
    expect(hostFromAuthority('[fe80::1]:1')).toBe('fe80::1');
    expect(hostFromAuthority('[FE80::1]:65535')).toBe('FE80::1');
  });

  it('still reads the ordinary single-colon and no-colon spellings', () => {
    expect(hostFromAuthority('127.0.0.1:8080')).toBe('127.0.0.1');
    expect(hostFromAuthority('example.com:8080')).toBe('example.com');
    expect(hostFromAuthority('example.com')).toBe('example.com');
  });
});
