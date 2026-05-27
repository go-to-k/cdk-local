#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartServiceStack } from '../lib/local-start-service-stack.ts';

const app = new cdk.App();

new LocalStartServiceStack(app, 'CdkdLocalStartServiceFixture', {
  description: 'Fixture stack for cdkl start-service integ test',
});
