#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbLambdaStack } from '../lib/local-start-alb-lambda-stack.ts';

const app = new cdk.App();

new LocalStartAlbLambdaStack(app, 'CdkLocalStartAlbLambdaFixture', {
  description: 'Fixture stack for cdkl start-alb -> Lambda target group integ test (#123)',
});
