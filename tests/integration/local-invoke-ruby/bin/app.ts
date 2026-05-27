#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeRubyStack } from '../lib/local-invoke-ruby-stack.ts';

const app = new cdk.App();

new LocalInvokeRubyStack(app, 'CdkLocalInvokeRubyFixture', {
  description: 'Fixture stack for cdkl invoke Ruby integ test',
});
