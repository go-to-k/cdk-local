import { readFileSync } from 'node:fs';
import type { ClientRequest } from 'node:http';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { defaultProviderMock, chainMock } = vi.hoisted(() => {
  const chainMock = vi.fn();
  return {
    chainMock,
    defaultProviderMock: vi.fn(() => chainMock),
  };
});

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: defaultProviderMock,
}));

const {
  buildProxyClientConfig,
  isProxyEnvConfigured,
  EnvRoutingProxyAgent,
  resetProxySchemeWarnings,
} = await import('../../../src/utils/aws-proxy.js');
const { getLogger, setLogger } = await import('../../../src/utils/logger.js');

const PROXY_ENV_KEYS = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

/** `connect()` ignores the request object; a bare stub is enough. */
const REQ = {} as ClientRequest;

const httpsOpts = (host: string, port = 443) =>
  ({ secureEndpoint: true, host, port }) as Parameters<EnvRoutingProxyAgent['connect']>[1];
const httpOpts = (host: string, port = 80) =>
  ({ secureEndpoint: false, host, port }) as Parameters<EnvRoutingProxyAgent['connect']>[1];

/**
 * The warn lines `run` emits through the shared logger. `child()` is stubbed
 * to the same spy because `warnUnspeakableProxy` logs through
 * `getLogger().child('aws-proxy')` — spying on the parent alone captures
 * nothing (the idiom `proxy-aware-fetch-bindings.test.ts` established).
 */
function stubLogger(
  previous: object,
  warn: unknown,
  child?: unknown
): Record<string, unknown> {
  // `Object.create(prototype)` first, not a bare `{ ...previous }`: spreading
  // a ConsoleLogger INSTANCE copies only its own fields (`level` /
  // `useColors`) and drops every prototype method, so a future
  // `getLogger().debug(...)` inside the captured window would fail as
  // `debug is not a function` rather than as a clean assertion.
  //
  // ONE spelling, used by every site in this file. The first round of this
  // change wrote the reasoning above and then added a fresh bare spread three
  // cases below it — which is what a helper prevents and a comment does not.
  const stub = Object.assign(
    Object.create(Object.getPrototypeOf(previous) as object) as Record<string, unknown>,
    previous,
    { warn }
  );
  stub['child'] = child ?? (() => stub);
  return stub;
}

function captureWarns(run: () => void): string[] {
  const warn = vi.fn();
  const previous = getLogger();
  setLogger(stubLogger(previous, warn) as never);
  try {
    run();
  } finally {
    setLogger(previous);
  }
  return warn.mock.calls.map((c) => String(c[0]));
}

describe('aws-proxy (issue #634)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    defaultProviderMock.mockClear();
    chainMock.mockReset();
    // Module-level memo: without this reset, a case asserting "warns ONCE"
    // would pass or fail on whether an earlier case in the file warned about
    // the same scheme first.
    resetProxySchemeWarnings();
  });

  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('isProxyEnvConfigured', () => {
    it('is false with a clean environment', () => {
      expect(isProxyEnvConfigured()).toBe(false);
    });

    it.each(['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'])(
      'is true when %s is set',
      (key) => {
        process.env[key] = 'http://proxy.internal:3128';
        expect(isProxyEnvConfigured()).toBe(true);
      }
    );

    it('is false when only NO_PROXY is set (nothing to route to)', () => {
      process.env['NO_PROXY'] = '*';
      expect(isProxyEnvConfigured()).toBe(false);
    });

    it('is false when the variable is set but empty', () => {
      process.env['HTTPS_PROXY'] = '';
      expect(isProxyEnvConfigured()).toBe(false);
    });
  });

  describe('buildProxyClientConfig', () => {
    it('returns an EMPTY config when no proxy variable is set — zero behavior change', () => {
      expect(buildProxyClientConfig()).toEqual({});
      expect(buildProxyClientConfig({ profile: 'dev' })).toEqual({});
    });

    it('returns a requestHandler and a credentials provider when HTTPS_PROXY is set', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const config = buildProxyClientConfig();
      expect(config.requestHandler).toBeInstanceOf(NodeHttpHandler);
      expect(typeof config.credentials).toBe('function');
    });

    it('honors the lowercase https_proxy spelling too', () => {
      process.env['https_proxy'] = 'http://proxy.internal:3128';
      expect(buildProxyClientConfig().requestHandler).toBeInstanceOf(NodeHttpHandler);
    });

    it('builds a FRESH handler per call — NodeHttpHandler.destroy() destroys its agents unconditionally, so sharing one across clients would strand siblings', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const a = buildProxyClientConfig();
      const b = buildProxyClientConfig();
      expect(a.requestHandler).not.toBe(b.requestHandler);
    });

    it('resolves credentials through defaultProvider with the profile and a clientConfig carrying ONLY requestHandler', async () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      chainMock.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 's' });
      const config = buildProxyClientConfig({ profile: 'corp' });
      const creds = await config.credentials!();
      expect(creds).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 's' });
      expect(defaultProviderMock).toHaveBeenCalledTimes(1);
      const init = defaultProviderMock.mock.calls[0]![0] as {
        profile?: string;
        clientConfig?: Record<string, unknown>;
      };
      expect(init.profile).toBe('corp');
      // NOTHING but requestHandler: a `region` here would override the SSO
      // portal region the chain resolves from the profile.
      expect(Object.keys(init.clientConfig ?? {})).toEqual(['requestHandler']);
      expect(init.clientConfig!['requestHandler']).toBeInstanceOf(NodeHttpHandler);
    });

    it('gives the credential chain its OWN handler instance, not the service client one', async () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      chainMock.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 's' });
      const config = buildProxyClientConfig();
      await config.credentials!();
      const init = defaultProviderMock.mock.calls[0]![0] as {
        clientConfig?: { requestHandler?: unknown };
      };
      expect(init.clientConfig!.requestHandler).not.toBe(config.requestHandler);
    });

    it('omits profile from the chain init when none is given', async () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      chainMock.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 's' });
      await buildProxyClientConfig().credentials!();
      const init = defaultProviderMock.mock.calls[0]![0] as Record<string, unknown>;
      expect('profile' in init).toBe(false);
    });

    it('creates the chain once and reuses it across invocations (memoization preserved)', async () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      chainMock.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 's' });
      const config = buildProxyClientConfig();
      await config.credentials!();
      await config.credentials!();
      expect(defaultProviderMock).toHaveBeenCalledTimes(1);
      expect(chainMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('EnvRoutingProxyAgent — per-request NO_PROXY routing', () => {
    it('routes an https target through the HTTPS_PROXY tunnel', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      expect(picked).toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('routes an http target through HttpProxyAgent when HTTP_PROXY is set', () => {
      process.env['HTTP_PROXY'] = 'http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpOpts('example.com'));
      expect(picked).toBeInstanceOf(HttpProxyAgent);
      agent.destroy();
    });

    it('connects DIRECT when no proxy variable applies to the protocol', () => {
      process.env['HTTP_PROXY'] = 'http://proxy.internal:3128'; // http only
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      expect(picked).toBeInstanceOf(HttpsAgent);
      expect(picked).not.toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('NO_PROXY entry is an EXACT hostname match: example.com does NOT exempt api.example.com', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['NO_PROXY'] = 'example.com';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('example.com'))).toBeInstanceOf(HttpsAgent);
      expect(agent.connect(REQ, httpsOpts('example.com'))).not.toBeInstanceOf(HttpsProxyAgent);
      expect(agent.connect(REQ, httpsOpts('api.example.com'))).toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('a leading dot makes the entry a suffix match: .example.com exempts api.example.com', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['NO_PROXY'] = '.example.com';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('api.example.com'))).not.toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('a leading ASTERISK is a suffix match too: *.example.com exempts api.example.com but NOT the apex', () => {
      // The doc comment on `EnvRoutingProxyAgent` promises `.`-OR-`*`; only
      // the dot form was covered (issue go-to-k/cdk-local#648). The asterisk
      // is STRIPPED and the remainder is an `endsWith` test, so `example.com`
      // — which does not end in `.example.com` — is still proxied. That
      // asymmetry is the part worth pinning: a user writing `*.example.com`
      // to mean "the whole domain" does not get the apex.
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['NO_PROXY'] = '*.example.com';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('api.example.com'))).not.toBeInstanceOf(HttpsProxyAgent);
      expect(agent.connect(REQ, httpsOpts('example.com'))).toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('honors the lowercase no_proxy spelling', () => {
      // The uppercase spelling was covered; the lowercase one — which
      // `getProxyForUrl` prefers when both are set — was not
      // (issue go-to-k/cdk-local#648). The second assertion is the
      // guard-the-guard: it must exempt THE ENTRY, not proxying at large.
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['no_proxy'] = 'example.com';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('example.com'))).not.toBeInstanceOf(HttpsProxyAgent);
      expect(agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toBeInstanceOf(
        HttpsProxyAgent
      );
      agent.destroy();
    });

    it('routes an IPv6 target through the proxy — the authority it builds is BRACKETED, and a bare `host:port` does not parse', () => {
      // `connect()` receives the host BARE (`2001:db8::1`), so composing the
      // probe URL as `${host}:${port}` yields `https://2001:db8::1:443`,
      // which `getProxyForUrl` cannot parse and answers `''` for — i.e. a
      // DIRECT connection, silently unproxied, for every IPv6 endpoint.
      // `formatAuthority` is what prevents that (issue
      // go-to-k/cdk-local#599's composition rule).
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('2001:db8::1'))).toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('a NO_PROXY entry exempts an IPv6 target in its BRACKETED spelling', () => {
      // `getProxyForUrl` compares against `URL.host` MINUS the port, and that
      // keeps an IPv6 literal's brackets — so `NO_PROXY=2001:db8::1` does
      // NOT exempt this target and `NO_PROXY=[2001:db8::1]` does. Surprising
      // enough to pin. The second assertion keeps the case honest: with the
      // bracketing removed both hosts go direct, which would satisfy the
      // first assertion for the wrong reason.
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['NO_PROXY'] = '[2001:db8::1]';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('2001:db8::1'))).not.toBeInstanceOf(HttpsProxyAgent);
      expect(agent.connect(REQ, httpsOpts('2001:db8::2'))).toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('a NO_PROXY :port entry applies only to that port', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['NO_PROXY'] = 'example.com:8443';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('example.com', 8443))).not.toBeInstanceOf(
        HttpsProxyAgent
      );
      expect(agent.connect(REQ, httpsOpts('example.com', 443))).toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('a bare * disables proxying entirely', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['NO_PROXY'] = '*';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).not.toBeInstanceOf(
        HttpsProxyAgent
      );
      agent.destroy();
    });

    it('the lowercase spelling wins over the uppercase one', () => {
      process.env['https_proxy'] = 'http://lower.internal:1080';
      process.env['HTTPS_PROXY'] = 'http://upper.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      expect(picked).toBeInstanceOf(HttpsProxyAgent);
      expect((picked as HttpsProxyAgent<string>).proxy.href).toBe('http://lower.internal:1080/');
      agent.destroy();
    });

    it('caches the inner proxy agent per proxy URL instead of rebuilding per connect()', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const first = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      const second = agent.connect(REQ, httpsOpts('s3.us-east-1.amazonaws.com'));
      expect(second).toBe(first);
      agent.destroy();
    });

    it('sets keepAlive + maxSockets explicitly — the SDK applies its defaults only to plain option bags, never to external Agent instances', () => {
      // NO_PROXY is set BEFORE the exempt host is connected. An earlier
      // revision connected it first and named the result `direct`, so it was
      // in fact the cached HttpsProxyAgent (issue go-to-k/cdk-local#648).
      // That cost no COVERAGE — a third connect, after NO_PROXY was set, put
      // a genuinely direct agent in the same loop — so what was wrong was the
      // name, and a name that lies about which agent is under assertion is
      // what makes the next edit here unsafe. The two instanceof lines below
      // are the guard-the-guard that keeps the pair distinct without relying
      // on the reader trusting the variable names.
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['NO_PROXY'] = 'proxy-exempt.internal';
      const agent = new EnvRoutingProxyAgent();
      const proxied = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com')) as HttpAgent;
      const direct = agent.connect(REQ, httpsOpts('proxy-exempt.internal')) as HttpAgent;
      expect(proxied).toBeInstanceOf(HttpsProxyAgent);
      expect(direct).not.toBeInstanceOf(HttpsProxyAgent);
      for (const a of [proxied, direct]) {
        // Instance properties, not `.options`: HttpsProxyAgent overwrites
        // `this.options` after `super(opts)`, but `keepAlive` / `maxSockets`
        // are captured onto the instance by the base constructors first.
        expect(a.keepAlive).toBe(true);
        expect(a.maxSockets).toBe(50);
      }
      agent.destroy();
    });

    it('destroy() forwards to the cached proxy agents and the direct agents', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const proxied = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      const destroySpy = vi.spyOn(proxied as HttpAgent, 'destroy');
      agent.destroy();
      expect(destroySpy).toHaveBeenCalled();
    });
  });

  /**
   * How the value of the proxy variable itself is read (issue
   * go-to-k/cdk-local#648). Both shapes below are ordinary things a user
   * types, and neither had a test: the first is silently reinterpreted, the
   * second fails at a point far from where it was configured.
   */
  describe('EnvRoutingProxyAgent — proxy URL spellings', () => {
    it('a SCHEME-LESS value takes the REQUEST scheme: `HTTPS_PROXY=proxy.internal:3128` means TLS to the PROXY', () => {
      // The common spelling, and it does not mean what it looks like.
      // `proxy-from-env` prepends the scheme of the URL BEING REQUESTED, not
      // `http:` — so an https target makes the connection TO THE PROXY itself
      // TLS, which a plain HTTP forward proxy will not answer. Both spellings
      // still tunnel with CONNECT; `HTTPS_PROXY=http://proxy.internal:3128`
      // is the one that reaches the proxy over plain HTTP first.
      process.env['HTTPS_PROXY'] = 'proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      expect(picked).toBeInstanceOf(HttpsProxyAgent);
      expect((picked as HttpsProxyAgent<string>).proxy.href).toBe('https://proxy.internal:3128/');
      agent.destroy();
    });

    it('the same scheme-less value stays plain HTTP for an http target', () => {
      process.env['HTTP_PROXY'] = 'proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpOpts('example.com'));
      expect(picked).toBeInstanceOf(HttpProxyAgent);
      expect((picked as HttpProxyAgent<string>).proxy.href).toBe('http://proxy.internal:3128/');
      agent.destroy();
    });

    it('an UNPARSABLE value throws at connect time rather than silently connecting DIRECT', () => {
      // The failure direction matters more than the exception type. A
      // machine with a proxy configured has no direct egress — falling back
      // to a direct connection would turn a typo in the variable into a hang
      // or a self-signed-certificate error at some unrelated AWS call, with
      // nothing pointing back at the proxy variable. Throwing keeps the
      // cause attached to the request.
      process.env['HTTPS_PROXY'] = 'http://[';
      const agent = new EnvRoutingProxyAgent();
      expect(() => agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toThrow(TypeError);
      agent.destroy();
    });

    it('an unparsable value on the http side throws the same way', () => {
      process.env['HTTP_PROXY'] = '%%%';
      const agent = new EnvRoutingProxyAgent();
      expect(() => agent.connect(REQ, httpOpts('example.com'))).toThrow(TypeError);
      agent.destroy();
    });

    it('a NO_PROXY-exempt target is unaffected by an unparsable proxy value — the URL is never built', () => {
      // Guard-the-guard for the pair above: they must fail on the PROXY
      // value, not on merely having a proxy variable set.
      process.env['HTTPS_PROXY'] = 'http://[';
      process.env['NO_PROXY'] = 'exempt.internal';
      const agent = new EnvRoutingProxyAgent();
      expect(agent.connect(REQ, httpsOpts('exempt.internal'))).not.toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });
  });

  /**
   * Issue go-to-k/cdk-local#663 — a proxy whose SCHEME these agents cannot
   * speak.
   *
   * `getProxyForUrl` honours `ALL_PROXY`, and `ALL_PROXY=socks5://...` is an
   * ordinary spelling (an `ssh -D` tunnel, a corporate SOCKS gateway). Before
   * this, `connect()` handed that URL straight to `HttpsProxyAgent`, which
   * constructs happily — measured, `proxy.protocol === 'socks5:'` — and then
   * talks HTTP at a SOCKS port, so every AWS call failed. PR 656 had already
   * taught the fetch half to fall back; this half kept building the agent.
   *
   * The choice between REFUSING loudly and falling back to DIRECT is settled
   * in `resolveProxyForTarget`'s comment; the cases below pin the fallback
   * AND the warn that keeps it from being silent, since "a fallback is
   * silent" was the only argument for refusing.
   */
  describe('EnvRoutingProxyAgent — an unspeakable proxy scheme (issue go-to-k/cdk-local#663)', () => {
    it('falls back to a DIRECT agent for an https target when ALL_PROXY is SOCKS', () => {
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      expect(picked).toBeInstanceOf(HttpsAgent);
      expect(picked).not.toBeInstanceOf(HttpsProxyAgent);
      agent.destroy();
    });

    it('falls back on the http side too', () => {
      // `HttpProxyAgent` also extends `http.Agent`, so `toBeInstanceOf(HttpAgent)`
      // cannot discriminate here — the negative assertion is the whole test.
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      const agent = new EnvRoutingProxyAgent();
      const picked = agent.connect(REQ, httpOpts('example.com'));
      expect(picked).toBeInstanceOf(HttpAgent);
      expect(picked).not.toBeInstanceOf(HttpProxyAgent);
      agent.destroy();
    });

    it('warns, naming the SCHEME and withholding the URL — a proxy URL carries credentials', () => {
      process.env['ALL_PROXY'] = 'socks5://corp-user:s3cr3t@socks.internal:1080';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('socks5');
      // The withholding is the point: this line is default-level, and studio
      // mirrors a serve child's output into the log panel it serves over HTTP.
      expect(lines[0]).not.toContain('s3cr3t');
      expect(lines[0]).not.toContain('corp-user');
      expect(lines[0]).not.toContain('socks.internal');
    });

    it('warns ONCE per scheme, not once per request — connect() runs per AWS call', () => {
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
        agent.connect(REQ, httpsOpts('s3.us-east-1.amazonaws.com'));
        agent.connect(REQ, httpOpts('example.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
    });

    it('a DIFFERENT unspeakable scheme warns again — the memo is per SCHEME, not "warned at all"', () => {
      // Guard-the-guard for the case above: a memo keyed on "has warned"
      // would swallow this second, differently-caused line.
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
        process.env['ALL_PROXY'] = 'socks4://127.0.0.1:1080';
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('socks5');
      expect(lines[1]).toContain('socks4');
    });

    it('an http:// proxy is still PROXIED and warns nothing — the fallback is about the SCHEME', () => {
      // Guard-the-guard: without this, deleting `isSpeakableProxy` entirely
      // (so nothing is ever unspeakable) is invisible to the cases above only
      // in one direction, and deleting the SPEAKABLE branch is invisible in
      // the other.
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        expect(agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toBeInstanceOf(
          HttpsProxyAgent
        );
      });
      agent.destroy();
      expect(lines).toEqual([]);
    });

    it('is decided PER REQUEST: a speakable HTTPS_PROXY still tunnels while ALL_PROXY stays SOCKS', () => {
      // The case a boot-time refusal would break. `getProxyForUrl` prefers
      // the protocol-specific variable, so an https target tunnels through
      // the HTTP proxy while an http target — for which only ALL_PROXY
      // applies — falls back.
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        expect(agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toBeInstanceOf(
          HttpsProxyAgent
        );
        expect(agent.connect(REQ, httpOpts('example.com'))).not.toBeInstanceOf(HttpProxyAgent);
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
    });

    it('a NO_PROXY-exempt target under a SOCKS proxy goes direct WITHOUT a warn', () => {
      // Nothing is being ignored for this target — it was never going to be
      // proxied — so a line here would be noise on a correct configuration.
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      process.env['NO_PROXY'] = 'exempt.internal';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        expect(agent.connect(REQ, httpsOpts('exempt.internal'))).not.toBeInstanceOf(
          HttpsProxyAgent
        );
      });
      agent.destroy();
      expect(lines).toEqual([]);
    });

    it('a value whose "://" is not at the start has no scheme to name', () => {
      // `getProxyForUrl` prepends the request scheme only when the value
      // contains no `://` at all, so this one is returned verbatim and has no
      // leading scheme. Pathological, but it is the branch `proxySchemeOf`
      // falls through to — without a case it is unreachable-looking code.
      process.env['ALL_PROXY'] = '/typo://proxy.internal:1080';
      const agent = new EnvRoutingProxyAgent();
      let picked: unknown;
      const lines = captureWarns(() => {
        picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(picked).not.toBeInstanceOf(HttpsProxyAgent);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('(unrecognized)');
    });

    it('names the scheme in LOWERCASE, so the memo cannot warn twice for one proxy', () => {
      // `SOCKS5://` is what a user who typed the scheme in caps gets, and
      // `getProxyForUrl` returns a value containing "://" verbatim — case and
      // all. Without the lowercasing the memo keys on `SOCKS5` and `socks5`
      // separately, so switching spelling re-warns for the same proxy.
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        process.env['ALL_PROXY'] = 'SOCKS5://127.0.0.1:1080';
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
        process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
        agent.connect(REQ, httpsOpts('s3.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"socks5"');
    });

    it('an UPPERCASE http scheme is still speakable — the predicate is case-insensitive', () => {
      // `HTTP://proxy.internal:3128` contains "://" so `getProxyForUrl` hands
      // it back unchanged. Dropping the `i` flag on `isSpeakableProxy` turns a
      // WORKING proxy into a warned direct connection, which no other case
      // would notice.
      process.env['HTTPS_PROXY'] = 'HTTP://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        expect(agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toBeInstanceOf(
          HttpsProxyAgent
        );
      });
      agent.destroy();
      expect(lines).toEqual([]);
    });

    it('a value with credentials BEFORE the scheme names no username — the scheme match requires "://"', () => {
      // The round-2 review blocker. `getProxyForUrl` returns any value
      // containing "://" verbatim, so this arrives whole; a bare `token:`
      // match would name `corp-user`, i.e. the proxy USERNAME, on a
      // default-level line studio serves over HTTP.
      process.env['HTTPS_PROXY'] = 'corp-user:s3cr3t@http://proxy.corp:3128';
      const agent = new EnvRoutingProxyAgent();
      let picked: unknown;
      const lines = captureWarns(() => {
        picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(picked).not.toBeInstanceOf(HttpsProxyAgent);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('(unrecognized)');
      expect(lines[0]).not.toContain('corp-user');
      expect(lines[0]).not.toContain('s3cr3t');
      expect(lines[0]).not.toContain('proxy.corp');
    });

    it('an absurdly long scheme run is not printed — the warn line stays bounded', () => {
      // Without the length bound the scheme is an unbounded run out of an
      // environment variable, so the whole value lands on a default-level
      // line. Over the bound it falls to the constant instead.
      const long = 'a'.repeat(64);
      process.env['ALL_PROXY'] = `${long}://proxy.internal:1080`;
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('(unrecognized)');
      expect(lines[0]).not.toContain(long);
    });

    it('a LEADING SPACE in the proxy value still tunnels — it did before this guard existed', () => {
      // `getProxyForUrl` returns a value containing "://" verbatim, space and
      // all, and `isSpeakableProxy` is anchored. Untrimmed, this reads as
      // unspeakable and silently goes direct — but the WHATWG URL parser
      // inside the agent trims, so this configuration WORKED before the
      // scheme guard was added. A regression fence, not a new feature.
      process.env['HTTPS_PROXY'] = ' http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        const picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
        expect(picked).toBeInstanceOf(HttpsProxyAgent);
        expect((picked as HttpsProxyAgent<string>).proxy.href).toBe(
          'http://proxy.internal:3128/'
        );
      });
      agent.destroy();
      expect(lines).toEqual([]);
    });

    it('the memo is shared across AGENT INSTANCES — one line per process, not per SDK client', () => {
      // `buildProxyRequestHandler` builds a fresh agent per client (and
      // `proxyAwareFetch` one per redirect hop), so a per-instance memo would
      // warn once per client. This is what makes the module-level memo the
      // right scope rather than merely a convenient one.
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      const first = new EnvRoutingProxyAgent();
      const second = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        first.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
        second.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      first.destroy();
      second.destroy();
      expect(lines).toHaveLength(1);
    });

    it('logs through the "aws-proxy" child prefix', () => {
      // `captureWarns` routes parent and child to the SAME spy, which cannot
      // tell whether `.child('aws-proxy')` is called at all — so this case
      // stubs `child` itself.
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      const warn = vi.fn();
      const previous = getLogger();
      const child = vi.fn(() => stubLogger(previous, warn));
      const agent = new EnvRoutingProxyAgent();
      setLogger(stubLogger(previous, warn, child) as never);
      try {
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      } finally {
        setLogger(previous);
        agent.destroy();
      }
      expect(child).toHaveBeenCalledWith('aws-proxy');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('buildProxyClientConfig still returns a NON-empty fragment under a SOCKS-only environment', () => {
      // Deliberate and worth pinning: `isProxyEnvConfigured` asks whether a
      // variable is SET, not whether it is usable, so the fragment is built
      // and every request through it then routes direct. Narrowing that
      // predicate instead would change which credential chain resolves,
      // which is a bigger behaviour change than this issue asked for.
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      expect(isProxyEnvConfigured()).toBe(true);
      const config = buildProxyClientConfig();
      expect(config.requestHandler).toBeDefined();
      expect(typeof config.credentials).toBe('function');
    });

    it.each([
      ['at the 32-character bound, the scheme is still named', 32, true],
      ['one character past it, it is not', 33, false],
    ])('%s', (_label, length, named) => {
      // The BOUNDARY, not just a wildly-over-length value: with only a 64-char
      // case, a `{0,30}` or `{0,32}` mutant stays green.
      const scheme = `a${'b'.repeat(length - 1)}`;
      expect(scheme).toHaveLength(length);
      process.env['ALL_PROXY'] = `${scheme}://proxy.internal:1080`;
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(named ? `"${scheme}"` : '(unrecognized)');
    });

    it('trims the UNSPEAKABLE path too, so the scheme is named rather than "(unrecognized)"', () => {
      // The trim runs before BOTH branches. Untrimmed, ` socks5://...` fails
      // the anchored scheme match and the warn degrades to `(unrecognized)`,
      // which is a worse message for a configuration cdk-local understands
      // perfectly well. Only the speakable side of the trim had a case.
      process.env['ALL_PROXY'] = ' socks5://127.0.0.1:1080';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"socks5"');
      expect(lines[0]).not.toContain('(unrecognized)');
    });

    it('a leading NON-BREAKING SPACE now works where it used to throw', () => {
      // Not a restoration but a genuine behaviour change, so it is pinned in
      // the throw -> works direction as well. The WHATWG URL parser strips
      // ASCII whitespace only; `String.prototype.trim` also strips U+00A0 and
      // U+FEFF, which is how a proxy URL copied out of a wiki page arrives.
      // Spelled as ESCAPES, never literal bytes: an invisible character in
      // source is unreadable in a diff and unsearchable by grep, and the
      // premise of this case IS which code points it carries.
      const value = '\u00A0http://proxy.internal:3128\uFEFF';
      expect(value.codePointAt(0)).toBe(0x00a0);
      expect(value.codePointAt(value.length - 1)).toBe(0xfeff);
      // The PREMISE, asserted rather than assumed: this value must be one the
      // URL parser rejects, or the case silently degrades into a duplicate of
      // the plain-ASCII-space case above and stops witnessing a throw -> works
      // transition at all.
      expect(() => new URL(value)).toThrow(TypeError);
      process.env['HTTPS_PROXY'] = value;
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        const picked = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
        expect(picked).toBeInstanceOf(HttpsProxyAgent);
        expect((picked as HttpsProxyAgent<string>).proxy.href).toBe(
          'http://proxy.internal:3128/'
        );
      });
      agent.destroy();
      expect(lines).toEqual([]);
    });

    it('INTERNAL whitespace still throws — a real typo stays loud', () => {
      // Guard-the-guard for the two trim cases above: the trim must not be
      // read as "whitespace is tolerated". This value is speakable by scheme,
      // so it reaches the agent constructor and fails there, as before.
      process.env['HTTPS_PROXY'] = 'http://proxy .internal:3128';
      const agent = new EnvRoutingProxyAgent();
      expect(() => agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toThrow(TypeError);
      agent.destroy();
    });

    it('a value whose scheme merely LOOKS like a username is named as the scheme', () => {
      // The stated bound of the `://` requirement, pinned so a reader finds a
      // decision rather than an oversight. `alice://s3cr3t@proxy:3128` is a
      // syntactically valid URL whose scheme IS `alice`; nothing here can know
      // the author meant it as a username, and it is not a working proxy
      // configuration either way. The BLOCKER shape — credentials followed by
      // a real `scheme://` — is the case above, and still yields
      // `(unrecognized)`.
      //
      // This case is a DECISION RECORD, not a fence: dropping the `://`
      // requirement leaves it green, because `alice` matches a bare `token:`
      // reading too. The case above is what fences that regression.
      process.env['HTTPS_PROXY'] = 'alice://s3cr3t@proxy.corp:3128';
      const agent = new EnvRoutingProxyAgent();
      const lines = captureWarns(() => {
        agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'));
      });
      agent.destroy();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"alice"');
      expect(lines[0]).not.toContain('s3cr3t');
    });

    it('does not memoise the scheme when the warn itself THROWS', () => {
      // The memo is written AFTER the emit, and nothing pinned that ordering
      // until the parent review asked for it. Under the reverse order a
      // logger that throws — a host CLI's injected one, a closed stream —
      // records the scheme as warned and never prints it, so the one-time
      // warn becomes a ZERO-time warn for the life of the process. That line
      // is the entire argument for choosing fallback over refusal.
      //
      // The discriminator is the SECOND attempt: with the memo written first
      // it is a silent no-op and `warn` is called once.
      process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
      const warn = vi.fn((): void => {
        throw new Error('logger down');
      });
      const previous = getLogger();
      const agent = new EnvRoutingProxyAgent();
      setLogger(stubLogger(previous, warn) as never);
      try {
        expect(() => agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toThrow(
          'logger down'
        );
        expect(() => agent.connect(REQ, httpsOpts('s3.us-east-1.amazonaws.com'))).toThrow(
          'logger down'
        );
      } finally {
        setLogger(previous);
        agent.destroy();
      }
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('an UNPARSABLE value still THROWS — a typo has no working setup behind it', () => {
      // The deliberate asymmetry, asserted next to the fallback so a future
      // reader does not "unify" the two. `http://[` IS speakable by scheme,
      // so it reaches the agent constructor exactly as before.
      process.env['HTTPS_PROXY'] = 'http://[';
      const agent = new EnvRoutingProxyAgent();
      expect(() => agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com'))).toThrow(TypeError);
      agent.destroy();
    });
  });

  /**
   * The SDK half and the fetch half answering the same question differently
   * IS issue go-to-k/cdk-local#663. `resolveProxyForTarget` is the site that
   * owns it, so a second `getProxyForUrl` call anywhere in the module would
   * be a second spelling — the shape that regenerates this defect.
   */
  describe('one site owns the routing decision', () => {
    it('src/utils/aws-proxy.ts calls getProxyForUrl exactly once, inside resolveProxyForTarget', () => {
      const source = readFileSync(new URL('../../../src/utils/aws-proxy.ts', import.meta.url), {
        encoding: 'utf-8',
      });
      // COMMENT LINES ARE EXCLUDED, so the prose in that module can spell the
      // call however reads best. Counting raw occurrences made the paren-less
      // spelling load-bearing and unstated: a future JSDoc writing
      // `getProxyForUrl(url)` would red this fence with no behaviour change at
      // all, which is a false alarm the next author has no way to anticipate.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(code.match(/getProxyForUrl\(/g) ?? []).toHaveLength(1);
      const body = /function resolveProxyForTarget\([^)]*\): string \{([\s\S]*?)\n\}/.exec(code);
      expect(body).not.toBeNull();
      expect(body![1]).toContain('getProxyForUrl(');

      // `resetProxySchemeWarnings` is a TEST SEAM, and the module's own JSDoc
      // says it is deliberately not part of the host-facing surface. Nothing
      // enforced that, unlike the neighbouring client / call-site audits, so
      // the claim could quietly stop being true.
      const internal = readFileSync(new URL('../../../src/internal.ts', import.meta.url), {
        encoding: 'utf-8',
      });
      expect(internal).not.toContain('resetProxySchemeWarnings');
    });
  });
});
