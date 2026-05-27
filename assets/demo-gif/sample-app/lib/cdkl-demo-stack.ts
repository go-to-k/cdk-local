import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal CDK stack used by the cdk-local demo GIFs.
 *
 * - `EchoHandler` is the asset-backed Node.js Lambda the `cdkl invoke`
 *   GIF runs against directly. It returns a clearly-recognizable JSON
 *   payload so the recorded output is readable in the GIF without
 *   scrolling.
 * - `MyApi` is an HTTP API v2 fronting the same Lambda, used by the
 *   `cdkl start-api` GIF. Path `/hello` → the same handler. HTTP API
 *   v2 (rather than REST API v1) keeps the demo URL prefix-free so
 *   the recorded `curl` line stays short.
 *
 * The handler returns an API-Gateway-shape response when invoked
 * through the HTTP API path (event carries `requestContext`) and a
 * plain echo shape otherwise — both demos work without code-branching
 * the sample app.
 *
 * No AWS deploy required — cdkl drives the synthesized `cdk.out`
 * directly.
 */
export class CdklDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'Hello from cdk-local!',
      },
      timeout: cdk.Duration.seconds(10),
    });

    const api = new HttpApi(this, 'MyApi', { apiName: 'cdkl-demo' });
    api.addRoutes({
      path: '/hello',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HelloIntegration', fn),
    });
  }
}
