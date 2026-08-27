/**
 * Compose the authority component of a URL from a host and a port.
 *
 * Every local serve prints an endpoint banner, and several of those banners
 * are MACHINE-PARSED — `cdkl studio` reads them to learn where to point its
 * capture proxy (`local/studio-serve-manager`'s `readyRe` /
 * `parsePublishedHostEndpoint`), then resolves the result with `new URL(...)`
 * before it will forward anything there. So an authority that the WHATWG
 * parser rejects is not a cosmetic log defect: the serve is refused.
 *
 * The one shape that used to be composed wrong is an IPv6 literal. RFC 3986
 * 3.2.2 requires it to be bracketed inside an authority, so a bare
 * `${host}:${port}` turns `--container-host ::` into `http://:::8080`, which
 * is not a URL — while the IPv4 wildcard `0.0.0.0`, the same intention spelled
 * differently, works. Issue go-to-k/cdk-local#599.
 *
 * The detection is mechanical rather than a list of known values: a colon is
 * forbidden in both a registered name and an IPv4 address, so a host carrying
 * one is an IPv6 literal — PROVIDED the rest of it could be one, which is a
 * character-class test (hex digits, `:`, and `.` for the IPv4-mapped form)
 * rather than an enumeration. The qualifier is load-bearing rather than
 * pedantry: `buildRedirectLocation` fills its host from an ALB `#{host}`
 * template or a configured literal, so a CRLF-injection attempt reaches this
 * function AS-IS — `example.test\r\nx-injected: yes`, with the CR/LF still in
 * it, because `front-door-server` sanitises the Location only AFTER building
 * it. Either way it is a colon in something that is not an address and must
 * pass through untouched rather than gain brackets it never had. (CR and LF
 * are outside the character class by construction, so the raw and flattened
 * spellings classify identically — but the raw one is what actually arrives.)
 * Caught by `front-door-server.test.ts`'s raw-socket injection case.
 */

/**
 * A host that could be an IPv6 literal: hex digits, `:` separators, and `.`
 * for the IPv4-mapped form (`::ffff:127.0.0.1`). Deliberately NOT a full
 * grammar — the job is to separate "an address" from "not an address", and
 * validating an address that has already been bound to is not this function's
 * business.
 */
const IPV6_LITERAL_CHARS = /^[0-9A-Fa-f:.]+$/;

/**
 * Render `host` as it must appear inside a URL authority.
 *
 * - An IPv6 literal is bracketed, in either case (`FE80::1` -> `[FE80::1]`).
 * - An already-bracketed literal comes back bracketed exactly once, so the
 *   function is idempotent: `[::1]` never becomes `[[::1]]`. That matters
 *   because a caller often feeds back a `URL.hostname`, which is ALREADY
 *   bracketed.
 * - A zone id (`fe80::1%en0`) is DROPPED, keeping `[fe80::1]`. No URL parser
 *   accepts one — Node's `new URL` throws on both the raw `%en0` and the
 *   percent-encoded `%25en0` — and a zone id is a host-local interface
 *   selector that carries no meaning for whoever reads the banner. Emitting
 *   an authority nothing can parse is the exact failure this helper exists to
 *   prevent, so the scope is dropped rather than propagated. The brackets are
 *   removed BEFORE that decision, so `[fe80::1%en0]` is stripped too — an
 *   early return on "already bracketed" would have waved the one input that
 *   is both bracketed and unparseable straight through.
 * - Everything else (IPv4 literal, registered name, the empty string, and a
 *   colon-bearing string that is not an address) is returned untouched.
 */
export function formatHostForAuthority(host: string): string {
  const wrapped = host.length > 1 && host.startsWith('[') && host.endsWith(']');
  const inner = wrapped ? host.slice(1, -1) : host;
  if (!inner.includes(':')) return host;
  const zoneAt = inner.indexOf('%');
  const literal = zoneAt === -1 ? inner : inner.slice(0, zoneAt);
  if (!IPV6_LITERAL_CHARS.test(literal)) return host;
  return `[${literal}]`;
}

/**
 * Compose `<host>:<port>` for use inside a URL, bracketing an IPv6 literal.
 *
 * An empty `host` is passed through as-is rather than substituted: the helper
 * composes an authority, it does not invent a host, and a caller that has no
 * host has a bug of its own. The result (`:8080`) does not parse, which is the
 * honest rendering of that state.
 */
export function formatAuthority(host: string, port: number | string): string {
  return `${formatHostForAuthority(host)}:${port}`;
}

/**
 * Read the HOST out of an authority (`<host>` or `<host>:<port>`), returning
 * it BARE — an IPv6 literal comes back without its brackets, ready to be
 * handed straight back to {@link formatAuthority}.
 *
 * The inverse of {@link formatAuthority}, and it exists for the same reason:
 * `authority.split(':')[0]` is the obvious thing to write and it is wrong for
 * exactly one input. A conforming client sends `Host: [::1]:8080` (measured —
 * see `tests/unit/local/ipv6-host-header.test.ts`), and splitting that on the
 * first colon yields `'['`, so an ALB `#{host}` substitution built from it
 * produced `http://[:8080/...`. Issue go-to-k/cdk-local#599.
 *
 * # It refuses rather than guesses — on BOTH arms
 *
 * This is an attacker-reachable parser: the request `Host` header feeds an
 * ALB `#{host}` substitution, and whatever comes back is composed into a
 * redirect `Location`. So a malformed authority yields the empty string
 * rather than the fragment that happens to be readable, on either branch.
 *
 * BRACKETED — read to the closing `]`, and only when the value is
 * well-formed: there must BE a closing bracket, and what follows it must be
 * empty or `:<digits>`. Guessing here is the worse of the two directions,
 * because the guess PARSES: `[evil.example` (no closing bracket) would come
 * back as `evil.example`, turning a half-named host into a valid `Location`
 * the client would follow, where the malformed input should have produced
 * nothing. `[a:b]junk` would silently drop its trailing junk, and `[x:y`
 * would return a multi-colon value as a host — the very thing the other arm
 * refuses.
 *
 * UNBRACKETED — the text before its single `:`. Two or more colons yields
 * the empty string: it is not a shape any conforming client sends (Node
 * brackets — measured in `tests/unit/local/ipv6-host-header.test.ts`), it has
 * no unambiguous split, and returning the leading fragment would hand a
 * caller a host that is not the one named. `split(':')[0]` did exactly that —
 * `fe80::1:8080` came back as `'fe80'`.
 */
export function hostFromAuthority(authority: string): string {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return '';
    const afterBracket = authority.slice(close + 1);
    if (afterBracket !== '' && !/^:\d+$/.test(afterBracket)) return '';
    return authority.slice(1, close);
  }
  const firstColon = authority.indexOf(':');
  if (firstColon === -1) return authority;
  if (authority.includes(':', firstColon + 1)) return '';
  return authority.slice(0, firstColon);
}
