import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
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
 *
 * This fixture's Lambda is a `DockerImageFunction`, so the declared
 * architecture drives the image BUILD as well as the run: cdk-local passes
 * the same `--platform` to `docker build` (see `buildContainerImage`). The
 * Dockerfile starts `FROM public.ecr.aws/lambda/nodejs:20`, which is
 * multi-arch, and nothing in the image is a prebuilt arch-specific binary,
 * so building at the host arch is safe. A fixture whose Dockerfile pulled
 * an amd64-only base, or COPYied in a cross-compiled executable, would NOT
 * be safe to convert -- it would belong with `local-invoke-provided`.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * Fixture stack for `cdkl invoke` container-Lambda integ test (PR 5).
 *
 * Single Lambda — `EchoHandler` — built from a local Dockerfile in
 * `docker/`. The Dockerfile starts FROM the AWS Lambda Node.js base image
 * (which bundles RIE), copies a tiny `app.js` into `${LAMBDA_TASK_ROOT}`,
 * and uses CMD `["app.handler"]` so the image's default entrypoint
 * (`/lambda-entrypoint.sh`) routes to RIE on :8080.
 *
 * No AWS deploy required. The integ exercises:
 *   1. Local-build path: `cdkl invoke` finds the asset via the cdk.out
 *      asset manifest, calls `docker build`, then runs the resulting image.
 *   2. `--event` payload pass-through.
 *   3. `--env-vars` SAM-shape override.
 */
export class LocalInvokeContainerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.DockerImageFunction(this, 'EchoHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker')),
      architecture: HOST_ARCHITECTURE,
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
