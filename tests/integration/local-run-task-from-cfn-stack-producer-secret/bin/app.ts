#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack } from '../lib/producer-stack.ts';
import { ConsumerStack } from '../lib/consumer-stack.ts';
import { integStackName, integScopedName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

// Export names are account-global, so they are lane-suffixed like the stacks
// (issue #582).
const exportNames = {
  apiKey: integScopedName('cdkl-producer-secret-api-key'),
  plain: integScopedName('cdkl-producer-secret-plain'),
  secretArn: integScopedName('cdkl-producer-secret-db-secret-arn'),
};

const producer = new ProducerStack(app, integStackName('CdkLocalRunTaskProducerSecretProducer'), {
  description: 'Producer stack: exports an AppSync API key, a plain value and a nested Secrets Manager ARN.',
  exportNames,
});

new ConsumerStack(app, integStackName('CdkLocalRunTaskProducerSecretConsumer'), {
  description: 'Consumer stack: ECS tasks read the producer exports through Fn::ImportValue.',
  exportNames,
}).addDependency(producer);
