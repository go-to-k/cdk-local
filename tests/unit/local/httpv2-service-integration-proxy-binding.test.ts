import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Issue #634 site-level binding for the DYNAMIC-import member form
// (`const mod = await import('@aws-sdk/client-sqs'); new mod.SQSClient(...)`)
// — the shape the static audit is most likely to be fooled by, so the
// binding is locked at runtime too: the constructed client must carry the
// proxy fragment when the environment demands one, and must NOT when it
// does not (the per-process client cache reset between the two).

const { ctorArgs, sendMock } = vi.hoisted(() => ({
  ctorArgs: [] as Array<Record<string, unknown>>,
  sendMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    constructor(cfg: Record<string, unknown>) {
      ctorArgs.push(cfg);
    }
    send = sendMock;
    destroy(): void {}
  },
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { dispatchServiceIntegration, _resetClientCacheForTest } = await import(
  '../../../src/local/httpv2-service-integration.js'
);

describe('dispatchServiceIntegration — proxy environment threading (issue #634)', () => {
  const saved = new Map<string, string | undefined>();
  const KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const;

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    ctorArgs.length = 0;
    sendMock.mockReset();
    sendMock.mockResolvedValue({ MessageId: 'mid-1' });
    _resetClientCacheForTest();
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetClientCacheForTest();
  });

  const PARAMS = {
    QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
    MessageBody: 'hello',
  };

  it('constructs the SQS client with the proxy fragment when HTTPS_PROXY is set', async () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.internal:3128';
    const result = await dispatchServiceIntegration('SQS-SendMessage', PARAMS, 'us-east-1');
    expect(result.statusCode).toBe(200);
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0]!['requestHandler']).toBeDefined();
    expect(typeof ctorArgs[0]!['credentials']).toBe('function');
    expect(ctorArgs[0]!['region']).toBe('us-east-1');
  });

  it('constructs the SQS client WITHOUT proxy fields on a clean environment', async () => {
    const result = await dispatchServiceIntegration('SQS-SendMessage', PARAMS, 'us-east-1');
    expect(result.statusCode).toBe(200);
    expect(ctorArgs).toHaveLength(1);
    expect('requestHandler' in ctorArgs[0]!).toBe(false);
    expect('credentials' in ctorArgs[0]!).toBe(false);
  });
});
