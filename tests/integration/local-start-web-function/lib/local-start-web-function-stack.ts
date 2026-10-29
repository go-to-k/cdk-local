import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import {
  CfnWebFunction,
  CfnWebFunctionEndpoint,
  CfnWebFunctionRevision,
} from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A Lambda Web Function the way a CDK user writes one today (L1s only, code
 * from an `s3assets.Asset` of a directory): one function, three revisions of
 * the SAME bundle that differ only in their `ServiceConfig` environment, and
 * one endpoint splitting 20 / 80 between V1 and V2. `RevAlt` is outside the
 * endpoint and sets `AWS_LAMBDA_NODEJS_ENTRYPOINT=alt.js`, so it is reachable
 * only through `--revision` and starts a different entry file.
 *
 * `RevDeploy` takes its code the other way a CDK user ships a bundle: a
 * `BucketDeployment` with `extract: false` copies the `web-deploy` zip into a
 * versioned bucket of the app's own, and the revision's key is
 * `Fn.select(0, upload.objectKeys)` (go-to-k/cdkd#5515). `RevExtracted` makes
 * the same selection on a deployment that extracts (the default), which no
 * object key can serve, so it is refused.
 *
 * Nothing is deployed: `cdkl start-web-function` reads the synthesized
 * template and the staged asset directory in cdk.out.
 */
export class LocalStartWebFunctionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const code = new s3assets.Asset(this, 'Code', { path: path.join(here, '..', 'web') });
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    const fn = new CfnWebFunction(this, 'WebFn', { functionName: 'cdkl-integ-web-fn' });

    const revision = (
      rid: string,
      env: Record<string, string>,
      s3Object: CfnWebFunctionRevision.S3ObjectProperty = {
        bucket: code.s3BucketName,
        key: code.s3ObjectKey,
      }
    ): CfnWebFunctionRevision =>
      new CfnWebFunctionRevision(this, rid, {
        functionName: fn.ref,
        buildConfig: {
          codeConfig: { s3Object },
          runtimeConfig: { runtime: 'nodejs24.x' },
        },
        serviceConfig: {
          executionRoleArn: role.roleArn,
          environmentVariables: env,
        },
      });

    const v1 = revision('RevV1', { REVISION_LABEL: 'v1', GREETING: 'hello-from-v1' });
    const v2 = revision('RevV2', { REVISION_LABEL: 'v2', GREETING: 'hello-from-v2' });
    revision('RevAlt', {
      REVISION_LABEL: 'alt',
      GREETING: 'hello-from-alt',
      AWS_LAMBDA_NODEJS_ENTRYPOINT: 'alt.js',
    });
    revision('RevBoom', {
      REVISION_LABEL: 'boom',
      GREETING: 'hello-from-boom',
      AWS_LAMBDA_NODEJS_ENTRYPOINT: 'boom.js',
    });

    const bucket = new s3.Bucket(this, 'CodeBucket', { versioned: true });
    const deploySource = (): s3deploy.ISource =>
      s3deploy.Source.asset(path.join(here, '..', 'web-deploy'));
    const upload = new s3deploy.BucketDeployment(this, 'Upload', {
      sources: [deploySource()],
      destinationBucket: bucket,
      extract: false,
      prune: false,
    });
    revision(
      'RevDeploy',
      { REVISION_LABEL: 'deploy' },
      { bucket: bucket.bucketName, key: cdk.Fn.select(0, upload.objectKeys) }
    );
    const extracted = new s3deploy.BucketDeployment(this, 'UploadExtracted', {
      sources: [deploySource()],
      destinationBucket: bucket,
      destinationKeyPrefix: 'extracted/',
      prune: false,
    });
    revision(
      'RevExtracted',
      { REVISION_LABEL: 'extracted' },
      { bucket: bucket.bucketName, key: cdk.Fn.select(0, extracted.objectKeys) }
    );

    new CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: fn.ref,
      endpointName: 'main',
      endpointType: 'HomeRegion',
      authType: 'ApplicationManaged',
      revisionWeights: [
        { revisionId: v1.attrRevisionId, weight: 20 },
        { revisionId: v2.attrRevisionId, weight: 80 },
      ],
    });
  }
}
