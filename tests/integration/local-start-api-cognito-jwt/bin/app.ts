#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiCognitoJwtStack } from '../lib/local-start-api-cognito-jwt-stack.ts';

const app = new cdk.App();

new LocalStartApiCognitoJwtStack(app, 'CdkLocalStartApiCognitoJwtFixture', {
  description:
    'Fixture stack for cdkl start-api HTTP API v2 JWT authorizer against a local JWKS sidecar (issue #250, gap G3)',
});
