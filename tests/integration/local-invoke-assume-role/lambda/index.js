// Returns the caller identity STS reports for whatever AWS credentials
// reached the container. The verify.sh harness greps for the
// "assumed-role/<RoleName>/<session>" pattern that --assume-role
// produces, and for the developer's plain user ARN in the baseline
// (no --assume-role) case.
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

exports.handler = async () => {
  const sts = new STSClient({});
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return {
    arn: identity.Arn,
    accountId: identity.Account,
    userId: identity.UserId,
  };
};
