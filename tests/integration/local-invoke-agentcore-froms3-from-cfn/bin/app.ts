#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAgentCoreFromS3FromCfnStack } from '../lib/local-invoke-agentcore-froms3-from-cfn-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalInvokeAgentCoreFromS3FromCfnStack(app, integStackName('CdkLocalInvokeAgentCoreFromS3FromCfnFixture'), {
  description: 'Fixture stack for cdkl invoke-agentcore fromS3 + --from-cfn-stack integ test',
});
