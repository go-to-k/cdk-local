import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * CloudFront distribution fronting a Lambda Function URL origin, for the
 * `cdkl start-cloudfront` Lambda-origin integ test (#376):
 *
 *   - A Node.js Lambda with a Function URL (`AuthType: NONE`). The handler
 *     echoes the request method / path / body and sets a cookie, returning a
 *     Function URL (payload v2.0) response.
 *   - A `cloudfront.Distribution` whose default behavior forwards to the
 *     Function URL via `origins.FunctionUrlOrigin`.
 *   - A `viewer-response` CloudFront Function that stamps an `x-cdkl-fixture`
 *     header so the integ can assert the function runs over the Lambda
 *     response (the same viewer pipeline as an S3 origin).
 */
export class LocalStartCloudFrontLambdaUrlStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'OriginFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'exports.handler = async (event) => {',
          '  const method = event.requestContext.http.method;',
          '  const path = event.rawPath;',
          "  let body = event.body || '';",
          "  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf-8');",
          '  return {',
          '    statusCode: 200,',
          "    headers: { 'content-type': 'application/json', 'x-lambda-origin': 'hit' },",
          "    cookies: ['origin_cookie=set; Path=/'],",
          '    body: JSON.stringify({',
          "      message: 'hello from the lambda function url origin',",
          '      method,',
          '      path,',
          '      echo: body,',
          '    }),',
          '  };',
          '};',
        ].join('\n')
      ),
    });

    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const stampHeader = new cloudfront.Function(this, 'StampFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var response = event.response;',
          "  response.headers['x-cdkl-fixture'] = { value: 'lambda-url' };",
          '  return response;',
          '}',
        ].join('\n')
      ),
    });

    new cloudfront.Distribution(this, 'ApiDist', {
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(fnUrl),
        functionAssociations: [
          { function: stampHeader, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
    });
  }
}
