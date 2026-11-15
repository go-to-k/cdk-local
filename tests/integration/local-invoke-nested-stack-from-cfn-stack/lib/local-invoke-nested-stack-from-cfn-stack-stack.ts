import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run every Lambda here at the HOST's CPU architecture (issue #560): an
 * undeclared architecture defaults to X86_64 and runs under emulation on an
 * arm64 host. See `tests/unit/integ-fixture-host-architecture.test.ts`.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

function fn(scope: Construct, id: string, env: Record<string, string>): lambda.Function {
  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: HOST_ARCHITECTURE,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
    environment: env,
  });
}

/** `Stack/Inner/Deeper/DeepFn`: both values are two hops away (Inner's bucket, the root's queue). */
class DeeperStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, b: s3.Bucket, q: sqs.Queue) {
    super(scope, id);
    fn(this, 'DeepFn', { PARENT_BUCKET: b.bucketName, ROOT_QUEUE: q.queueUrl });
  }
}

/** `Stack/Inner/*`: a bucket of its own plus the root stack's queue passed in as a template parameter. */
class InnerStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, q: sqs.Queue) {
    super(scope, id);
    const b = new s3.Bucket(this, 'B', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    fn(this, 'InnerFn', { BUCKET: b.bucketName, QUEUE_URL: q.queueUrl });
    new DeeperStack(this, 'Deeper', b, q);
  }
}

/**
 * Fixture for `cdkl invoke --from-cfn-stack` against a deployed stack with
 * NESTED stacks (go-to-k/cdk-local#986): a nested stack's template parameters
 * (parent values CDK passes in) must resolve from the PARENT's deployed state.
 */
export class LocalInvokeNestedStackFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const q = new sqs.Queue(this, 'PQ');
    new InnerStack(this, 'Inner', q);
  }
}
