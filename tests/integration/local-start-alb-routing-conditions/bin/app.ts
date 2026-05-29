#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbRoutingConditionsStack } from '../lib/local-start-alb-routing-conditions-stack.ts';

const app = new cdk.App();

new LocalStartAlbRoutingConditionsStack(app, 'CdkLocalStartAlbRoutingConditionsFixture', {
  description:
    'Fixture stack for cdkl start-alb host-header + fixed-response rule routing integ test (#123)',
});
