#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiWatchStack } from '../lib/watch-stack.ts';

const app = new cdk.App();

new LocalStartApiWatchStack(app, 'CdkLocalStartApiWatchFixture', {
  description: 'Fixture stack for cdkl start-api --watch integ test',
});
