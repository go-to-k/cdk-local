#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { LocalStartCloudFrontLambdaUrlStack } from '../lib/local-start-cloudfront-lambda-url-stack.ts';

const app = new cdk.App();

new LocalStartCloudFrontLambdaUrlStack(app, 'CdkLocalStartCloudFrontLambdaUrlFixture', {
  description: 'Fixture stack for cdkl start-cloudfront Lambda Function URL origin integ test (#376)',
});

// An unrelated second stack (#798): with more than one stack in the assembly, a
// bare-logical-id resolution of the Function URL origin's backing function is
// refused ("Multiple stacks in app ... missing a stack prefix"). Never deployed.
const other = new cdk.Stack(app, 'CdkLocalStartCloudFrontLambdaUrlUnrelated');
new sqs.Queue(other, 'Unrelated');
