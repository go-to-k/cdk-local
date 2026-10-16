#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { LocalStartCloudFrontEdgeStack } from '../lib/local-start-cloudfront-edge-stack.ts';

const app = new cdk.App();

// Lambda@Edge functions live in us-east-1; pin the env so the synth validates.
new LocalStartCloudFrontEdgeStack(app, 'CdkLocalStartCloudFrontEdgeFixture', {
  env: { region: 'us-east-1' },
  description: 'Fixture stack for cdkl start-cloudfront Lambda@Edge integ test (#400)',
});

// An unrelated second stack (#798): with more than one stack in the assembly, a
// bare-logical-id resolution of the Lambda@Edge function is refused and the edge
// stage is skipped with a warning, so `/go` would no longer 302 and `/` would carry
// no x-edge-stamp. Never deployed.
const other = new cdk.Stack(app, 'CdkLocalStartCloudFrontEdgeUnrelated', {
  env: { region: 'us-east-1' },
});
new sqs.Queue(other, 'Unrelated');
