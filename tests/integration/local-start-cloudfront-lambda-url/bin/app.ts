#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontLambdaUrlStack } from '../lib/local-start-cloudfront-lambda-url-stack.ts';

const app = new cdk.App();

new LocalStartCloudFrontLambdaUrlStack(app, 'CdkLocalStartCloudFrontLambdaUrlFixture', {
  description: 'Fixture stack for cdkl start-cloudfront Lambda Function URL origin integ test (#376)',
});
