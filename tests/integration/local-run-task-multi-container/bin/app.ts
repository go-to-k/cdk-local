#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskMultiStack } from '../lib/local-run-task-multi-stack.ts';

const app = new cdk.App();

new LocalRunTaskMultiStack(app, 'CdkLocalRunTaskMultiFixture', {
  description: 'Fixture stack for cdkl run-task multi-container integ test',
});
