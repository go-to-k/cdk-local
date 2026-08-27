#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAssumeRoleStack } from '../lib/local-invoke-assume-role-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalInvokeAssumeRoleStack(app, integStackName('CdkLocalInvokeAssumeRoleFixture'), {
  description:
    'Fixture stack for cdkl invoke --assume-role (explicit ARN + bare auto-resolve from CFn state)',
});
