#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontExtBucketFromCfnStackStack } from '../lib/local-start-cloudfront-extbucket-from-cfn-stack-stack.ts';

const app = new cdk.App();

new LocalStartCloudFrontExtBucketFromCfnStackStack(app, 'CdkLocalStartCfExtBucketFromCfnFixture', {
  description:
    'Fixture for cdkl start-cloudfront --from-cfn-stack (GetDistributionConfig external-bucket resolution) integ test',
});
