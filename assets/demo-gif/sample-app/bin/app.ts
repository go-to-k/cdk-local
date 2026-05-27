#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CdklDemoStack } from '../lib/cdkl-demo-stack.ts';

const app = new cdk.App();

new CdklDemoStack(app, 'CdklDemo', {
  description: 'Minimal stack for the cdkl-invoke demo GIF',
});
