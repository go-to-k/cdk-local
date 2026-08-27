import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture.
 *
 * A function that declares no `architecture` defaults to `X86_64`, so on an
 * arm64 host cdk-local pins `--platform linux/amd64` and the container runs
 * under CPU emulation -- where the Go RIE in the `public.ecr.aws/lambda/*`
 * base images faults intermittently (issue #560; extended to the remaining
 * fixtures by issue #569).
 *
 * See the note on `EdgeFn` below: this fixture's Lambda is a Lambda@Edge
 * function, which real AWS restricts to x86_64, so declaring the host arch
 * here is a deliberate, measured deviation rather than the routine change it
 * is everywhere else.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

/**
 * Lambda@Edge fixture for `cdkl start-cloudfront` (#400). The distribution's
 * default behavior wires ONE Lambda function to BOTH the `viewer-request` and
 * `viewer-response` event types (a single warm RIE container is booted). The
 * function branches on `cf.config.eventType`:
 *
 *   - viewer-request: `/go` -> a generated `302` redirect to `/` (the
 *     request-stage short-circuit); any other path continues to the origin;
 *   - viewer-response: stamps an `x-edge-stamp` response header (the
 *     response-stage modification, visible to the client).
 *
 * The S3 origin content (`index.html`) is served from the local BucketDeployment
 * asset; only the Lambda@Edge function runs in Docker.
 */
export class LocalStartCloudFrontEdgeStack extends cdk.Stack {
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

    // Declares the HOST architecture, and this fixture is the one place in
    // the repo where that is a JUDGEMENT CALL rather than the obvious move.
    //
    // Real AWS restricts Lambda@Edge to x86_64: a function attached to a
    // distribution through `edgeLambdas` cannot be arm64. So on paper this
    // fixture should pin x86_64, and CDK would not stop it either way -- it
    // does NOT reject arm64 here at synth.
    //
    // It declares the host arch anyway, because the pin was measured and it
    // is not free. Ten runs on an arm64 host, five per arm:
    //
    //   pinned x86_64        4/5 passed, 1 emulation warning
    //   host architecture    5/5 passed, 0 emulation warnings
    //
    // and a sixth pinned run failed with the Go RIE dying mid-request --
    // `fatal error: found pointer to free object`, then `GET /go` returning
    // 500 instead of the edge function's 302. That is issue #560 exactly, in
    // the last fixture of the issue that exists to remove it.
    //
    // What decides it: this fixture NEVER DEPLOYS. `verify.sh` runs
    // `cdkl start-cloudfront` against the synthesized assembly, so the
    // `Architectures` value is read by cdk-local alone and AWS never sees the
    // template. Trading a reproducible local fault for fidelity to a
    // constraint nothing here enforces is the wrong way round.
    //
    // If this fixture ever grows a `cdk deploy`, this decision reverses:
    // pin x86_64 and accept the emulation, because then the constraint is
    // real. **A production Lambda@Edge stack must pin x86_64** -- do not copy
    // the line below into one.
    const edgeFn = new lambda.Function(this, 'EdgeFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'exports.handler = async (event) => {',
          '  const cf = event.Records[0].cf;',
          "  if (cf.config.eventType === 'viewer-response') {",
          "    cf.response.headers['x-edge-stamp'] = [{ key: 'X-Edge-Stamp', value: 'edge' }];",
          '    return cf.response;',
          '  }',
          "  if (cf.request.uri === '/go') {",
          '    return {',
          "      status: '302',",
          "      statusDescription: 'Found',",
          "      headers: { location: [{ key: 'Location', value: '/' }] },",
          '    };',
          '  }',
          '  return cf.request;',
          '};',
        ].join('\n')
      ),
    });

    new cloudfront.Distribution(this, 'EdgeDist', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        edgeLambdas: [
          {
            functionVersion: edgeFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
          {
            functionVersion: edgeFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_RESPONSE,
          },
        ],
      },
    });
  }
}
