import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import {
  Runtime,
  AgentRuntimeArtifact,
  RuntimeAuthorizerConfiguration,
} from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `cdkl invoke-agentcore` integ test.
 *
 * Uses the stable L2 `Runtime` construct + `AgentRuntimeArtifact.fromAsset`
 * — the shape real users author — whose container is built from a local
 * Dockerfile in `agent/`. The container serves the AgentCore HTTP contract
 * on 8080 (GET /ping + POST /invocations) and the `/invocations` handler
 * echoes the request body, the received session-id header, and the injected
 * `GREETING` env var so verify.sh can assert each.
 *
 * No AWS deploy required. The integ exercises the local-build path:
 * `cdkl invoke-agentcore` finds the asset via the cdk.out asset manifest,
 * `docker build`s it (linux/arm64, the AgentCore-required arch), runs it on
 * 8080, waits for /ping, and POSTs to /invocations. The L2 construct
 * auto-creates the execution role; the default invoke path forwards the
 * developer's shell credentials, so that role is never assumed locally.
 */
export class LocalInvokeAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new Runtime(this, 'EchoAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-agent' },
    });

    // A JWT-protected runtime for the inbound-auth tests. The discovery URL
    // is deliberately unreachable (localhost:1), so `cdkl invoke-agentcore`
    // falls back to JWKS/discovery pass-through (accept + warn) — exercising
    // the auth wiring end-to-end offline: a missing token is rejected before
    // the container starts, `--no-verify-auth` skips, and `--bearer-token` is
    // forwarded to /invocations.
    new Runtime(this, 'ProtectedAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-agent' },
      authorizerConfiguration: RuntimeAuthorizerConfiguration.usingJWT(
        'https://127.0.0.1:1/.well-known/openid-configuration',
        ['client-9'],
        ['aud-1']
      ),
    });
  }
}
