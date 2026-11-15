/**
 * Which `Fn::GetAtt` attributes are or hold a secret: the one rule behind the
 * ECS argv check of a same-stack read (`ecs-task-resolver.ts`'s
 * `secretAttributeRead`) and the `--from-cfn-stack` producer-secret check of
 * a cross-stack one (`cfn-producer-secrets.ts`), so the two cannot disagree.
 * The rule is cdkd's (`isSensitiveAttributeName` / `isSecretValuedAttribute`).
 */

/**
 * Attribute names that look credential-bearing, minus the ones that name an
 * identifier of the secret rather than the secret (`SecretArn`, `SecretId`,
 * `SecretName`, ...).
 */
const SECRET_ATTRIBUTE_NAME = /secret|password|credential/i;
const NON_SECRET_ATTRIBUTE_SUFFIX = /(arn|id|name|url|alias|status)$/i;

/**
 * Attributes whose VALUE is a secret although their name does not look like
 * one, keyed by resource type and read by own key. `AWS::AppSync::ApiKey`'s
 * `ApiKeyId` is CloudFormation's other attribute for the same `x-api-key`
 * value as `ApiKey`.
 */
const SECRET_VALUED_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ['AWS::AppSync::ApiKey', ['ApiKey', 'ApiKeyId']],
  ['AWS::EC2::IpamExternalResourceVerificationToken', ['TokenValue']],
  ['AWS::IVS::StreamKey', ['Value']],
]);

/** Whether an attribute NAME (dotted, as `Fn::GetAtt` spells it) looks credential-bearing. */
export function isSecretAttributeName(attribute: string): boolean {
  return SECRET_ATTRIBUTE_NAME.test(attribute) && !NON_SECRET_ATTRIBUTE_SUFFIX.test(attribute);
}

/** Whether `attribute` of `resourceType` records a secret VALUE its name does not show. */
export function isSecretValuedAttribute(resourceType: unknown, attribute: string): boolean {
  if (typeof resourceType !== 'string') return false;
  return SECRET_VALUED_ATTRIBUTES.get(resourceType)?.includes(attribute) === true;
}
