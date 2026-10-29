import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  CfnWebFunction,
  CfnWebFunctionEndpoint,
  CfnWebFunctionRevision,
} from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
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
 *     The same policy carries security, custom and remove headers, applied
 *     over every response (go-to-k/cdk-local#843).
 *   - A second distribution, `WebDist`, in front of a Lambda Web Function
 *     (go-to-k/cdkd#5516): its default behavior is an `HttpOrigin` on a
 *     `WebFunctionEndpoint`'s `DomainName` with a lambda-type OAC, the same
 *     CORS policy and the stamp function; a `/deploy/*` behavior targets a
 *     second endpoint whose revision's code is a `BucketDeployment` with
 *     `extract: false` (`Fn.select(0, upload.objectKeys)`). `SiteDist` stays
 *     Docker-free; only `WebDist` runs containers.
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
      // go-to-k/cdk-local#843: the rest of the policy, applied over every
      // response. The Web Function origin sends X-Frame-Options (replaced),
      // Referrer-Policy (kept) and X-Powered-By (removed).
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: false,
        },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'X-Cdkl-Policy', value: 'applied', override: true }],
      },
      removeHeaders: ['X-Powered-By'],
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

    // A Basic-Auth viewer-request function on a /secure/* behavior, using the
    // Buffer global to build the expected Authorization header. This is the
    // common case from issue #410 — a cloudfront-js-2.0 function that uses
    // Buffer, which previously failed locally with "Buffer is not defined".
    const basicAuth = new cloudfront.Function(this, 'BasicAuthFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          "  var expected = 'Basic ' + Buffer.from('user:pass').toString('base64');",
          '  var auth = request.headers.authorization;',
          '  if (!auth || auth.value !== expected) {',
          '    return {',
          "      statusCode: 401,",
          "      statusDescription: 'Unauthorized',",
          "      headers: { 'www-authenticate': { value: 'Basic realm=\"secure\"' } },",
          '    };',
          '  }',
          "  request.uri = '/';",
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
        '/secure/*': {
          origin: s3Origin,
          functionAssociations: [
            { function: basicAuth, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/404.html' },
      ],
    });

    // --- WebDist: CloudFront in front of a Lambda Web Function (cdkd#5516) ---
    const webCode = new s3assets.Asset(this, 'WebCode', { path: path.join(__dirname, '..', 'web') });
    const webRole = new iam.Role(this, 'WebRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const webFn = new CfnWebFunction(this, 'WebFn', { functionName: 'cdkl-integ-cf-web-fn' });
    const webRevision = (
      id: string,
      env: Record<string, string>,
      s3Object: CfnWebFunctionRevision.S3ObjectProperty
    ): CfnWebFunctionRevision =>
      new CfnWebFunctionRevision(this, id, {
        functionName: webFn.ref,
        buildConfig: {
          codeConfig: { s3Object },
          runtimeConfig: { runtime: 'nodejs24.x' },
        },
        serviceConfig: { executionRoleArn: webRole.roleArn, environmentVariables: env },
      });
    const assetObject = { bucket: webCode.s3BucketName, key: webCode.s3ObjectKey };
    const revOld = webRevision('WebRevOld', { REVISION_LABEL: 'old', GREETING: 'hi-old' }, assetObject);
    const revMain = webRevision('WebRevMain', { REVISION_LABEL: 'main', GREETING: 'hi-main' }, assetObject);
    const endpoint = new CfnWebFunctionEndpoint(this, 'WebEndpoint', {
      functionName: webFn.ref,
      endpointName: 'main',
      endpointType: 'HomeRegion',
      authType: 'AWS_IAM',
      revisionWeights: [
        { revisionId: revOld.attrRevisionId, weight: 10 },
        { revisionId: revMain.attrRevisionId, weight: 90 },
      ],
    });

    // The code shipped the other way: a BucketDeployment that does not extract.
    const codeBucket = new s3.Bucket(this, 'WebCodeBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const upload = new s3deploy.BucketDeployment(this, 'WebUpload', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'web'))],
      destinationBucket: codeBucket,
      extract: false,
      prune: false,
    });
    const revDeploy = webRevision(
      'WebRevDeploy',
      { REVISION_LABEL: 'deploy', GREETING: 'hi-deploy' },
      { bucket: codeBucket.bucketName, key: cdk.Fn.select(0, upload.objectKeys) }
    );
    const deployEndpoint = new CfnWebFunctionEndpoint(this, 'WebDeployEndpoint', {
      functionName: webFn.ref,
      endpointName: 'deploy',
      endpointType: 'HomeRegion',
      authType: 'AWS_IAM',
      revisionWeights: [{ revisionId: revDeploy.attrRevisionId, weight: 100 }],
    });

    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'WebOac');
    const webOrigin = (ep: CfnWebFunctionEndpoint): origins.HttpOrigin =>
      new origins.HttpOrigin(ep.attrDomainName, {
        originAccessControlId: oac.originAccessControlId,
      });

    new cloudfront.Distribution(this, 'WebDist', {
      defaultBehavior: {
        origin: webOrigin(endpoint),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: corsPolicy,
        functionAssociations: [
          { function: stampHeader, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
      additionalBehaviors: {
        '/deploy/*': {
          origin: webOrigin(deployEndpoint),
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
    });
  }
}
