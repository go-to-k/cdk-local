import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2_authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkl start-api` HTTP API v2 JWT authorizer
 * (issue #250, gap G3).
 *
 * REST v1 CUSTOM authorizers and HTTP v2 Lambda authorizers already
 * have integ coverage; the HTTP v2 JWT authorizer code path
 * (`resolveHttpApiAuthorizer` -> kind `'jwt'` -> `verifyJwtAuthorizer`
 * -> JWKS fetch + signature + iss + aud + exp checks) does not.
 *
 * Wires `GET /protected` to a JWT-gated Lambda. The authorizer is a
 * generic `HttpJwtAuthorizer` (NOT `HttpUserPoolAuthorizer`) because
 * the Cognito-shaped User Pool authorizer hardcodes its issuer to the
 * real `https://cognito-idp.<region>.amazonaws.com/...` URL, which
 * cdk-local hits as-is (`buildCognitoJwksUrl`) — there is no local
 * Cognito IdP available, so the verifier always fails to fetch JWKS
 * and falls through to its pass-through mode (every JWT admitted),
 * which would defeat the test.
 *
 * `HttpJwtAuthorizer` is the closest non-Cognito JWT shape: it sets
 * `AuthorizerType: 'JWT'` with a free-form Issuer + Audience pair.
 * `resolveHttpApiAuthorizer`'s JWT branch treats both authorizer
 * kinds identically — the only divergence is the cognito-detection
 * branch in `cognito-jwt.ts`'s JWKS URL builder, where a non-Cognito
 * issuer falls into `buildJwksUrlFromIssuer` (= `<issuer>/.well-known/
 * jwks.json`). That URL is what the local JWKS sidecar serves, so the
 * test exercises the verifier's full signature + iss + aud + exp
 * pipeline end-to-end with no real Cognito IdP needed.
 *
 * The sidecar runs on `http://127.0.0.1:19001` (must match
 * `SIDECAR_PORT` in verify.sh and the issuer string below). The
 * audience is `cdkl-integ-g3-aud` (must match verify.sh's
 * `SIDECAR_AUDIENCE`).
 *
 * `covers: AWS::ApiGatewayV2::Authorizer` (AuthorizerType=JWT, full
 * signature + iss + aud + exp verification path).
 */
const SIDECAR_ISSUER = 'http://127.0.0.1:19001';
const SIDECAR_AUDIENCE = 'cdkl-integ-g3-aud';

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

export class LocalStartApiCognitoJwtStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const protectedHandler = new lambda.Function(this, 'ProtectedHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-protected')),
      timeout: cdk.Duration.seconds(10),
    });

    const httpApi = new apigwv2.HttpApi(this, 'MyHttpApi');

    const jwtAuthorizer = new apigwv2_authorizers.HttpJwtAuthorizer(
      'JwtAuthorizer',
      SIDECAR_ISSUER,
      {
        jwtAudience: [SIDECAR_AUDIENCE],
        authorizerName: 'IntegG3JwtAuth',
        identitySource: ['$request.header.Authorization'],
      }
    );

    httpApi.addRoutes({
      path: '/protected',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration(
        'ProtectedIntegration',
        protectedHandler
      ),
      authorizer: jwtAuthorizer,
    });
  }
}
