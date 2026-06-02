#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStudioStack } from '../lib/local-studio-stack.ts';

const app = new cdk.App();

new LocalStudioStack(app, 'LocalStudioFixture', {
  description: 'Fixture stack for cdkl studio Phase 1 integ test',
});
