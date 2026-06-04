import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { ResolvedDistribution, ResolvedOrigin } from '../../../src/local/cloudfront-resolver.js';

// Site-level binding test for the deployed-S3 read-through origin wiring
// (issue #405): resolveDeployedS3Origins promotes an `s3-unresolved` origin to
// `s3-deployed` by reading the bucket's physical name from `--from-cfn-stack`
// state, and annotateDeployedS3Origins re-applies that promotion on a `--watch`
// reload (the pure resolver re-emits the origin as `s3-unresolved`). The state
// provider is mocked so no real AWS is touched.

const { createProviderMock, cfnPresentMock, readerMock, bucketResolverMock } = vi.hoisted(() => ({
  createProviderMock: vi.fn(),
  cfnPresentMock: vi.fn(() => true),
  // Stub the reader so the binding test can assert the options threaded into it
  // (cache flag, region, credentials) without building a real S3 client.
  readerMock: vi.fn(() => {
    const fn = (async () => ({ statusCode: 404, headers: {}, body: Buffer.alloc(0) })) as never;
    (fn as { close: unknown }).close = async (): Promise<void> => undefined;
    (fn as { clearCache: unknown }).clearCache = (): void => undefined;
    return fn;
  }),
  // Stub the GetDistributionConfig fallback (no real CloudFront call).
  bucketResolverMock: vi.fn(async () => undefined as string | undefined),
}));

vi.mock('../../../src/cli/commands/local-state-source.js', () => ({
  createLocalStateProvider: createProviderMock,
  isCfnFlagPresent: cfnPresentMock,
}));

vi.mock('../../../src/local/cloudfront-s3-origin.js', () => ({
  createS3OriginReader: readerMock,
}));

vi.mock('../../../src/local/cloudfront-distribution-config.js', () => ({
  resolveDeployedOriginBucket: bucketResolverMock,
}));

const { resolveDeployedS3Origins, annotateDeployedS3Origins } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
);

const logger = { info: vi.fn(), warn: vi.fn() } as never;

function distribution(origin: ResolvedOrigin): ResolvedDistribution {
  return {
    logicalId: 'Dist',
    stackName: 'Stack',
    behaviors: [{ targetOriginId: 'o1' }],
    origins: new Map([['o1', origin]]),
    customErrorResponses: [],
  };
}

const stacks = [{ stackName: 'Stack', region: 'us-west-2' } as StackInfo];

describe('resolveDeployedS3Origins', () => {
  it('promotes an s3-unresolved origin to s3-deployed using the state physical id', async () => {
    createProviderMock.mockReturnValue({
      load: vi.fn().mockResolvedValue({ resources: { Bucket123: { physicalId: 'my-site-bucket' } } }),
    });
    const dist = distribution({ kind: 's3-unresolved', originId: 'o1', bucketLogicalId: 'Bucket123' });

    const { readers, buckets } = await resolveDeployedS3Origins(
      dist,
      stacks,
      { fromCfnStack: 'Stack' } as never,
      undefined,
      logger
    );

    expect(dist.origins.get('o1')).toEqual({
      kind: 's3-deployed',
      originId: 'o1',
      bucketName: 'my-site-bucket',
    });
    expect(readers.has('o1')).toBe(true);
    expect(buckets.get('o1')).toBe('my-site-bucket');
  });

  it('is a no-op without --from-cfn-stack (stays s3-unresolved)', async () => {
    cfnPresentMock.mockReturnValueOnce(false);
    const dist = distribution({ kind: 's3-unresolved', originId: 'o1', bucketLogicalId: 'Bucket123' });

    const { readers } = await resolveDeployedS3Origins(dist, stacks, {} as never, undefined, logger);

    expect(dist.origins.get('o1')?.kind).toBe('s3-unresolved');
    expect(readers.size).toBe(0);
  });

  it('leaves the origin unresolved when the bucket physical id is not in state', async () => {
    createProviderMock.mockReturnValue({
      load: vi.fn().mockResolvedValue({ resources: {} }),
    });
    const dist = distribution({ kind: 's3-unresolved', originId: 'o1', bucketLogicalId: 'Bucket123' });

    const { readers, buckets } = await resolveDeployedS3Origins(
      dist,
      stacks,
      { fromCfnStack: 'Stack' } as never,
      undefined,
      logger
    );

    expect(dist.origins.get('o1')?.kind).toBe('s3-unresolved');
    expect(readers.size).toBe(0);
    expect(buckets.size).toBe(0);
  });

  it('does not touch an origin that already has a local source', async () => {
    createProviderMock.mockReturnValue({ load: vi.fn().mockResolvedValue({ resources: {} }) });
    const dist = distribution({ kind: 's3', originId: 'o1', localDirs: ['/tmp/site'] });

    const { readers } = await resolveDeployedS3Origins(
      dist,
      stacks,
      { fromCfnStack: 'Stack' } as never,
      undefined,
      logger
    );

    expect(dist.origins.get('o1')?.kind).toBe('s3');
    expect(readers.size).toBe(0);
  });

  it('uses a literal bucketName from the DomainName directly (external/imported bucket)', async () => {
    createProviderMock.mockReturnValue({ load: vi.fn().mockResolvedValue({ resources: {} }) });
    readerMock.mockClear();
    const dist = distribution({ kind: 's3-unresolved', originId: 'o1', bucketName: 'ext-bucket' });

    const { readers, buckets } = await resolveDeployedS3Origins(
      dist,
      stacks,
      { fromCfnStack: 'Stack' } as never,
      undefined,
      logger
    );

    expect(buckets.get('o1')).toBe('ext-bucket');
    expect(readers.has('o1')).toBe(true);
    expect(readerMock).toHaveBeenCalledWith('ext-bucket', expect.anything());
    expect(dist.origins.get('o1')).toMatchObject({ kind: 's3-deployed', bucketName: 'ext-bucket' });
  });

  it('falls back to GetDistributionConfig for a deployedConfigOnly origin (pure intrinsic)', async () => {
    createProviderMock.mockReturnValue({
      load: vi.fn().mockResolvedValue({ resources: { Dist: { physicalId: 'E123ABC' } } }),
    });
    bucketResolverMock.mockResolvedValueOnce('resolved-from-config');
    readerMock.mockClear();
    const dist = distribution({ kind: 's3-unresolved', originId: 'o1', deployedConfigOnly: true });

    const { buckets } = await resolveDeployedS3Origins(
      dist,
      stacks,
      { fromCfnStack: 'Stack' } as never,
      undefined,
      logger
    );

    expect(bucketResolverMock).toHaveBeenCalledWith(
      expect.objectContaining({ distributionId: 'E123ABC', originId: 'o1' })
    );
    expect(buckets.get('o1')).toBe('resolved-from-config');
    expect(dist.origins.get('o1')).toMatchObject({
      kind: 's3-deployed',
      bucketName: 'resolved-from-config',
    });
  });

  it('leaves a deployedConfigOnly origin unresolved when GetDistributionConfig cannot resolve it', async () => {
    createProviderMock.mockReturnValue({
      load: vi.fn().mockResolvedValue({ resources: { Dist: { physicalId: 'E123ABC' } } }),
    });
    bucketResolverMock.mockResolvedValueOnce(undefined);
    const dist = distribution({ kind: 's3-unresolved', originId: 'o1', deployedConfigOnly: true });

    const { readers } = await resolveDeployedS3Origins(
      dist,
      stacks,
      { fromCfnStack: 'Stack' } as never,
      undefined,
      logger
    );

    expect(dist.origins.get('o1')?.kind).toBe('s3-unresolved');
    expect(readers.size).toBe(0);
  });

  it('threads cache: true into the reader only when --cache-origin is set', async () => {
    createProviderMock.mockReturnValue({
      load: vi.fn().mockResolvedValue({ resources: { Bucket123: { physicalId: 'b' } } }),
    });

    readerMock.mockClear();
    await resolveDeployedS3Origins(
      distribution({ kind: 's3-unresolved', originId: 'o1', bucketLogicalId: 'Bucket123' }),
      stacks,
      { fromCfnStack: 'Stack', cacheOrigin: true } as never,
      undefined,
      logger
    );
    expect(readerMock).toHaveBeenCalledWith('b', expect.objectContaining({ cache: true }));

    readerMock.mockClear();
    await resolveDeployedS3Origins(
      distribution({ kind: 's3-unresolved', originId: 'o1', bucketLogicalId: 'Bucket123' }),
      stacks,
      { fromCfnStack: 'Stack' } as never,
      undefined,
      logger
    );
    const opts = readerMock.mock.calls[0]?.[1] as { cache?: boolean } | undefined;
    expect(opts?.cache).toBeUndefined();
  });
});

describe('annotateDeployedS3Origins', () => {
  it('re-promotes a reloaded s3-unresolved origin to s3-deployed from the boot map', () => {
    const dist = distribution({ kind: 's3-unresolved', originId: 'o1', bucketLogicalId: 'Bucket123' });
    annotateDeployedS3Origins(dist, new Map([['o1', 'my-site-bucket']]));
    expect(dist.origins.get('o1')).toEqual({
      kind: 's3-deployed',
      originId: 'o1',
      bucketName: 'my-site-bucket',
    });
  });

  it('does not override an origin that resolved a local source on reload', () => {
    const dist = distribution({ kind: 's3', originId: 'o1', localDirs: ['/tmp/site'] });
    annotateDeployedS3Origins(dist, new Map([['o1', 'my-site-bucket']]));
    expect(dist.origins.get('o1')?.kind).toBe('s3');
  });
});
