import { readFileSync } from 'fs';
import { Command, InvalidArgumentError, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  regionOption,
  parseContextOptions,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { displayIdent, displayStackName } from '../../utils/ident-display.js';
import { displayUntrustedValue } from '../../utils/assembly-path.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { CdkLocalError, withErrorHandling } from '../../utils/error-handler.js';
import { resolveProfileCredentials } from '../../utils/profile-resolver.js';
import { formatAuthority } from '../../utils/url-authority.js';
import { listTargets } from '../../local/target-lister.js';
import { resolveSingleTarget } from '../../local/target-picker.js';
import {
  Synthesizer,
  type CdkAppSynthesizer,
  type SynthesisOptions,
} from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import type { ExtraStateProviders } from './local-state-source.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import {
  ensureDockerAvailable,
  pickFreePort,
  removeContainer,
  runDetached,
  streamLogs,
} from '../../local/docker-runner.js';
import { architectureToPlatform } from '../../local/docker-image-builder.js';
import type { ResolvedZipLambda } from '../../local/lambda-resolver.js';
import { parseTimeoutMs } from './local-invoke-agentcore.js';
import { resolveLambdaContainerEnv, type LambdaContainerEnvOptions } from './local-invoke.js';
import {
  disposeMicrovmCodeArtifact,
  readMicrovmImageConfig,
  resolveMicrovmCodeArtifact,
  resolveMicrovmImageTarget,
  type MicrovmCodeArtifact,
  type MicrovmImageConfig,
  type ResolvedMicrovmImage,
} from '../../local/microvm-image.js';
import {
  MAX_RUN_HOOK_PAYLOAD_BYTES,
  MicrovmHookError,
  generateMicrovmId,
  type HookEndpoint,
} from '../../local/microvm-hooks.js';
import {
  MICROVM_CONTROL_PATH,
  startMicrovmFrontDoor,
  type RunningMicrovmFrontDoor,
} from '../../local/microvm-front-door.js';
import {
  LocalMicrovm,
  buildMicrovmImage,
  planMicrovmPorts,
  readExposedPorts,
} from '../../local/microvm-runner.js';
import {
  RecentOutput,
  containerFailure,
  watchContainerExit,
} from '../../local/web-function-runner.js';

/** Options for `cdkl start-microvm`. */
export interface LocalStartMicrovmOptions extends LambdaContainerEnvOptions {
  app?: string;
  output: string;
  context?: string[];
  verbose?: boolean;
  roleArn?: string;
  /** `--count <n>`: independent MicroVMs to run (default 1). */
  count: number;
  /** `--run-hook-payload <string>`. */
  runHookPayload?: string;
  /** `--run-hook-payload-file <path>`. */
  runHookPayloadFile?: string;
  /** Base host port of the first MicroVM's front door (`--port`, default 0 = OS-assigned). */
  port: number;
  /** Address the front doors listen on (`--host`, default 127.0.0.1). */
  host: string;
  /** `--platform`; default: the image's `CpuConfigurations` architecture. */
  platform?: string;
  /** `--no-build-cache` sets this false. */
  buildCache?: boolean;
  /** `--proxy-port <ports...>`: extra container ports the front door may route to. */
  proxyPort?: number[];
  /** `--auto-resume`: resume a suspended MicroVM on its next request. */
  autoResume?: boolean;
  /** `--assume-role <arn>`: the MicroVM execution role. */
  assumeRole?: string;
  /** Default hook / readiness deadline in ms (`--timeout`). */
  timeout: number;
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError(`--port must be an integer 0-65535, got '${raw}'.`);
  }
  return n;
}

function parseCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    throw new InvalidArgumentError(`--count must be an integer 1-64, got '${raw}'.`);
  }
  return n;
}

function parseProxyPort(raw: string, previous: number[] | undefined): number[] {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError(`--proxy-port must be an integer 1-65535, got '${raw}'.`);
  }
  return [...(previous ?? []), n];
}

/** The address a probe / the printed URL uses for a wildcard bind. */
function connectHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host;
}

/**
 * The `--run-hook-payload` / `--run-hook-payload-file` value, refused above the
 * 16 KB `run-microvm` accepts. Exported for unit testing.
 */
export function readRunHookPayload(
  options: Pick<LocalStartMicrovmOptions, 'runHookPayload' | 'runHookPayloadFile'>,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8')
): string | undefined {
  if (options.runHookPayload !== undefined && options.runHookPayloadFile !== undefined) {
    throw new CdkLocalError(
      '--run-hook-payload and --run-hook-payload-file are mutually exclusive.',
      'LOCAL_START_MICROVM_PAYLOAD_CONFLICT'
    );
  }
  let payload = options.runHookPayload;
  if (options.runHookPayloadFile !== undefined) {
    try {
      payload = readFile(options.runHookPayloadFile);
    } catch (err) {
      throw new CdkLocalError(
        `Cannot read --run-hook-payload-file ${displayUntrustedValue(options.runHookPayloadFile)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        'LOCAL_START_MICROVM_PAYLOAD_UNREADABLE'
      );
    }
  }
  if (payload !== undefined && Buffer.byteLength(payload) > MAX_RUN_HOOK_PAYLOAD_BYTES) {
    throw new CdkLocalError(
      `The run hook payload is ${Buffer.byteLength(payload)} bytes; run-microvm accepts at most ` +
        `${MAX_RUN_HOOK_PAYLOAD_BYTES} (16 KB).`,
      'LOCAL_START_MICROVM_PAYLOAD_TOO_LARGE'
    );
  }
  return payload;
}

/**
 * The MicroVM image as the shared Lambda container-env resolver sees it, so
 * `EnvironmentVariables` goes through the SAME pipeline `cdkl invoke` uses
 * (`--env-vars` keyed by the image's logical id or path, `--from-cfn-stack`
 * substitution, dynamic references, `--assume-role` / `--profile` / shell
 * credentials, the fallback `AWS_REGION`).
 */
export function buildMicrovmLambdaView(
  resolved: ResolvedMicrovmImage,
  config: MicrovmImageConfig
): ResolvedZipLambda {
  return {
    kind: 'zip',
    stack: resolved.stack,
    logicalId: resolved.logicalId,
    resource: {
      Type: resolved.resource.Type,
      Properties: { Environment: { Variables: config.environment } },
      ...(resolved.resource.Metadata !== undefined && { Metadata: resolved.resource.Metadata }),
    },
    memoryMb: 128,
    timeoutSec: 0,
    layers: [],
    runtime: '',
    handler: '',
    codePath: null,
    architecture: config.architecture ?? 'arm64',
  };
}

/** The Lambda-function runtime variables the shared resolver adds, which a MicroVM does not define. */
const LAMBDA_RUNTIME_ENV_KEYS = [
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_LAMBDA_FUNCTION_MEMORY_SIZE',
  'AWS_LAMBDA_FUNCTION_TIMEOUT',
  'AWS_LAMBDA_FUNCTION_VERSION',
  'AWS_LAMBDA_LOG_GROUP_NAME',
  'AWS_LAMBDA_LOG_STREAM_NAME',
];

/** Drop the Lambda-function runtime variables the image did not declare itself. Exported for unit testing. */
export function finalizeMicrovmEnv(
  lambdaEnv: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, unknown>>
): Record<string, string> {
  const env = { ...lambdaEnv };
  for (const key of LAMBDA_RUNTIME_ENV_KEYS) {
    if (!Object.hasOwn(declared, key)) delete env[key];
  }
  return env;
}

/**
 * One line per cloud behavior the local run does NOT reproduce, warned ONCE at
 * boot. Exported for unit testing.
 */
export function microvmFidelityWarnings(config: MicrovmImageConfig): string[] {
  const image = displayIdent(config.logicalId);
  const out = [
    `MicroVM image ${image}: each MicroVM is a Docker container started fresh from the built image, ` +
      `not a MicroVM restored from a snapshot — state the app initializes before /ready ` +
      `answers 200 is NOT shared across MicroVMs (each one runs its own startup), and there is no ` +
      `VM isolation or memory checkpoint (suspend is docker pause).`,
    `MicroVM image ${image}: requests are accepted without X-aws-proxy-auth — the JWE token the ` +
      `cloud endpoint requires is not checked locally (the header is still stripped).`,
    `MicroVM image ${image}: the idle policy is not emulated — a MicroVM suspends, resumes and ` +
      `terminates only through ${MICROVM_CONTROL_PATH}/suspend|resume|terminate (and --auto-resume).`,
    `MicroVM image ${image}: the Dockerfile is built by the local Docker engine, not on the ` +
      `Lambda-managed MicroVM base OS (BaseImageArn).`,
  ];
  if (config.hooks.validate) {
    out.push(
      `MicroVM image ${image}: /validate is called on the same container as /ready (the cloud ` +
        `calls it on a fresh MicroVM started from the built snapshot).`
    );
  }
  for (const what of config.unemulated)
    out.push(`MicroVM image ${image}: ${what} is not emulated.`);
  return out;
}

/**
 * `cdkl start-microvm <target>` — run AWS Lambda MicroVMs from a CDK app's
 * `AWS::Lambda::MicrovmImage` locally (issue #835): build its Dockerfile once,
 * start `--count` containers, drive each one's hooks in the cloud's order and
 * serve each on its own local front door, until SIGINT / SIGTERM.
 */
async function localStartMicrovmCommand(
  target: string | undefined,
  options: LocalStartMicrovmOptions,
  extraStateProviders: ExtraStateProviders | undefined,
  hostSynthesizer?: CdkAppSynthesizer
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const runHookPayload = readRunHookPayload(options);

  const vms: LocalMicrovm[] = [];
  const frontDoors = new Map<LocalMicrovm, RunningMicrovmFrontDoor>();
  const logStops: (() => void)[] = [];
  const exitWatches: ReturnType<typeof watchContainerExit>[] = [];
  // Containers whose `docker run` returned but are not wrapped in a LocalMicrovm yet.
  const bareContainers = new Set<string>();
  // The `docker run -d` in flight and its name, so a teardown that starts
  // before it returns still removes (or can name) the container.
  let runInFlight: Promise<string> | undefined;
  let containerName: string | undefined;
  let artifact: MicrovmCodeArtifact | undefined;
  let teardownPromise: Promise<void> | undefined;
  let shuttingDown = false;
  let waitingOnRun = false;
  const forever = (): Promise<never> => new Promise<never>(() => undefined);

  const doTeardown = async (): Promise<void> => {
    for (const w of exitWatches) w.stop();
    if (runInFlight !== undefined) {
      waitingOnRun = true;
      try {
        bareContainers.add(await runInFlight);
      } catch {
        /* docker run failed: no container */
      } finally {
        waitingOnRun = false;
      }
    }
    // Each MicroVM gets its /terminate hook (bounded by its timeout) before
    // its container is removed; containers never wrapped are removed directly.
    await Promise.allSettled(vms.map((vm) => vm.terminate()));
    for (const vm of vms) bareContainers.delete(vm.containerId);
    await Promise.allSettled([...bareContainers].map((id) => removeContainer(id)));
    await Promise.allSettled([...frontDoors.values()].map((fd) => fd.close()));
    for (const stop of logStops) {
      try {
        stop();
      } catch (err) {
        logger.debug(`streamLogs stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    disposeMicrovmCodeArtifact(artifact);
  };
  // Memoized PROMISE: every caller (a failure path, a signal racing it, the
  // last control-endpoint terminate) awaits the SAME teardown.
  const teardown = (): Promise<void> => (teardownPromise ??= doTeardown());

  await applyRoleArnIfSet({
    roleArn: options.roleArn,
    region: options.region,
    profile: options.profile,
  });
  await ensureDockerAvailable();
  const profileCredentials = options.profile
    ? await resolveProfileCredentials(options.profile)
    : undefined;

  const appCmd = resolveApp(options.app);
  if (!appCmd) {
    throw new Error(
      `No CDK app specified. Pass --app, set ${getEmbedConfig().envPrefix}_APP, or add "app" to cdk.json.`
    );
  }
  logger.info('Synthesizing CDK app...');
  const synthesizer: CdkAppSynthesizer = hostSynthesizer ?? new Synthesizer();
  const context = parseContextOptions(options.context);
  const synthOpts: SynthesisOptions = {
    app: appCmd,
    output: options.output,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
  };
  const { stacks } = await synthesizer.synthesize(synthOpts);

  const resolvedTarget = await resolveSingleTarget(target, {
    entries: listTargets(stacks).microvmImages,
    message: 'Select a Lambda MicroVM image to run',
    noun: 'Lambda MicroVM images',
    onMissing: () =>
      new CdkLocalError(
        `${getEmbedConfig().cliName} start-microvm requires a <target> (a MicrovmImage display path ` +
          `or logical ID). Run \`${getEmbedConfig().cliName} list\` to see them, or run it in a TTY ` +
          `to pick interactively.`,
        'LOCAL_START_MICROVM_TARGET_REQUIRED'
      ),
  });

  const resolved = resolveMicrovmImageTarget(resolvedTarget, stacks);
  const config = readMicrovmImageConfig(resolved.logicalId, resolved.resource);
  const platform =
    options.platform ??
    (config.architecture !== undefined ? architectureToPlatform(config.architecture) : undefined);
  logger.info(
    `Target: ${displayStackName(`${resolved.stack.stackName}/${resolved.logicalId}`)} ` +
      `(MicroVM image ${displayIdent(config.name)}; hooks: ` +
      `${Object.keys(config.hooks).join(', ') || 'none'}${platform ? `; ${platform}` : ''})`
  );
  for (const line of microvmFidelityWarnings(config)) logger.warn(line);

  artifact = await resolveMicrovmCodeArtifact(resolved.stack, config);

  // Armed as soon as there is anything on the host to clean up.
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM', exitCode: number): Promise<void> => {
    if (shuttingDown) {
      // A second signal. Abandon ONLY while teardown waits on an in-flight
      // `docker run`; once it is terminating / removing containers, finish —
      // exiting would cut short the `docker rm -f` children and leave
      // credential-bearing containers running.
      if (!waitingOnRun) {
        logger.info(`Received ${signal} again; still terminating the MicroVMs, please wait...`);
        return;
      }
      disposeMicrovmCodeArtifact(artifact);
      logger.warn(
        `Received ${signal} again; exiting without waiting for docker run to return. The ` +
          `container may still be starting, and its environment holds the forwarded AWS ` +
          `credentials. Remove it by its name (this works even if it is created after this ` +
          `exit): docker rm -f ${containerName ?? '<name>'}`
      );
      process.exit(signal === 'SIGINT' ? 130 : 143);
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, terminating ${vms.length} MicroVM(s)...`);
    await teardown();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT', 130));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  const recents = new Map<string, RecentOutput>();
  let allTerminated!: () => void;
  const everyVmTerminated = new Promise<void>((r) => (allTerminated = r));
  let unexpectedExit!: (e: { vm: LocalMicrovm; code: number | undefined }) => void;
  const anyUnexpectedExit = new Promise<{ vm: LocalMicrovm; code: number | undefined }>(
    (r) => (unexpectedExit = r)
  );
  const probeHost = connectHost(options.host);

  try {
    const containerEnv = await resolveLambdaContainerEnv(
      buildMicrovmLambdaView(resolved, config),
      { ...options, deployedFunctionLookups: false },
      profileCredentials,
      extraStateProviders
    );
    const env = finalizeMicrovmEnv(containerEnv.env, config.environment);

    const image = await buildMicrovmImage({
      artifact,
      platform,
      noCache: options.buildCache === false,
    });
    if (teardownPromise) return await forever();
    const containerPorts = planMicrovmPorts(
      config.hooksPort,
      await readExposedPorts(image),
      options.proxyPort ?? []
    );
    logger.info(`Publishing container ports ${containerPorts.join(', ')} to the front door(s).`);

    for (let i = 0; i < options.count; i++) {
      const microvmId = generateMicrovmId();
      const hostPorts = new Map<number, HookEndpoint>();
      for (const cp of containerPorts)
        hostPorts.set(cp, { host: '127.0.0.1', port: await pickFreePort() });
      const [first, ...rest] = containerPorts;
      const name =
        (containerName = `${getEmbedConfig().resourceNamePrefix}-microvm-${process.pid}-${i}-${Math.random().toString(36).slice(2, 8)}`);
      logger.info(`Starting MicroVM ${microvmId} (container ${name})...`);
      runInFlight = runDetached({
        image,
        mounts: [],
        env,
        ...(containerEnv.sensitiveEnvKeys.length > 0 && {
          sensitiveEnvKeys: new Set(containerEnv.sensitiveEnvKeys),
        }),
        cmd: [],
        hostPort: hostPorts.get(first!)!.port,
        containerPort: first!,
        extraPorts: rest.map((cp) => ({ hostPort: hostPorts.get(cp)!.port, containerPort: cp })),
        host: '127.0.0.1',
        ...(platform !== undefined && { platform }),
        name,
        autoRemove: false,
      });
      const containerId = await runInFlight;
      runInFlight = undefined;
      bareContainers.add(containerId);
      // A signal while `docker run` was in flight: its teardown removes it.
      if (teardownPromise) return await forever();
      const recent = new RecentOutput();
      recents.set(containerId, recent);
      logStops.push(
        streamLogs(containerId, {
          onOutput: (chunk) => recent.push(chunk),
          ...(options.count > 1 && { prefix: `[${microvmId.slice(0, 12)}] ` }),
        })
      );
      const watch = watchContainerExit(containerId);
      exitWatches.push(watch);
      let exited = false;
      const vm: LocalMicrovm = new LocalMicrovm(
        {
          microvmId,
          containerId,
          ports: hostPorts,
          config,
          timeoutMs: options.timeout,
          // Its front door stays up answering 503 until the process ends,
          // as a terminated MicroVM's endpoint stops serving.
          onTerminated: () => {
            if (vms.every((v) => v.state() === 'terminated')) allTerminated();
          },
        },
        { isAlive: async () => !exited }
      );
      vms.push(vm);
      bareContainers.delete(containerId);
      void watch.exited.then((code) => {
        exited = true;
        const s = vm.state();
        if (s !== 'terminating' && s !== 'terminated') unexpectedExit({ vm, code });
      });

      await vm.boot(runHookPayload);
      if (teardownPromise) return await forever();
      const fd = await startMicrovmFrontDoor({
        host: options.host,
        port: options.port === 0 ? 0 : options.port + i,
        target: vm,
        autoResume: options.autoResume === true,
      });
      frontDoors.set(vm, fd);
      const base = `http://${formatAuthority(probeHost, fd.port)}`;
      logger.info(
        `MicroVM ${microvmId} listening on ${base}  (control: ${base}${MICROVM_CONTROL_PATH})`
      );
    }
    logger.info('Press ^C to terminate the MicroVM(s).');
  } catch (err) {
    if (shuttingDown) return await forever();
    const failed = vms.at(-1);
    const wrapped =
      err instanceof MicrovmHookError && failed
        ? await containerFailure(
            err.message,
            failed.containerId,
            recents.get(failed.containerId) ?? new RecentOutput()
          ).then((f) => new CdkLocalError(f.message, err.code))
        : err;
    await teardown();
    throw wrapped;
  }

  const outcome = await Promise.race([everyVmTerminated.then(() => undefined), anyUnexpectedExit]);
  if (shuttingDown) return await forever();
  if (outcome === undefined) {
    logger.info('Every MicroVM is terminated; shutting down.');
    await teardown();
    return;
  }
  if (teardownPromise) return await forever();
  const failure = await containerFailure(
    `MicroVM ${outcome.vm.microvmId}'s container exited (exit code ${outcome.code ?? 'unknown'}) while running.`,
    outcome.vm.containerId,
    recents.get(outcome.vm.containerId) ?? new RecentOutput()
  );
  await teardown();
  throw new CdkLocalError(failure.message, 'LOCAL_START_MICROVM_EXITED');
}

export interface CreateLocalStartMicrovmCommandOptions {
  extraStateProviders?: ExtraStateProviders;
  /** Synthesizes the CDK app in place of the built-in toolkit-lib one. */
  synthesizer?: CdkAppSynthesizer;
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl start-microvm <target>` — run AWS Lambda MicroVMs from an
 * `AWS::Lambda::MicrovmImage` locally: the code artifact's Dockerfile built
 * once, `--count` containers each driven through `/ready`, `/validate` and
 * `/run`, each behind its own front door (port routing, header stripping and a
 * suspend / resume / terminate control endpoint).
 */
export function createLocalStartMicrovmCommand(
  opts: CreateLocalStartMicrovmCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('start-microvm')
    .description(
      'Run AWS Lambda MicroVMs locally. Builds a MicrovmImage code artifact (a Dockerfile plus the ' +
        'app, from cdk.out) once, starts --count containers with its EnvironmentVariables, drives ' +
        'the /ready, /validate and /run lifecycle hooks in the cloud order, and serves each MicroVM ' +
        'on its own local URL: X-aws-proxy-port / lambda-microvms.port.N routing (default 8080), ' +
        'X-aws-proxy-* stripping, and a control endpoint for suspend / resume / terminate. Target ' +
        'accepts a CDK display path or stack-qualified logical ID; single-stack apps may omit the ' +
        'prefix. Omit <target> in a TTY to pick from a list. Runs until ^C, which calls /terminate.'
    )
    .argument(
      '[target]',
      'CDK display path or stack-qualified logical ID of the MicrovmImage (omit to pick interactively in a TTY)'
    )
    .action(
      withErrorHandling(async (target: string | undefined, options: LocalStartMicrovmOptions) => {
        await localStartMicrovmCommand(target, options, opts.extraStateProviders, opts.synthesizer);
      })
    );

  addStartMicrovmSpecificOptions(cmd);
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(regionOption);
  return cmd;
}

/**
 * Register the option block `cdkl start-microvm` adds on top of the shared
 * common / app / context helpers. Shared with any host CLI wrapping this
 * factory, so a new `start-microvm`-only flag lands here once. Chainable.
 */
export function addStartMicrovmSpecificOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option('--count <n>', 'Number of independent MicroVMs to run, each with its own URL.')
        .default(1)
        .argParser(parseCount)
    )
    .addOption(
      new Option(
        '--run-hook-payload <string>',
        "The runHookPayload string delivered to each MicroVM's /run hook (max 16 KB)."
      )
    )
    .addOption(
      new Option(
        '--run-hook-payload-file <path>',
        'Read the runHookPayload from a file (mutually exclusive with --run-hook-payload).'
      )
    )
    .addOption(
      new Option(
        '--port <n>',
        'Local port of the first MicroVM; MicroVM i listens on <n>+i. Default 0 (OS-assigned).'
      )
        .default(0)
        .argParser(parsePort)
    )
    .addOption(
      new Option('--host <ip>', 'Address the MicroVM URLs listen on.').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--platform <platform>',
        "docker --platform for the build and the containers. Defaults to the image's " +
          'CpuConfigurations architecture.'
      ).choices(['linux/amd64', 'linux/arm64'])
    )
    .addOption(
      new Option(
        '--proxy-port <port>',
        'An extra container port X-aws-proxy-port may route to (repeatable). 8080, Hooks.Port and ' +
          "the image's EXPOSE ports are always routable."
      ).argParser(parseProxyPort)
    )
    .addOption(
      new Option(
        '--auto-resume',
        'Resume a suspended MicroVM on its next request instead of answering 503 (autoResumeEnabled).'
      )
    )
    .addOption(new Option('--no-build-cache', 'Build the image with docker build --no-cache.'))
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"MicrovmImageLogicalId":{"KEY":"VALUE"}, "Parameters": {...}})'
      )
    )
    .addOption(
      new Option(
        '--timeout <ms>',
        'Default deadline in milliseconds for each hook without its own <Hook>TimeoutInSeconds ' +
          '(/terminate defaults to 10000), and for the app to answer HTTP when there is no /ready hook. ' +
          'Default 60000.'
      )
        .default(60000)
        .argParser(parseTimeoutMs)
    )
    .addOption(
      new Option(
        '--assume-role <arn>',
        "Assume this role (the MicroVM's execution role, a run-microvm parameter rather than part " +
          'of the template) and forward STS-issued temp credentials to the containers. Off by ' +
          'default: the shell credentials are forwarded.'
      )
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack and substitute Ref / Fn::ImportValue in env vars ' +
          'with the deployed physical IDs / exports. Bare form uses the resolved stack name.'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      )
    );
}
