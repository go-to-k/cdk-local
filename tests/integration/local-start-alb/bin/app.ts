#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbStack } from '../lib/local-start-alb-stack.ts';

const app = new cdk.App();

new LocalStartAlbStack(app, 'CdkLocalStartAlbFixture', {
  description: 'Fixture stack for cdkl start-alb front-door integ test (#86)',
});
