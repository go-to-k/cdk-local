#!/usr/bin/env node

import { Command } from 'commander';
import { createLocalInvokeCommand } from './commands/local-invoke.js';
import { createLocalInvokeAgentCommand } from './commands/local-invoke-agent.js';
import { createLocalStartApiCommand } from './commands/local-start-api.js';
import { createLocalRunTaskCommand } from './commands/local-run-task.js';
import { createLocalStartServiceCommand } from './commands/local-start-service.js';
import { createLocalListCommand } from './commands/local-list.js';

declare const __CDK_LOCAL_VERSION__: string;

const program = new Command();
program
  .name('cdkl')
  .description('Run AWS CDK stacks locally with Docker.')
  .version(__CDK_LOCAL_VERSION__);

program.addCommand(createLocalInvokeCommand());
program.addCommand(createLocalInvokeAgentCommand());
program.addCommand(createLocalStartApiCommand());
program.addCommand(createLocalRunTaskCommand());
program.addCommand(createLocalStartServiceCommand());
program.addCommand(createLocalListCommand());

void program.parseAsync(process.argv);
