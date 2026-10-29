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
import { ensureDockerAvailable } from '../../local/docker-runner.js';
import { parseTimeoutMs } from './local-invoke-agentcore.js';
import type { LambdaContainerEnvOptions } from './local-invoke.js';
import { resolveWebFunctionTarget } from '../../local/web-function-resolver.js';
import { webFunctionFidelityWarnings } from '../../local/web-function-service-config.js';
import { WebFunctionServe, prepareWebFunctionServe } from './web-function-serve.js';

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

  const forever = (): Promise<never> => new Promise<never>(() => undefined);

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
  const prepared = prepareWebFunctionServe(resolved);
  const selectionNote: Record<typeof resolved.selection, string> = {
    'target-revision': 'the target revision',
    'revision-flag': '--revision',
    'endpoint-weight': `highest weight on endpoint ${displayIdent(resolved.endpoint?.logicalId ?? '')}`,
    'only-revision': "the function's only revision",
  };
  logger.info(
    `Target: ${displayStackName(`${resolved.stack.stackName}/${resolved.revisionLogicalId}`)} ` +
      `(${prepared.spec.runtime}; revision chosen by ${selectionNote[resolved.selection]})`
  );
  for (const line of webFunctionFidelityWarnings(resolved, prepared.serviceConfig)) {
    logger.warn(line);
  }

  const serve = new WebFunctionServe(prepared, {
    envOptions: options,
    ...(profileCredentials !== undefined && { profileCredentials }),
    ...(extraStateProviders !== undefined && { extraStateProviders }),
    host: options.host,
    port: options.port,
    ...(options.platform !== undefined && { platform: options.platform }),
    skipPull: options.pull === false,
    timeoutMs: options.timeout,
  });
  let shuttingDown = false;

  // Armed before the first host-side effect (the extracted bundle), so ^C
  // during the extraction or a long first pull still removes it.
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM', exitCode: number): Promise<void> => {
    if (shuttingDown) {
      // A second signal. Abandon ONLY while teardown waits on an in-flight
      // `docker run` (which may never return). Once it is removing the
      // container / bundle, finish: a double ^C reaches the whole process group,
      // so exiting here would also cut short the `docker rm -f` child and leave
      // a credential-bearing container running.
      if (!serve.waitingOnRun) {
        logger.info(`Received ${signal} again; still removing the container, please wait...`);
        return;
      }
      // The bundle is ours alone: remove it now, synchronously.
      serve.disposeArtifactNow();
      logger.warn(
        `Received ${signal} again; exiting without waiting for docker run to return. The ` +
          `container may still be starting, and its environment holds the forwarded AWS ` +
          `credentials. Remove it by its name (this works even if it is created after this ` +
          `exit): docker rm -f ${serve.containerName ?? '<name>'}`
      );
      process.exit(signal === 'SIGINT' ? 130 : 143);
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    await serve.teardown();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT', 130));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  try {
    const address = await serve.start();
    // A signal mid-start: its shutdown owns the teardown and the exit.
    if (!address) return await forever();
    logger.info(
      `Server listening on http://${formatAuthority(address.host, address.port)}  ` +
        `(${displayIdent(resolved.functionName)} (Lambda web function))`
    );
    logger.info('Press ^C to shut down.');
  } catch (err) {
    if (shuttingDown) return await forever();
    await serve.teardown();
    throw err;
  }

  // Serving. The `docker wait` child keeps the process alive; when the server
  // exits on its own, fail loudly (non-zero) with its last output instead of
  // exiting 0 with the container and the extracted bundle left behind.
  const exited = serve.exited;
  if (!exited) return await forever();
  const exitCode = await exited;
  if (shuttingDown || serve.tornDown) return await forever();
  const failure = await serve.exitFailure(
    `The web function container exited (exit code ${exitCode ?? 'unknown'}) while serving.`
  );
  await serve.teardown();
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
          "(bare) uses the revision's ServiceConfig.ExecutionRoleArn: a literal ARN as written, or " +
          'the Fn::GetAtt / Ref CDK synthesizes resolved against --from-cfn-stack deployed state; (3) ' +
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
