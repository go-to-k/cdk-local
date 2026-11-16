#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiUserPoolAuthorizerStack } from '../lib/local-start-api-user-pool-authorizer-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

new LocalStartApiUserPoolAuthorizerStack(app, integStackName('CdkLocalStartApiUserPoolAuthorizerFixture'), {
  description: 'Fixture stack for cdkl start-api behind an HttpUserPoolAuthorizer (issue #1001)',
});
