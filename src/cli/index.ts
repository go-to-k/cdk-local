#!/usr/bin/env node

import { Command } from 'commander';
import { createLocalInvokeCommand } from './commands/local-invoke.js';
import { createLocalInvokeAgentCoreCommand } from './commands/local-invoke-agentcore.js';
import { createLocalStartApiCommand } from './commands/local-start-api.js';
import { createLocalRunTaskCommand } from './commands/local-run-task.js';
import { createLocalStartServiceCommand } from './commands/local-start-service.js';
import { createLocalStartAlbCommand } from './commands/local-start-alb.js';
import { createLocalListCommand } from './commands/local-list.js';
import { createLocalStudioCommand } from './commands/local-studio.js';

declare const __CDK_LOCAL_VERSION__: string;

const program = new Command();
program
  .name('cdkl')
  .description('Run AWS CDK stacks locally with Docker.')
  .version(__CDK_LOCAL_VERSION__);

program.addCommand(createLocalInvokeCommand());
program.addCommand(createLocalInvokeAgentCoreCommand());
program.addCommand(createLocalStartApiCommand());
program.addCommand(createLocalRunTaskCommand());
program.addCommand(createLocalStartServiceCommand());
program.addCommand(createLocalStartAlbCommand());
program.addCommand(createLocalListCommand());
program.addCommand(createLocalStudioCommand());

void program.parseAsync(process.argv);
