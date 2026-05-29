import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `cdkl invoke-agentcore` integ test.
 *
 * Single AWS::BedrockAgentCore::Runtime — `EchoAgent` — whose container is
 * built from a local Dockerfile in `agent/`. The container serves the
 * AgentCore HTTP contract on 8080 (GET /ping + POST /invocations) and the
 * `/invocations` handler echoes the request body, the received session-id
 * header, and the injected `GREETING` env var so verify.sh can assert each.
 *
 * No AWS deploy required. The integ exercises the local-build path:
 * `cdkl invoke-agentcore` finds the asset via the cdk.out asset manifest,
 * `docker build`s it, runs it on 8080, waits for /ping, and POSTs to
 * /invocations.
 *
 * RoleArn is a literal placeholder — the default invoke path forwards the
 * developer's shell credentials (no --assume-role), so the role is never
 * assumed locally.
 */
export class LocalInvokeAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const asset = new DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '../agent'),
      platform: Platform.LINUX_ARM64,
    });

    new CfnRuntime(this, 'EchoAgent', {
      agentRuntimeName: 'echo_agent',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: asset.imageUri },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      roleArn: `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/agentcore-local-fixture`,
      environmentVariables: { GREETING: 'hello-from-agent' },
    });
  }
}
