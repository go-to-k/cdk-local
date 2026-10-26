import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { CfnMicrovmImage } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The literal the producer exports (kept in sync with verify.sh). */
export const SHARED_VALUE = 'shared-from-microvm-producer';

export interface ProducerStackProps extends cdk.StackProps {
  readonly exportName: string;
  /** Lane-unique name of the producer's SSM parameter. */
  readonly parameterName: string;
}

/**
 * Exports one literal, consumed through `Fn::ImportValue`. The stack holds a
 * real resource (an SSM parameter carrying the literal): the CDK CLI skips a
 * stack with no resources, which would leave the export uncreated.
 */
export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProducerStackProps) {
    super(scope, id, props);
    const shared = new ssm.StringParameter(this, 'SharedParam', {
      parameterName: props.parameterName,
      stringValue: SHARED_VALUE,
    });
    new cdk.CfnOutput(this, 'SharedValue', {
      value: shared.stringValue,
      exportName: props.exportName,
    });
  }
}

export interface MicrovmConsumerStackProps extends cdk.StackProps {
  readonly exportName: string;
  readonly imageName: string;
  readonly baseImageVersion: string;
}

/**
 * One MicroVM image whose `EnvironmentVariables` carry the three intrinsic
 * shapes `--from-cfn-stack` treats differently:
 *
 * - `REF_VALUE` — `Ref` to a same-stack SSM parameter: resolved to its
 *   deployed physical id.
 * - `IMPORTED_VALUE` — `Fn::ImportValue` of the producer's export: resolved
 *   through `ListExports`.
 * - `GETATT_VALUE` — `Fn::GetAtt` of the build role's `Arn`: NOT resolved
 *   (ListStackResources returns physical ids only), so it is warned and
 *   dropped.
 *
 * The image really builds in the cloud (CloudFormation waits for it): the
 * build role reads the code asset from the bootstrap bucket and writes logs.
 */
export class MicrovmConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MicrovmConsumerStackProps) {
    super(scope, id, props);

    const code = new s3assets.Asset(this, 'Code', { path: path.join(here, '..', 'app') });
    const refParam = new ssm.StringParameter(this, 'RefParam', {
      stringValue: 'the-value-is-irrelevant-the-name-is-asserted',
    });
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    // The image build assumes the role with session tags.
    buildRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      })
    );
    code.grantRead(buildRole);
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      })
    );

    const env: Record<string, string> = {
      STATIC_VALUE: 'always-the-same',
      REF_VALUE: refParam.parameterName,
      IMPORTED_VALUE: cdk.Fn.importValue(props.exportName),
      GETATT_VALUE: buildRole.roleArn,
    };
    const image = new CfnMicrovmImage(this, 'Image', {
      name: props.imageName,
      description: 'cdkl start-microvm --from-cfn-stack fixture image',
      baseImageArn: cdk.Fn.sub('arn:${AWS::Partition}:lambda:${AWS::Region}:aws:microvm-image:al2023-1'),
      baseImageVersion: props.baseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: { uri: code.s3ObjectUrl },
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      resources: [{ minimumMemoryInMiB: 2048 }],
      additionalOsCapabilities: [],
      egressNetworkConnectors: [],
      logging: {},
      environmentVariables: Object.entries(env).map(([key, value]) => ({ key, value })),
      hooks: {
        port: 9001,
        microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: 300 },
      },
    });
    // The build reads the asset with the role's policy, so the policy must exist first.
    image.node.addDependency(buildRole);
  }
}
