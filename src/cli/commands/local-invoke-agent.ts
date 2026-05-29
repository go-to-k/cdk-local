import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { CdkLocalError, withErrorHandling } from '../../utils/error-handler.js';
import { listTargets } from '../../local/target-lister.js';
import { resolveSingleTarget } from '../../local/target-picker.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { readCdkPathOrUndefined } from '../cdk-path.js';
import {
  createLocalStateProvider,
  resolveCfnFallbackRegion,
  type ExtraStateProviders,
} from './local-state-source.js';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import {
  resolveAgentCoreTarget,
  type ResolvedAgentRuntime,
} from '../../local/agentcore-resolver.js';
import {
  invokeAgent,
  waitForAgentPing,
  type AgentInvokeResult,
} from '../../local/agentcore-client.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local/env-resolver.js';
import {
  substituteEnvVarsFromStateAsync,
  type SubstitutionContext,
} from '../../local/state-resolver.js';
import { derivePseudoParametersFromRegion } from '../../local/intrinsic-image.js';
import {
  ensureDockerAvailable,
  pickFreePort,
  pullImage,
  removeContainer,
  runDetached,
  streamLogs,
} from '../../local/docker-runner.js';
import { buildContainerImage } from '../../local/docker-image-builder.js';
import { parseEcrUri, pullEcrImage } from '../../local/ecr-puller.js';
import {
  AssetManifestLoader,
  getDockerImageBySourceHash,
} from '../../assets/asset-manifest-loader.js';
import { singleFlight } from '../../utils/single-flight.js';
import { resolveProfileCredentials } from './local-start-api.js';
import { applyProfileCredentialsOverlay } from './local-invoke.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from './local-profile-credentials-file.js';

interface LocalInvokeAgentOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  event?: string;
  eventStdin?: boolean;
  envVars?: string;
  pull: boolean;
  build: boolean;
  containerHost: string;
  /** `--platform <linux/amd64|linux/arm64>`. Defaults to AgentCore's required arm64. */
  platform: string;
  /** Session id forwarded via the AgentCore session-id header (auto-generated when omitted). */
  sessionId?: string;
  /**
   * Optional execution role to assume before invoking. Commander's `[arn]`
   * maps to `string | boolean`:
   *   - absent → `undefined` (dev creds pass through; SAM-compatible default)
   *   - `--assume-role` (bare) → `true` (use the runtime's literal RoleArn)
   *   - `--assume-role <arn>` → `'<arn>'`
   *   - `--no-assume-role` → `false`
   */
  assumeRole?: string | boolean;
  /** Role ARN to assume before authenticating against ECR for the container image pull. */
  ecrRoleArn?: string;
  fromCfnStack?: string | boolean;
  stackRegion?: string;
  /** Host-injected extra state-source flag fields. */
  [key: string]: unknown;
}

/**
 * Factory options for {@link createLocalInvokeAgentCommand}.
 */
export interface CreateLocalInvokeAgentCommandOptions {
  extraStateProviders?: ExtraStateProviders;
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
}

/**
 * `cdkl invoke-agent <target>` — run a Bedrock AgentCore Runtime container
 * locally and invoke it once over the AgentCore HTTP contract. Resolves
 * the `AWS::BedrockAgentCore::Runtime`, pulls / builds its container,
 * starts it on port 8080, waits for `GET /ping`, POSTs the event to
 * `POST /invocations`, prints the response, and tears down. v1 covers the
 * container artifact + HTTP protocol; the agent's calls to real AWS go to
 * real AWS (credentials injected like `cdkl invoke`).
 */
async function localInvokeAgentCommand(
  target: string | undefined,
  options: LocalInvokeAgentOptions,
  extraStateProviders: ExtraStateProviders | undefined
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  warnIfDeprecatedRegion(options);

  let containerId: string | undefined;
  let stopLogs: (() => void) | undefined;
  let sigintHandler: (() => void) | undefined;
  let profileCredsFile: ProfileCredentialsFile | undefined;

  const cleanup = singleFlight(
    async (): Promise<void> => {
      if (stopLogs) {
        try {
          stopLogs();
        } catch (err) {
          getLogger().debug(
            `streamLogs stop failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (containerId) {
        try {
          await removeContainer(containerId);
        } catch (err) {
          getLogger().debug(
            `removeContainer(${containerId}) failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (profileCredsFile) {
        try {
          await profileCredsFile.dispose();
        } catch (err) {
          getLogger().debug(
            `Failed to remove profile credentials tmpdir ${profileCredsFile.hostPath}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    },
    (err) => {
      getLogger().debug(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  );

  try {
    await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });
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
      message: 'Select an AgentCore Runtime to invoke',
      noun: 'AgentCore Runtimes',
      onMissing: () =>
        new CdkLocalError(
          `${getEmbedConfig().cliName} invoke-agent requires a <target> (an AgentCore Runtime display path or logical ID). ` +
            `Run \`${getEmbedConfig().cliName} list\` to see them, or run it in a TTY to pick interactively.`,
          'LOCAL_INVOKE_AGENT_TARGET_REQUIRED'
        ),
    });

    const resolved = resolveAgentCoreTarget(resolvedTarget, stacks);
    logger.info(`Target: ${resolved.stack.stackName}/${resolved.logicalId} (${resolved.protocol})`);

    const image = await resolveAgentImage(resolved, options);

    const dockerEnv = await buildContainerEnv(
      resolved,
      options,
      profileCredentials,
      profileCredsFile,
      extraStateProviders
    );

    const hostPort = await pickFreePort();
    const containerHost = options.containerHost;
    logger.info(`Starting agent container (image=${image}, port=${hostPort})...`);
    containerId = await runDetached({
      image,
      mounts: [],
      env: dockerEnv,
      cmd: [],
      hostPort,
      host: containerHost,
      platform: options.platform,
    });

    stopLogs = streamLogs(containerId);

    sigintHandler = (): void => {
      void cleanup().then(() => process.exit(130));
    };
    process.on('SIGINT', sigintHandler);

    await waitForAgentPing(containerHost, hostPort);

    const sessionId = options.sessionId ?? randomUUID();
    const event = await readEvent(options);
    const result = await invokeAgent(containerHost, hostPort, event, {
      sessionId,
      timeoutMs: 120_000,
    });

    // Settle so container logs flush before teardown.
    await new Promise((r) => setTimeout(r, 250));
    emitResult(result);
  } finally {
    if (sigintHandler) process.off('SIGINT', sigintHandler);
    await cleanup();
  }
}

/**
 * Acquire the agent container image. Mirrors the container-Lambda path:
 * build from a local cdk.out asset when the URI matches one, else pull
 * from ECR, else pull a plain registry image.
 */
export async function resolveAgentImage(
  resolved: ResolvedAgentRuntime,
  options: LocalInvokeAgentOptions
): Promise<string> {
  const logger = getLogger();
  const architecture = platformToArchitecture(options.platform);

  const manifestPath = resolved.stack.assetManifestPath;
  if (manifestPath) {
    const cdkOutDir = dirname(manifestPath);
    const loader = new AssetManifestLoader();
    const manifest = await loader.loadManifest(cdkOutDir, resolved.stack.stackName);
    if (manifest) {
      const entry = getDockerImageBySourceHash(manifest, resolved.containerUri);
      if (entry) {
        return buildContainerImage(entry.asset, cdkOutDir, {
          architecture,
          noBuild: options.build === false,
        });
      }
    }
  }

  if (parseEcrUri(resolved.containerUri)) {
    logger.info(`Pulling agent image from ECR: ${resolved.containerUri}`);
    return pullEcrImage(resolved.containerUri, {
      skipPull: options.pull === false,
      ...(options.region !== undefined && { region: options.region }),
      ...(options.ecrRoleArn !== undefined && { ecrRoleArn: options.ecrRoleArn }),
      ...(options.profile !== undefined && { profile: options.profile }),
    });
  }

  await pullImage(resolved.containerUri, options.pull === false);
  return resolved.containerUri;
}

/**
 * Build the container env: resolved template env vars (+ `--env-vars`
 * overrides, + `--from-cfn-stack` state substitution) plus AWS credentials
 * (`--assume-role` STS temp creds, else `--profile` / dev creds).
 */
export async function buildContainerEnv(
  resolved: ResolvedAgentRuntime,
  options: LocalInvokeAgentOptions,
  profileCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined,
  extraStateProviders: ExtraStateProviders | undefined
): Promise<Record<string, string>> {
  const logger = getLogger();
  let templateEnv: Record<string, unknown> = resolved.environmentVariables;

  const stateProvider = createLocalStateProvider(
    options,
    resolved.stack.stackName,
    await resolveCfnFallbackRegion(options, resolved.stack.region),
    extraStateProviders
  );
  if (stateProvider) {
    try {
      const loaded = await stateProvider.load(resolved.stack.stackName, resolved.stack.region);
      if (loaded) {
        const subContext: SubstitutionContext = {
          resources: loaded.resources,
          consumerRegion: loaded.region,
        };
        const pseudo = derivePseudoParametersFromRegion(loaded.region);
        if (pseudo) subContext.pseudoParameters = pseudo;
        const resolver = await stateProvider.buildCrossStackResolver(loaded.region);
        if (resolver) subContext.crossStackResolver = resolver;
        const { env, audit } = await substituteEnvVarsFromStateAsync(templateEnv, subContext);
        templateEnv = env;
        for (const key of audit.resolvedKeys) {
          logger.debug(`${stateProvider.label}: substituted env var ${key}`);
        }
        for (const { key, reason } of audit.unresolved) {
          logger.warn(
            `${stateProvider.label}: could not substitute env var ${key} (${reason}). ` +
              `Override it via --env-vars or it will be dropped.`
          );
        }
      }
    } finally {
      stateProvider.dispose();
    }
  }

  const overrides = readEnvOverridesFile(options.envVars);
  const cdkPath = readCdkPathOrUndefined(resolved.resource);
  const envResult = resolveEnvVars(resolved.logicalId, cdkPath, templateEnv, overrides);
  for (const key of envResult.unresolved) {
    const overrideKeyExample = cdkPath?.replace(/\/Resource$/, '') ?? resolved.logicalId;
    logger.warn(
      `Environment variable ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${overrideKeyExample}":{"${key}":"<literal>"}}), ` +
        `or pass a state-source flag (e.g. --from-cfn-stack) to recover deployed values.`
    );
  }

  const dockerEnv: Record<string, string> = { ...envResult.resolved };
  const assumeRoleArn = resolveAssumeRoleArn(options, resolved);
  await applyAgentCredentialEnv(dockerEnv, {
    ...(assumeRoleArn !== undefined && { assumeRoleArn }),
    ...(options.region !== undefined && { region: options.region }),
    ...(profileCredentials !== undefined && { profileCredentials }),
    ...(profileCredsFile !== undefined && {
      profileCredsFile: {
        containerPath: profileCredsFile.containerPath,
        profileName: profileCredsFile.profileName,
      },
    }),
  });
  return dockerEnv;
}

/**
 * Inject AWS credentials into the container env. Precedence:
 *   1. `--assume-role` → STS-issued temp creds for the resolved ARN (on
 *      STS failure, warn + fall through to dev creds).
 *   2. dev shell creds (`forwardAwsEnv`) + `--profile` overlay
 *      ({@link applyProfileCredentialsOverlay}) + the bind-mounted
 *      credentials-file env so handler `fromIni({ profile })` resolves.
 *
 * Exported so a unit test can lock the binding (mock STS) without driving
 * the full synth + docker pipeline.
 */
export async function applyAgentCredentialEnv(
  dockerEnv: Record<string, string>,
  args: {
    assumeRoleArn?: string;
    region?: string;
    profileCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    profileCredsFile?: { containerPath: string; profileName: string };
  }
): Promise<void> {
  const logger = getLogger();
  let assumeSucceeded = false;
  if (args.assumeRoleArn) {
    const stsRegion = args.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
    try {
      const creds = await assumeAgentExecutionRole(args.assumeRoleArn, stsRegion);
      dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
      dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
      dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
      if (stsRegion) dockerEnv['AWS_REGION'] = stsRegion;
      assumeSucceeded = true;
    } catch (err) {
      logger.warn(
        `--assume-role: STS AssumeRole(${args.assumeRoleArn}) failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Falling back to the developer's shell credentials."
      );
    }
  }
  if (!assumeSucceeded) {
    forwardAwsEnv(dockerEnv);
    applyProfileCredentialsOverlay(dockerEnv, args.profileCredentials, false);
    if (args.profileCredsFile) {
      dockerEnv['AWS_SHARED_CREDENTIALS_FILE'] = args.profileCredsFile.containerPath;
      dockerEnv['AWS_PROFILE'] = args.profileCredsFile.profileName;
    }
  }
}

/**
 * Resolve the role ARN to assume, honoring the three `--assume-role` forms.
 * Bare `--assume-role` uses the runtime's literal `RoleArn`; warns when it
 * is an intrinsic (no ARN to assume) and falls back to dev creds.
 */
export function resolveAssumeRoleArn(
  options: LocalInvokeAgentOptions,
  resolved: ResolvedAgentRuntime
): string | undefined {
  if (typeof options.assumeRole === 'string') return options.assumeRole;
  if (options.assumeRole === true) {
    if (resolved.roleArn) return resolved.roleArn;
    getLogger().warn(
      "--assume-role passed without an ARN, but the runtime's RoleArn is not a literal ARN in the template. " +
        'Pass the ARN explicitly: --assume-role <arn>. ' +
        "Falling back to the developer's shell credentials."
    );
  }
  return undefined;
}

export function emitResult(result: AgentInvokeResult): void {
  const logger = getLogger();
  if (result.status >= 400) {
    logger.warn(`Agent /invocations returned HTTP ${result.status}.`);
    process.exitCode = 1;
  }
  process.stdout.write(`${result.raw}\n`);
}

/** Map a `--platform` value to the architecture `buildContainerImage` expects. */
function platformToArchitecture(platform: string): 'x86_64' | 'arm64' {
  return platform === 'linux/amd64' ? 'x86_64' : 'arm64';
}

function forwardAwsEnv(env: Record<string, string>): void {
  const passThrough = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
  ] as const;
  for (const key of passThrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
}

async function assumeAgentExecutionRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `${getEmbedConfig().resourceNamePrefix}-invoke-agent-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new Error(`AssumeRole(${roleArn}) returned no usable credentials.`);
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}

async function readEvent(options: LocalInvokeAgentOptions): Promise<unknown> {
  if (options.event && options.eventStdin) {
    throw new Error('--event and --event-stdin are mutually exclusive.');
  }
  if (options.eventStdin) {
    return parseEvent(await readStdin(), '<stdin>');
  }
  if (options.event) {
    return parseEvent(readFileSync(options.event, 'utf-8'), options.event);
  }
  return {};
}

function parseEvent(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse event payload from ${source} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read --env-vars file '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--env-vars file '${filePath}' must contain a JSON object at the top level.`);
  }
  return parsed as EnvOverrideFile;
}

export function createLocalInvokeAgentCommand(
  opts: CreateLocalInvokeAgentCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('invoke-agent')
    .description(
      'Run a Bedrock AgentCore Runtime container locally and invoke it once over the AgentCore HTTP ' +
        'contract (POST /invocations + GET /ping on port 8080). Resolves the AWS::BedrockAgentCore::Runtime, ' +
        'pulls/builds its container, injects env vars + AWS credentials, and prints the response. ' +
        'Target accepts a CDK display path (MyStack/MyAgent) or stack-qualified logical ID ' +
        '(MyStack:MyAgentRuntime1234). Single-stack apps may omit the stack prefix. ' +
        'Omit <target> in an interactive terminal to pick from a list. ' +
        'v1 supports the container artifact + HTTP protocol; the agent calls real AWS for managed services.'
    )
    .argument(
      '[target]',
      'CDK display path or stack-qualified logical ID of the AgentCore Runtime to invoke (omit to pick interactively in a TTY)'
    )
    .addOption(new Option('-e, --event <file>', 'JSON event payload file (default: {})'))
    .addOption(new Option('--event-stdin', 'Read event JSON from stdin').default(false))
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"LogicalId":{"KEY":"VALUE"}})'
      )
    )
    .addOption(
      new Option(
        '--session-id <id>',
        'AgentCore runtime session id header value (default: a random UUID)'
      )
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'docker --platform for the agent container (linux/amd64 or linux/arm64)'
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
      new Option('--container-host <host>', 'Host to bind the agent port to').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume the runtime's execution role and forward STS-issued temp credentials to the container " +
          'so the agent runs with the deployed role. Three forms: ' +
          '(1) `--assume-role <arn>` assumes the explicit ARN; ' +
          "(2) `--assume-role` (bare) uses the runtime's RoleArn when it is a literal ARN; " +
          '(3) `--no-assume-role` opts out. ' +
          "Off by default — the developer's shell credentials are forwarded unchanged."
      )
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized registries. ' +
          'Same-account / same-region pulls do not need this flag.'
      )
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in env vars with the deployed physical IDs / exports. Bare form uses the resolved stack name; ' +
          'pass an explicit value when the CFn stack name differs.'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      )
    )
    .action(
      withErrorHandling(async (target: string | undefined, options: LocalInvokeAgentOptions) => {
        await localInvokeAgentCommand(target, options, opts.extraStateProviders);
      })
    );

  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
