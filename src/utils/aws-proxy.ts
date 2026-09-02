import type { ClientRequest, IncomingMessage } from 'node:http';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import { Agent } from 'agent-base';
import type { AgentConnectOpts } from 'agent-base';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import { getLogger } from './logger.js';
import { formatAuthority } from './url-authority.js';

/**
 * Proxy-aware AWS SDK client plumbing (issue #634).
 *
 * The AWS SDK for JavaScript v3 does not read `HTTPS_PROXY` / `HTTP_PROXY` /
 * `NO_PROXY` on its own: a proxy must be supplied through a `requestHandler`
 * by whoever constructs the client. On a machine whose only egress is a
 * corporate forward proxy, every AWS call cdk-local makes would otherwise
 * fail (typically as `CredentialsProviderError: self-signed certificate in
 * certificate chain` — the direct route is intercepted).
 *
 * `buildProxyClientConfig()` is the single seam: it returns an EMPTY config
 * when no proxy environment variable is set (zero behavior change for
 * existing users), and a `{ requestHandler, credentials }` fragment when one
 * is. Every AWS SDK client construction in cdk-local spreads it (directly, or
 * via `buildStsClientConfig` for the STS sites);
 * `tests/unit/utils/aws-proxy-client-audit.test.ts` fences the sweep so a new
 * construction site cannot silently skip it.
 *
 * Not every AWS-bound request is an SDK call, though — and the global
 * `fetch` (undici) reads no proxy variable either (issue #647). The layer
 * ZIP download and the Cognito JWKS / OIDC discovery reads are plain GETs,
 * so `proxyAwareFetch()` is the second seam: same `NO_PROXY` decision, same
 * "empty when unconfigured" contract, fenced by
 * `tests/unit/utils/aws-proxy-fetch-audit.test.ts`.
 *
 * Both seams route through ONE routing decision,
 * {@link resolveProxyForTarget} (issue go-to-k/cdk-local#663) -- which is
 * also where a proxy scheme these agents cannot speak is turned into a
 * warned DIRECT connection rather than into an HTTP agent pointed at, for
 * example, a SOCKS port.
 */

/**
 * The SDK applies these defaults only when it builds its OWN agents from a
 * plain option bag; an externally supplied Agent instance passes through
 * `NodeHttpHandler.resolveDefaultConfig` untouched. Set them explicitly so
 * the proxied path keeps the same socket profile as the unproxied default.
 */
const AGENT_OPTS = { keepAlive: true, maxSockets: 50 };

/**
 * Whether any standard proxy environment variable is set (either spelling).
 * `NO_PROXY` alone does not count — with no proxy to route to there is
 * nothing to exempt from.
 *
 * Read live (not memoized) so a host CLI that sets the variables
 * programmatically before constructing clients is honored.
 */
export function isProxyEnvConfigured(): boolean {
  const env = process.env;
  return Boolean(
    env['https_proxy'] ||
    env['HTTPS_PROXY'] ||
    env['http_proxy'] ||
    env['HTTP_PROXY'] ||
    env['all_proxy'] ||
    env['ALL_PROXY']
  );
}

/**
 * Proxy SCHEMES already warned about, so a decision taken per REQUEST does
 * not print a line per AWS call. Keyed by scheme rather than by URL because
 * the message names only the scheme — two SOCKS proxies would otherwise
 * print the same sentence twice.
 */
const warnedProxySchemes = new Set<string>();

/**
 * Clear the warn-once memo. TEST SEAM only: production never calls it, and
 * it is deliberately NOT re-exported from `src/internal.ts`. Without it a
 * case asserting "warns ONCE" would pass or fail on whether an earlier case
 * in the file happened to warn about the same scheme first — an assertion
 * whose premise has evaporated, which no mutation probe can see.
 */
export function resetProxySchemeWarnings(): void {
  warnedProxySchemes.clear();
}

/**
 * The scheme of a proxy URL, lowercased and without its `://`.
 *
 * `getProxyForUrl` prepends the REQUEST's scheme to any value that does not
 * already contain `://`, so the URL it returns normally carries one — even
 * `HTTPS_PROXY=proxy.internal:3128`, which becomes `https://proxy.internal:3128`
 * and therefore makes the connection TO THE PROXY ITSELF TLS. (Both spellings
 * still tunnel with `CONNECT`; what changes is whether that tunnel is wrapped
 * in TLS to the proxy. Read from `https-proxy-agent`: an `https:` proxy is
 * reached with `tls.connect` and the `CONNECT` line is written over it.) A
 * value containing `://` somewhere OTHER than the start is returned verbatim
 * and has no leading scheme; pathological, but reachable, so it gets a NAME
 * rather than an empty string that would read as a missing message.
 *
 * The `:\/\/` is load-bearing and NOT decoration. Matching a bare `token:`
 * would name whatever precedes the first colon, and in a verbatim value that
 * is routinely the PROXY USERNAME. Measured:
 * `HTTPS_PROXY=corp-user:s3cr3t@http://proxy.corp:3128` contains `://`, so it
 * comes back untouched — and a `^([a-z][a-z0-9+.-]*):` reading of it yields
 * `corp-user`, which {@link warnUnspeakableProxy} would then print at default
 * level into a log panel `cdkl studio` serves over HTTP. Requiring `://`
 * sends that shape to `(unrecognized)`.
 *
 * It does NOT make "a username can never be printed" true, and the bound is
 * stated rather than left to be rediscovered: `alice://s3cr3t@proxy:3128` is
 * a syntactically valid URL whose scheme IS `alice`, so `alice` is named.
 * That is the URL grammar answering correctly — nothing here can know the
 * author meant it as a username — and it is not a working proxy
 * configuration in any case. Pinned by a case so a future reader finds a
 * decision instead of an oversight.
 *
 * The length bound is the other half: without it the scheme run is
 * unbounded, so a proxy value of 100 kB of `a` followed by `://` becomes a
 * 100 kB default-level warn. 32 is far past every real scheme, and it never
 * affects ROUTING — {@link isSpeakableProxy} is a separate unbounded test, so
 * a 40-character scheme is unspeakable either way.
 */
function proxySchemeOf(proxyUrl: string): string {
  const match = /^([a-z][a-z0-9+.-]{0,31}):\/\//i.exec(proxyUrl);
  return match ? match[1]!.toLowerCase() : '(unrecognized)';
}

/**
 * Whether `proxyUrl` names a proxy these agents can actually SPEAK to.
 *
 * `getProxyForUrl` honours `ALL_PROXY`, and `ALL_PROXY=socks5://...` is an
 * ordinary spelling — but `http-proxy-agent` / `https-proxy-agent` speak HTTP
 * `CONNECT`, not SOCKS. Measured: `new HttpsProxyAgent('socks5://127.0.0.1:1080')`
 * constructs happily and reports `proxy.protocol === 'socks5:'`, then talks
 * HTTP at a SOCKS port, so every request through it fails.
 */
function isSpeakableProxy(proxyUrl: string): boolean {
  return /^https?:\/\//i.test(proxyUrl);
}

/**
 * Say ONCE per scheme that a proxy variable is being ignored.
 *
 * The URL is withheld and only the SCHEME is named: a proxy URL routinely
 * carries `user:password@`, and this line is emitted at DEFAULT level
 * somewhere a third party reads it — `cdkl studio` mirrors a serve child's
 * output into the log panel it serves over HTTP. Same rule `parseHttpUrl`'s
 * rejection follows, for the same reason.
 */
function warnUnspeakableProxy(proxyUrl: string): void {
  const scheme = proxySchemeOf(proxyUrl);
  if (warnedProxySchemes.has(scheme)) return;
  // The memo is written AFTER the line is emitted, not before. A throwing
  // `logger.warn` — a host CLI's injected logger, a closed stream — would
  // otherwise record the scheme as warned and never print it, turning the
  // one-time warn into a zero-time one. That warn is the entire argument for
  // choosing fallback over refusal, so losing it silently is the failure this
  // whole seam is arranged to prevent.
  getLogger()
    .child('aws-proxy')
    .warn(
      `Unsupported proxy scheme "${scheme}" — cdk-local speaks HTTP CONNECT proxies ` +
        'only, so this request went DIRECT instead of through the proxy. Set ' +
        'HTTPS_PROXY / HTTP_PROXY / ALL_PROXY to an http:// or https:// proxy URL. ' +
        '(The proxy URL is withheld here: it can carry credentials.)'
    );
  warnedProxySchemes.add(scheme);
}

/**
 * The proxy to route `targetHref` through, or `''` for a DIRECT connection.
 *
 * ONE site owns the question, so the SDK-client half
 * ({@link EnvRoutingProxyAgent}) and the fetch half ({@link proxyAwareFetch})
 * cannot answer it differently for the same environment — they did until
 * issue go-to-k/cdk-local#663: PR 656 taught the fetch half to fall back on
 * an unspeakable proxy, while the agent PR 646 built kept constructing an
 * HTTP agent pointed at a SOCKS port.
 *
 * Falling back to DIRECT rather than REFUSING is the deliberate call, and it
 * is now the same call on both halves:
 *
 * - Before either seam existed every one of these requests went direct, so a
 *   developer who exports `ALL_PROXY=socks5://...` for an unrelated tunnel
 *   AND has working direct egress had cdk-local working; PR 646 broke that.
 *   Refusing keeps them broken with no configuration to reach — cdk-local
 *   speaks no SOCKS, so the only remedy would be unsetting the variable.
 * - On the JWKS / OIDC discovery path a FAILED read does not deny: the
 *   verifier caches pass-through and accepts every bearer token for the
 *   failure TTL (`docs/cli-reference.md`, "JWKS / OIDC discovery
 *   unreachable"). Attempting and failing there is strictly worse than going
 *   direct.
 * - The one argument for refusing was that a fallback is SILENT, and
 *   {@link warnUnspeakableProxy} removes it: a user whose direct egress is
 *   blocked still gets a line naming the cause, instead of an `ETIMEDOUT`
 *   that points at nothing.
 *
 * An unparsable proxy value whose scheme IS `http(s):` is a DIFFERENT
 * question and still throws from the agent constructor, as before
 * (`HTTPS_PROXY=http://[`): a typo has no working setup behind it, so going
 * direct would hide it rather than restore anything. A value whose scheme is
 * NEITHER — garbage that merely contains `://` — is refused here first and
 * gets the warn instead of the throw. That is the same trade either way: the
 * cause stays attached to the request, which is the property the throw
 * existed for.
 */
function resolveProxyForTarget(targetHref: string): string {
  // TRIMMED before anything reads it. `getProxyForUrl` returns a value
  // containing `://` VERBATIM, so `HTTPS_PROXY=" http://proxy.corp:3128"`
  // arrives with its leading space — and `isSpeakableProxy` is anchored, so
  // untrimmed it reads as unspeakable and goes DIRECT. That configuration
  // WORKED before this change: the WHATWG `URL` parser inside the agent trims
  // leading ASCII whitespace, so the agent was built correctly. Measured both
  // ways; trimming keeps it working AND hands the agent the clean value.
  //
  // One case is NOT a restoration but a genuine change, so it is stated
  // rather than buried: `String.prototype.trim` also strips U+00A0 and
  // U+FEFF, which the URL parser does NOT, so a value carrying one of those
  // (the usual way a proxy URL copied out of a wiki page arrives) goes from
  // THROWING `Invalid URL` to working. Deliberate — the author's intent is
  // unambiguous there — and pinned by a case so a revert is caught in that
  // direction too. An internal SPACE is untouched and still throws, which
  // keeps that typo loud. Deliberately not stated more broadly: measured, the
  // WHATWG parser silently strips an internal TAB / LF / CR from anywhere
  // (`http://proxy\t.internal:3128` parses clean), so "internal whitespace
  // throws" would be false for three of the four characters — pre-existing
  // behaviour this does not change, and named here so the next reader does
  // not infer a guarantee that was never there.
  //
  // And the direction that actually carries risk, stated because the
  // enumeration above would otherwise read as complete: this trim is the ONE
  // change in this seam that moves a request from DIRECT to PROXIED.
  // `HTTPS_PROXY=" http://proxy"` used to reach `proxyAwareFetch`'s
  // not-proxied branch and go straight out; it now tunnels. On the JWKS /
  // OIDC discovery path that matters more than elsewhere — a proxy with no
  // route to an internal IdP turns a read that WAS succeeding into a failure,
  // and `cognito-jwt` fails OPEN for the failure TTL. Intended (the value
  // names a proxy, so honouring it is what the user asked for) and
  // `NO_PROXY` is the remedy, but it is the one effect here that can degrade
  // a working setup rather than repair a broken one.
  const proxyUrl = getProxyForUrl(targetHref).trim();
  if (proxyUrl === '') return '';
  if (isSpeakableProxy(proxyUrl)) return proxyUrl;
  warnUnspeakableProxy(proxyUrl);
  return '';
}

/**
 * An `agent-base` Agent that decides PER REQUEST whether to tunnel through
 * the configured proxy or connect directly. `NodeHttpHandler` picks its agent
 * by protocol alone, and `https-proxy-agent` does not consult `NO_PROXY` —
 * so the `NO_PROXY` decision has to live in `connect()`, where the target
 * host is known.
 *
 * `getProxyForUrl` (proxy-from-env) implements the standard semantics:
 * lowercase spellings win, entries split on commas AND whitespace, an entry
 * is an EXACT hostname match unless it starts with `.` or `*` (then a
 * suffix match), a `:port` on an entry must match the target port, and a
 * bare `*` disables proxying entirely.
 *
 * The inner agents are cached per proxy URL (not rebuilt per `connect()`),
 * and `destroy()` forwards to every one of them. Exported for unit tests;
 * construct through {@link buildProxyClientConfig} everywhere else.
 */
export class EnvRoutingProxyAgent extends Agent {
  private readonly proxyAgents = new Map<
    string,
    HttpProxyAgent<string> | HttpsProxyAgent<string>
  >();
  private readonly directHttpAgent = new HttpAgent(AGENT_OPTS);
  private readonly directHttpsAgent = new HttpsAgent(AGENT_OPTS);

  constructor() {
    super(AGENT_OPTS);
  }

  override connect(_req: ClientRequest, options: AgentConnectOpts): HttpAgent {
    const secure = options.secureEndpoint;
    const host = options.host ?? 'localhost';
    const port = options.port || (secure ? 443 : 80);
    // Port included so a `NO_PROXY=host:port` entry can match;
    // `formatAuthority` brackets an IPv6 literal so the URL parses
    // (issue #599's composition rule).
    const proxyUrl = resolveProxyForTarget(
      `${secure ? 'https' : 'http'}://${formatAuthority(host, port)}`
    );
    if (!proxyUrl) {
      return secure ? this.directHttpsAgent : this.directHttpAgent;
    }
    const key = `${secure ? 'https' : 'http'}|${proxyUrl}`;
    let agent = this.proxyAgents.get(key);
    if (!agent) {
      agent = secure
        ? new HttpsProxyAgent(proxyUrl, AGENT_OPTS)
        : new HttpProxyAgent(proxyUrl, AGENT_OPTS);
      this.proxyAgents.set(key, agent);
    }
    return agent;
  }

  override destroy(): void {
    for (const agent of this.proxyAgents.values()) agent.destroy();
    this.proxyAgents.clear();
    this.directHttpAgent.destroy();
    this.directHttpsAgent.destroy();
    super.destroy();
  }
}

/**
 * The config fragment {@link buildProxyClientConfig} returns. Spread it
 * FIRST in a client constructor's config object so a site that resolves its
 * own explicit `credentials` still wins.
 */
export interface AwsProxyClientConfig {
  requestHandler?: NodeHttpHandler;
  credentials?: AwsCredentialIdentityProvider;
}

/**
 * Build a fresh `NodeHttpHandler` that routes through the proxy environment.
 * Fresh per call on purpose: `NodeHttpHandler.destroy()` destroys its agents
 * unconditionally (external instances included), so a handler — and its
 * agents — must never be shared across clients, or one client's `destroy()`
 * strands its siblings.
 */
function buildProxyRequestHandler(): NodeHttpHandler {
  const agent = new EnvRoutingProxyAgent();
  return new NodeHttpHandler({
    httpAgent: agent,
    // agent-base's Agent extends http.Agent; NodeHttpHandler duck-types the
    // instance at runtime (`typeof httpsAgent?.destroy === 'function'`), so
    // the same routing agent serves both slots.
    httpsAgent: agent as unknown as HttpsAgent,
  });
}

/**
 * AWS SDK client config that honors the standard proxy environment
 * (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`, lowercase spellings included,
 * with `NO_PROXY` exemptions evaluated per request).
 *
 * Returns `{}` when no proxy variable is set, so the unproxied path keeps
 * the SDK's own defaults and the change is a no-op for existing users.
 *
 * When one IS set, the fragment carries:
 *
 * - `requestHandler` — routes the client's own wire calls through the proxy.
 *   The SDK's internal STS hops (`role_arn` profiles, web identity) inherit
 *   it via `parentClientConfig`.
 * - `credentials` — the SDK's default provider chain with the handler ALSO
 *   threaded into `clientConfig`, because the SSO portal / SSOOIDC clients
 *   the chain constructs do NOT inherit the service client's handler (they
 *   coalesce only `logger` / `region` / `userAgentAppId` from it). The
 *   `clientConfig` carries NOTHING but `requestHandler` — a `region` there
 *   would override the SSO portal region. The chain gets its OWN handler
 *   instance so a service client's `destroy()` cannot strand it. IMDS and
 *   ECS container credentials call `node:http` directly and correctly
 *   bypass the proxy (link-local traffic).
 *
 * Sites that resolve their own explicit `credentials` spread this fragment
 * FIRST and their credentials after, so the override wins while the
 * `requestHandler` stays.
 *
 * Host-side use case: a host CLI (e.g. cdkd) constructing its own AWS SDK
 * clients alongside cdk-local's spreads the same fragment so both honor the
 * same proxy environment with the same `NO_PROXY` semantics.
 */
export function buildProxyClientConfig(
  opts: { profile?: string | undefined } = {}
): AwsProxyClientConfig {
  if (!isProxyEnvConfigured()) return {};
  const profile = opts.profile;
  // The PROMISE is memoized, not the resolved provider: two overlapping
  // `credentials()` calls both pass a `if (!chain)` guard before either
  // assigns, so a resolved-value memo builds (and orphans) a second
  // NodeHttpHandler with its agents.
  let chain: Promise<AwsCredentialIdentityProvider> | undefined;
  const credentials: AwsCredentialIdentityProvider = async (identityProperties) => {
    // Lazy so the credential-provider tree loads only when a proxied client
    // actually resolves credentials (keeps the CLI's deferred SDK loading
    // intact for the dynamic-import call sites). The chain's handler is built
    // HERE rather than beside the service client's, so a site that overrides
    // `credentials` — discarding this provider — does not pay for a
    // NodeHttpHandler and its agents it will never use (issue #647).
    chain ??= (async () => {
      const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
      return defaultProvider({
        ...(profile ? { profile } : {}),
        clientConfig: { requestHandler: buildProxyRequestHandler() },
      });
    })().catch((err: unknown) => {
      // Do NOT memoize a rejection: a transient dynamic-import failure would
      // otherwise be replayed for the life of the process, so every later
      // resolution keeps failing with an error that has stopped being true.
      chain = undefined;
      throw err;
    });
    return (await chain)(identityProperties);
  };
  return {
    requestHandler: buildProxyRequestHandler(),
    credentials,
  };
}

/**
 * The fetch spec's redirect budget. Reached only by a redirect loop, which
 * neither call site's endpoint produces — the bound exists so a
 * misconfigured origin cannot spin forever.
 */
const MAX_FETCH_REDIRECTS = 20;

/** Statuses whose response carries a null body per the fetch spec. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Socket-inactivity bound for a proxied request, matching undici's
 * `headersTimeout` / `bodyTimeout` defaults — because `node:http` has NO
 * default timeout at all, and without one a proxy that accepts the
 * connection and never answers hangs `cdkl` forever. That is strictly worse
 * than the pre-#647 direct connection it replaced, and it would hang exactly
 * the fallback (`docs/cli-reference.md`, "JWKS / OIDC discovery
 * unreachable") that exists to keep local dev moving.
 *
 * Undici's separate 10 s CONNECT timeout is not reproduced: a black-holed
 * proxy fails here in 300 s rather than 10. Bounded is the property that
 * matters; the exempt path keeps undici's own timers (see the short-circuit
 * in {@link proxyAwareFetch}). Enforced by a timer `getThroughAgent` re-arms
 * on every byte — INACTIVITY, like undici's, not a wall-clock TOTAL, which
 * would abort a slow-but-progressing transfer that `fetch` would have
 * completed (a Lambda layer ZIP is up to 250 MB, and the whole point is that
 * it is crossing a corporate proxy). See `getThroughAgent` for why a
 * socket-level timer cannot bound the CONNECT tunnel.
 */
const REQUEST_STALL_TIMEOUT_MS = 300_000;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

interface RawHttpResponse {
  status: number;
  statusText: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/**
 * Whether `hostname` names THIS machine. `proxy-from-env` implements the
 * standard `NO_PROXY` semantics faithfully, and the standard exempts nothing
 * by default — so with `HTTP_PROXY` exported and no matching `NO_PROXY`
 * entry, a request to `127.0.0.1` is sent to the corporate proxy, which
 * cannot reach the caller's own loopback and refuses it.
 *
 * For an AWS SDK client that is unreachable in practice (every endpoint is a
 * public AWS host), which is why {@link EnvRoutingProxyAgent} does not carry
 * this rule. For `proxyAwareFetch` it is not: a JWT authorizer's issuer is
 * routinely a loopback IdP in local dev — this repo's own
 * `local-start-api-cognito-jwt` fixture is exactly that shape — and an
 * unreachable JWKS does not fail the request, it degrades the verifier to
 * ACCEPT EVERY TOKEN with a warn. So proxying loopback here converts a
 * working local setup into a silent auth downgrade, and it cannot buy
 * anything in exchange: a forward proxy has no route to the client's
 * loopback. Every other loopback request in cdk-local (the RIE and AgentCore
 * container clients) is unproxied for the same reason.
 *
 * Deliberately NOT extended to RFC 1918 / private ranges: a corporate proxy
 * plausibly does reach those, so exempting them would be a guess rather
 * than an impossibility. `NO_PROXY` remains the control for that case.
 */
export function isLoopbackHost(hostname: string): boolean {
  // `URL.hostname` lowercases the host and strips the port, but it KEEPS an
  // IPv6 literal's brackets and canonicalises the address inside them.
  // Measured on Node 24:
  //
  //   http://[::1]/              -> "[::1]"
  //   http://[0:0:0:0:0:0:0:1]/  -> "[::1]"
  //   http://[::ffff:127.0.0.1]/ -> "[::ffff:7f00:1]"
  //   http://localhost./         -> "localhost."
  //
  // An earlier revision compared against a bare `'::1'` and the expanded
  // form, so BOTH arms were dead code and an IPv6-loopback issuer was
  // PROXIED — precisely the silent accept-all downgrade this exists to
  // prevent. Normalise first, then compare.
  const host = hostname
    .trim()
    .replace(/^\[|\]$/g, '')
    // A single trailing dot is the fully-qualified spelling of the same name.
    .replace(/\.$/, '')
    .toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // The WILDCARD address is a bind address, not a destination: connecting to
  // it reaches this machine, and `http://0.0.0.0:8080/realms/x` is an
  // ordinary local-IdP issuer spelling. `studio-proxy`'s `isWildcardHostname`
  // takes the same position for the same reason (issue #578).
  if (
    host === '0.0.0.0' ||
    host === '::' ||
    host === '0:0:0:0:0:0:0:0' ||
    host === '::ffff:0.0.0.0' ||
    host === '::ffff:0:0'
  ) {
    return true;
  }
  // IPv4-mapped IPv6 in hex form (`::ffff:7f00:1`): the high hextet's top
  // byte is the first IPv4 octet. Arithmetic rather than a `7f…` pattern,
  // which admits a SHORT hextet — `::ffff:7f:1` is 0.127.0.1, not loopback.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) return parseInt(mapped[1]!, 16) >> 8 === 127;
  const dotted = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!dotted) return false;
  const octets = dotted.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

/**
 * `http:` / `https:` only. The rejection names the PROTOCOL and never the
 * URL: the presigned layer `Content.Location` carries an `X-Amz-Signature`
 * in its query string, so a URL in an error message is a credential in a log
 * line (the same reasoning `downloadPresignedZip`'s own HTTP-status throw
 * applies).
 */
function parseHttpUrl(href: string): URL {
  const parsed = new URL(href);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Unsupported protocol for a proxied request: "${parsed.protocol}"`);
  }
  return parsed;
}

/**
 * One GET through `agent`, with the whole body buffered. Buffering is what
 * lets the result become a real `Response` (and is what both call sites do
 * with the body anyway: `text()` for JWKS / discovery, `arrayBuffer()` for
 * the layer ZIP).
 */
function getThroughAgent(
  url: URL,
  agent: HttpAgent,
  timeoutMs = REQUEST_STALL_TIMEOUT_MS
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Re-arms the stall timer; assigned below, once `req` exists.
    let rearm: () => void = () => undefined;
    // One settle, and the timer cleared on every exit: without the guard a
    // late `error` after a delivered body is an unhandled rejection.
    const succeed = (value: RawHttpResponse): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        agent: agent as unknown as HttpsAgent,
        // `node:http` sends neither by itself, so without these a picky
        // origin can answer the proxied branch differently from the direct
        // one. `identity` rather than undici's `gzip, deflate` because there
        // is nothing to gain from transfer compression here — the decoder
        // stays for a body S3 replays with a STORED `Content-Encoding`,
        // which no request header suppresses.
        headers: { accept: '*/*', 'accept-encoding': 'identity' },
      },
      (res) => {
        // Headers arriving is progress, and so is every body chunk.
        rearm();
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          rearm();
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          if (res.statusCode === undefined) {
            fail(new Error('Malformed HTTP response: no status code'));
            return;
          }
          succeed({
            status: res.statusCode,
            statusText: res.statusMessage ?? '',
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', fail);
    // The stall bound armed above, with the rejection raised DIRECTLY — not
    // `req.setTimeout`, and not left for `req.destroy(err)` to surface. Two
    // measured reasons:
    //
    //   - `req.setTimeout` arms only once a socket is ASSIGNED to the
    //     request, and `https-proxy-agent` assigns one only after the CONNECT
    //     tunnel is established. Against a proxy that accepts TCP and never
    //     answers CONNECT, `req.setTimeout(1500)` never fired and the request
    //     was still hanging at 5000 ms.
    //   - with no socket yet assigned, `destroy(err)` stores the error
    //     against a socket that never arrives and no `error` event is emitted
    //     at all, so a destroy-only timer hung past 15 s.
    //
    // That is the PRODUCTION shape (an https JWKS endpoint, an https
    // presigned URL); the plain-http path the tests drive is the one where
    // the socket-level timer does work, which is exactly how it looked
    // correct while leaving the real case unbounded.
    // No URL in the message — see `parseHttpUrl`.
    rearm = () => {
      // A `data` event can be queued behind the settle that the timeout
      // itself triggered; re-arming then leaves a timer nothing clears.
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        req.destroy();
        fail(new Error(`Proxied request stalled for ${timeoutMs} ms with no progress`));
      }, timeoutMs);
      // The 300 s default must not by itself hold a one-shot `cdkl invoke`
      // open.
      timer.unref?.();
    };
    rearm();
    req.end();
  });
}

/**
 * `fetch` decodes a `Content-Encoding` body before handing it to the caller;
 * `node:http` does not. Node sends no `Accept-Encoding` of its own, so a
 * compliant origin answers identity — but S3 replays an object's STORED
 * `Content-Encoding`, so the case is reachable and a silently-still-
 * compressed body would be a corrupt layer ZIP rather than an error.
 *
 * An encoding this cannot decode (or one that fails to decode) leaves the
 * body and the header untouched, so the caller sees exactly what the origin
 * sent instead of a truncated one.
 */
function decodeContentEncoding(raw: RawHttpResponse): { body: Buffer; decoded: boolean } {
  const header = raw.headers['content-encoding'];
  const encoding = (Array.isArray(header) ? header.join(',') : (header ?? '')).trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return { body: raw.body, decoded: false };
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return { body: gunzipSync(raw.body), decoded: true };
    }
    if (encoding === 'deflate' || encoding === 'x-deflate') {
      return { body: inflateSync(raw.body), decoded: true };
    }
    if (encoding === 'br') return { body: brotliDecompressSync(raw.body), decoded: true };
  } catch {
    return { body: raw.body, decoded: false };
  }
  return { body: raw.body, decoded: false };
}

function toWebResponse(raw: RawHttpResponse): Response {
  // `llhttp` accepts any three-digit status; `Response` accepts 200-599 and
  // throws a bare `RangeError` outside it. Same hostile-origin class the
  // `statusText` sanitisation below defends against, and it matters for the
  // same reason: on the JWKS path an exception is not a failed read, it is
  // the pass-through fallback that accepts every token. Refuse it by name.
  if (raw.status < 200 || raw.status > 599) {
    throw new Error(`Unsupported HTTP status in response: ${raw.status}`);
  }
  const { body, decoded } = decodeContentEncoding(raw);
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw.headers)) {
    if (value === undefined) continue;
    // Both describe the WIRE body; after decoding they describe neither the
    // bytes nor the length the caller now holds.
    if (decoded && (name === 'content-encoding' || name === 'content-length')) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else headers.append(name, value);
  }
  return new Response(NULL_BODY_STATUSES.has(raw.status) ? null : body, {
    status: raw.status,
    // The reason phrase is a string the ORIGIN chose and `Response` validates
    // it against the reason-phrase grammar, so a byte outside that set would
    // throw here instead of surfacing the response. Drop those bytes rather
    // than let a hostile origin turn a 404 into an exception.
    statusText: raw.statusText.replace(/[^\t\x20-\x7e\x80-\xff]/g, ''),
    headers,
  });
}

/**
 * GET a URL, honoring the standard proxy environment (issue #647).
 *
 * The global `fetch` (undici) reads no proxy variable, so cdk-local's
 * non-SDK AWS-bound reads — the Lambda layer ZIP download from its
 * presigned `Content.Location`, and the Cognito JWKS / OIDC discovery
 * documents — connected DIRECT even where every SDK call was tunneled. On a
 * machine whose only egress is a forward proxy that is a hang or a
 * self-signed-certificate failure one step after `GetLayerVersion`
 * succeeded.
 *
 * Contract mirrors {@link buildProxyClientConfig}: with no proxy variable
 * set this IS `globalThis.fetch` (zero behavior change), and with one set
 * the request goes through {@link EnvRoutingProxyAgent} — the same
 * `NO_PROXY` decision, evaluated per request against the target host, that
 * the SDK clients get. A target that `NO_PROXY` exempts is ALSO handed back
 * to `globalThis.fetch`, so the hand-rolled path is entered only when it
 * has something to add, and every direct request keeps undici's semantics
 * (its timers included) exactly as before. A fresh agent per proxied
 * request, destroyed the moment that request's body is in hand — see the
 * loop below for why that is a correctness requirement and not only
 * tidiness.
 *
 * `opts.timeoutMs` is a TEST SEAM only — production callers pass one
 * argument and get {@link REQUEST_STALL_TIMEOUT_MS}, which no test can
 * afford to wait out.
 *
 * GET-only by construction: both call sites are GETs, and a method with a
 * request body needs redirect-replay semantics this deliberately does not
 * guess at. A future POST caller extends this (with its tests) rather than
 * falling back to a bare `fetch` —
 * `tests/unit/utils/aws-proxy-fetch-audit.test.ts` refuses the fallback.
 */
export async function proxyAwareFetch(
  url: string,
  opts: { timeoutMs?: number } = {}
): Promise<Response> {
  // proxy-audit: ignore: the unproxied branch is this seam's own no-proxy
  // contract — with no proxy variable set, nothing should change at all.
  if (!isProxyEnvConfigured()) return globalThis.fetch(url);
  let target = parseHttpUrl(url);
  for (let hop = 0; ; hop++) {
    // Re-asked PER HOP, since a redirect can cross the NO_PROXY boundary in
    // either direction. When this target is not proxied there is nothing for
    // the hand-rolled path to add, so hand it back to the platform `fetch`,
    // which keeps its own timers and follows the rest of the chain itself.
    // The same `resolveProxyForTarget` call `EnvRoutingProxyAgent.connect`
    // makes, so the two cannot disagree about what NO_PROXY means, nor about
    // a proxy scheme neither can speak.
    if (isLoopbackHost(target.hostname) || resolveProxyForTarget(target.href) === '') {
      // proxy-audit: ignore: the NOT-proxied branch of this seam; routing it
      // through the agent would be a no-op with worse timeout behavior.
      return globalThis.fetch(target.href);
    }
    // A FRESH agent per hop, destroyed the moment its body is in hand.
    // `http-proxy-agent` rewrites the request line to ABSOLUTE form
    // (`GET http://host/path`) inside `connect()`, and a keep-alive agent
    // skips `connect()` when it REUSES a pooled socket — so a second
    // request on one agent reaches the proxy in origin form (`GET /path`)
    // and is misrouted. Measured on the redirect case; a per-hop agent also
    // means no keep-alive socket outlives a one-shot `cdkl invoke`.
    const agent = new EnvRoutingProxyAgent();
    let raw: RawHttpResponse;
    try {
      raw = await getThroughAgent(target, agent, opts.timeoutMs);
    } finally {
      agent.destroy();
    }
    const location = raw.headers['location'];
    if (!isRedirectStatus(raw.status) || typeof location !== 'string' || location === '') {
      return toWebResponse(raw);
    }
    if (hop >= MAX_FETCH_REDIRECTS) {
      // No URL in the message: see `parseHttpUrl`.
      throw new Error(`Too many redirects (more than ${MAX_FETCH_REDIRECTS})`);
    }
    target = parseHttpUrl(new URL(location, target).href);
  }
}
