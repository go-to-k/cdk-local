#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbRoutingStack } from '../lib/local-start-alb-routing-stack.ts';

const app = new cdk.App();

new LocalStartAlbRoutingStack(app, 'CdkLocalStartAlbRoutingFixture', {
  description: 'Fixture stack for cdkl start-alb path-pattern routing integ test (#123)',
});
