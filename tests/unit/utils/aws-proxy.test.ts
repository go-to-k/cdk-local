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

const { buildProxyClientConfig, isProxyEnvConfigured, EnvRoutingProxyAgent } = await import(
  '../../../src/utils/aws-proxy.js'
);

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

describe('aws-proxy (issue #634)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    defaultProviderMock.mockClear();
    chainMock.mockReset();
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
      process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
      const agent = new EnvRoutingProxyAgent();
      const proxied = agent.connect(REQ, httpsOpts('sts.us-east-1.amazonaws.com')) as HttpAgent;
      const direct = agent.connect(REQ, httpsOpts('proxy-exempt.internal')) as HttpAgent;
      process.env['NO_PROXY'] = 'proxy-exempt.internal';
      const directPicked = agent.connect(REQ, httpsOpts('proxy-exempt.internal')) as HttpAgent;
      for (const a of [proxied, direct, directPicked]) {
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
});
