#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MicrovmConsumerStack, ProducerStack } from '../lib/local-start-microvm-from-cfn-stack.ts';
import { integScopedName, integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

// Account-global names are lane-suffixed (issue #582): the export the
// consumer imports, and the MicroVM image's Name.
const EXPORT_NAME = integScopedName('cdkl-microvm-from-cfn-shared');

const producer = new ProducerStack(app, integStackName('CdkLocalMicrovmFromCfnProducer'), {
  description: 'Producer stack: exports a value the MicroVM image imports.',
  exportName: EXPORT_NAME,
});

new MicrovmConsumerStack(app, integStackName('CdkLocalMicrovmFromCfnConsumer'), {
  description: 'Consumer stack: a MicroVM image whose EnvironmentVariables use Ref / Fn::ImportValue / Fn::GetAtt.',
  exportName: EXPORT_NAME,
  imageName: integScopedName('cdkl-integ-microvm-from-cfn'),
  // verify.sh passes the newest AVAILABLE managed base image version, so a
  // deprecated version never pins the fixture.
  baseImageVersion: process.env['MICROVM_BASE_IMAGE_VERSION'] ?? '2',
}).addDependency(producer);
