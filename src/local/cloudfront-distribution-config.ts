import { describeS3OriginDomain } from './cloudfront-resolver.js';

/**
 * Resolve a deployed S3 origin's bucket NAME via `cloudfront:GetDistributionConfig`
 * (issue #405 follow-up). The fallback for a deployed-S3 origin whose bucket
 * name is a pure intrinsic in the local template (a `Ref` to a parameter, a
 * cross-stack import) — not a same-stack `Fn::GetAtt` (resolved from
 * `ListStackResources` state) and not a literal in the `DomainName` (parsed
 * locally). The DEPLOYED distribution config carries the origin's concrete
 * `DomainName`, from which the bucket name is parsed the same way the local
 * resolver parses a literal S3 domain.
 *
 * Used by `cdkl start-cloudfront --from-cfn-stack` (the command resolves the
 * distribution's physical id from state, then calls this); a host CLI wrapping
 * the command reaches it via `cdk-local/internal`. CloudFront is a global
 * service, so the client signs against `us-east-1` regardless of the bucket's
 * region (the bucket region is the S3 client's concern, not this call's).
 */

/** Static / STS-issued credentials for the CloudFront control-plane read. */
export interface CloudFrontClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ResolveDeployedOriginBucketOptions {
  /** The deployed `AWS::CloudFront::Distribution` physical id (e.g. `E123ABC`). */
  distributionId: string;
  /** The origin's `Id` within the distribution config. */
  originId: string;
  /** Explicit credentials; when absent the SDK's default credential chain is used. */
  credentials?: CloudFrontClientCredentials;
  /**
   * Test seam: override the GetDistributionConfig call so unit tests need no
   * real CloudFront. Receives the distribution id, returns the origins list.
   */
  getOrigins?: (distributionId: string) => Promise<Array<{ Id?: string; DomainName?: string }>>;
}

/**
 * Returns the resolved bucket name, or `undefined` when the distribution /
 * origin cannot be read or its `DomainName` is not an S3 domain. Never throws —
 * a failure (no permission, wrong id, throttle) resolves to `undefined` so the
 * caller can fall back to its actionable `--origin` guidance.
 */
export async function resolveDeployedOriginBucket(
  options: ResolveDeployedOriginBucketOptions
): Promise<string | undefined> {
  try {
    const origins = await (options.getOrigins
      ? options.getOrigins(options.distributionId)
      : defaultGetOrigins(options));
    const origin = origins.find((o) => o.Id === options.originId);
    if (!origin || typeof origin.DomainName !== 'string') return undefined;
    return describeS3OriginDomain(origin.DomainName).bucketName;
  } catch {
    return undefined;
  }
}

async function defaultGetOrigins(
  options: ResolveDeployedOriginBucketOptions
): Promise<Array<{ Id?: string; DomainName?: string }>> {
  const { CloudFrontClient, GetDistributionConfigCommand } =
    await import('@aws-sdk/client-cloudfront');
  const client = new CloudFrontClient({
    region: 'us-east-1', // CloudFront is global; the control plane lives in us-east-1.
    ...(options.credentials && {
      credentials: {
        accessKeyId: options.credentials.accessKeyId,
        secretAccessKey: options.credentials.secretAccessKey,
        ...(options.credentials.sessionToken && {
          sessionToken: options.credentials.sessionToken,
        }),
      },
    }),
  });
  try {
    const res = await client.send(new GetDistributionConfigCommand({ Id: options.distributionId }));
    return (res.DistributionConfig?.Origins?.Items ?? []) as Array<{
      Id?: string;
      DomainName?: string;
    }>;
  } finally {
    client.destroy();
  }
}
