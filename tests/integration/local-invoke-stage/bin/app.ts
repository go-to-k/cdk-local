#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MarkerStack, OuterStage } from '../lib/local-invoke-stage-stack.ts';

// A top-level stack plus a NESTED Stage (go-to-k/cdk-local#746). The Stage's
// stacks are `cdk.out/assembly-CdklLocalInvokeStage/assembly-CdklLocalInvokeStage-Inner/`
// artifacts that `CloudAssembly.stacks` alone never lists.
const app = new cdk.App();

new MarkerStack(app, 'CdklLocalInvokeStageTop', {
  marker: 'top',
  description: 'Fixture top-level stack for the cdkl Stage-stack integ test',
});

new OuterStage(app, 'CdklLocalInvokeStage');
