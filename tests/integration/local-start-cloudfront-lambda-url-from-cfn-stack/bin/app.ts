#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontLambdaUrlFromCfnStackStack } from '../lib/local-start-cloudfront-lambda-url-from-cfn-stack-stack.ts';

const app = new cdk.App();

new LocalStartCloudFrontLambdaUrlFromCfnStackStack(app, 'CdkLocalStartCfFnUrlFromCfnFixture', {
  description: 'Fixture stack for cdkl start-cloudfront --from-cfn-stack (Lambda Function URL origin) integ test',
});
