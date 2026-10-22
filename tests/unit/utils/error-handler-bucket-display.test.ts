/**
 * go-to-k/cdk-local#761: the bucket in `normalizeAwsError`'s S3 messages is
 * the template's AgentCore `fromS3` bucket, so it renders through
 * `displayIdent`; the `<unknown bucket>` sentinel stays bare.
 */
import { describe, expect, it } from 'vite-plus/test';
import { normalizeAwsError } from '../../../src/utils/error-handler.js';

const unknown = (status: number): unknown =>
  Object.assign(new Error('UnknownError'), { name: 'Unknown', $metadata: { httpStatusCode: status } });

describe('normalizeAwsError renders the bucket (#761)', () => {
  it('prints a plain bucket bare', () => {
    expect(normalizeAwsError(unknown(404), { bucket: 'my-bucket' }).message).toBe(
      'Bucket my-bucket does not exist.'
    );
  });

  it('quotes a forging bucket as one JSON literal', () => {
    expect(normalizeAwsError(unknown(403), { bucket: "b' ok" }).message).toBe(
      `Access denied to bucket "b' ok". Verify credentials and bucket policy.`
    );
  });

  it('leaves the unknown-bucket sentinel bare', () => {
    expect(normalizeAwsError(unknown(404)).message).toBe('Bucket <unknown bucket> does not exist.');
  });
});
