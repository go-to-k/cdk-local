#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalNestedStackStack } from '../lib/local-nested-stack-stack.ts';

const app = new cdk.App();
new LocalNestedStackStack(app, 'CdklIntegNestedStack', {});
