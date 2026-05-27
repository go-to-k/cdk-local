#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeJavaStack } from '../lib/local-invoke-java-stack.ts';

const app = new cdk.App();

new LocalInvokeJavaStack(app, 'CdkLocalInvokeJavaFixture', {
  description: 'Fixture stack for cdkl invoke Java integ test',
});
