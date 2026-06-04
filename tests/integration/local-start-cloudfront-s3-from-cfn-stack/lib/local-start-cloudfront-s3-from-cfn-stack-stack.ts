import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Real-AWS fixture for `cdkl start-cloudfront --from-cfn-stack` serving an S3
 * origin from the DEPLOYED bucket on demand (issue #405) — the front/back-split
 * case: the CDK repo defines the CloudFront distribution + S3 bucket, but the
 * static files are uploaded out of band (a separate frontend repo / pipeline),
 * so there is NO `BucketDeployment` source asset to serve locally.
 *
 * The bucket is ALWAYS created (deployed), so `--from-cfn-stack` resolves its
 * physical name from `ListStackResources` and the local server reads it from
 * real S3. The distribution + S3 origin are created ONLY under the
 * `withDistribution` context flag:
 *
 *   - `cdk deploy` (no flag) deploys the BUCKET ALONE — fast, because a full
 *     CloudFront distribution is slow to create / delete and the local serve
 *     does NOT need it deployed (start-cloudfront synths the distribution
 *     locally; --from-cfn-stack only needs the deployed bucket's NAME).
 *   - `cdkl start-cloudfront --from-cfn-stack -c withDistribution=true` synths
 *     the full distribution locally + resolves the bucket name from the deployed
 *     (bucket-only) stack. The `SiteBucket` construct path is identical in both
 *     synths, so its logical id (what --from-cfn-stack resolves) matches.
 *
 * Crucially there is NO `BucketDeployment`: content reaches the bucket via an
 * out-of-band `aws s3 cp` in verify.sh, so the local resolver finds no source
 * asset and falls to the deployed-S3 read-through path under test.
 */
export class LocalStartCloudFrontS3FromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Always present, in both the deployed (bucket-only) and local (full) synth,
    // so its logical id is stable across them. autoDeleteObjects empties the
    // out-of-band-uploaded objects on `cdk destroy`.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });

    // The distribution side is local-serve-only (kept out of the deployed stack
    // so the slow CloudFront resources are never created in AWS).
    if (!this.node.tryGetContext('withDistribution')) return;

    new cloudfront.Distribution(this, 'SiteDist', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
      },
      // SPA fallback: a missing key (403 on the OAC-private bucket) serves
      // /index.html with a 200 — exercised against real S3 in verify.sh.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });
  }
}
