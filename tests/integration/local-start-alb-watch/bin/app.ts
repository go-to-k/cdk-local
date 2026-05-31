#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbWatchStack } from '../lib/watch-stack.ts';

const app = new cdk.App();

new LocalStartAlbWatchStack(app, 'CdkLocalStartAlbWatchFixture', {
  description:
    'Fixture stack for cdkl start-alb --watch (Phase 3 of issue #214: multi-replica rolling deploy + front-door pool swap)',
});
