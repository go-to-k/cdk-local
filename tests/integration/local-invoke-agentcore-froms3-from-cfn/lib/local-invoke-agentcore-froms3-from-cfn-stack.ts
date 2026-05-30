import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import {
  Runtime,
  AgentRuntimeArtifact,
  AgentCoreRuntime,
} from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `cdkl invoke-agentcore` fromS3 + `--from-cfn-stack`
 * integ test.
 *
 * Creates a CDK-managed `s3.Bucket` in the same stack and passes its `Ref`
 * (via `bucket.bucketName`) as the `fromS3` artifact bucket. The synthesized
 * `Code.S3.Bucket` is a `{ "Ref": "<BundleBucketLogicalId>" }` intrinsic — the
 * common "create the bundle bucket alongside the agent" pattern that the
 * literal-bucket flow of #144 can't resolve locally.
 *
 * Under `--from-cfn-stack`, `cdkl invoke-agentcore` resolves that `Ref` to the
 * deployed bucket's physical name via state and downloads the bundle from it.
 *
 * `removalPolicy: DESTROY` + `autoDeleteObjects: true` so `cdk destroy`
 * removes the bucket cleanly after the test (no manual S3 cleanup needed).
 *
 * AWS::BedrockAgentCore::Runtime validates the bundle object exists at create
 * time, so we use `BucketDeployment` (Lambda-backed custom resource) to upload
 * the bundle in the SAME deploy BEFORE the Runtime is created. The Runtime
 * `addDependency`s the BucketDeployment so CFn orders them. verify.sh zips
 * the code-agent into `bundle-source/agent.zip` BEFORE `cdk deploy` so the
 * BucketDeployment asset picks it up.
 */
export class LocalInvokeAgentCoreFromS3FromCfnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bundleBucket = new s3.Bucket(this, 'BundleBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Expose the deployed bucket name so verify.sh can read the Ref's
    // resolved physical name (used for assertions).
    new cdk.CfnOutput(this, 'BundleBucketName', {
      value: bundleBucket.bucketName,
      description: 'Physical name of the fromS3 bundle bucket (Ref target).',
    });

    // BucketDeployment unpacks the CDK asset zip and uploads each contained
    // file to `<destinationKeyPrefix>/<filename>`. verify.sh stages
    // `bundle-source/agent.zip`, so the Lambda uploads it as
    // `bundles/agent.zip` — the key the Runtime references.
    const bundleDeployment = new s3deploy.BucketDeployment(this, 'BundleUpload', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../bundle-source'))],
      destinationBucket: bundleBucket,
      destinationKeyPrefix: 'bundles',
    });

    const runtime = new Runtime(this, 'S3Agent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromS3(
        { bucketName: bundleBucket.bucketName, objectKey: 'bundles/agent.zip' },
        AgentCoreRuntime.PYTHON_3_12,
        ['app.py']
      ),
      environmentVariables: { GREETING: 'hello-from-s3-ref' },
    });
    // Force CFn to wait for the BucketDeployment custom resource to upload
    // the bundle BEFORE creating the Runtime (which validates that the
    // bundle exists at create time).
    runtime.node.addDependency(bundleDeployment);
  }
}
