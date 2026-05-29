#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartServiceAlbStack } from '../lib/local-start-service-alb-stack.ts';

const app = new cdk.App();

new LocalStartServiceAlbStack(app, 'CdkLocalStartServiceAlbFixture', {
  description: 'Fixture stack for cdkl start-service ALB front-door integ test (#86)',
});
