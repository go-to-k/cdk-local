#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontExtBucketFromCfnStackStack } from '../lib/local-start-cloudfront-extbucket-from-cfn-stack-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalStartCloudFrontExtBucketFromCfnStackStack(app, integStackName('CdkLocalStartCfExtBucketFromCfnFixture'), {
  description:
    'Fixture for cdkl start-cloudfront --from-cfn-stack (GetDistributionConfig external-bucket resolution) integ test',
});
