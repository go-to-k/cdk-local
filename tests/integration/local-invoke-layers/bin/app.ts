#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeLayersStack } from '../lib/local-invoke-layers-stack.ts';

const app = new cdk.App();

new LocalInvokeLayersStack(app, 'CdkLocalInvokeLayersFixture', {
  description: 'Fixture stack for cdkl invoke Lambda Layers integ test',
});
