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
    const proxyUrl = getProxyForUrl(
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
  let chain: AwsCredentialIdentityProvider | undefined;
  const credentials: AwsCredentialIdentityProvider = async (identityProperties) => {
    if (!chain) {
      // Lazy so the credential-provider tree loads only when a proxied
      // client actually resolves credentials (keeps the CLI's deferred
      // SDK loading intact for the dynamic-import call sites). The chain's
      // handler is built HERE rather than beside the service client's, so a
      // site that overrides `credentials` (this provider is then discarded)
      // does not pay for a NodeHttpHandler and its agents it will never use
      // — issue #647.
      const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
      chain = defaultProvider({
        ...(profile ? { profile } : {}),
        clientConfig: { requestHandler: buildProxyRequestHandler() },
      });
    }
    return chain(identityProperties);
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
function getThroughAgent(url: URL, agent: HttpAgent): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { agent: agent as unknown as HttpsAgent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode === undefined) {
          reject(new Error('Malformed HTTP response: no status code'));
          return;
        }
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
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
    if (encoding === 'deflate') return { body: inflateSync(raw.body), decoded: true };
    if (encoding === 'br') return { body: brotliDecompressSync(raw.body), decoded: true };
  } catch {
    return { body: raw.body, decoded: false };
  }
  return { body: raw.body, decoded: false };
}

function toWebResponse(raw: RawHttpResponse): Response {
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
 * the SDK clients get. A fresh agent per request, destroyed the moment that
 * request's body is in hand — see the loop below for why that is a
 * correctness requirement and not only tidiness.
 *
 * GET-only by construction: both call sites are GETs, and a method with a
 * request body needs redirect-replay semantics this deliberately does not
 * guess at. A future POST caller extends this (with its tests) rather than
 * falling back to a bare `fetch` —
 * `tests/unit/utils/aws-proxy-fetch-audit.test.ts` refuses the fallback.
 */
export async function proxyAwareFetch(url: string): Promise<Response> {
  // proxy-audit: ignore: the unproxied branch is this seam's own no-proxy
  // contract — with no proxy variable set, nothing should change at all.
  if (!isProxyEnvConfigured()) return globalThis.fetch(url);
  let target = parseHttpUrl(url);
  for (let hop = 0; ; hop++) {
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
      raw = await getThroughAgent(target, agent);
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
