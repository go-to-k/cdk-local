#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeProvidedStack } from '../lib/local-invoke-provided-stack.ts';

const app = new cdk.App();

new LocalInvokeProvidedStack(app, 'CdkLocalInvokeProvidedFixture', {
  description: 'Fixture stack for cdkl invoke provided.* + go1.x integ test',
});
