#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack, WebFunctionConsumerStack } from '../lib/local-start-web-function-from-cfn-stack.ts';
import { integScopedName, integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

// Account-global names are lane-suffixed (issue #582): the export the
// consumer imports, and the web function's literal FunctionName.
const EXPORT_NAME = integScopedName('cdkl-webfn-from-cfn-shared');

const producer = new ProducerStack(app, integStackName('CdkLocalWebFnFromCfnProducer'), {
  description: 'Producer stack: exports a value the web function imports.',
  exportName: EXPORT_NAME,
});

new WebFunctionConsumerStack(app, integStackName('CdkLocalWebFnFromCfnConsumer'), {
  description: 'Consumer stack: a Lambda Web Function whose ServiceConfig env uses Ref / Fn::ImportValue / Fn::GetAtt.',
  exportName: EXPORT_NAME,
  functionName: integScopedName('cdkl-integ-webfn-from-cfn'),
}).addDependency(producer);
