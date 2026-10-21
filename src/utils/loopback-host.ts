/**
 * "Is this host THIS machine?" — the ONE implementation behind two security
 * bounds (issue go-to-k/cdk-local#666):
 *
 * - `cdkl studio`'s capture proxy refuses to forward a composer request —
 *   headers and body — anywhere but loopback (`local/studio-proxy`'s
 *   `normalizeLocalUpstream`, issue #578). Failure direction: a developer's
 *   request carried OFF-BOX.
 * - `proxyAwareFetch` never sends a loopback read to a forward proxy
 *   (`utils/aws-proxy`, issue #647). Failure direction: a local-IdP JWKS read
 *   proxied into a refusal, which degrades the JWT verifier to ACCEPT EVERY
 *   TOKEN.
 *
 * They used to be two copies, kept apart only because `src/utils/**` must not
 * import `src/local/**` — a constraint that never forbade both importing ONE
 * `src/utils/**` module. The copies diverged twice (an IPv6 arm that was dead
 * code, a short-hextet false positive), so the shared rules live here once.
 *
 * Two bounds remain, deliberately, and they differ by EXACTLY two spellings:
 * {@link isLoopbackHost} additionally accepts `*.localhost` (RFC 6761
 * reserves it to loopback) and a single trailing dot (the fully-qualified
 * spelling of the same name). studio's bound stays the NARROWER one — it
 * decides where a request body may be sent, and widening it would be a
 * security change of its own, not a consequence of sharing code.
 *
 * Every input is normalised the way `URL.hostname` leaves it: lowercased,
 * port stripped, but an IPv6 literal KEEPS its brackets (`http://[::1]/` ->
 * `"[::1]"`), so brackets are tolerated rather than required.
 */

/** Trim, drop one pair of IPv6 brackets, lowercase. */
function normaliseHostLiteral(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/** The loopback rule over an ALREADY-normalised host. */
function isLoopbackLiteral(h: string): boolean {
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped IPv6 in hex form (`::ffff:7f00:1`): the high hextet's top
  // byte is the first IPv4 octet. Arithmetic rather than a `7f…` pattern,
  // which admits a SHORT hextet — `::ffff:7f:1` is 0.127.0.1, not loopback.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) return parseInt(mapped[1]!, 16) >> 8 === 127;
  const dotted = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!dotted) return false;
  const octets = dotted.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

/** The wildcard rule over an ALREADY-normalised host. */
function isWildcardLiteral(h: string): boolean {
  return (
    h === '0.0.0.0' ||
    h === '::' ||
    h === '0:0:0:0:0:0:0:0' ||
    h === '::ffff:0.0.0.0' ||
    h === '::ffff:0:0'
  );
}

/**
 * True when `hostname` names this machine's loopback interface: `localhost`,
 * an IPv4 address in `127.0.0.0/8`, IPv6 `::1`, or an IPv4-mapped loopback
 * (`::ffff:127.0.0.1`, which `URL.hostname` renders in hex as
 * `[::ffff:7f00:1]`). The match is EXACT — `localhost.example.com` and
 * `127.0.0.1.example.com` are ordinary DNS names that resolve wherever their
 * owner points them, and are NOT loopback. The wildcard address is NOT
 * matched here; see {@link isWildcardHostname}.
 *
 * studio's bound on where it forwards a composer request (issue #578): a
 * `cdkl` serve child always listens on this machine, so a destination that is
 * not loopback did not come from a genuine serve.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackLiteral(normaliseHostLiteral(hostname));
}

/**
 * True when `hostname` is the UNSPECIFIED (wildcard) address: IPv4 `0.0.0.0`,
 * IPv6 `::` (`URL` normalises `0:0:0:0:0:0:0:0` to it), or the IPv4-mapped
 * `::ffff:0.0.0.0` (which `URL.hostname` renders as `[::ffff:0:0]`).
 *
 * A wildcard is a BIND address, not a destination — a server bound to it IS
 * reachable on loopback, and connecting to it reaches this machine, so no
 * spelling of it reaches anywhere else.
 */
export function isWildcardHostname(hostname: string): boolean {
  return isWildcardLiteral(normaliseHostLiteral(hostname));
}

/**
 * The WIDER bound: {@link isLoopbackHostname} or {@link isWildcardHostname},
 * plus `*.localhost` and a single trailing dot. Used where a FALSE NEGATIVE is
 * the dangerous direction — `proxyAwareFetch` treating a loopback JWKS host as
 * remote and proxying it (issue #647) — so accepting two more spellings that
 * can only ever mean this machine is the safe side.
 *
 * Why `proxyAwareFetch` needs it at all: `proxy-from-env` implements the
 * standard `NO_PROXY` semantics, which exempt nothing by default, so with
 * `HTTP_PROXY` exported a request to `127.0.0.1` goes to the corporate proxy,
 * which has no route to the caller's loopback. For an AWS SDK client that is
 * unreachable in practice (every endpoint is a public AWS host), which is why
 * `EnvRoutingProxyAgent` does not carry this rule; for a local-IdP JWKS read
 * (the `local-start-api-cognito-jwt` fixture's shape) it is the difference
 * between verifying tokens and accepting all of them.
 *
 * Deliberately NOT extended to RFC 1918 / private ranges: a corporate proxy
 * plausibly does reach those, so exempting them would be a guess rather than
 * an impossibility. `NO_PROXY` remains the control for that case.
 */
export function isLoopbackHost(hostname: string): boolean {
  // A single trailing dot is the fully-qualified spelling of the same name.
  const h = normaliseHostLiteral(hostname).replace(/\.$/, '');
  return h.endsWith('.localhost') || isLoopbackLiteral(h) || isWildcardLiteral(h);
}
