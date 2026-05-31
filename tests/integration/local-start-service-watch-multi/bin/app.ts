#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartServiceWatchMultiStack } from '../lib/watch-stack.ts';

const app = new cdk.App();

new LocalStartServiceWatchMultiStack(app, 'CdkLocalStartServiceWatchMultiFixture', {
  description: 'Fixture stack for cdkl start-service --watch (Phase 2 of issue #214: multi-replica rolling deploy)',
});
