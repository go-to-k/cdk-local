#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  LocalEcsAssumeRoleRoleStack,
  LocalEcsAssumeRoleTaskStack,
} from '../lib/local-ecs-assume-role-stack.ts';
import { integStackName } from '../../_lib/stack-name.ts';

const app = new cdk.App();

// Deployed: only the assumable task role.
new LocalEcsAssumeRoleRoleStack(app, integStackName('CdkLocalEcsAssumeRoleFixture'), {
  description: 'Fixture stack for cdkl run-task / start-service --assume-role (the task role)',
});

// Synthesized only, never deployed: the task definition and service cdkl runs.
new LocalEcsAssumeRoleTaskStack(app, integStackName('CdkLocalEcsAssumeRoleTasks'), {
  description: 'Fixture stack for cdkl run-task / start-service --assume-role (never deployed)',
});
