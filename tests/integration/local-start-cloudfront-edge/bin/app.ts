#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontEdgeStack } from '../lib/local-start-cloudfront-edge-stack.ts';

const app = new cdk.App();

// Lambda@Edge functions live in us-east-1; pin the env so the synth validates.
new LocalStartCloudFrontEdgeStack(app, 'CdkLocalStartCloudFrontEdgeFixture', {
  env: { region: 'us-east-1' },
  description: 'Fixture stack for cdkl start-cloudfront Lambda@Edge integ test (#400)',
});
