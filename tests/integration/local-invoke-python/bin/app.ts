#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokePythonStack } from '../lib/local-invoke-python-stack.ts';

const app = new cdk.App();

new LocalInvokePythonStack(app, 'CdkLocalInvokePythonFixture', {
  description: 'Fixture stack for cdkl invoke Python integ test',
});
