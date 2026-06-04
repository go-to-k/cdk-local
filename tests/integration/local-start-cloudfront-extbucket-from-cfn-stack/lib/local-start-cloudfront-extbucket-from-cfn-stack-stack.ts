import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Real-AWS fixture for `cdkl start-cloudfront --from-cfn-stack` resolving a
 * deployed S3 origin whose bucket name is a PURE INTRINSIC in the template, via
 * `cloudfront:GetDistributionConfig` (issue #405 follow-up).
 *
 * The distribution is an L1 `CfnDistribution` whose S3 origin `DomainName` is an
 * `Fn::Sub` referencing the bucket name as a Sub variable
 * (`${BN}.s3.${AWS::Region}.amazonaws.com`). Locally cdk-local cannot derive the
 * bucket name from that (the label is `${BN}`, not a literal and not a same-stack
 * `Fn::GetAtt`), so it falls back to `GetDistributionConfig` on the DEPLOYED
 * distribution — whose origin `DomainName` is the concrete
 * `<bucket>.s3.<region>.amazonaws.com` — and parses the bucket name from there.
 *
 * Unlike the #405 fixture (bucket-only deploy), this MUST deploy the
 * distribution so `GetDistributionConfig` has something to read. The
 * distribution is never served through (cdk-local reads the bucket directly with
 * the dev credentials), so the legacy public-S3 origin config is fine — it just
 * needs to exist. No `BucketDeployment`: content is uploaded out of band.
 */
export class LocalStartCloudFrontExtBucketFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });

    new cloudfront.CfnDistribution(this, 'Dist', {
      distributionConfig: {
        enabled: true,
        defaultRootObject: 'index.html',
        origins: [
          {
            id: 'o1',
            // Pure-intrinsic S3 origin domain: the bucket name is a Sub variable,
            // not a literal or a same-stack Fn::GetAtt -> forces the
            // GetDistributionConfig fallback locally.
            domainName: cdk.Fn.sub('${BN}.s3.${AWS::Region}.amazonaws.com', {
              BN: bucket.bucketName,
            }),
            s3OriginConfig: { originAccessIdentity: '' },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: 'o1',
          viewerProtocolPolicy: 'allow-all',
          forwardedValues: { queryString: false },
        },
        customErrorResponses: [
          { errorCode: 403, responseCode: 200, responsePagePath: '/index.html' },
        ],
      },
    });
  }
}
