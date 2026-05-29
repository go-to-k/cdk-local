import { Command, Option } from 'commander';
import { withErrorHandling, LocalStartServiceError } from '../../utils/error-handler.js';
import { listTargets } from '../../local/target-lister.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import type { ExtraStateProviders } from './local-state-source.js';
import {
  addCommonEcsServiceOptions,
  runEcsServiceEmulator,
  type EcsServiceEmulatorOptions,
  type EmulatorStrategy,
} from './ecs-service-emulator.js';

// Re-exported for existing unit tests that import these from this module.
export {
  resolveSharedSidecarCredentials,
  buildEcsImageResolutionContext,
  MAX_TASKS_SUBNET_RANGE_CAP,
} from './ecs-service-emulator.js';

/**
 * Factory options for {@link createLocalStartServiceCommand}.
 */
export interface CreateLocalStartServiceCommandOptions {
  extraStateProviders?: ExtraStateProviders;
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl start-service` strategy — a pure ECS replica runner. It picks
 * `AWS::ECS::Service` targets and boots each with NO front-door (the ALB
 * front-door is its own command, `cdkl start-alb`). This keeps `start-service`
 * a leaf compute runner, symmetric with `invoke` / `run-task`.
 */
export function serviceStrategy(): EmulatorStrategy {
  return {
    pickEntries: (stacks) => listTargets(stacks).ecsServices,
    pickerMessage: 'Select one or more ECS services to run',
    pickerNoun: 'ECS services',
    onMissing: () =>
      new LocalStartServiceError(
        `${getEmbedConfig().cliName} start-service requires at least one <target>. ` +
          "Pass one or more service paths like 'Stack/Orders' 'Stack/Frontend', " +
          'or run it in a TTY to pick interactively.'
      ),
    resolveBoots: (_stacks, chosenTargets) => ({
      boots: chosenTargets.map((target) => ({ target, frontDoorTargets: [] })),
      warnings: [],
    }),
    lbPortOverrides: {},
  };
}

/**
 * `cdkl start-service <Stack/Service>` — Phase 2 of #262. Spins up
 * `DesiredCount` task replicas locally (clamped by `--max-tasks`) using the
 * existing `ecs-task-runner` per replica. Long-running; ^C cleans every replica
 * + sidecar + shared network. Pure compute: to put a local ALB front-door in
 * front of an ALB-fronted service, use `cdkl start-alb`.
 */
export function createLocalStartServiceCommand(
  opts: CreateLocalStartServiceCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('start-service')
    .description(
      'Run one or more AWS::ECS::Service resources locally as a long-running emulator. Spins up ' +
        'DesiredCount task replicas per service (clamped by --max-tasks) using the same per-task ' +
        `docker network + metadata sidecar pattern as \`${getEmbedConfig().cliName} run-task\`, then keeps each ` +
        'replica running and restarts it on exit per --restart-policy. ^C tears every replica + ' +
        'sidecar + network down. Each <target> accepts a CDK display path (MyStack/MyService) ' +
        'or stack-qualified logical ID (MyStack:MyServiceXYZ); single-stack apps may omit the ' +
        'stack prefix. When two or more <target>s are supplied, every service is booted into a ' +
        'shared Cloud Map / Service Connect registry so peer services discover each other via ' +
        'docker --add-host overlay. Omit <targets> in an interactive terminal to ' +
        `multi-select the services from a list. To put a local ALB front-door in front of an ` +
        `ALB-fronted service, use \`${getEmbedConfig().cliName} start-alb\` instead.`
    )
    .argument(
      '[targets...]',
      'One or more CDK display paths or stack-qualified logical IDs of the AWS::ECS::Service resources to run (omit to multi-select interactively in a TTY)'
    )
    .addOption(
      new Option(
        '--host-port <containerPort=hostPort...>',
        'Publish a container port on a specific host port (e.g. 80=8080); repeatable. ' +
          'Default: host port == container port. Use this on macOS to map a privileged ' +
          'container port (< 1024) to a non-privileged host port and avoid the Docker ' +
          'Desktop admin-password prompt. (Single-replica services only — multi-replica ' +
          'services do not publish host ports.)'
      )
    )
    .action(
      withErrorHandling(async (targets: string[], options: EcsServiceEmulatorOptions) => {
        await runEcsServiceEmulator(targets, options, serviceStrategy(), opts.extraStateProviders);
      })
    );

  return addCommonEcsServiceOptions(cmd);
}
