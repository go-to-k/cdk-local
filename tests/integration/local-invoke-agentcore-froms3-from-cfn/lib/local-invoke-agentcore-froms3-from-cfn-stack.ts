import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  Runtime,
  AgentRuntimeArtifact,
  AgentCoreRuntime,
} from 'aws-cdk-lib/aws-bedrockagentcore';

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
 */
export class LocalInvokeAgentCoreFromS3FromCfnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bundleBucket = new s3.Bucket(this, 'BundleBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new Runtime(this, 'S3Agent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromS3(
        { bucketName: bundleBucket.bucketName, objectKey: 'bundles/agent.zip' },
        AgentCoreRuntime.PYTHON_3_12,
        ['app.py']
      ),
      environmentVariables: { GREETING: 'hello-from-s3-ref' },
    });

    // Expose the deployed bucket name so verify.sh can upload the bundle to
    // the same bucket the Ref will resolve to under --from-cfn-stack.
    new cdk.CfnOutput(this, 'BundleBucketName', {
      value: bundleBucket.bucketName,
      description: 'Physical name of the fromS3 bundle bucket (Ref target).',
    });
  }
}
