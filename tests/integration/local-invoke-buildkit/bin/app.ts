#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeBuildkitStack } from '../lib/local-invoke-buildkit-stack.ts';

const app = new cdk.App();

new LocalInvokeBuildkitStack(app, 'CdkLocalInvokeBuildkitFixture', {
  description: 'Fixture stack for cdkl invoke against a BuildKit-only Dockerfile',
});
