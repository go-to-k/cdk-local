// Function URL handler that echoes back (as a JSON HTTP body) the env
// vars the container saw. The integ asserts that under --from-cfn-stack
// TABLE_NAME is the deployed table name (Ref) and SIBLING_ARN is the
// deployed sibling function ARN (Fn::GetAtt .Arn, recovered via the
// deployed-env fallback), while STATIC_VALUE passes through unchanged.
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableName: process.env.TABLE_NAME ?? 'unset',
      siblingArn: process.env.SIBLING_ARN ?? 'unset',
      staticValue: process.env.STATIC_VALUE ?? 'unset',
    }),
  };
};
