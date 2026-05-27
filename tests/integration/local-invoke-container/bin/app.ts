#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeContainerStack } from '../lib/local-invoke-container-stack.ts';

const app = new cdk.App();

new LocalInvokeContainerStack(app, 'CdkdLocalInvokeContainerFixture', {
  description: 'Fixture stack for cdkl invoke container Lambda integ test',
});
