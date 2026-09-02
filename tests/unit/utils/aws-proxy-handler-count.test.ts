import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue go-to-k/cdk-local#647 — how MANY `NodeHttpHandler`s
 * `buildProxyClientConfig` builds, and when.
 *
 * The sibling suite (`aws-proxy.test.ts`) asserts the handler IDENTITIES —
 * that the credential chain's is not the service client's. That leaves the
 * counting question open, and the counting question is the whole point of
 * PR 646's review nit: `chainHandler` used to be built EAGERLY on every
 * `buildProxyClientConfig()` call, including at the many sites that override
 * `credentials` and never invoke the returned provider, each of which then
 * paid for a handler plus its agents and orphaned them.
 *
 * Measured against the sibling suite before this file existed: hoisting the
 * construction back out of the lazy closure left it entirely GREEN, and so
 * did rebuilding the handler on every credential resolution. Both are
 * counting mutations, and identity assertions cannot see either.
 *
 * `@smithy/node-http-handler` is mocked with a counting stub for that reason
 * — the count is the assertion, so it has to be observable.
 */

const { handlerCtor } = vi.hoisted(() => ({ handlerCtor: vi.fn() }));

vi.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: class {
    constructor(...args: unknown[]) {
      handlerCtor(...args);
    }
  },
}));

const { defaultProviderMock, chainMock } = vi.hoisted(() => {
  const chainMock = vi.fn();
  return { chainMock, defaultProviderMock: vi.fn(() => chainMock) };
});

vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: defaultProviderMock }));

const { buildProxyClientConfig } = await import('../../../src/utils/aws-proxy.js');

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

describe('buildProxyClientConfig handler count (issue #647)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    handlerCtor.mockClear();
    defaultProviderMock.mockClear();
    chainMock.mockReset();
    chainMock.mockResolvedValue({ accessKeyId: 'AKIA', secretAccessKey: 's' });
  });

  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds NO handler at all when no proxy variable is set', () => {
    expect(buildProxyClientConfig()).toEqual({});
    expect(handlerCtor).toHaveBeenCalledTimes(0);
  });

  it('builds exactly ONE handler for a config whose credentials are never resolved', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    buildProxyClientConfig();
    // The service client's, and only that: a site spreading this fragment and
    // then supplying its own `credentials` discards the provider below, so
    // building the chain's handler here would be pure waste. Hoisting the
    // construction back out of the lazy closure makes this 2.
    expect(handlerCtor).toHaveBeenCalledTimes(1);
  });

  it('builds the SECOND handler only when the credential chain is first resolved, and never a third', async () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    const config = buildProxyClientConfig();
    expect(handlerCtor).toHaveBeenCalledTimes(1);

    await config.credentials!();
    expect(handlerCtor).toHaveBeenCalledTimes(2);

    await config.credentials!();
    await config.credentials!();
    // Rebuilding per resolution — moving the construction out of the memo but
    // leaving it inside the provider — makes this 4.
    expect(handlerCtor).toHaveBeenCalledTimes(2);
    expect(defaultProviderMock).toHaveBeenCalledTimes(1);
  });

  it('builds ONE chain handler under CONCURRENT first resolutions', async () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    const config = buildProxyClientConfig();

    // Both calls reach the lazy branch before either assigns. Memoising the
    // resolved provider instead of the PROMISE lets both through, building
    // and orphaning a second handler with its agents.
    await Promise.all([config.credentials!(), config.credentials!()]);

    expect(handlerCtor).toHaveBeenCalledTimes(2);
    expect(defaultProviderMock).toHaveBeenCalledTimes(1);
  });
});
