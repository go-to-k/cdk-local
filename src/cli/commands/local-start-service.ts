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
 *
 * `supportsWatch: true` opts this strategy into the emulator's `--watch`
 * reload pathway (Phase 1 + Phase 2 of issue #214 — per-replica rolling
 * deploy: shadow boot under a bumped generation suffix, TCP-ready probe,
 * atomic Cloud Map / front-door swap, retire old). `start-alb`'s strategy
 * intentionally does NOT set this so a `--watch` flag never leaks into
 * the ALB-front-door path (Phase 3).
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
      boots: chosenTargets.map((target) => ({ target })),
      warnings: [],
    }),
    lbPortOverrides: {},
    supportsWatch: true,
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
    .action(
      withErrorHandling(async (targets: string[], options: EcsServiceEmulatorOptions) => {
        await runEcsServiceEmulator(targets, options, serviceStrategy(), opts.extraStateProviders);
      })
    );

  addStartServiceSpecificOptions(cmd);
  return addCommonEcsServiceOptions(cmd);
}

/**
 * Register the option block that `cdkl start-service` adds on top of the
 * shared {@link addCommonEcsServiceOptions} ECS-service common block — the
 * flags that only make sense for a pure-compute service emulator (no front
 * door). Shared between `cdkl start-service` and any host CLI (e.g. cdkd's
 * `local start-service`) that wraps {@link runEcsServiceEmulator} with the
 * {@link serviceStrategy}, so adding or renaming a `start-service`-only flag
 * here propagates to every embedder without duplicate `.addOption(...)`
 * blocks.
 *
 * Calling order only affects `--help` presentation (Commander parses
 * insertion-order-independent). The host-CLI convention is host-specific
 * options first, then this helper, then {@link addCommonEcsServiceOptions}
 * — host flags / start-service flags / common flags grouped in three
 * `--help` clusters. Chainable: returns `cmd`.
 *
 * `--watch` is intentionally NOT in the shared
 * {@link addCommonEcsServiceOptions} block: `start-alb --watch` is not yet
 * implemented (Phase 3 of issue #214), and the shared block must not
 * advertise a flag one of its consumers does not honor.
 */
export function addStartServiceSpecificOptions(cmd: Command): Command {
  return cmd
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
    .addOption(
      new Option(
        '--watch',
        'Hot-reload: re-synth + per-replica rolling deploy when the CDK source changes ' +
          '(honors cdk.json watch.include/exclude; cdk.out, node_modules, .git are always ' +
          'excluded). Each replica is rolled one at a time — boot a shadow under a bumped ' +
          'generation suffix, wait for its container port to accept a TCP connection, ' +
          'atomically swap Service-Connect / Cloud Map registrations, then retire the old ' +
          'container — so peer services see zero connection refusals across the reload even ' +
          'on multi-replica services. Off by default; existing replica(s) keep serving when ' +
          'synth fails mid-reload.'
      ).default(false)
    );
}
