#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbWeightedStack } from '../lib/local-start-alb-weighted-stack.ts';

const app = new cdk.App();

new LocalStartAlbWeightedStack(app, 'CdkLocalStartAlbWeightedFixture', {
  description:
    'Fixture stack for cdkl start-alb weighted forward (60/40 target-group distribution; issue #250, gap G5)',
});
