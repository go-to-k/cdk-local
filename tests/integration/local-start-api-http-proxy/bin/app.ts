#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiHttpProxyStack } from '../lib/local-start-api-http-proxy-stack.ts';

const app = new cdk.App();

new LocalStartApiHttpProxyStack(app, 'CdkLocalStartApiHttpProxyFixture', {
  description:
    'Fixture stack for cdkl start-api REST v1 HTTP_PROXY happy-path integ test',
});
