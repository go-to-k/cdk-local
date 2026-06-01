#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartServiceImageOverrideStack } from '../lib/local-start-service-image-override-stack.ts';

const app = new cdk.App();

new LocalStartServiceImageOverrideStack(app, 'CdkLocalStartServiceImageOverrideFixture', {
  description:
    'Fixture stack for cdkl start-service --image-override (issues #238/#240/#244)',
});
