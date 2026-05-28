// Echoes back the env vars the container saw. The integ asserts that
// TABLE_NAME is the deployed DynamoDB table's actual physical name,
// SIBLING_ARN is the deployed sibling function's actual ARN, and DB_HOST
// is the value of the SSM parameter the AWS::SSM::Parameter::Value<String>
// CFn parameter points at (issue #94) — not the unresolved intrinsic shape.
exports.handler = async (event) => {
  return {
    tableName: process.env.TABLE_NAME ?? 'unset',
    siblingArn: process.env.SIBLING_ARN ?? 'unset',
    staticValue: process.env.STATIC_VALUE ?? 'unset',
    dbHost: process.env.DB_HOST ?? 'unset',
    event,
  };
};
