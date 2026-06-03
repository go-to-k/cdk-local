#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontStack } from '../lib/local-start-cloudfront-stack.ts';

const app = new cdk.App();

new LocalStartCloudFrontStack(app, 'CdkLocalStartCloudFrontFixture', {
  description: 'Fixture stack for cdkl start-cloudfront integ test (#363)',
});
