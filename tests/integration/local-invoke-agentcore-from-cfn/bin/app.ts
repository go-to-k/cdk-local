#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAgentCoreFromCfnStack } from '../lib/local-invoke-agentcore-from-cfn-stack.ts';

const app = new cdk.App();

new LocalInvokeAgentCoreFromCfnStack(app, 'CdkLocalInvokeAgentCoreFromCfnFixture', {
  description: 'Fixture stack for cdkl invoke-agentcore --from-cfn-stack integ test',
});
