import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import type { Construct } from 'constructs';

/**
 * Fixture stack for `cdkl start-api` REST v1 HTTP_PROXY happy-path
 * coverage (issue #250, gap G2).
 *
 * The deferred-501 / 502 failure paths are already covered by
 * `local-start-api-rest-v1-non-proxy`. THIS fixture exercises the
 * SUCCESSFUL HTTP_PROXY round-trip: the integration forwards the
 * request to a LOCAL mock HTTP server (booted by verify.sh on
 * 127.0.0.1:<MOCK_PORT>), the mock echoes the path / method / headers
 * / body, and start-api surfaces the response back to the client.
 *
 * The route is `ANY /echo` -> HTTP_PROXY `http://127.0.0.1:18091/echo`.
 * The mock URL is hard-coded to match `MOCK_PORT` in verify.sh
 * (changing one requires updating the other). The cdkl process
 * forwards HTTP_PROXY via `globalThis.fetch` from inside the host
 * Node process — no docker network involved, so `127.0.0.1` resolves
 * the same way verify.sh's curl does.
 *
 * Test assertions in verify.sh:
 *   1. Boot banner surfaces and the start-api listener is reachable.
 *   2. `curl GET /echo` -> 200 + body contains the echoed method, path
 *      (`/echo`), AND a request-time header the client set
 *      (`X-Integ-Trace`), proving header pass-through.
 *   3. `curl POST /echo -d '<payload>'` -> 200 + body echoes the
 *      payload verbatim, proving body pass-through.
 *
 * `covers: AWS::ApiGateway::Integration` (Type=HTTP_PROXY happy path).
 */
export class LocalStartApiHttpProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const api = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'http-proxy-integ',
    });

    // ANY /echo -> HTTP_PROXY to the local mock server.
    // The mock URL is the same loopback the host curl uses; cdkl
    // dispatches HTTP_PROXY via fetch() from the host Node process.
    const echo = api.root.addResource('echo');
    echo.addMethod(
      'ANY',
      new apigw.HttpIntegration('http://127.0.0.1:18091/echo', {
        proxy: true,
        httpMethod: 'ANY',
      })
    );
  }
}
