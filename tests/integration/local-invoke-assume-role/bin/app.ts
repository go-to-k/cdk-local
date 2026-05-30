#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAssumeRoleStack } from '../lib/local-invoke-assume-role-stack.ts';

const app = new cdk.App();

new LocalInvokeAssumeRoleStack(app, 'CdkLocalInvokeAssumeRoleFixture', {
  description:
    'Fixture stack for cdkl invoke --assume-role (explicit ARN + bare auto-resolve from CFn state)',
});
