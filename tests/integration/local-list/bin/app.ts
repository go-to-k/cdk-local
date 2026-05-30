#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalListStack } from '../lib/local-list-stack.ts';

const app = new cdk.App();

new LocalListStack(app, 'LocalListFixture', {
  description: 'Fixture stack for cdkl list target enumeration integ test',
});
