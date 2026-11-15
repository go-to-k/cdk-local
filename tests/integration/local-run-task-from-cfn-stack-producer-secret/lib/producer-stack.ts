import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface ExportNames {
  readonly apiKey: string;
  readonly plain: string;
  readonly secretArn: string;
}

export interface ProducerStackProps extends cdk.StackProps {
  readonly exportNames: ExportNames;
}

/** The plain value the consumer's Command reads; it MUST reach the argv. */
export const PLAIN_VALUE = 'plain-export-value-v1';

/**
 * The Secrets Manager secret's value. A fixture constant, not a real secret:
 * verify.sh compares its digest with what the container received.
 */
export const DB_SECRET_VALUE = 'integ-db-secret-value-v1';

/**
 * Holds the secret in a NESTED stack, so the parent re-exports its ARN as
 * CDK does: `Fn::GetAtt <Nested>.Outputs.<Path>DbSecret<hash>Ref`, a name
 * the secret-name rule would misjudge (cdkd's #6333). The producer-secret
 * check must decide it by tracing the nested output (a `Ref` to the secret,
 * an ARN), so the consumer's `Secrets` `ValueFrom` still resolves.
 */
class SecretNestedStack extends cdk.NestedStack {
  readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.secret = new secretsmanager.Secret(this, 'DbSecret', {
      // A fixture constant (see DB_SECRET_VALUE), not a credential.
      secretStringValue: cdk.SecretValue.unsafePlainText(DB_SECRET_VALUE),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}

/**
 * Producer for `cdkl run-task --from-cfn-stack`'s producer-secret check
 * (go-to-k/cdkd#6339). It exports:
 *   - an AppSync API key (`AWS::AppSync::ApiKey.ApiKey`): a secret, which
 *     must never reach the `docker run` argv;
 *   - a plain literal, which must;
 *   - a nested stack's Secrets Manager ARN, a pointer that must resolve as a
 *     `Secrets` `ValueFrom`.
 */
export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProducerStackProps) {
    super(scope, id, props);

    const api = new appsync.CfnGraphQLApi(this, 'Api', {
      name: `${id}-api`,
      authenticationType: 'API_KEY',
    });
    const apiKey = new appsync.CfnApiKey(this, 'ApiKey', { apiId: api.attrApiId });

    new cdk.CfnOutput(this, 'ApiKeyExport', {
      value: apiKey.attrApiKey,
      exportName: props.exportNames.apiKey,
    });
    new cdk.CfnOutput(this, 'PlainExport', {
      value: PLAIN_VALUE,
      exportName: props.exportNames.plain,
    });

    const nested = new SecretNestedStack(this, 'SecretNested');
    new cdk.CfnOutput(this, 'SecretArnExport', {
      value: nested.secret.secretArn,
      exportName: props.exportNames.secretArn,
    });
  }
}
