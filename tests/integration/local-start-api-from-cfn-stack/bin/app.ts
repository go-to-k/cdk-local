#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiFromCfnStackStack } from '../lib/local-start-api-from-cfn-stack-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalStartApiFromCfnStackStack(app, integStackName('CdkLocalStartApiFromCfnStackFixture'), {
  description: 'Fixture stack for cdkl start-api --from-cfn-stack integ test',
});
