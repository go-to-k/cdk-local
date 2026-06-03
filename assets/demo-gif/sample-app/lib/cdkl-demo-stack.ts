import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * CDK stack used by the cdk-local demo GIFs. It deliberately exposes
 * SEVERAL runnable targets of MULTIPLE kinds so the recorded interactive
 * picker is illustrative:
 *
 *   - three Lambdas — `EchoHandler`, `GreetHandler`, `HealthHandler` — so
 *     the `cdkl invoke` single-select picker has a real list to arrow
 *     through;
 *   - an HTTP API v2 (`MyHttpApi`, `/hello` → EchoHandler), a REST API v1
 *     (`MyRestApi`, `/greet` → GreetHandler), and a Function URL on
 *     `HealthHandler`, so the `cdkl start-api` multi-select picker shows
 *     all three surface kinds (grouped HTTP API v2 / REST API v1 /
 *     Function URL).
 *
 * Every Lambda shares one asset (`../lambda`); the handler returns an API
 * Gateway-shape response when the event carries `requestContext` (the
 * start-api path) and a plain echo otherwise (the invoke path), so no
 * code-branching of the sample app is needed.
 *
 * No AWS deploy required — cdkl drives the synthesized `cdk.out` directly.
 */
export class CdklDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const code = lambda.Code.fromAsset(path.join(__dirname, '../lambda'));
    const mkFn = (logicalId: string, greeting: string): lambda.Function =>
      new lambda.Function(this, logicalId, {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code,
        environment: { GREETING: greeting },
        timeout: cdk.Duration.seconds(10),
      });

    const echo = mkFn('EchoHandler', 'Hello from cdk-local!');
    const greet = mkFn('GreetHandler', 'Greetings from a REST API!');
    const health = mkFn('HealthHandler', 'OK');

    // HTTP API v2 → EchoHandler (the `curl /hello` target in the start-api GIF).
    const httpApi = new HttpApi(this, 'MyHttpApi', { apiName: 'cdkl-demo-http' });
    httpApi.addRoutes({
      path: '/hello',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HelloIntegration', echo),
    });
    // POST /echo — echoes the request headers + body so the studio request
    // composer demo (assets/demo-gif/record-studio.mjs) can show a request
    // body + a header being sent and reflected in the response.
    httpApi.addRoutes({
      path: '/echo',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('EchoIntegration', echo),
    });

    // REST API v1 → GreetHandler — a second API kind for the picker.
    const restApi = new apigw.RestApi(this, 'MyRestApi', { restApiName: 'cdkl-demo-rest' });
    restApi.root.addResource('greet').addMethod('GET', new apigw.LambdaIntegration(greet));

    // Function URL → HealthHandler — the third API kind for the picker.
    health.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
