import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real-AWS fixture for `cdkl start-cloudfront --from-cfn-stack` against a
 * CloudFront KeyValueStore (issue #399).
 *
 * The store is ALWAYS created and SEEDED at deploy time with
 * `/go -> /foo/index.html` (inline import source), so the deployed store has a
 * real key the `GetKey` data-plane API returns. The distribution + S3 origin +
 * KVS-reading viewer-request function are created ONLY under the
 * `withDistribution` context flag:
 *
 *   - `cdk deploy` (no flag) deploys the KeyValueStore ALONE — fast, because a
 *     full CloudFront distribution is slow to create / delete and the local
 *     serve does NOT need it deployed (start-cloudfront synths the distribution
 *     locally and serves the S3 origin from the local BucketDeployment asset;
 *     --from-cfn-stack only needs the deployed store to resolve its ARN).
 *   - `cdkl start-cloudfront --from-cfn-stack -c withDistribution=true` synths
 *     the full distribution locally + resolves the KVS ARN from the deployed
 *     (store-only) stack. The `RoutesKvs` construct path is identical in both
 *     synths, so its logical id (what --from-cfn-stack resolves) matches.
 */
export class LocalStartCloudFrontKvsFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Always present, in both the deployed (store-only) and local (full) synth,
    // so its logical id is stable across them.
    const routesKvs = new cloudfront.KeyValueStore(this, 'RoutesKvs', {
      source: cloudfront.ImportSource.fromInline(
        JSON.stringify({ data: [{ key: '/go', value: '/foo/index.html' }] })
      ),
    });

    // The distribution side is local-serve-only (kept out of the deployed stack
    // so the slow CloudFront resources are never created in AWS).
    if (!this.node.tryGetContext('withDistribution')) return;

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site'))],
      destinationBucket: bucket,
    });

    const kvsRewrite = new cloudfront.Function(this, 'KvsRewriteFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: routesKvs,
      code: cloudfront.FunctionCode.fromInline(
        [
          "import cf from 'cloudfront';",
          'const store = cf.kvs();',
          'async function handler(event) {',
          '  var request = event.request;',
          '  try {',
          '    request.uri = await store.get(request.uri);',
          '  } catch (e) {}',
          '  return request;',
          '}',
        ].join('\n')
      ),
    });

    new cloudfront.Distribution(this, 'SiteDist', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        functionAssociations: [
          { function: kvsRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
    });
  }
}
