import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Runtime,
  AgentRuntimeArtifact,
  AgentCoreRuntime,
} from 'aws-cdk-lib/aws-bedrockagentcore';

export interface LocalInvokeAgentCoreFromS3StackProps extends cdk.StackProps {
  /** Literal S3 bucket holding the uploaded fromS3 code bundle. */
  readonly bundleBucket: string;
  /** Literal S3 object key of the uploaded bundle ZIP. */
  readonly bundleKey: string;
}

/**
 * Fixture stack for the `cdkl invoke-agentcore` fromS3 integ test.
 *
 * Uses the stable L2 `Runtime` construct + `AgentRuntimeArtifact.fromS3` — the
 * shape a real user authors for a pre-existing S3 bundle. The bucket + key are
 * literal context values (verify.sh creates the bucket + uploads the zipped
 * `code-agent/` first), so the synthesized template carries a literal
 * `Code.S3.Bucket` / `Code.S3.Prefix` — the fromS3 shape cdk-local resolves.
 *
 * No CloudFormation deploy: `cdkl invoke-agentcore` downloads the bundle from
 * S3, extracts it, runs the same from-source build the fromCodeAsset path uses
 * (pip install + run the entrypoint), and the entrypoint self-serves the 8080
 * HTTP contract.
 */
export class LocalInvokeAgentCoreFromS3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LocalInvokeAgentCoreFromS3StackProps) {
    super(scope, id, props);

    new Runtime(this, 'S3Agent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromS3(
        { bucketName: props.bundleBucket, objectKey: props.bundleKey },
        AgentCoreRuntime.PYTHON_3_12,
        ['app.py']
      ),
      environmentVariables: { GREETING: 'hello-from-s3' },
    });
  }
}
