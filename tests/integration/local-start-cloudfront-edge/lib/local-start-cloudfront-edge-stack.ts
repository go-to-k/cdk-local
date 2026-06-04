import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Lambda@Edge fixture for `cdkl start-cloudfront` (#400). The distribution's
 * default behavior wires ONE Lambda function to BOTH the `viewer-request` and
 * `viewer-response` event types (a single warm RIE container is booted). The
 * function branches on `cf.config.eventType`:
 *
 *   - viewer-request: `/go` -> a generated `302` redirect to `/` (the
 *     request-stage short-circuit); any other path continues to the origin;
 *   - viewer-response: stamps an `x-edge-stamp` response header (the
 *     response-stage modification, visible to the client).
 *
 * The S3 origin content (`index.html`) is served from the local BucketDeployment
 * asset; only the Lambda@Edge function runs in Docker.
 */
export class LocalStartCloudFrontEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site'))],
      destinationBucket: bucket,
    });

    const edgeFn = new lambda.Function(this, 'EdgeFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'exports.handler = async (event) => {',
          '  const cf = event.Records[0].cf;',
          "  if (cf.config.eventType === 'viewer-response') {",
          "    cf.response.headers['x-edge-stamp'] = [{ key: 'X-Edge-Stamp', value: 'edge' }];",
          '    return cf.response;',
          '  }',
          "  if (cf.request.uri === '/go') {",
          '    return {',
          "      status: '302',",
          "      statusDescription: 'Found',",
          "      headers: { location: [{ key: 'Location', value: '/' }] },",
          '    };',
          '  }',
          '  return cf.request;',
          '};',
        ].join('\n')
      ),
    });

    new cloudfront.Distribution(this, 'EdgeDist', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        edgeLambdas: [
          {
            functionVersion: edgeFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
          {
            functionVersion: edgeFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_RESPONSE,
          },
        ],
      },
    });
  }
}
