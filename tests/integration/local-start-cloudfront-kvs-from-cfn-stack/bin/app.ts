#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontKvsFromCfnStackStack } from '../lib/local-start-cloudfront-kvs-from-cfn-stack-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalStartCloudFrontKvsFromCfnStackStack(app, integStackName('CdkLocalStartCfKvsFromCfnFixture'), {
  description: 'Fixture stack for cdkl start-cloudfront --from-cfn-stack (CloudFront KeyValueStore) integ test',
});
