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
 * Fixture stack for the comprehensive BuildKit-Dockerfile regression integ.
 *
 * `BuildkitHandler` is built from a Dockerfile that exercises EVERY
 * BuildKit feature this PR newly forwards through cdk-local's docker build
 * path: `# syntax=docker/dockerfile:1`, multi-stage with `--target`,
 * `ARG` via `--build-arg`, heredocs (`RUN <<EOF`), `RUN --mount=type=cache`,
 * AND `RUN --mount=type=secret` via `--secret`.
 *
 * Each feature bakes a verifiable artifact into the image so the integ's
 * runtime invocation proves the flag actually flowed through:
 *   - `buildArg`: echoes the `dockerBuildArgs.GREETING_BUILD_ARG` value
 *   - `secretSha`: echoes sha256 of the file `dockerBuildSecrets.mysecret` mounted
 *   - `multiStageTarget: 'final'`: only the `final` stage exposes `app.js`,
 *     so a non-target build (or build that picked the wrong stage) would
 *     fail to load the handler
 */
export class LocalInvokeBuildkitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.DockerImageFunction(this, 'BuildkitHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker'), {
        // Multi-stage Dockerfile — picks the `final` stage explicitly.
        target: 'final',
        // ARG threaded via `--build-arg` to confirm `dockerBuildArgs` flows
        // through cdk-local unchanged (was pre-fix-supported, but verifying parity).
        buildArgs: {
          GREETING_BUILD_ARG: 'compiled-in-from-cdk',
        },
        // BuildKit `--secret` via cdk-local's new `dockerBuildSecrets` forwarding.
        // The Dockerfile's `RUN --mount=type=secret,id=mysecret` reads the
        // file at /run/secrets/mysecret during build only.
        buildSecrets: {
          mysecret: cdk.DockerBuildSecret.fromSrc('secret.txt'),
        },
      }),
      architecture: HOST_ARCHITECTURE,
      environment: {
        GREETING: 'hello-buildkit',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
