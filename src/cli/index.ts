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

/**
 * `cdkl studio` is built incrementally and is NOT yet user-ready, so it
 * is registered ONLY when `CDKL_STUDIO_PREVIEW=1`. This keeps a
 * half-finished command from shipping enabled while each slice lands on
 * main, while still letting the integration suite drive the real binary
 * end-to-end. The gate is removed in the final "unveil" slice.
 */
const STUDIO_PREVIEW_ENABLED = process.env['CDKL_STUDIO_PREVIEW'] === '1';

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
if (STUDIO_PREVIEW_ENABLED) {
  program.addCommand(createLocalStudioCommand());
}

void program.parseAsync(process.argv);
