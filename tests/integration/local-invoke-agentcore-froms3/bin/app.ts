#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAgentCoreFromS3Stack } from '../lib/local-invoke-agentcore-froms3-stack.ts';

const app = new cdk.App();

// The bundle's S3 location is injected at synth time (`-c bundleBucket=... -c
// bundleKey=...`) by verify.sh, which creates the bucket + uploads the zipped
// code-agent first. fromS3 needs a literal bucket + key in the template, which
// is exactly what these literal context values produce.
const bundleBucket = app.node.tryGetContext('bundleBucket');
const bundleKey = app.node.tryGetContext('bundleKey');
if (typeof bundleBucket !== 'string' || typeof bundleKey !== 'string') {
  throw new Error(
    'Pass -c bundleBucket=<name> -c bundleKey=<key> (the uploaded fromS3 bundle location).'
  );
}

new LocalInvokeAgentCoreFromS3Stack(app, 'CdkLocalInvokeAgentCoreFromS3Fixture', {
  description: 'Fixture stack for cdkl invoke-agentcore fromS3 integ test',
  bundleBucket,
  bundleKey,
});
