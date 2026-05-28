import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkl start-api --watch` integ test.
 *
 * No AWS deploy required — the integ exercises the synthesized cdk.out
 * locally against Docker + RIE.
 *
 * One Lambda (`PingHandler`) behind a NONE-auth Function URL. verify.sh
 * boots `cdkl start-api --watch`, asserts the handler's `version`
 * marker, edits `lambda-ping/index.js` to bump the marker, and asserts
 * the served response changes after a single hot reload — proving the
 * watcher re-synths the CDK app source and swaps the container without a
 * restart, and that the reload's own `cdk.out/` re-synth writes do NOT
 * re-trigger the watcher (no loop).
 */
export class LocalStartApiWatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pingHandler = new lambda.Function(this, 'PingHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-ping')),
      timeout: cdk.Duration.seconds(10),
    });
    pingHandler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
