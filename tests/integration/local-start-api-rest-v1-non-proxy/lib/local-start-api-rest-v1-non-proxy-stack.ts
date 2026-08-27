import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture.
 *
 * A function that declares no `architecture` defaults to `X86_64`, so on an
 * arm64 host cdk-local pins `--platform linux/amd64` and every container here
 * runs under CPU emulation -- where the Go RIE in the `public.ecr.aws/lambda/*`
 * base images faults intermittently, at a different assertion on every run
 * (issue #560; extended to the remaining fixtures by issue #569).
 *
 * Declaring the HOST arch -- rather than hardcoding either value -- is what
 * makes the container native on an Apple Silicon dev host AND on an x86_64 CI
 * runner, instead of trading one host's emulation for the other's. Keep it on
 * every function here: a new handler that omits it silently reintroduces the
 * arm64-only flake. The full rationale, the carve-outs, and the fence that
 * enforces this live in `tests/unit/integ-fixture-host-architecture.test.ts`.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * Fixture stack for `cdkl start-api` REST v1 non-AWS_PROXY
 * integrations (#457).
 *
 * Deploys NOTHING — the integ exercises `cdkl start-api` end-to-
 * end against Docker + the AWS Lambda Node.js base image (which
 * bundles RIE). The test runner verifies that each non-AWS_PROXY
 * integration kind responds correctly when curl'd.
 *
 * Routes exercised:
 *
 *   - `GET /mock-200` — MOCK integration with a request template that
 *     selects `{"statusCode": 200}` and a response template that
 *     returns `{"source":"mock"}`. Asserts cdk-local's MOCK dispatcher
 *     (VTL evaluation against an empty input) round-trips correctly.
 *
 *   - `GET /mock-404` — MOCK integration with a request template that
 *     drives the 404 IntegrationResponses[] entry. Asserts status-code
 *     selection on MOCK.
 *
 *   - `GET /http-proxy` — HTTP_PROXY to https://httpbin.org/get. Without
 *     network access in CI sandboxes this typically returns a 502; the
 *     integ tolerates either the upstream 200 response OR the 502.
 *
 *   - `POST /aws-lambda` — AWS (Lambda non-proxy) integration with VTL
 *     request templates that synthesize `{action, name}` from the
 *     request body, invoke the Lambda, and shape the response via VTL
 *     into `{"data": "Hello, <name>"}`. The integ asserts that the
 *     request-side AND response-side VTL both fired.
 *
 *   - `POST /parse-json-header` — MOCK whose request template runs
 *     `$util.parseJson` over a request HEADER, and
 *     `POST /parse-json-body` — AWS (Lambda non-proxy) whose request
 *     template runs it over the request BODY. Both cover
 *     go-to-k/cdkd#2203: the failure message must not echo a prefix of
 *     what it parsed, and `vtlFailure` copies that message into the 502
 *     response body, so the assertion has to be made over HTTP. The two
 *     vectors are separate because a MOCK template is handed a hardcoded
 *     EMPTY body and can only see a header.
 */
export class LocalStartApiRestV1NonProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handler = new lambda.Function(this, 'NonProxyHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-non-proxy')),
      timeout: cdk.Duration.seconds(10),
    });

    const api = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'rest-v1-non-proxy-integ',
    });

    // MOCK 200 — request template selects statusCode 200, response
    // template returns a literal JSON payload.
    const mock200 = api.root.addResource('mock-200');
    mock200.addMethod(
      'GET',
      new apigw.MockIntegration({
        requestTemplates: {
          'application/json': '{"statusCode": 200}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"source":"mock","statusCode":200}',
            },
          },
        ],
      }),
      {
        methodResponses: [{ statusCode: '200' }],
      }
    );

    // MOCK parse-json-header — the request template runs `$util.parseJson`
    // over a REQUEST HEADER, the vector the cdkd host reproduced the leak
    // with (go-to-k/cdkd#2203). A header is the only request-carried value a
    // MOCK template can see: `dispatchMockIntegration` builds its VTL context
    // with a hardcoded EMPTY body, so `$input.body` is always `''` here --
    // measured, after a first cut of this fixture used the body and the
    // premise check below caught it answering 502 with `argument length 0`.
    //
    // A VALID JSON header renders `{"statusCode": 200}` and answers 200; a
    // NON-JSON one throws `VtlEvaluationError`, which the REST v1 dispatcher
    // turns into a 502 whose body carries the reason. verify.sh asserts BOTH
    // directions, so an edit that stops the route reaching `$util.parseJson`
    // fails loudly instead of silently disarming the redaction assertion.
    const parseJsonHeader = api.root.addResource('parse-json-header');
    parseJsonHeader.addMethod(
      'POST',
      new apigw.MockIntegration({
        requestTemplates: {
          'application/json':
            "#set($parsed = $util.parseJson($input.params('xpayload')))\n{\"statusCode\": 200}",
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"source":"mock","parsed":true}',
            },
          },
        ],
      }),
      {
        methodResponses: [{ statusCode: '200' }],
      }
    );

    // MOCK 404 — request template selects statusCode 404.
    const mock404 = api.root.addResource('mock-404');
    mock404.addMethod(
      'GET',
      new apigw.MockIntegration({
        requestTemplates: {
          'application/json': '{"statusCode": 404}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"source":"mock","statusCode":200}',
            },
          },
          {
            statusCode: '404',
            responseTemplates: {
              'application/json': '{"source":"mock","statusCode":404,"error":"not found"}',
            },
          },
        ],
        passthroughBehavior: apigw.PassthroughBehavior.NEVER,
      }),
      {
        methodResponses: [{ statusCode: '200' }, { statusCode: '404' }],
      }
    );

    // HTTP_PROXY — public upstream. May 502 in network-isolated CI; the
    // integ tolerates either a connection error or a 200.
    const httpProxy = api.root.addResource('http-proxy');
    httpProxy.addMethod(
      'GET',
      new apigw.HttpIntegration('https://httpbin.org/get', {
        proxy: true,
        httpMethod: 'GET',
      })
    );

    // AWS Lambda non-proxy — request-side VTL synthesizes `{action, name}`
    // from the request body; response-side VTL wraps `$inputRoot.greeting`
    // into `{"data": <value>}`.
    const awsLambda = api.root.addResource('aws-lambda');
    awsLambda.addMethod(
      'POST',
      new apigw.LambdaIntegration(handler, {
        proxy: false,
        requestTemplates: {
          'application/json':
            '{"action": "$input.path(\'$.action\')", "name": "$input.path(\'$.name\')"}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"data": $input.json("$.greeting")}',
            },
          },
        ],
      }),
      {
        methodResponses: [{ statusCode: '200' }],
      }
    );

    // AWS Lambda non-proxy parse-json-body — the BODY vector of
    // go-to-k/cdkd#2203. Unlike MOCK, `dispatchAwsLambdaIntegration` hands
    // the real request body to the VTL context, so `$util.parseJson(
    // $input.body)` here parses what the caller actually POSTed -- the
    // login-endpoint shape the issue describes.
    //
    // The request template is evaluated BEFORE the Lambda is invoked, so the
    // failing case costs no container round trip; the valid case does invoke
    // it, which is what proves the route is wired rather than merely present.
    const parseJsonBody = api.root.addResource('parse-json-body');
    parseJsonBody.addMethod(
      'POST',
      new apigw.LambdaIntegration(handler, {
        proxy: false,
        requestTemplates: {
          'application/json':
            '#set($parsed = $util.parseJson($input.body))\n{"action": "greet", "name": "$parsed.name"}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"data": $input.json("$.greeting")}',
            },
          },
        ],
      }),
      {
        methodResponses: [{ statusCode: '200' }],
      }
    );
  }
}
