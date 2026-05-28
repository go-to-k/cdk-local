#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeFromCfnStackLargeStack } from '../lib/local-invoke-from-cfn-stack-large-stack-stack.ts';

const app = new cdk.App();

new LocalInvokeFromCfnStackLargeStack(app, 'CdkLocalInvokeFromCfnStackLargeFixture', {
  description: 'Fixture stack (>100 resources) for cdkl invoke --from-cfn-stack pagination',
});
