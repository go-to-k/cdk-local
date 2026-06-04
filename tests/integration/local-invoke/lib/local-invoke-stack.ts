import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkl invoke` integ test.
 *
 * Three Lambdas:
 *   - `EchoHandler` — asset-backed Node.js function (a DIRECTORY asset) that
 *     echoes its event plus the value of an env var. Exercises the
 *     already-unzipped asset-path bind-mount code path AND the env-var
 *     resolution code path.
 *   - `InlineHandler` — `Code.ZipFile` inline function. Exercises the
 *     inline-code materialization code path.
 *   - `ZipAssetHandler` — asset-backed function whose `Code.fromAsset` points
 *     at a `.zip` FILE (not a directory). CDK stages it as `asset.<hash>.zip`
 *     and `aws:asset:path` points at the zip file, so this exercises the
 *     zip-asset extract-then-bind-mount code path. The zip is built from the
 *     same `lambda/index.js` by verify.sh before synth.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only.
 */
export class LocalInvokeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    new lambda.Function(this, 'InlineHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async (event) => ({ inlineEcho: event });`
      ),
      timeout: cdk.Duration.seconds(10),
    });

    // `Code.fromAsset` pointing at a `.zip` FILE — CDK keeps it zipped and
    // `aws:asset:path` points at `asset.<hash>.zip`. verify.sh builds
    // `zip-lambda.zip` from `lambda/index.js` before synth.
    new lambda.Function(this, 'ZipAssetHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../zip-lambda.zip')),
      environment: {
        GREETING: 'from-zip-asset',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
