import { describe, expect, it } from 'vite-plus/test';
import { isLoopbackHost } from '../../../src/utils/aws-proxy.js';
import { isLoopbackHostname, isWildcardHostname } from '../../../src/local/studio-proxy.js';

/**
 * cdk-local carries TWO loopback predicates, both on the `UP_PATHS` security
 * surface and both answering "is this host this machine?":
 *
 *   - `studio-proxy`'s `isLoopbackHostname` / `isWildcardHostname` bound where
 *     studio will forward a composer request (issue #578).
 *   - `aws-proxy`'s `isLoopbackHost` decides whether a JWKS / discovery /
 *     layer read may be sent to a forward proxy (issue #647).
 *
 * They exist separately because they answer for different LAYERS —
 * `src/utils/**` must not import from `src/local/**` — but a host is a host,
 * and the round-2 review found them already diverging: `aws-proxy`'s first
 * cut used a `7f…` PATTERN that admits a short hextet (`::ffff:7f:1` is
 * 0.127.0.1) where studio-proxy compares ARITHMETICALLY, and did not treat
 * the WILDCARD address as this machine at all, where studio-proxy does.
 *
 * The failure directions are opposite and both bad: studio-proxy forwarding
 * a request off-box, and aws-proxy proxying a local JWKS read — which does
 * not deny requests, it degrades the verifier to accept EVERY token.
 *
 * So the duplication is fenced rather than trusted. Consolidating the two
 * into one `src/utils/**` predicate is tracked separately; until then this
 * test is what stops them drifting again.
 */

/** Every spelling `URL.hostname` can produce for this machine, and near-misses. */
const CASES: [host: string, isThisMachine: boolean][] = [
  ['127.0.0.1', true],
  ['127.0.0.53', true],
  ['127.5.5.5', true],
  ['localhost', true],
  ['LOCALHOST', true],
  ['::1', true],
  ['[::1]', true],
  ['0:0:0:0:0:0:0:1', true],
  ['::ffff:127.0.0.1', true],
  ['[::ffff:7f00:1]', true],
  ['0.0.0.0', true],
  ['::', true],
  ['[::]', true],
  ['::ffff:0.0.0.0', true],
  // Near-misses that must NOT be treated as this machine.
  ['192.168.0.5', false],
  ['169.254.169.254', false],
  ['10.0.0.1', false],
  ['attacker.example', false],
  ['localhost.attacker.example', false],
  ['my-localhost', false],
  ['127.0.0.1.attacker.example', false],
  ['2130706433.attacker.example', false],
  ['999.0.0.1', false],
  ['[2001:db8::1]', false],
  ['::ffff:169.254.169.254', false],
  // The short-hextet near-miss that the pre-fix `7f…` pattern accepted.
  ['[::ffff:7f:1]', false],
  ['[::ffff:7f0:1]', false],
  ['', false],
];

describe('loopback predicates agree across the two security surfaces (issue #647)', () => {
  it.each(CASES)('%s', (host, isThisMachine) => {
    // studio-proxy splits the question in two; aws-proxy answers it whole.
    const studio = isLoopbackHostname(host) || isWildcardHostname(host);
    expect(studio, `studio-proxy on ${host}`).toBe(isThisMachine);
    expect(isLoopbackHost(host), `aws-proxy on ${host}`).toBe(isThisMachine);
  });

  // `aws-proxy` accepts two spellings studio-proxy deliberately does not, and
  // the asymmetry is intentional rather than drift: RFC 6761 reserves
  // `.localhost` to loopback, and a trailing dot is the fully-qualified
  // spelling of the same name. studio-proxy's bound is deliberately the
  // narrower one — it gates where a developer's request body may be sent.
  it.each(['sub.localhost', 'localhost.'])('%s is this machine for aws-proxy only', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
    expect(isLoopbackHostname(host) || isWildcardHostname(host)).toBe(false);
  });
});
