import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Runtime, AgentRuntimeArtifact, ProtocolType } from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `cdkl start-agentcore` integ test.
 *
 * Three AgentCore `Runtime`s, one per warm-serve protocol shape (issue #454):
 *
 * - `EchoAgent` (HTTP) — container (from `agent/`) serves GET /ping + the
 *   bidirectional /ws WebSocket on 8080. The /ws handler echoes the first
 *   frame, and when that frame carries `{"loop": true}` it enters a REPL mode
 *   that echoes each subsequent frame as `loop-echo:<text>` until the client
 *   closes.
 * - `McpAgent` (MCP) — container (from `mcp-agent/`) serves POST /mcp on 8000.
 * - `A2aAgent` (A2A) — container (from `a2a-agent/`) serves POST / on 9000.
 *
 * No AWS deploy required. The integ exercises the local-build warm-serve path:
 * `cdkl start-agentcore` builds the asset, boots the container ONCE, waits for
 * readiness, and serves the protocol's contract against the SAME warm
 * container — for HTTP that is POST /invocations + GET /ping plus the host /ws
 * bridge; for MCP / A2A that is the JSON-RPC contract path with no /ws.
 */
export class LocalStartAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new Runtime(this, 'EchoAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-agent' },
    });

    new Runtime(this, 'McpAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../mcp-agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      protocolConfiguration: ProtocolType.MCP,
    });

    new Runtime(this, 'A2aAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../a2a-agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      protocolConfiguration: ProtocolType.A2A,
    });
  }
}
