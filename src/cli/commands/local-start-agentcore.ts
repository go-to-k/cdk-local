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
} from '../../local/agentcore-resolver.js';
import { waitForAgentCorePing, waitForAgentCoreHttpReady } from '../../local/agentcore-client.js';
import { MCP_CONTAINER_PORT, MCP_PATH } from '../../local/agentcore-mcp-client.js';
import { A2A_CONTAINER_PORT, A2A_PATH } from '../../local/agentcore-a2a-client.js';
import {
  startAgentCoreHttpServer,
  type AgentCoreServeRoute,
  type AgentCoreServeSignRequest,
  type RunningAgentCoreHttpServer,
} from '../../local/agentcore-http-server.js';
import { selectServeInboundAuth } from '../../local/agentcore-serve-auth.js';
import { signAgentCoreInvocation } from '../../local/agentcore-sigv4-sign.js';
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
  resolveAgentCoreSigV4Context,
  resolveFromS3BucketIntrinsic,
  type LocalInvokeAgentCoreOptions,
} from './local-invoke-agentcore.js';

/**
 * Options for `cdkl start-agentcore`. A superset of the single-shot
 * `invoke-agentcore` options (so the shared boot / env / auth / image helpers
 * can be reused verbatim) plus the serve bind controls. The invoke-only fields
 * (`--ws` / `--event` / `--event-stdin`) are absent — this command never
 * single-shots; it keeps the container warm and serves its contract. `--sigv4`
 * IS accepted (issue #454): it signs each forwarded request, the serve
 * counterpart of invoke's single-shot signing.
 */
interface LocalStartAgentCoreOptions extends LocalInvokeAgentCoreOptions {
  /** Serve bind port (`--port`, default 0 = OS-assigned). */
  port: number;
  /** Serve bind host (`--host`, default 127.0.0.1). */
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
 * How `cdkl start-agentcore` serves a warm container for a given runtime
 * protocol. The HTTP serve proxy is protocol-agnostic — only the published
 * container port, the routing table, the `/ws`-attach decision, and the
 * readiness probe differ per protocol. Exported so a unit test can lock the
 * per-protocol mapping without the Docker pipeline.
 */
export interface AgentCoreServePlan {
  /**
   * Container port the host port maps to (`runDetached.containerPort`), or
   * `undefined` to use the default 8080 (HTTP / AGUI).
   */
  containerPort: number | undefined;
  /** Human label for the boot log (`<port>` or `<port><path>`). */
  containerPortLabel: string;
  /** `{method, path}` pairs the serve forwards to the warm container. */
  routes: AgentCoreServeRoute[];
  /** Whether to attach the `/ws` bridge (HTTP / AGUI only). */
  attachWs: boolean;
  /**
   * Path for the post-boot HTTP readiness probe (MCP / A2A, which have no
   * `GET /ping`), or `undefined` to use the `GET /ping` wait (HTTP / AGUI).
   */
  readyPath: string | undefined;
}

/**
 * Map a resolved runtime's protocol to its warm-serve plan. All four protocols
 * are served (issue #454): HTTP / AGUI on 8080 (`POST /invocations` + `GET
 * /ping` + the `/ws` bridge), MCP on 8000 (`POST /mcp`), A2A on 9000
 * (`POST /`). MCP / A2A are pure request/response pass-through with no `/ws`.
 */
export function resolveAgentCoreServePlan(protocol: string): AgentCoreServePlan {
  if (protocol === AGENTCORE_MCP_PROTOCOL) {
    return {
      containerPort: MCP_CONTAINER_PORT,
      containerPortLabel: `${MCP_CONTAINER_PORT}${MCP_PATH}`,
      routes: [{ method: 'POST', path: MCP_PATH }],
      attachWs: false,
      readyPath: MCP_PATH,
    };
  }
  if (protocol === AGENTCORE_A2A_PROTOCOL) {
    return {
      containerPort: A2A_CONTAINER_PORT,
      containerPortLabel: `${A2A_CONTAINER_PORT}${A2A_PATH}`,
      routes: [{ method: 'POST', path: A2A_PATH }],
      attachWs: false,
      readyPath: A2A_PATH,
    };
  }
  // HTTP / AGUI: 8080, the default routes (POST /invocations + GET /ping) +
  // the /ws bridge, GET /ping readiness.
  return {
    containerPort: undefined,
    containerPortLabel: '8080',
    routes: [
      { method: 'POST', path: '/invocations' },
      { method: 'GET', path: '/ping' },
    ],
    attachWs: true,
    readyPath: undefined,
  };
}

/**
 * `cdkl start-agentcore <target>` — boot a Bedrock AgentCore Runtime container
 * locally ONCE, keep it warm, and serve its native contract on one host port
 * until SIGINT / SIGTERM, so a client can hit the agent repeatedly against the
 * SAME warm container (issue #454).
 *
 * All four protocols are served (the proxy is protocol-agnostic; only the
 * routing + readiness differ per {@link resolveAgentCoreServePlan}):
 *  - HTTP / AGUI (8080): `POST /invocations` + `GET /ping`, plus the
 *    bidirectional `/ws` endpoint behind a host bridge. The `/ws` upgrade
 *    requires the session-id (and, under a `customJwtAuthorizer`,
 *    `Authorization`) header a browser `WebSocket` cannot set, so the bridge
 *    accepts a header-less client and injects those headers on the container
 *    leg.
 *  - MCP (8000): `POST /mcp`. A2A (9000): `POST /`. No `/ws` — pure
 *    request/response pass-through (the client drives the handshake).
 *
 * The container is booted once via the SAME image / env / auth resolution as
 * `cdkl invoke-agentcore`; the process then blocks until SIGINT / SIGTERM,
 * tearing down the serve and the container.
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

  // Protocol -> warm-serve plan (container port + routes + /ws-attach +
  // readiness). All four protocols are served (issue #454).
  const plan = resolveAgentCoreServePlan(resolved.protocol);

  // Inbound auth (issue #454). Unlike single-shot invoke-agentcore (which
  // validates the --bearer-token ONCE at boot), the warm serve verifies the
  // CALLER's token PER REQUEST against the customJwtAuthorizer (as the cloud
  // does). Resolve the strategy before any Docker work:
  //  - customJwtAuthorizer => a per-request authCheck gates each POST contract
  //    request (401 missing / 403 invalid); the --bearer-token (if any) is the
  //    default injected when the inbound request carries none.
  //  - else --sigv4 => resolve the SigV4 signing context (creds + region; same
  //    resolution as invoke-agentcore) and sign each forwarded POST.
  //  - else => forward the --bearer-token verbatim (pass-through), if given.
  // The conflict / region / creds checks live in resolveAgentCoreSigV4Context
  // (shared with invoke); it returns undefined when --sigv4 is off or an
  // authorizer is declared (the JWT path wins, warns).
  const sigv4Context = await resolveAgentCoreSigV4Context(
    options,
    resolved,
    loadedState,
    stateProvider
  );
  const authPlan = selectServeInboundAuth(resolved, options, sigv4Context !== undefined);
  if (authPlan.authCheck && resolved.jwtAuthorizer) {
    logger.info(
      `Inbound JWT: each request verified per-request against ${resolved.jwtAuthorizer.discoveryUrl}` +
        `${options.verifyAuth === false ? ' (verification DISABLED via --no-verify-auth)' : ''}.`
    );
  }

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
  logger.info(
    `Starting agent container (image=${image}, port=${containerHostPort} -> ${plan.containerPortLabel})...`
  );
  containerId = await runDetached({
    image,
    mounts: [],
    env: dockerEnv,
    cmd: [],
    hostPort: containerHostPort,
    host: containerHost,
    platform: options.platform,
    name: containerName,
    // MCP / A2A publish the host port to 8000 / 9000 (HTTP / AGUI -> 8080).
    ...(plan.containerPort !== undefined && { containerPort: plan.containerPort }),
    ...(sensitiveEnvKeys.size > 0 && { sensitiveEnvKeys }),
  });
  stopLogs = streamLogs(containerId);

  // Wire the shutdown handlers NOW — immediately after the container is booted,
  // BEFORE the (potentially slow) readiness wait + serve bind — so a SIGINT /
  // SIGTERM arriving during boot still tears the container down instead of
  // orphaning it. `teardown` is null-safe (the server may not exist yet) and
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

  // A failure in the post-boot setup (readiness wait or server bind) must stop
  // the booted container before rethrowing.
  try {
    // HTTP / AGUI wait on GET /ping; MCP / A2A (no /ping) wait on an HTTP
    // response to the protocol path.
    if (plan.readyPath === undefined) {
      await waitForAgentCorePing(containerHost, containerHostPort, options.timeout);
    } else {
      await waitForAgentCoreHttpReady(
        containerHost,
        containerHostPort,
        plan.readyPath,
        options.timeout
      );
    }
    // --sigv4: sign each forwarded POST against the warm container's host:port
    // (built here, now that the port is known). Reuses the boot-resolved
    // credentials + region from resolveAgentCoreSigV4Context.
    const signRequest: AgentCoreServeSignRequest | undefined =
      authPlan.sign && sigv4Context
        ? async ({ method, path, body, sessionId }) => {
            const signed = await signAgentCoreInvocation({
              credentials: sigv4Context.credentials,
              region: sigv4Context.region,
              host: containerHost,
              port: containerHostPort,
              path,
              // Pass the raw Buffer (not a re-encoded string) so the signature
              // commits to the exact bytes the proxy forwards.
              body,
              sessionId,
              method,
            });
            const h: Record<string, string> = {
              Authorization: signed.authorization,
              'X-Amz-Date': signed.amzDate,
              'X-Amz-Content-Sha256': signed.amzContentSha256,
            };
            if (signed.amzSecurityToken) h['X-Amz-Security-Token'] = signed.amzSecurityToken;
            return h;
          }
        : undefined;

    server = await startAgentCoreHttpServer({
      containerHost,
      containerPort: containerHostPort,
      host: options.host,
      port: options.port,
      routes: plan.routes,
      attachWs: plan.attachWs,
      ...(authPlan.bridgeAuthorization && { authorization: authPlan.bridgeAuthorization }),
      ...(authPlan.authCheck && { authCheck: authPlan.authCheck }),
      ...(signRequest && { signRequest }),
      ...(options.sessionId && { sessionId: options.sessionId }),
    });
  } catch (err) {
    await teardown();
    throw err;
  }

  // Ready lines. For HTTP / AGUI the warm container serves its HTTP contract
  // (POST /invocations + GET /ping) AND the /ws bridge on one port; the
  // `Server listening on ws://...` line is kept VERBATIM so studio's
  // serve-manager readyRe still captures the ws:// endpoint for its WebSocket
  // console, and the HTTP line points humans / curl at the request endpoints.
  // MCP / A2A have no /ws, so they print the http:// listen line + the protocol
  // contract path instead.
  if (server.wsUrl) {
    logger.info(
      `Server listening on ${server.wsUrl}  (${resolved.logicalId} (AgentCore WebSocket))`
    );
    logger.info(
      `HTTP contract served on ${server.httpUrl} — POST ${server.httpUrl}/invocations, GET ${server.httpUrl}/ping`
    );
  } else {
    const contractPath = plan.routes[0]?.path ?? '/';
    const contractUrl = `${server.httpUrl}${contractPath}`;
    logger.info(`Server listening on ${server.httpUrl}  (${resolved.logicalId})`);
    logger.info(`${resolved.protocol} contract served on ${contractUrl} — POST ${contractUrl}`);
  }
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
 * `cdkl start-agentcore <target>` — long-running warm serve for a Bedrock
 * AgentCore Runtime. Boots the container once and serves its native contract on
 * one host port: HTTP / AGUI get `POST /invocations` + `GET /ping` plus the
 * `/ws` bridge (which injects the session-id / Authorization upgrade headers a
 * browser `WebSocket` cannot set), MCP gets `POST /mcp`, A2A gets `POST /`. The
 * serve counterpart of the single-shot `cdkl invoke-agentcore`; the studio
 * `agentcore-ws` serve kind spawns this command.
 */
export function createLocalStartAgentCoreCommand(
  opts: CreateLocalStartAgentCoreCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('start-agentcore')
    .description(
      "Serve a Bedrock AgentCore Runtime's contract locally against a warm container. Boots the " +
        'AWS::BedrockAgentCore::Runtime container ONCE (same image / env / credential resolution as ' +
        'invoke-agentcore) and keeps it warm, so a client can hit it repeatedly. HTTP / AGUI runtimes ' +
        'serve POST /invocations + GET /ping plus the bidirectional /ws endpoint behind a host bridge ' +
        '(injects the AgentCore session-id, and Authorization under a customJwtAuthorizer, so a ' +
        'header-less client like a browser can connect); MCP runtimes serve POST /mcp, A2A POST /. ' +
        'Target accepts a CDK display path (MyStack/MyAgent) or stack-qualified logical ID; ' +
        'single-stack apps may omit the prefix. Omit <target> in a TTY to pick from a list. Runs ' +
        'until ^C.'
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
        'Serve bind port the client connects to (HTTP contract + /ws on the same port). Default 0 (OS-assigned).'
      )
        .default(0)
        .argParser(parsePort)
    )
    .addOption(
      new Option('--host <ip>', 'Serve bind host. Default 127.0.0.1.').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--session-id <id>',
        'Pin one AgentCore runtime session id header value for every forwarded request / /ws ' +
          'connection (default: a fresh random UUID each, so each is its own session).'
      )
    )
    .addOption(
      new Option(
        '--bearer-token <jwt>',
        'Bearer JWT to present when the runtime declares a customJwtAuthorizer. Verified against ' +
          "the runtime's OIDC discovery URL before the container starts, then injected as " +
          'Authorization: Bearer <jwt> on every forwarded request and the container /ws upgrade.'
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
        '--sigv4',
        'Sign each forwarded request with AWS SigV4 (service bedrock-agentcore) when the runtime ' +
          'declares NO customJwtAuthorizer, so the warm container sees the same Authorization / ' +
          'X-Amz-* headers the cloud receives. Mutually exclusive with --bearer-token; ignored ' +
          '(with a warning) when a customJwtAuthorizer is declared.'
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
