#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartServiceWatchStack } from '../lib/watch-stack.ts';

const app = new cdk.App();

new LocalStartServiceWatchStack(app, 'CdkLocalStartServiceWatchFixture', {
  description: 'Fixture stack for cdkl start-service --watch (Phase 1 of issue #214)',
});
