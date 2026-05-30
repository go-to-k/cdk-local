#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbWebSocketStack } from '../lib/local-start-alb-websocket-stack.ts';

const app = new cdk.App();

new LocalStartAlbWebSocketStack(app, 'CdkLocalStartAlbWebSocketFixture', {
  description: 'Fixture stack for cdkl start-alb WebSocket Upgrade proxy integ test (#176)',
});
