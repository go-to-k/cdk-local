#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbAuthStack } from '../lib/local-start-alb-auth-stack.ts';

const app = new cdk.App();

new LocalStartAlbAuthStack(app, 'CdkLocalStartAlbAuthFixture', {
  description: 'Fixture stack for cdkl start-alb authenticate-cognito + --no-verify-auth integ test',
});
