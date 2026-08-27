#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeFromCfnStackStack } from '../lib/local-invoke-from-cfn-stack-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalInvokeFromCfnStackStack(app, integStackName('CdkLocalInvokeFromCfnStackFixture'), {
  description: 'Fixture stack for cdkl invoke --from-cfn-stack integ test',
});
