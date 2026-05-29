#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAgentStack } from '../lib/local-invoke-agent-stack.ts';

const app = new cdk.App();

new LocalInvokeAgentStack(app, 'CdkLocalInvokeAgentFixture', {
  description: 'Fixture stack for cdkl invoke-agent integ test',
});
