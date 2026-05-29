import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Runtime, AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SSM parameter the fixture's `verify.sh` `put-parameter`s as a `String`
 * BEFORE `cdk deploy` (CloudFormation resolves `AWS::SSM::Parameter::Value`
 * parameters at deploy start). Kept in sync with verify.sh's GREETING_PARAM.
 */
const SSM_GREETING_PARAM = '/cdkl-integ/invoke-agentcore-from-cfn/greeting';

/**
 * SSM parameter for the SecureString case. `verify.sh` creates it as a plain
 * `String` BEFORE deploy (CloudFormation rejects an
 * `AWS::SSM::Parameter::Value<String>` template parameter that points at a
 * SecureString), then SWAPS it to a `SecureString` AFTER deploy. cdkl resolves
 * it directly via SSM `GetParameters(WithDecryption)` at invoke time, so it
 * sees the SecureString type and must route the decrypted value off the
 * `docker run` argv. Kept in sync with verify.sh's API_KEY_PARAM.
 */
const SSM_API_KEY_PARAM = '/cdkl-integ/invoke-agentcore-from-cfn/api-key';

/**
 * Fixture stack for `cdkl invoke-agentcore --from-cfn-stack` (issue #130).
 *
 * One AgentCore Runtime (fromAsset — a plain Node agent serving the 8080 HTTP
 * contract) whose env references two `AWS::SSM::Parameter::Value<String>` CFn
 * parameters (a plain String + a swapped-to-SecureString) plus a literal. Under
 * `--from-cfn-stack`, cdkl resolves both SSM values into the LOCALLY-run agent's
 * env and keeps the decrypted SecureString off the docker argv. Without the
 * flag both intrinsic env vars warn-and-drop.
 *
 * `cdkl invoke-agentcore --from-cfn-stack` runs the agent locally and only
 * READS this deployed stack's state, so the runtime need not be healthy — it
 * only has to exist. Teardown is `cdk destroy` (+ verify.sh deletes the SSM
 * params it created).
 */
export class LocalInvokeAgentCoreFromCfnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new Runtime(this, 'EchoAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: {
        // A literal env var — confirms --from-cfn-stack doesn't break the
        // normal-case passthrough.
        STATIC_VALUE: 'always-the-same',
        // Ref to an AWS::SSM::Parameter::Value<String> CFn parameter (issue
        // #130 / #94). Without --from-cfn-stack it warns-and-drops; with it,
        // cdkl resolves the value from SSM and substitutes it (inline on argv —
        // the plain-String control).
        GREETING: ssm.StringParameter.valueForStringParameter(this, SSM_GREETING_PARAM),
        // Ref to a second SSM param verify.sh swaps to a SecureString after
        // deploy (issue #130 / #99). Under --from-cfn-stack cdkl resolves it
        // with WithDecryption and routes the decrypted value off the docker
        // argv (value-less `-e API_KEY`).
        API_KEY: ssm.StringParameter.valueForStringParameter(this, SSM_API_KEY_PARAM),
      },
    });
  }
}
