#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbCognitoFromCfnStackStack } from '../lib/local-start-alb-cognito-from-cfn-stack-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalStartAlbCognitoFromCfnStackStack(app, integStackName('CdkLocalStartAlbCognitoFromCfnStackFixture'), {
  description: 'Fixture stack for cdkl start-alb authenticate-cognito resolved from the deployed stack (issue #1004)',
});
