import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  regionOption,
  parseContextOptions,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { CdkLocalError, withErrorHandling } from '../../utils/error-handler.js';
import { listTargets } from '../../local/target-lister.js';
import { resolveSingleTarget } from '../../local/target-picker.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import {
  createLocalStateProvider,
  resolveCfnFallbackRegion,
  type ExtraStateProviders,
} from './local-state-source.js';
import type { LocalStateProvider } from '../../local/local-state-provider.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import {
  AGENTCORE_A2A_PROTOCOL,
  AGENTCORE_MCP_PROTOCOL,
  pickAgentCoreCandidateStack,
  resolveAgentCoreTarget,
  type ResolvedAgentCoreRuntime,
} from '../../local/agentcore-resolver.js';
import { waitForAgentCorePing } from '../../local/agentcore-client.js';
import {
  startAgentCoreHttpServer,
  type RunningAgentCoreHttpServer,
} from '../../local/agentcore-http-server.js';
import {
  ensureDockerAvailable,
  pickFreePort,
  removeContainer,
  runDetached,
  streamLogs,
} from '../../local/docker-runner.js';
import { resolveProfileCredentials } from './local-start-api.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from './local-profile-credentials-file.js';
import {
  buildAgentCoreImageContext,
  buildContainerEnv,
  parseTimeoutMs,
  resolveAgentCoreImage,
  resolveFromS3BucketIntrinsic,
  resolveInboundAuthorization,
  type LocalInvokeAgentCoreOptions,
} from './local-invoke-agentcore.js';

/**
 * Options for `cdkl start-agentcore`. A superset of the single-shot
 * `invoke-agentcore` options (so the shared boot / env / auth / image helpers
 * can be reused verbatim) plus the bridge-server bind controls. The
 * invoke-only fields (`--ws` / `--sigv4` / `--event` / `--event-stdin`) are
 * absent — this command never single-shots; it serves the `/ws` endpoint.
 */
interface LocalStartAgentCoreOptions extends LocalInvokeAgentCoreOptions {
  /** Bridge-server bind port (`--port`, default 0 = OS-assigned). */
  port: number;
  /** Bridge-server bind host (`--host`, default 127.0.0.1). */
  host: string;
}

/**
 * Parser for `--port <n>`. Accepts 0 (OS-assigned) through 65535.
 */
function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new CdkLocalError(`--port must be an integer 0-65535, got '${raw}'.`, 'INVALID_PORT');
  }
  return n;
}

/**
 * Reject MCP / A2A runtimes: the `/ws` WebSocket endpoint this command serves
 * exists only on the HTTP / AGUI protocols. MCP (`POST /mcp`) and A2A
 * (`POST /`) are single-shot request/response contracts with no bidirectional
 * socket. Exported so a unit test can drive the gate without the Docker
 * pipeline.
 */
export function assertAgentCoreWsServable(
  resolved: Pick<ResolvedAgentCoreRuntime, 'protocol' | 'logicalId'>
): void {
  if (
    resolved.protocol === AGENTCORE_MCP_PROTOCOL ||
    resolved.protocol === AGENTCORE_A2A_PROTOCOL
  ) {
    throw new CdkLocalError(
      `${getEmbedConfig().cliName} start-agentcore serves the HTTP / AGUI /ws WebSocket endpoint, but ` +
        `'${resolved.logicalId}' is a ${resolved.protocol} runtime, which has no /ws. ` +
        `Use \`${getEmbedConfig().cliName} invoke-agentcore\` for ${resolved.protocol} runtimes.`,
      'LOCAL_START_AGENTCORE_PROTOCOL_UNSUPPORTED'
    );
  }
}

/**
 * `cdkl start-agentcore <target>` — boot a Bedrock AgentCore Runtime container
 * locally and serve its bidirectional `/ws` WebSocket endpoint behind a
 * long-running host bridge, so a browser (or any WebSocket client) can hold an
 * interactive multi-frame session against it.
 *
 * Why a bridge rather than the published container port directly: the
 * AgentCore `/ws` upgrade requires the session-id (and, under a
 * `customJwtAuthorizer`, `Authorization`) header, which a browser `WebSocket`
 * cannot set. The bridge accepts a header-less client and injects those
 * headers on the container leg. HTTP / AGUI protocols only — MCP / A2A
 * runtimes have no `/ws`.
 *
 * The container is booted once via the SAME image / env / auth resolution as
 * `cdkl invoke-agentcore`; the process then blocks until SIGINT / SIGTERM,
 * tearing down the bridge and the container.
 */
async function localStartAgentCoreCommand(
  target: string | undefined,
  options: LocalStartAgentCoreOptions,
  extraStateProviders: ExtraStateProviders | undefined
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  let containerId: string | undefined;
  let stopLogs: (() => void) | undefined;
  let server: RunningAgentCoreHttpServer | undefined;
  let profileCredsFile: ProfileCredentialsFile | undefined;
  let stateProvider: LocalStateProvider | undefined;
  let shuttingDown = false;
  let tornDown = false;

  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    if (server) {
      try {
        await server.close();
      } catch (err) {
        logger.debug(`server close failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (stopLogs) {
      try {
        stopLogs();
      } catch (err) {
        logger.debug(`streamLogs stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (containerId) {
      try {
        await removeContainer(containerId);
      } catch (err) {
        logger.debug(
          `removeContainer(${containerId}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (stateProvider) {
      try {
        stateProvider.dispose();
      } catch {
        /* best-effort */
      }
    }
    if (profileCredsFile) {
      try {
        await profileCredsFile.dispose();
      } catch {
        /* best-effort */
      }
    }
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
  if (options.profile && profileCredentials) {
    profileCredsFile = await writeProfileCredentialsFile(options.profile, profileCredentials);
  }

  const appCmd = resolveApp(options.app);
  if (!appCmd) {
    throw new Error(
      `No CDK app specified. Pass --app, set ${getEmbedConfig().envPrefix}_APP, or add "app" to cdk.json.`
    );
  }

  logger.info('Synthesizing CDK app...');
  const synthesizer = new Synthesizer();
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
    entries: listTargets(stacks).agentCoreRuntimes,
    message: 'Select an AgentCore Runtime to serve',
    noun: 'AgentCore Runtimes',
    onMissing: () =>
      new CdkLocalError(
        `${getEmbedConfig().cliName} start-agentcore requires a <target> (an AgentCore Runtime display path or logical ID). ` +
          `Run \`${getEmbedConfig().cliName} list\` to see them, or run it in a TTY to pick interactively.`,
        'LOCAL_START_AGENTCORE_TARGET_REQUIRED'
      ),
  });

  const candidate = pickAgentCoreCandidateStack(resolvedTarget, stacks);
  stateProvider = createLocalStateProvider(
    options,
    candidate?.stackName ?? '',
    await resolveCfnFallbackRegion(options, candidate?.region),
    extraStateProviders
  );
  const { context: imageContext, loaded: loadedState } =
    stateProvider && candidate
      ? await buildAgentCoreImageContext(candidate, stateProvider, options)
      : { context: undefined, loaded: undefined };

  const resolved = resolveAgentCoreTarget(resolvedTarget, stacks, imageContext);
  logger.info(`Target: ${resolved.stack.stackName}/${resolved.logicalId} (${resolved.protocol})`);

  // The /ws WebSocket endpoint exists only on the HTTP / AGUI protocols.
  assertAgentCoreWsServable(resolved);

  // Inbound JWT auth: when the runtime declares a customJwtAuthorizer, verify
  // the supplied --bearer-token against its OIDC discovery URL BEFORE any
  // Docker work and resolve the Authorization header the bridge injects on the
  // container leg (the bridge speaks to the same authorizer the cloud would).
  const authorization = await resolveInboundAuthorization(resolved, options);

  // Resolve a fromS3 bundle's intrinsic bucket before the image step.
  await resolveFromS3BucketIntrinsic(resolved, stateProvider, loadedState, imageContext);

  const image = await resolveAgentCoreImage(resolved, options, loadedState, stateProvider);
  const { env: dockerEnv, sensitiveEnvKeys } = await buildContainerEnv(
    resolved,
    options,
    profileCredentials,
    profileCredsFile,
    stateProvider,
    loadedState,
    imageContext
  );

  const containerHostPort = await pickFreePort();
  const containerHost = options.containerHost;
  // Stable `cdkl-`-prefixed name so the orphan sweep (`docker ps --filter
  // name=cdkl-`) used by `/cleanup` + `/run-integ` finds this long-lived
  // container if the process is killed before teardown.
  const containerName = `${getEmbedConfig().resourceNamePrefix}-agentcore-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  logger.info(`Starting agent container (image=${image}, port=${containerHostPort} -> 8080)...`);
  containerId = await runDetached({
    image,
    mounts: [],
    env: dockerEnv,
    cmd: [],
    hostPort: containerHostPort,
    host: containerHost,
    platform: options.platform,
    name: containerName,
    ...(sensitiveEnvKeys.size > 0 && { sensitiveEnvKeys }),
  });
  stopLogs = streamLogs(containerId);

  // Wire the shutdown handlers NOW — immediately after the container is booted,
  // BEFORE the (potentially slow) /ping wait + bridge bind — so a SIGINT /
  // SIGTERM arriving during boot still tears the container down instead of
  // orphaning it. `teardown` is null-safe (the bridge may not exist yet) and
  // idempotent, so the boot-error catch below and a racing signal cannot
  // double-tear-down.
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    await teardown();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT', 130));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  // A failure in the post-boot setup (/ping wait or server bind) must stop the
  // booted container before rethrowing.
  try {
    await waitForAgentCorePing(containerHost, containerHostPort, options.timeout);
    server = await startAgentCoreHttpServer({
      containerHost,
      containerPort: containerHostPort,
      host: options.host,
      port: options.port,
      ...(authorization && { authorization }),
      ...(options.sessionId && { sessionId: options.sessionId }),
    });
  } catch (err) {
    await teardown();
    throw err;
  }

  // The warm container serves its HTTP contract (POST /invocations + GET /ping)
  // AND the /ws bridge on one port (issue #454). The `Server listening on
  // ws://...` line is kept verbatim so studio's serve-manager readyRe still
  // captures the ws:// endpoint for its WebSocket console; the HTTP line below
  // points humans / curl at the request endpoints.
  logger.info(`Server listening on ${server.wsUrl}  (${resolved.logicalId} (AgentCore WebSocket))`);
  logger.info(
    `HTTP contract served on ${server.httpUrl} — POST ${server.httpUrl}/invocations, GET ${server.httpUrl}/ping`
  );
  logger.info('Press ^C to shut down.');

  // Block forever — signal handlers exit the process.
  await new Promise<never>(() => undefined);
}

export interface CreateLocalStartAgentCoreCommandOptions {
  extraStateProviders?: ExtraStateProviders;
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl start-agentcore <target>` — long-running serve for a Bedrock AgentCore
 * Runtime's `/ws` WebSocket endpoint, fronted by a host bridge that injects the
 * session-id / Authorization upgrade headers a browser `WebSocket` cannot set.
 * The serve counterpart of the single-shot `cdkl invoke-agentcore`; the studio
 * `agentcore-ws` serve kind spawns this command.
 */
export function createLocalStartAgentCoreCommand(
  opts: CreateLocalStartAgentCoreCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('start-agentcore')
    .description(
      "Serve a Bedrock AgentCore Runtime's bidirectional /ws WebSocket endpoint locally for an " +
        'interactive multi-frame session. Boots the AWS::BedrockAgentCore::Runtime container (same ' +
        'image / env / credential resolution as invoke-agentcore), then runs a host WebSocket bridge ' +
        'that injects the AgentCore session-id (and Authorization under a customJwtAuthorizer) on the ' +
        'container upgrade so a header-less client (e.g. a browser) can connect. HTTP / AGUI protocols ' +
        'only (MCP / A2A runtimes have no /ws). Target accepts a CDK display path (MyStack/MyAgent) or ' +
        'stack-qualified logical ID; single-stack apps may omit the prefix. Omit <target> in a TTY to ' +
        'pick from a list. Runs until ^C.'
    )
    .argument(
      '[target]',
      'CDK display path or stack-qualified logical ID of the AgentCore Runtime to serve (omit to pick interactively in a TTY)'
    )
    .action(
      withErrorHandling(async (target: string | undefined, options: LocalStartAgentCoreOptions) => {
        await localStartAgentCoreCommand(target, options, opts.extraStateProviders);
      })
    );

  addStartAgentCoreSpecificOptions(cmd);
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(regionOption);
  return cmd;
}

/**
 * Register the option block `cdkl start-agentcore` adds on top of the shared
 * common / app / context helpers. Shared with any host CLI (e.g. cdkd's
 * `local start-agentcore`) wrapping this factory, so adding or renaming a
 * `start-agentcore`-only flag here propagates without duplicate
 * `.addOption(...)` blocks. Chainable: returns `cmd`.
 */
export function addStartAgentCoreSpecificOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option(
        '--port <n>',
        'Bridge-server bind port the client (browser) connects to. Default 0 (OS-assigned).'
      )
        .default(0)
        .argParser(parsePort)
    )
    .addOption(
      new Option('--host <ip>', 'Bridge-server bind host. Default 127.0.0.1.').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--session-id <id>',
        'Pin one AgentCore runtime session id header value for every connection ' +
          '(default: a fresh random UUID per connection, so each client is its own session).'
      )
    )
    .addOption(
      new Option(
        '--bearer-token <jwt>',
        'Bearer JWT to present when the runtime declares a customJwtAuthorizer. Verified against ' +
          "the runtime's OIDC discovery URL before the container starts, then injected as " +
          'Authorization: Bearer <jwt> on the container /ws upgrade for every bridged connection.'
      )
    )
    .addOption(
      new Option(
        '--no-verify-auth',
        'Skip inbound JWT verification even when the runtime declares a customJwtAuthorizer ' +
          '(local-dev escape hatch). A --bearer-token, if given, is still forwarded.'
      )
    )
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"LogicalId":{"KEY":"VALUE"}, "Parameters": {...}})'
      )
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'docker --platform for the agent container (linux/amd64 or linux/arm64). ' +
          'Defaults to linux/arm64 because the cloud AgentCore Runtime requires arm64.'
      )
        .choices(['linux/amd64', 'linux/arm64'])
        .default('linux/arm64')
    )
    .addOption(
      new Option(
        '--no-pull',
        'Skip docker pull (use cached image) — no-op for the local-build path'
      )
    )
    .addOption(
      new Option(
        '--no-build',
        'Skip docker build on the local-asset path (use the previously-built tag). No-op for the ECR / registry pull paths.'
      )
    )
    .addOption(
      new Option(
        '--container-host <host>',
        'Host IP used to bind the agent container port. Must be a numeric IP. Defaults to 127.0.0.1.'
      ).default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--timeout <ms>',
        'Maximum time in milliseconds to wait for the container to become ready (the GET /ping readiness deadline). Default 120000.'
      )
        .default(120000)
        .argParser(parseTimeoutMs)
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume the runtime's execution role and forward STS-issued temp credentials to the container. " +
          '(1) `--assume-role <arn>` assumes the explicit ARN; ' +
          "(2) `--assume-role` (bare) uses the runtime's literal RoleArn; " +
          '(3) `--no-assume-role` opts out. Off by default.'
      )
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized registries.'
      )
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack and substitute Ref / Fn::ImportValue in env vars / image ' +
          'URIs with the deployed physical IDs / exports. Bare form uses the resolved stack name.'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      )
    );
}
