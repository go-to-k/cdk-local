import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';

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
 *
 * This fixture's Lambda is a `DockerImageFunction`, so the declared
 * architecture drives the image BUILD as well as the run: cdk-local passes
 * the same `--platform` to `docker build` (see `buildContainerImage`). The
 * Dockerfile starts `FROM public.ecr.aws/lambda/nodejs:20`, which is
 * multi-arch, and copies in no prebuilt arch-specific binary, so building at
 * the host arch is safe.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * Fixture stack for the `cdkl start-api` container-Lambda integ
 * test (closes #453).
 *
 * Single HTTP API v2 with one GET / route backed by a
 * `lambda.DockerImageFunction` built from a local Dockerfile under
 * `docker/`. The Dockerfile starts FROM the AWS Lambda Node.js base
 * image (which bundles RIE) and copies a tiny `app.js` into
 * `${LAMBDA_TASK_ROOT}` with `CMD ["app.handler"]` — same shape as the
 * `local-invoke-container` fixture, exercised here through the
 * `cdkl start-api` HTTP server instead of a one-shot invoke.
 *
 * No AWS deploy required. The integ exercises end-to-end:
 *   1. `cdkl start-api` discovers the HTTP API v2 route + the
 *      backing container Lambda.
 *   2. The container-pool's IMAGE branch (PR closing #453) runs
 *      `docker build` against the asset entry, NO bind-mount at
 *      /var/task, and `--platform` threaded through. That platform is
 *      whatever the function's `Architectures` declares -- since issue
 *      #569 that is the HOST arch, so it is `linux/arm64` on an Apple
 *      Silicon dev host and `linux/amd64` on an x86_64 CI runner. It was
 *      hardcoded as `linux/amd64` in this comment when the fixture
 *      declared no architecture and always defaulted to x86_64.
 *   3. A `curl http://127.0.0.1:<port>/` against the HTTP server
 *      reaches the container Lambda via RIE and the JSON response
 *      includes the `fromContainer: true` marker the app.js emits.
 */
export class LocalStartApiContainerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.DockerImageFunction(this, 'EchoHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker')),
      architecture: HOST_ARCHITECTURE,
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    const api = new apigwv2.HttpApi(this, 'Api');
    api.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2int.HttpLambdaIntegration('EchoIntegration', fn),
    });
  }
}
