import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal CDK stack used by the cdkl-invoke demo GIF.
 *
 * A single asset-backed Node.js Lambda that returns a clearly-recognisable
 * JSON payload so the recorded output is readable in the GIF without
 * scrolling. No AWS deploy required — cdkl drives the synthesized
 * `cdk.out` directly.
 */
export class CdklDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'Hello from cdk-local!',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
