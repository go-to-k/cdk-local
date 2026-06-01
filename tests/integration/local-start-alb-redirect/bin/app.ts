#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbRedirectStack } from '../lib/local-start-alb-redirect-stack.ts';

const app = new cdk.App();

new LocalStartAlbRedirectStack(app, 'CdkLocalStartAlbRedirectFixture', {
  description:
    'Fixture stack for cdkl start-alb listener redirect action (issue #250, gap G4)',
});
