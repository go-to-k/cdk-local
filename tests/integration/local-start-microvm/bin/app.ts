#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartMicrovmStack } from '../lib/local-start-microvm-stack.ts';

const app = new cdk.App();

new LocalStartMicrovmStack(app, 'CdkLocalStartMicrovmFixture', {
  description: 'Fixture stack for cdkl start-microvm integ test',
});
