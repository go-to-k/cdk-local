#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack } from '../lib/producer-stack.ts';
import { ConsumerStack } from '../lib/consumer-stack.ts';
import { integStackName, integScopedName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

// The shared CloudFormation export name. Producer emits an Output with
// `Export.Name` set to this; consumer's Lambda env var pulls it via
// `Fn::ImportValue`. The literal is intentionally distinctive so the
// integ can grep for it.
//
// An export name is ACCOUNT-GLOBAL, exactly like a stack name, so it is
// lane-suffixed too (issue #582): without that, two worktree lanes would
// fight over one export even with distinct stack names, and the second
// producer deploy would fail with "Export ... is already exported".
const EXPORT_NAME = integScopedName('cdkl-multi-stack-shared-value');

const producer = new ProducerStack(app, integStackName('CdkLocalInvokeMultiStackProducer'), {
  description: 'Producer stack: emits an SSM Parameter and exports its name via Fn::ImportValue.',
  exportName: EXPORT_NAME,
});

new ConsumerStack(app, integStackName('CdkLocalInvokeMultiStackConsumer'), {
  description: 'Consumer stack: Lambda env reads producer export via Fn::ImportValue.',
  exportName: EXPORT_NAME,
}).addDependency(producer);
