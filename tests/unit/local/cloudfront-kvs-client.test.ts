import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { sendMock, clientCtorMock, cfClientCtorMock, paginatePagesRef } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  clientCtorMock: vi.fn(),
  cfClientCtorMock: vi.fn(),
  // A mutable holder the paginator mock reads its pages from, set per test.
  paginatePagesRef: { pages: [] as unknown[] },
}));

class FakeResourceNotFound extends Error {
  override readonly name = 'ResourceNotFoundException';
}

vi.mock('@aws-sdk/client-cloudfront-keyvaluestore', () => ({
  CloudFrontKeyValueStoreClient: class {
    constructor(config: unknown) {
      clientCtorMock(config);
    }
    send = sendMock;
  },
  GetKeyCommand: class {
    constructor(public readonly input: unknown) {}
  },
  ResourceNotFoundException: FakeResourceNotFound,
}));

vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    constructor(config: unknown) {
      cfClientCtorMock(config);
    }
  },
  paginateListKeyValueStores: async function* () {
    for (const page of paginatePagesRef.pages) yield page;
  },
}));

const { createDeployedKvsDataSource, resolveDeployedKvsArnByName } = await import(
  '../../../src/local/cloudfront-kvs-client.js'
);

const ARN = 'arn:aws:cloudfront::111122223333:key-value-store/abcd-1234';

describe('createDeployedKvsDataSource', () => {
  beforeEach(() => {
    sendMock.mockReset();
    clientCtorMock.mockReset();
  });

  it('returns the GetKey Value for a present key', async () => {
    sendMock.mockResolvedValueOnce({ Value: 'hello', Key: 'k' });
    const src = createDeployedKvsDataSource({ kvsArn: ARN, kvsId: 'abcd-1234' });
    expect(await src.getValue('k')).toBe('hello');
    expect(src.kvsId).toBe('abcd-1234');
    // The GetKeyCommand was built with the ARN + key.
    expect((sendMock.mock.calls[0]![0] as { input: unknown }).input).toEqual({
      KvsARN: ARN,
      Key: 'k',
    });
  });

  it('maps a ResourceNotFoundException to undefined (missing key)', async () => {
    sendMock.mockRejectedValueOnce(new FakeResourceNotFound('nope'));
    const src = createDeployedKvsDataSource({ kvsArn: ARN });
    expect(await src.getValue('missing')).toBeUndefined();
  });

  it('maps a 404 $metadata to undefined', async () => {
    sendMock.mockRejectedValueOnce({ name: 'Other', $metadata: { httpStatusCode: 404 } });
    const src = createDeployedKvsDataSource({ kvsArn: ARN });
    expect(await src.getValue('missing')).toBeUndefined();
  });

  it('rethrows a real failure (access denied) with context', async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
    );
    const src = createDeployedKvsDataSource({ kvsArn: ARN });
    await expect(src.getValue('k')).rejects.toThrow(/failed: not authorized/);
  });

  it('defaults the client region to us-east-1', async () => {
    sendMock.mockResolvedValueOnce({ Value: 'v' });
    const src = createDeployedKvsDataSource({ kvsArn: ARN });
    await src.getValue('k');
    expect((clientCtorMock.mock.calls[0]![0] as { region: string }).region).toBe('us-east-1');
  });

  it('honors an explicit region + credentials', async () => {
    sendMock.mockResolvedValueOnce({ Value: 'v' });
    const creds = { accessKeyId: 'AK', secretAccessKey: 'SK' };
    const src = createDeployedKvsDataSource({ kvsArn: ARN, region: 'eu-west-1', credentials: creds });
    await src.getValue('k');
    const config = clientCtorMock.mock.calls[0]![0] as { region: string; credentials: unknown };
    expect(config.region).toBe('eu-west-1');
    expect(config.credentials).toEqual(creds);
  });
});

describe('resolveDeployedKvsArnByName', () => {
  beforeEach(() => {
    cfClientCtorMock.mockReset();
    paginatePagesRef.pages = [];
  });

  it('resolves a store ARN + Id by matching its Name across pages', async () => {
    paginatePagesRef.pages = [
      { KeyValueStoreList: { Items: [{ Name: 'other', Id: 'x', ARN: 'arn:...:key-value-store/x' }] } },
      {
        KeyValueStoreList: {
          Items: [{ Name: 'MyStoreName', Id: 'uuid-1', ARN: 'arn:aws:cloudfront::1:key-value-store/uuid-1' }],
        },
      },
    ];
    const out = await resolveDeployedKvsArnByName('MyStoreName');
    expect(out).toEqual({ arn: 'arn:aws:cloudfront::1:key-value-store/uuid-1', id: 'uuid-1' });
    // CloudFront is global: the control-plane client defaults to us-east-1.
    expect((cfClientCtorMock.mock.calls[0]![0] as { region: string }).region).toBe('us-east-1');
  });

  it('returns undefined when no store matches the name', async () => {
    paginatePagesRef.pages = [
      { KeyValueStoreList: { Items: [{ Name: 'a', Id: 'x', ARN: 'arn:a' }] } },
    ];
    expect(await resolveDeployedKvsArnByName('nope')).toBeUndefined();
  });

  it('returns undefined (best-effort) when the API throws', async () => {
    // A page object whose access throws simulates an API failure mid-iteration.
    paginatePagesRef.pages = [
      new Proxy(
        {},
        {
          get() {
            throw new Error('AccessDenied');
          },
        }
      ),
    ];
    expect(await resolveDeployedKvsArnByName('x')).toBeUndefined();
  });
});
