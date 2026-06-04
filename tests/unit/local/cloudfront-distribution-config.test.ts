import { describe, expect, it } from 'vite-plus/test';
import { resolveDeployedOriginBucket } from '../../../src/local/cloudfront-distribution-config.js';

describe('resolveDeployedOriginBucket', () => {
  it('parses the bucket name from the matching origin DomainName in the deployed config', async () => {
    const bucket = await resolveDeployedOriginBucket({
      distributionId: 'E123',
      originId: 'o1',
      getOrigins: async () => [
        { Id: 'other', DomainName: 'wrong.s3.us-east-1.amazonaws.com' },
        { Id: 'o1', DomainName: 'deployed-bucket.s3.us-west-2.amazonaws.com' },
      ],
    });
    expect(bucket).toBe('deployed-bucket');
  });

  it('returns undefined when the origin id is not in the config', async () => {
    const bucket = await resolveDeployedOriginBucket({
      distributionId: 'E123',
      originId: 'missing',
      getOrigins: async () => [{ Id: 'o1', DomainName: 'b.s3.us-east-1.amazonaws.com' }],
    });
    expect(bucket).toBeUndefined();
  });

  it('returns undefined when the matched origin DomainName is not an S3 domain', async () => {
    const bucket = await resolveDeployedOriginBucket({
      distributionId: 'E123',
      originId: 'o1',
      getOrigins: async () => [{ Id: 'o1', DomainName: 'example.execute-api.us-east-1.amazonaws.com' }],
    });
    expect(bucket).toBeUndefined();
  });

  it('never throws — a GetDistributionConfig failure resolves to undefined', async () => {
    const bucket = await resolveDeployedOriginBucket({
      distributionId: 'E123',
      originId: 'o1',
      getOrigins: async () => {
        throw new Error('AccessDenied');
      },
    });
    expect(bucket).toBeUndefined();
  });
});
