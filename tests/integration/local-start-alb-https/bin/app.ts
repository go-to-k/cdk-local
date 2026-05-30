#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbHttpsStack } from '../lib/local-start-alb-https-stack.ts';

const app = new cdk.App();

new LocalStartAlbHttpsStack(app, 'CdkLocalStartAlbHttpsFixture', {
  description: 'Fixture stack for cdkl start-alb HTTPS termination integ test',
});
