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
 * Static-site distribution fixture for `cdkl start-cloudfront` (#363):
 *
 *   - An S3 bucket populated by a `BucketDeployment` of `../site`
 *     (`index.html`, `foo/index.html`, `404.html`) — the local source
 *     cdk-local resolves to serve the origin.
 *   - A `viewer-request` CloudFront Function that rewrites an extension-less
 *     path to `<path>/index.html` (e.g. `/foo` -> `/foo/index.html`) and a
 *     trailing-slash path to `<path>index.html`.
 *   - A `viewer-response` CloudFront Function that stamps an `x-cdkl-fixture`
 *     header so the integ can assert the response function ran.
 *   - `DefaultRootObject: index.html` and a `403 -> /404.html (200)` custom
 *     error response (the SPA fallback for a missing key behind an
 *     OAC-fronted private bucket).
 *   - A `ResponseHeadersPolicy` with a CORS config on the default behavior
 *     (allow origin `http://127.0.0.1:5050`, method `GET`, header
 *     `Authorization`) so the integ can assert `cdkl start-cloudfront`
 *     reproduces CloudFront's edge CORS: an OPTIONS preflight answered with
 *     `Access-Control-Allow-Origin` + a `GET` actual response carrying it.
 */
export class LocalStartCloudFrontStack extends cdk.Stack {
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

    const rewrite = new cloudfront.Function(this, 'RewriteFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          '  var uri = request.uri;',
          "  if (uri.endsWith('/')) {",
          "    request.uri = uri + 'index.html';",
          "  } else if (!uri.split('/').pop().includes('.')) {",
          "    request.uri = uri + '/index.html';",
          '  }',
          '  return request;',
          '}',
        ].join('\n')
      ),
    });

    const stampHeader = new cloudfront.Function(this, 'StampFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var response = event.response;',
          "  response.headers['x-cdkl-fixture'] = { value: 'start-cloudfront' };",
          '  return response;',
          '}',
        ].join('\n')
      ),
    });

    const corsPolicy = new cloudfront.ResponseHeadersPolicy(this, 'CorsPolicy', {
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['Authorization'],
        accessControlAllowMethods: ['GET'],
        accessControlAllowOrigins: ['http://127.0.0.1:5050'],
        originOverride: true,
      },
    });

    // A KeyValueStore-backed viewer-request function on a /kv/* behavior: it
    // looks the request URI up in the store and rewrites to the mapped path.
    // The integ backs it with --kvs-file (local JSON), exercising the
    // import-cf-from-cloudfront transform + cf.kvs().get() runtime path with no
    // AWS. (issue #399)
    const routesKvs = new cloudfront.KeyValueStore(this, 'RoutesKvs');
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

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    new cloudfront.Distribution(this, 'SiteDist', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: s3Origin,
        responseHeadersPolicy: corsPolicy,
        functionAssociations: [
          { function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          { function: stampHeader, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
      additionalBehaviors: {
        '/kv/*': {
          origin: s3Origin,
          functionAssociations: [
            { function: kvsRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/404.html' },
      ],
    });
  }
}
