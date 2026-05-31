#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartServiceWatchFastStack } from '../lib/watch-stack.ts';

const app = new cdk.App();

new LocalStartServiceWatchFastStack(app, 'CdkLocalStartServiceWatchFastFixture', {
  description:
    'Fixture stack for cdkl start-service --watch bind-mount source fast path (Phase 4 of issue #214)',
});
