#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStudioFromCfnStackStack } from '../lib/local-studio-from-cfn-stack-stack.ts';

const app = new cdk.App();

new LocalStudioFromCfnStackStack(app, 'CdkLocalStudioFromCfnStackFixture', {
  description: 'Fixture stack for cdkl studio --from-cfn-stack ECS pin classification (issue #354)',
});
