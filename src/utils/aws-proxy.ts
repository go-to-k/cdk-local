import type { ClientRequest } from 'node:http';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
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
  const chainHandler = buildProxyRequestHandler();
  let chain: AwsCredentialIdentityProvider | undefined;
  const credentials: AwsCredentialIdentityProvider = async (identityProperties) => {
    if (!chain) {
      // Lazy so the credential-provider tree loads only when a proxied
      // client actually resolves credentials (keeps the CLI's deferred
      // SDK loading intact for the dynamic-import call sites).
      const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
      chain = defaultProvider({
        ...(profile ? { profile } : {}),
        clientConfig: { requestHandler: chainHandler },
      });
    }
    return chain(identityProperties);
  };
  return {
    requestHandler: buildProxyRequestHandler(),
    credentials,
  };
}
