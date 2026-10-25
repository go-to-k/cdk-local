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
  pullImage,
  removeContainer,
  streamLogs,
} from '../../local/docker-runner.js';
import { parseTimeoutMs } from './local-invoke-agentcore.js';
import { resolveLambdaContainerEnv, type LambdaContainerEnvOptions } from './local-invoke.js';
import { resolveWebFunctionTarget } from '../../local/web-function-resolver.js';
import {
  disposeWebFunctionArtifact,
  parseWebFunctionBuildConfig,
  resolveWebFunctionArtifact,
  type WebFunctionArtifact,
} from '../../local/web-function-artifact.js';
import {
  defaultWebFunctionPlatform,
  resolveWebFunctionRuntime,
} from '../../local/web-function-runtime.js';
import {
  WEB_FUNCTION_HTTP_ENDPOINT_ENV,
  buildWebFunctionLambdaView,
  finalizeWebFunctionEnv,
  readWebFunctionServiceConfig,
  webFunctionAssumeRole,
  webFunctionFidelityWarnings,
} from '../../local/web-function-service-config.js';
import {
  RecentOutput,
  WEB_FUNCTION_CONTAINER_PORT,
  containerFailure,
  planWebFunctionContainer,
  startWebFunctionContainer,
  waitForWebFunctionReady,
  watchContainerExit,
} from '../../local/web-function-runner.js';

/** Options for `cdkl start-web-function`. */
export interface LocalStartWebFunctionOptions extends LambdaContainerEnvOptions {
  app?: string;
  output: string;
  context?: string[];
  verbose?: boolean;
  roleArn?: string;
  /** `--revision <logicalId>`: serve this revision instead of the endpoint's pick. */
  revision?: string;
  /** Host port (`--port`, default 0 = OS-assigned). */
  port: number;
  /** Address the port is published on (`--host`, default 127.0.0.1). */
  host: string;
  /** `--platform`; default: the runtime row's first architecture. */
  platform?: string;
  /** `--no-pull` sets this false. */
  pull?: boolean;
  /** Readiness deadline in ms (`--timeout`). */
  timeout: number;
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError(`--port must be an integer 0-65535, got '${raw}'.`);
  }
  return n;
}

/** The address a probe / the printed URL uses for a wildcard bind. */
function connectHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host;
}

/**
 * `cdkl start-web-function <target>` — serve an AWS Lambda Web Function from
 * the CDK app on a local port (issue #831). Resolves the target to ONE revision
 * (`web-function-resolver`), its code to a local artifact
 * (`web-function-artifact`, seam 1) and its runtime to an image + start command
 * (`web-function-runtime`, seam 2), builds the env through the same resolver
 * `cdkl invoke` uses, boots the server container and blocks until SIGINT /
 * SIGTERM.
 */
async function localStartWebFunctionCommand(
  target: string | undefined,
  options: LocalStartWebFunctionOptions,
  extraStateProviders: ExtraStateProviders | undefined,
  hostSynthesizer?: CdkAppSynthesizer
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  let containerId: string | undefined;
  let stopLogs: (() => void) | undefined;
  let exitWatch: ReturnType<typeof watchContainerExit> | undefined;
  let artifact: WebFunctionArtifact | undefined;
  let tornDown = false;
  let shuttingDown = false;
  const forever = (): Promise<never> => new Promise<never>(() => undefined);

  // Null-safe and idempotent: it may run before the container exists (a
  // signal during the pull) or twice (a signal racing a failure).
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    exitWatch?.stop();
    if (stopLogs) {
      try {
        stopLogs();
      } catch (err) {
        logger.debug(`streamLogs stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Not `--rm`, so this removal is the only one.
    if (containerId) await removeContainer(containerId);
    disposeWebFunctionArtifact(artifact);
  };

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
    entries: listTargets(stacks).webFunctions,
    message: 'Select a Lambda web function to serve',
    noun: 'Lambda web functions',
    onMissing: () =>
      new CdkLocalError(
        `${getEmbedConfig().cliName} start-web-function requires a <target> (a WebFunction, ` +
          `WebFunctionEndpoint or WebFunctionRevision display path or logical ID). Run ` +
          `\`${getEmbedConfig().cliName} list\` to see them, or run it in a TTY to pick interactively.`,
        'LOCAL_START_WEB_FUNCTION_TARGET_REQUIRED'
      ),
  });

  const resolved = resolveWebFunctionTarget(resolvedTarget, stacks, options.revision);
  const code = parseWebFunctionBuildConfig(
    resolved.revisionLogicalId,
    resolved.revision.Properties?.['BuildConfig']
  );
  const spec = resolveWebFunctionRuntime(code.runtime);
  const selectionNote: Record<typeof resolved.selection, string> = {
    'target-revision': 'the target revision',
    'revision-flag': '--revision',
    'endpoint-weight': `highest weight on endpoint ${displayIdent(resolved.endpoint?.logicalId ?? '')}`,
    'only-revision': "the function's only revision",
  };
  logger.info(
    `Target: ${displayStackName(`${resolved.stack.stackName}/${resolved.revisionLogicalId}`)} ` +
      `(${spec.runtime}; revision chosen by ${selectionNote[resolved.selection]})`
  );

  const serviceConfig = readWebFunctionServiceConfig(resolved.revision);
  for (const line of webFunctionFidelityWarnings(resolved, serviceConfig)) logger.warn(line);

  artifact = await resolveWebFunctionArtifact(resolved.stack, resolved.revisionLogicalId, code);

  // Armed as soon as there is anything on the host to clean up (an extracted
  // bundle), so ^C during a long first pull still removes it.
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    await teardown();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT', 130));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  const recent = new RecentOutput();
  try {
    const assumeRole = webFunctionAssumeRole(options.assumeRole, serviceConfig);
    const containerEnv = await resolveLambdaContainerEnv(
      buildWebFunctionLambdaView(resolved, serviceConfig, spec.runtime),
      {
        ...options,
        ...(assumeRole !== undefined && { assumeRole }),
        deployedFunctionLookups: false,
      },
      profileCredentials,
      extraStateProviders
    );
    const { env, replacedHttpEndpoint } = finalizeWebFunctionEnv(containerEnv.env, {
      functionName: resolved.functionName,
      containerPort: WEB_FUNCTION_CONTAINER_PORT,
      timeoutSeconds: serviceConfig.timeoutSeconds,
      logGroup: serviceConfig.logGroup,
    });
    if (replacedHttpEndpoint) {
      logger.warn(
        `The revision's ${WEB_FUNCTION_HTTP_ENDPOINT_ENV} is replaced with 0.0.0.0:` +
          `${WEB_FUNCTION_CONTAINER_PORT}: the runtime owns that variable, and the local port ` +
          `is published to it.`
      );
    }
    const plan = planWebFunctionContainer(artifact, spec, env);
    const platform = options.platform ?? defaultWebFunctionPlatform(spec);

    await pullImage(plan.image, options.pull === false, platform);
    if (tornDown) return await forever();
    const hostPort = options.port === 0 ? await pickFreePort() : options.port;
    const name = `${getEmbedConfig().resourceNamePrefix}-webfn-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    logger.info(
      `Starting web function container (image=${plan.image}, start=${plan.label}, ` +
        `port=${hostPort} -> ${WEB_FUNCTION_CONTAINER_PORT})...`
    );
    const id = await startWebFunctionContainer({
      plan,
      env,
      sensitiveEnvKeys: new Set(containerEnv.sensitiveEnvKeys),
      host: options.host,
      hostPort,
      platform,
      name,
    });
    if (tornDown) {
      // A signal tore down while `docker run` was in flight.
      await removeContainer(id);
      return await forever();
    }
    containerId = id;
    stopLogs = streamLogs(id, { onOutput: (chunk) => recent.push(chunk) });
    exitWatch = watchContainerExit(id);

    const probeHost = connectHost(options.host);
    await waitForWebFunctionReady({
      containerId: id,
      host: probeHost,
      port: hostPort,
      timeoutMs: options.timeout,
      recent,
      label: plan.label,
    });
    logger.info(
      `Server listening on http://${formatAuthority(probeHost, hostPort)}  ` +
        `(${displayIdent(resolved.functionName)} (Lambda web function))`
    );
    logger.info('Press ^C to shut down.');
  } catch (err) {
    if (shuttingDown) return await forever();
    await teardown();
    throw err;
  }

  // Serving. The `docker wait` child keeps the process alive; when the server
  // exits on its own, fail loudly (non-zero) with its last output instead of
  // exiting 0 with the container and the extracted bundle left behind.
  if (!exitWatch || !containerId) return await forever();
  const exitCode = await exitWatch.exited;
  if (shuttingDown || tornDown) return await forever();
  const failure = await containerFailure(
    `The web function container exited (exit code ${exitCode ?? 'unknown'}) while serving.`,
    containerId,
    recent
  );
  await teardown();
  throw failure;
}

export interface CreateLocalStartWebFunctionCommandOptions {
  extraStateProviders?: ExtraStateProviders;
  /** Synthesizes the CDK app in place of the built-in toolkit-lib one. */
  synthesizer?: CdkAppSynthesizer;
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl start-web-function <target>` — serve an AWS Lambda Web Function
 * (`AWS::Lambda::WebFunction` / `WebFunctionRevision` / `WebFunctionEndpoint`)
 * on a local port: one revision's code in an arm64 container listening on
 * `AWS_LAMBDA_HTTP_ENDPOINT`, with its `ServiceConfig` environment and the same
 * credential / state-source resolution as `cdkl invoke`.
 */
export function createLocalStartWebFunctionCommand(
  opts: CreateLocalStartWebFunctionCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('start-web-function')
    .description(
      'Serve an AWS Lambda Web Function locally. Resolves a WebFunction, WebFunctionEndpoint or ' +
        'WebFunctionRevision target to one revision (an endpoint serves its highest-weight ' +
        'revision; --revision overrides), runs its code bundle from cdk.out in a container ' +
        'whose server listens on AWS_LAMBDA_HTTP_ENDPOINT, and publishes it on a local port with ' +
        "the revision's ServiceConfig environment. Target accepts a CDK display path or " +
        'stack-qualified logical ID; single-stack apps may omit the prefix. Omit <target> in a ' +
        'TTY to pick from a list. Runs until ^C.'
    )
    .argument(
      '[target]',
      'CDK display path or stack-qualified logical ID of the WebFunction / WebFunctionEndpoint / WebFunctionRevision (omit to pick interactively in a TTY)'
    )
    .action(
      withErrorHandling(
        async (target: string | undefined, options: LocalStartWebFunctionOptions) => {
          await localStartWebFunctionCommand(
            target,
            options,
            opts.extraStateProviders,
            opts.synthesizer
          );
        }
      )
    );

  addStartWebFunctionSpecificOptions(cmd);
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(regionOption);
  return cmd;
}

/**
 * Register the option block `cdkl start-web-function` adds on top of the
 * shared common / app / context helpers. Shared with any host CLI wrapping this
 * factory, so a new `start-web-function`-only flag lands here once. Chainable.
 */
export function addStartWebFunctionSpecificOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option(
        '--revision <logicalId>',
        'Serve this WebFunctionRevision (logical ID) instead of the one the endpoint weights pick.'
      )
    )
    .addOption(
      new Option('--port <n>', 'Local port to serve on. Default 0 (OS-assigned).')
        .default(0)
        .argParser(parsePort)
    )
    .addOption(new Option('--host <ip>', 'Address to publish the port on.').default('127.0.0.1'))
    .addOption(
      new Option(
        '--platform <platform>',
        "docker --platform for the server container. Defaults to the runtime's cloud " +
          'architecture (linux/arm64 for nodejs24.x).'
      ).choices(['linux/amd64', 'linux/arm64'])
    )
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"RevisionLogicalId":{"KEY":"VALUE"}, "Parameters": {...}})'
      )
    )
    .addOption(
      new Option('--no-pull', 'Skip docker pull of the runtime base image (use the cached image)')
    )
    .addOption(
      new Option(
        '--timeout <ms>',
        'Maximum time in milliseconds to wait for the server to answer HTTP. Default 60000.'
      )
        .default(60000)
        .argParser(parseTimeoutMs)
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume the revision's execution role and forward STS-issued temp credentials to the " +
          'container. (1) `--assume-role <arn>` assumes the explicit ARN; (2) `--assume-role` ' +
          "(bare) uses the revision's literal ServiceConfig.ExecutionRoleArn; (3) " +
          '`--no-assume-role` opts out. Off by default.'
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
