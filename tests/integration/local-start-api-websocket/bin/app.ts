#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiWebSocketStack } from '../lib/stack.ts';

const app = new cdk.App();

new LocalStartApiWebSocketStack(app, 'CdkLocalStartApiWebSocket', {
  description: 'Fixture stack for cdkl start-api WebSocket integ test (#462)',
});
