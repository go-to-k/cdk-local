#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontS3FromCfnStackStack } from '../lib/local-start-cloudfront-s3-from-cfn-stack-stack.ts';

const app = new cdk.App();

new LocalStartCloudFrontS3FromCfnStackStack(app, 'CdkLocalStartCfS3FromCfnFixture', {
  description:
    'Fixture stack for cdkl start-cloudfront --from-cfn-stack (deployed-S3 read-through origin) integ test',
});
