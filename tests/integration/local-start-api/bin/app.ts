#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiStack } from '../lib/local-start-api-stack.ts';

const app = new cdk.App();

new LocalStartApiStack(app, 'CdkLocalStartApiFixture', {
  description: 'Fixture stack for cdkl start-api integ test',
});
