#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskEnvVarsStack } from '../lib/local-run-task-env-vars-stack.ts';

const app = new cdk.App();

new LocalRunTaskEnvVarsStack(app, 'CdkLocalRunTaskEnvVarsFixture', {
  description: 'Fixture stack for cdkl run-task --env-vars overlay integ test',
});
