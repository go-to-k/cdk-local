#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskEcrPullStack } from '../lib/local-run-task-ecr-pull-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalRunTaskEcrPullStack(app, integStackName('CdkLocalRunTaskEcrPullFixture'), {
  description:
    'Fixture stack for cdkl run-task pulling a private ECR image through every registry host form',
});
