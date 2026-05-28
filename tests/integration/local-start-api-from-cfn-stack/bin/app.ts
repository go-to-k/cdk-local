#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiFromCfnStackStack } from '../lib/local-start-api-from-cfn-stack-stack.ts';

const app = new cdk.App();

new LocalStartApiFromCfnStackStack(app, 'CdkLocalStartApiFromCfnStackFixture', {
  description: 'Fixture stack for cdkl start-api --from-cfn-stack integ test',
});
