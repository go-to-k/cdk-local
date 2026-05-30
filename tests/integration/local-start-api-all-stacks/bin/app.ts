#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StackA } from '../lib/stack-a.ts';
import { StackB } from '../lib/stack-b.ts';

const app = new cdk.App();

new StackA(app, 'CdkLocalStartApiAllStacksA', {
  description: 'Fixture stack A for cdkl start-api --all-stacks integ test',
});

new StackB(app, 'CdkLocalStartApiAllStacksB', {
  description: 'Fixture stack B for cdkl start-api --all-stacks integ test',
});
