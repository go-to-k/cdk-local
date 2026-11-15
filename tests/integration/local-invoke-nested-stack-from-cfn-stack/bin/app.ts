#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeNestedStackFromCfnStackStack } from '../lib/local-invoke-nested-stack-from-cfn-stack-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();
new LocalInvokeNestedStackFromCfnStackStack(app, integStackName('CdklIntegNestedCfn'), {});
