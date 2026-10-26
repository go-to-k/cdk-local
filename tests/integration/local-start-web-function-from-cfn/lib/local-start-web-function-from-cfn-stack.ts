import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { CfnWebFunction, CfnWebFunctionRevision } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The literal the producer exports (kept in sync with verify.sh). */
export const SHARED_VALUE = 'shared-from-webfn-producer';

export interface ProducerStackProps extends cdk.StackProps {
  readonly exportName: string;
}

/** Exports one literal, consumed through `Fn::ImportValue`. */
export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProducerStackProps) {
    super(scope, id, props);
    new cdk.CfnOutput(this, 'SharedValue', { value: SHARED_VALUE, exportName: props.exportName });
  }
}

export interface WebFunctionConsumerStackProps extends cdk.StackProps {
  readonly exportName: string;
  readonly functionName: string;
}

/**
 * One web function with ONE revision (so the function itself is the target),
 * whose `ServiceConfig.EnvironmentVariables` carry the three intrinsic shapes
 * `--from-cfn-stack` treats differently:
 *
 * - `REF_VALUE` — `Ref` to a same-stack SSM parameter: resolved to its
 *   deployed physical id (the CloudFormation-generated parameter name).
 * - `IMPORTED_VALUE` — `Fn::ImportValue` of the producer's export: resolved
 *   through `ListExports`.
 * - `GETATT_VALUE` — `Fn::GetAtt` of the execution role's `Arn`: NOT resolved
 *   (ListStackResources returns physical ids only, and start-web-function
 *   does not fall back to a Lambda API lookup), so it is warned and dropped.
 *
 * The execution role trusts the account root as well as Lambda, so a bare
 * `--assume-role` (resolving the GetAtt ExecutionRoleArn by the role's
 * deployed name and Path) can be assumed by the developer's credentials.
 */
export class WebFunctionConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebFunctionConsumerStackProps) {
    super(scope, id, props);

    const code = new s3assets.Asset(this, 'Code', { path: path.join(here, '..', 'web') });
    const refParam = new ssm.StringParameter(this, 'RefParam', {
      stringValue: 'the-value-is-irrelevant-the-name-is-asserted',
    });
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.AccountRootPrincipal()
      ),
      // A non-root Path, so the bare --assume-role ARN must carry it.
      path: '/webfn-from-cfn/',
    });

    const fn = new CfnWebFunction(this, 'WebFn', { functionName: props.functionName });
    new CfnWebFunctionRevision(this, 'Rev', {
      functionName: fn.ref,
      buildConfig: {
        codeConfig: { s3Object: { bucket: code.s3BucketName, key: code.s3ObjectKey } },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        environmentVariables: {
          STATIC_VALUE: 'always-the-same',
          REF_VALUE: refParam.parameterName,
          IMPORTED_VALUE: cdk.Fn.importValue(props.exportName),
          GETATT_VALUE: role.roleArn,
        },
      },
    });
  }
}
