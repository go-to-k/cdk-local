/**
 * go-to-k/cdk-local#1020: every repeatable value flag takes ONE value per
 * occurrence and accumulates across repeats, as the AWS CDK CLI declares its
 * repeatable options (`nargs: 1`). Declared variadic (`<x...>`), a flag
 * swallowed the positional target written after it:
 * `cdkl start-service --host-port 80=8080 MySvc` read `MySvc` as a second
 * host-port value and selected no target.
 */
import { describe, expect, it } from 'vite-plus/test';
import type { Command } from 'commander';
import { createLocalInvokeCommand } from '../../../src/cli/commands/local-invoke.js';
import { createLocalInvokeAgentCoreCommand } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { createLocalListCommand } from '../../../src/cli/commands/local-list.js';
import { createLocalRunTaskCommand } from '../../../src/cli/commands/local-run-task.js';
import { createLocalStartAgentCoreCommand } from '../../../src/cli/commands/local-start-agentcore.js';
import { createLocalStartAlbCommand } from '../../../src/cli/commands/local-start-alb.js';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';
import { createLocalStartCloudFrontCommand } from '../../../src/cli/commands/local-start-cloudfront.js';
import { createLocalStartMicrovmCommand } from '../../../src/cli/commands/local-start-microvm.js';
import { createLocalStartServiceCommand } from '../../../src/cli/commands/local-start-service.js';
import { createLocalStartWebFunctionCommand } from '../../../src/cli/commands/local-start-web-function.js';
import { createLocalStudioCommand } from '../../../src/cli/commands/local-studio.js';

type Parsed = { opts: Record<string, unknown>; operands: string[] };

function parse(cmd: Command, args: string[]): Parsed {
  cmd.exitOverride();
  cmd.action(() => {});
  cmd.parse(args, { from: 'user' });
  return { opts: cmd.opts(), operands: cmd.args };
}

describe('repeatable flags keep a following target (go-to-k/cdk-local#1020)', () => {
  it('start-service --host-port and the --image-* family: one value per flag, target kept', () => {
    const { opts, operands } = parse(createLocalStartServiceCommand(), [
      '--host-port',
      '80=8080',
      'MyStack/Svc',
      '--host-port',
      '443=8443',
      '--image-override',
      'Svc=./Dockerfile',
      '--image-build-arg',
      'A=1',
      '--image-build-secret',
      'npmrc=./.npmrc',
      '--image-target',
      'Svc=build',
      '--image-context',
      'Svc=.',
      'MyStack/Other',
    ]);
    expect(operands).toEqual(['MyStack/Svc', 'MyStack/Other']);
    expect(opts['hostPort']).toEqual(['80=8080', '443=8443']);
    expect(opts['imageOverride']).toEqual(['Svc=./Dockerfile']);
    expect(opts['imageBuildArg']).toEqual(['A=1']);
    expect(opts['imageBuildSecret']).toEqual(['npmrc=./.npmrc']);
    expect(opts['imageTarget']).toEqual(['Svc=build']);
    expect(opts['imageContext']).toEqual(['Svc=.']);
  });

  it('start-alb --lb-port: one value per flag, target kept', () => {
    const { opts, operands } = parse(createLocalStartAlbCommand(), [
      '--lb-port',
      '80=8080',
      'MyStack/Alb',
      '--lb-port',
      '443=8443',
    ]);
    expect(operands).toEqual(['MyStack/Alb']);
    expect(opts['lbPort']).toEqual(['80=8080', '443=8443']);
  });

  it('run-task --host-port / --image-build-arg: one value per flag, target kept', () => {
    const { opts, operands } = parse(createLocalRunTaskCommand(), [
      '--host-port',
      '80=8080',
      'MyStack/Task',
      '--image-build-arg',
      'A=1',
      '--image-build-arg',
      'B=2',
    ]);
    expect(operands).toEqual(['MyStack/Task']);
    expect(opts['hostPort']).toEqual(['80=8080']);
    expect(opts['imageBuildArg']).toEqual(['A=1', 'B=2']);
  });

  it('-c / --context: one key=value per flag, target kept', () => {
    const { opts, operands } = parse(createLocalInvokeCommand(), [
      '-c',
      'env=prod',
      'MyStack/Fn',
      '--context',
      'b=2',
    ]);
    expect(operands).toEqual(['MyStack/Fn']);
    expect(opts['context']).toEqual(['env=prod', 'b=2']);
  });

  it('studio --stack: one glob per flag, accumulated', () => {
    const { opts } = parse(createLocalStudioCommand(), ['--stack', 'dev/*', '--stack', 'qa/*']);
    expect(opts['stack']).toEqual(['dev/*', 'qa/*']);
  });

  it('no flag leaves each option unset', () => {
    const { opts, operands } = parse(createLocalStartServiceCommand(), ['MyStack/Svc']);
    expect(operands).toEqual(['MyStack/Svc']);
    expect(opts['hostPort']).toBeUndefined();
    expect(opts['imageOverride']).toBeUndefined();
    expect(opts['context']).toBeUndefined();
  });

  it('no command declares a variadic value option', () => {
    const factories: Array<() => Command> = [
      createLocalInvokeCommand,
      createLocalInvokeAgentCoreCommand,
      createLocalListCommand,
      createLocalRunTaskCommand,
      createLocalStartAgentCoreCommand,
      createLocalStartAlbCommand,
      createLocalStartApiCommand,
      createLocalStartCloudFrontCommand,
      createLocalStartMicrovmCommand,
      createLocalStartServiceCommand,
      createLocalStartWebFunctionCommand,
      createLocalStudioCommand,
    ];
    const variadic = factories.flatMap((factory) => {
      const cmd = factory();
      return cmd.options.filter((o) => o.variadic).map((o) => `${cmd.name()} ${o.flags}`);
    });
    expect(variadic).toEqual([]);
  });
});
