#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbAuthJwksStack } from '../lib/local-start-alb-auth-jwks-stack.ts';

const app = new cdk.App();

new LocalStartAlbAuthJwksStack(app, 'CdkLocalStartAlbAuthJwksFixture', {
  description:
    'Fixture stack for cdkl start-alb authenticate-oidc full JWT-verification integ test',
});
