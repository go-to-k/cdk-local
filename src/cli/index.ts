#!/usr/bin/env node

import { Command } from 'commander';

declare const __CDK_LOCAL_VERSION__: string;

const program = new Command();
program
  .name('cdkl')
  .description('Run AWS CDK stacks locally with Docker.')
  .version(__CDK_LOCAL_VERSION__);

// Phase 1 scaffold: no subcommands wired yet.
// Phase 2 will register: invoke / start-api / run-task / start-service.

program.parse(process.argv);
