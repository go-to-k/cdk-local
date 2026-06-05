import { Command, Option } from 'commander';
import {
  getEmbedConfig,
  setEmbedConfig,
  type CdkLocalEmbedConfig,
} from '../../local/embed-config.js';
import {
  resolveCloudFrontDistribution,
  type ResolvedDistribution,
} from '../../local/cloudfront-resolver.js';
import {
  startCloudFrontServer,
  type StartedCloudFrontServer,
  type LambdaUrlInvokerMap,
} from '../../local/cloudfront-server.js';
import { createS3OriginReader, type S3OriginReader } from '../../local/cloudfront-s3-origin.js';
import { resolveDeployedOriginBucket } from '../../local/cloudfront-distribution-config.js';
import {
  createFrontDoorLambdaRunner,
  type FrontDoorLambdaRunner,
} from '../../local/front-door-lambda-runner.js';
import {
  resolveLambdaContainerEnv,
  type LambdaContainerEnvOptions,
  type ResolvedProfileCredentials,
} from './local-invoke.js';
import {
  createLocalStateProvider,
  isCfnFlagPresent,
  type LocalStateSourceOptions,
  type ExtraStateProviders,
} from './local-state-source.js';
import {
  resolveKvsModulesForDistribution,
  idFromArn,
  type DeployedKvsRef,
  type ResolveKvsModulesOptions,
} from '../../local/cloudfront-kvs-binding.js';
import { resolveDeployedKvsArnByName } from '../../local/cloudfront-kvs-client.js';
import { resolveProfileCredentials } from '../../utils/profile-resolver.js';
import { resolveLambdaTarget } from '../../local/lambda-resolver.js';
import { createFileWatcher, type FileWatcher } from '../../local/file-watcher.js';
import {
  resolveFrontDoorTlsMaterials,
  type FrontDoorTlsMaterials,
} from '../../local/front-door-tls.js';
import { parseEcsTarget } from '../../local/ecs-task-resolver.js';
import { listTargets } from '../../local/target-lister.js';
import { resolveSingleTarget } from '../../local/target-picker.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cdk-path.js';
import { matchStacks } from '../stack-matcher.js';
import { resolveApp, resolveWatchConfig } from '../config-loader.js';
import {
  appOptions,
  commonOptions,
  contextOptions,
  parseContextOptions,
  regionOption,
} from '../options.js';
import { CdkLocalError, withErrorHandling } from '../../utils/error-handler.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { getLogger } from '../../utils/logger.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { CLOUDFRONT_DISTRIBUTION_TYPE } from '../../local/cloudfront-resolver.js';
import { createWatchPredicates } from './local-start-api.js';

/** Error thrown by `cdkl start-cloudfront` for target / option problems. */
export class LocalStartCloudFrontError extends CdkLocalError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCAL_START_CLOUDFRONT_ERROR', cause);
  }
}

interface LocalStartCloudFrontOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  /** Bind port (default 0 = auto-allocate). */
  port: string;
  /** Bind host (default 127.0.0.1). */
  host: string;
  /** Repeatable `--origin <id>=<dir>` override. */
  origin?: string[];
  /** Repeatable `--kvs-file <kvsLogicalId>=<file.json>` local KeyValueStore map. */
  kvsFile?: string[];
  /**
   * `--cache-origin` — keep a deployed-S3 origin's fetched objects in memory
   * for the session (a read-through cache) instead of re-`GetObject`-ing on
   * every request (issue #405 follow-up). Cleared on each `--watch` reload.
   */
  cacheOrigin?: boolean;
  /** Opt-in to real TLS termination. */
  tls?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  /** Hot-reload on CDK source changes. */
  watch: boolean;
  /**
   * Commander resolves `--no-pull` to `pull = false` (default `true`); when
   * false, skip `docker pull` for a Lambda Function URL origin's base image.
   */
  pull?: boolean;
  /**
   * `--from-cfn-stack [name]` — bind a Lambda Function URL origin's backing
   * Lambda to a deployed CloudFormation stack so its intrinsic env vars
   * resolve to deployed physical IDs (issue #380). Off for a pure-S3
   * distribution (no AWS call).
   */
  fromCfnStack?: string | boolean;
  /** `--stack-region <region>` — CFn client region for `--from-cfn-stack`. */
  stackRegion?: string;
  /**
   * `--assume-role [arn]` — assume the Function URL origin Lambda's deployed
   * execution role and inject the STS creds into its container.
   */
  assumeRole?: string | boolean;
}

/** Factory options for {@link createLocalStartCloudFrontCommand}. */
export interface CreateLocalStartCloudFrontCommandOptions {
  /** Embed-time branding overrides for a host wrapping this factory. */
  embedConfig?: CdkLocalEmbedConfig;
  /**
   * Additional state-source factories a host CLI can inject so its own
   * `--from-state`-style source is picked up by the deployed-state resolution
   * paths (the KVS resolver + the deployed-S3 origin resolver). Absent =>
   * cdk-local's built-in `--from-cfn-stack` only.
   */
  extraStateProviders?: ExtraStateProviders;
}

/**
 * Parse the repeatable `--origin <originId>=<dir>` overrides into a map. Each
 * value points one of the distribution's origins at a local directory — the
 * escape hatch for when cdk-local cannot resolve the BucketDeployment source
 * automatically (content uploaded out of band, or a non-CDK bucket).
 */
export function parseOriginOverrides(values: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of values ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new LocalStartCloudFrontError(
        `Invalid --origin '${raw}'. Expected <originId>=<dir> (e.g. MyOrigin=./site).`
      );
    }
    out.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Parse the repeatable `--kvs-file <kvsLogicalId>=<file.json>` overrides into a
 * map. Each entry backs a CloudFront Function's `cf.kvs()` reads with a local
 * JSON map instead of the deployed store — the AWS-free escape hatch for KVS,
 * symmetric with `--origin <id>=<dir>`. The key is the
 * `AWS::CloudFront::KeyValueStore` resource logical id (surfaced in the
 * unbound-KVS boot warning when missing).
 */
export function parseKvsFileOverrides(values: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of values ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new LocalStartCloudFrontError(
        `Invalid --kvs-file '${raw}'. Expected <kvsLogicalId>=<file.json> (e.g. MyKvsStore=./kvs.json).`
      );
    }
    out.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Resolve + attach the `cf` KeyValueStore module to every KVS-reading
 * CloudFront Function in the distribution (run after each synth, initial +
 * `--watch` reload). A `--kvs-file` map wins; otherwise `--from-cfn-stack`
 * resolves the deployed store's ARN from state and `cf.kvs().get()` reads it
 * via the `GetKey` API. Unresolved associations log an actionable WARN (the
 * runtime then fails the read with the same guidance).
 */
async function attachKvsModules(
  distribution: ResolvedDistribution,
  stacks: StackInfo[],
  options: LocalStartCloudFrontOptions,
  profileCredentials: ResolvedProfileCredentials | undefined,
  logger: ReturnType<typeof getLogger>,
  extraStateProviders: ExtraStateProviders | undefined
): Promise<void> {
  const kvsFiles = parseKvsFileOverrides(options.kvsFile);
  const stack = stacks.find((s) => s.stackName === distribution.stackName);
  const synthRegion = stack?.region;

  const resolveDeployedKvs = isCfnFlagPresent(options)
    ? async (kvsLogicalId: string): Promise<DeployedKvsRef | undefined> => {
        const provider = createLocalStateProvider(
          options as unknown as LocalStateSourceOptions,
          distribution.stackName,
          synthRegion,
          extraStateProviders
        );
        if (!provider) return undefined;
        const record = await provider.load(distribution.stackName, synthRegion);
        const physicalId = record?.resources[kvsLogicalId]?.physicalId;
        if (!physicalId) return undefined;
        // `ListStackResources` returns the store's NAME (the `Ref` value) as its
        // physical id, NOT the ARN. The data-plane `GetKey` needs the ARN (which
        // embeds the store's UUID), so look the name up via the CloudFront
        // control plane. A literal-ARN physical id (defensive) is used directly.
        if (physicalId.startsWith('arn:')) {
          const id = idFromArn(physicalId);
          return { arn: physicalId, ...(id !== undefined && { id }) };
        }
        return resolveDeployedKvsArnByName(physicalId, {
          ...(profileCredentials !== undefined && { credentials: profileCredentials }),
        });
      }
    : undefined;

  const resolution: ResolveKvsModulesOptions = {
    ...(kvsFiles.size > 0 && { kvsFiles }),
    ...(resolveDeployedKvs !== undefined && { resolveDeployedKvs }),
    ...(profileCredentials !== undefined && { credentials: profileCredentials }),
  };
  const { warnings } = await resolveKvsModulesForDistribution(distribution, resolution);
  for (const warning of warnings) logger.warn(warning);
}

/**
 * Resolve a CloudFront target string (`Stack/Path` display path or
 * `Stack:LogicalId`) to its stack + `AWS::CloudFront::Distribution` logical id.
 * Mirrors the ALB / ECS resolver target grammar.
 */
export function resolveCloudFrontTarget(
  target: string,
  stacks: StackInfo[]
): { stack: StackInfo; logicalId: string } {
  if (stacks.length === 0) {
    throw new LocalStartCloudFrontError('No stacks found in the synthesized assembly.');
  }
  const parsed = parseEcsTarget(target);
  const stack = pickStack(parsed.stackPattern, stacks, target);
  const resources = stack.template.Resources ?? {};

  if (parsed.isPath) {
    const index = buildCdkPathIndex(stack.template);
    const resolved = resolveCdkPathToLogicalIds(parsed.pathOrId, index);
    const dists = resolved.filter(({ logicalId }) => {
      const r = resources[logicalId];
      return r !== undefined && r.Type === CLOUDFRONT_DISTRIBUTION_TYPE;
    });
    if (dists.length === 0) throw notFound(target, stack, resources);
    if (dists.length > 1) {
      throw new LocalStartCloudFrontError(
        `Target '${target}' matches ${dists.length} distributions in ${stack.stackName}: ` +
          `${dists.map((d) => d.logicalId).join(', ')}. Refine the path or use the stack:LogicalId form.`
      );
    }
    return { stack, logicalId: dists[0]!.logicalId };
  }

  const res = resources[parsed.pathOrId];
  if (!res || res.Type !== CLOUDFRONT_DISTRIBUTION_TYPE) throw notFound(target, stack, resources);
  return { stack, logicalId: parsed.pathOrId };
}

function pickStack(stackPattern: string | null, stacks: StackInfo[], target: string): StackInfo {
  if (stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new LocalStartCloudFrontError(
      `Target '${target}' has no stack prefix, and the assembly contains ${stacks.length} stacks: ` +
        `${stacks.map((s) => s.stackName).join(', ')}. Pass it as 'Stack/Path' or 'Stack:LogicalId'.`
    );
  }
  const matched = matchStacks(stacks, [stackPattern]);
  if (matched.length === 0) {
    throw new LocalStartCloudFrontError(
      `No stack matches '${stackPattern}'. Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new LocalStartCloudFrontError(
      `Multiple stacks match '${stackPattern}': ${matched.map((s) => s.stackName).join(', ')}. Refine the pattern.`
    );
  }
  return matched[0]!;
}

function notFound(
  target: string,
  stack: StackInfo,
  resources: Record<string, { Type: string }>
): LocalStartCloudFrontError {
  const dists = Object.entries(resources)
    .filter(([, r]) => r.Type === CLOUDFRONT_DISTRIBUTION_TYPE)
    .map(([logicalId]) => logicalId);
  const available =
    dists.length > 0
      ? ` Available distributions in ${stack.stackName}: ${dists.join(', ')}.`
      : ` ${stack.stackName} declares no ${CLOUDFRONT_DISTRIBUTION_TYPE} resources.`;
  return new LocalStartCloudFrontError(
    `Target '${target}' did not match a CloudFront distribution in ${stack.stackName}.${available}`
  );
}

/**
 * Boot one warm RIE container per unique Lambda Function URL origin in the
 * distribution (issue #376), returning the runners + an invoker map keyed by
 * backing-function logical id for {@link startCloudFrontServer}. Returns empty
 * collections when the distribution has no Function URL origin — start-cloudfront
 * then stays pure-local (no Docker). Booted once at start-up; NOT re-run on a
 * `--watch` reload (the warm containers keep their boot-time image).
 */
export async function bootLambdaUrlOrigins(
  distribution: ResolvedDistribution,
  stacks: StackInfo[],
  opts: {
    containerHost: string;
    skipPull: boolean;
    /**
     * State-source + assume-role + profile options threaded into the shared
     * {@link resolveLambdaContainerEnv} so a Function URL origin Lambda gets
     * its declared env vars + `--from-cfn-stack` deployed values + an
     * `--assume-role` execution role, exactly like `cdkl invoke` (issue #380).
     */
    envOptions: LambdaContainerEnvOptions;
    profileCredentials?: ResolvedProfileCredentials;
  }
): Promise<{ invokers: LambdaUrlInvokerMap; runners: FrontDoorLambdaRunner[] }> {
  const logger = getLogger();
  const invokers: LambdaUrlInvokerMap = new Map();
  const runners: FrontDoorLambdaRunner[] = [];
  // Unique backing functions across all lambda-url origins.
  const functionLogicalIds = new Set<string>();
  for (const origin of distribution.origins.values()) {
    if (origin.kind === 'lambda-url') functionLogicalIds.add(origin.functionLogicalId);
  }
  for (const functionLogicalId of functionLogicalIds) {
    let runner: FrontDoorLambdaRunner;
    try {
      const lambda = resolveLambdaTarget(functionLogicalId, stacks);
      // Resolve the container env (declared env vars + --from-cfn-stack state
      // substitution + --assume-role / shell creds) the same way `cdkl invoke`
      // does, so the Function URL Lambda reaches its deployed resources.
      const containerEnv = await resolveLambdaContainerEnv(
        lambda,
        opts.envOptions,
        opts.profileCredentials
      );
      runner = createFrontDoorLambdaRunner(lambda, {
        containerHost: opts.containerHost,
        skipPull: opts.skipPull,
        ...(opts.envOptions.region !== undefined && { region: opts.envOptions.region }),
        containerEnv: containerEnv.env,
        ...(containerEnv.sensitiveEnvKeys.length > 0 && {
          sensitiveEnvKeys: new Set(containerEnv.sensitiveEnvKeys),
        }),
      });
      logger.info(
        `Booting Lambda Function URL origin container for ${functionLogicalId} (the backing Lambda runs locally via RIE)...`
      );
      await runner.start();
    } catch (err) {
      // A lambda-url origin is essential to the distribution; if its backing
      // Lambda cannot be booted, stop the runners already started and fail.
      await Promise.all(runners.map((r) => r.stop().catch(() => undefined)));
      throw new LocalStartCloudFrontError(
        `Failed to boot the Lambda Function URL origin's backing function '${functionLogicalId}': ` +
          `${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }
    runners.push(runner);
    invokers.set(functionLogicalId, (event) => runner.invoke(event));
  }
  return { invokers, runners };
}

/**
 * Boot one warm RIE container per unique Lambda@Edge function across the
 * distribution's behaviors (issue #400), returning the runners + an invoker map
 * keyed by backing-function logical id for {@link startCloudFrontServer}. Each
 * function gets the SAME container env as a direct `cdkl invoke` (declared env
 * vars + `--from-cfn-stack` substitution + `--assume-role` creds) via the shared
 * {@link resolveLambdaContainerEnv}. A function that cannot be booted is
 * warn-and-skipped (its edge stage will not run); booted once at start-up, NOT
 * rebuilt on a `--watch` reload.
 */
export async function bootLambdaEdgeFunctions(
  distribution: ResolvedDistribution,
  stacks: StackInfo[],
  opts: {
    containerHost: string;
    skipPull: boolean;
    envOptions: LambdaContainerEnvOptions;
    profileCredentials?: ResolvedProfileCredentials;
  }
): Promise<{ invokers: LambdaUrlInvokerMap; runners: FrontDoorLambdaRunner[] }> {
  const logger = getLogger();
  const invokers: LambdaUrlInvokerMap = new Map();
  const runners: FrontDoorLambdaRunner[] = [];
  const functionLogicalIds = new Set<string>();
  for (const behavior of distribution.behaviors) {
    const edge = behavior.lambdaEdge;
    if (!edge) continue;
    for (const assoc of [
      edge.viewerRequest,
      edge.originRequest,
      edge.originResponse,
      edge.viewerResponse,
    ]) {
      if (assoc) functionLogicalIds.add(assoc.functionLogicalId);
    }
  }
  for (const functionLogicalId of functionLogicalIds) {
    try {
      const lambda = resolveLambdaTarget(functionLogicalId, stacks);
      const containerEnv = await resolveLambdaContainerEnv(
        lambda,
        opts.envOptions,
        opts.profileCredentials
      );
      const runner = createFrontDoorLambdaRunner(lambda, {
        containerHost: opts.containerHost,
        skipPull: opts.skipPull,
        ...(opts.envOptions.region !== undefined && { region: opts.envOptions.region }),
        containerEnv: containerEnv.env,
        ...(containerEnv.sensitiveEnvKeys.length > 0 && {
          sensitiveEnvKeys: new Set(containerEnv.sensitiveEnvKeys),
        }),
      });
      logger.info(
        `Booting Lambda@Edge container for ${functionLogicalId} (the function runs locally via RIE)...`
      );
      await runner.start();
      runners.push(runner);
      invokers.set(functionLogicalId, (event) => runner.invoke(event));
    } catch (err) {
      // Non-fatal: the distribution can still serve without this edge stage.
      logger.warn(
        `Could not boot Lambda@Edge function '${functionLogicalId}'; its stage will be skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return { invokers, runners };
}

/** Emit boot-time WARNs for parts of the distribution cdk-local does not serve. */
function warnUnsupported(distribution: ResolvedDistribution): void {
  const logger = getLogger();
  for (const origin of distribution.origins.values()) {
    if (origin.kind === 'custom') {
      logger.warn(
        `Origin '${origin.originId}' is a custom (non-S3, non-Lambda-Function-URL) origin (${origin.domainName}); ` +
          `${getEmbedConfig().cliName} start-cloudfront serves S3 origins and Lambda Function URL origins only. Requests routed to it return 502.`
      );
    } else if (origin.kind === 's3-unresolved') {
      logger.warn(
        `Origin '${origin.originId}' is an S3 origin with no resolvable local source (no BucketDeployment found, or its source could not be located in the cloud assembly). ` +
          `Pass --from-cfn-stack to serve the deployed bucket from real S3 on demand, or point it at a local directory with --origin ${origin.originId}=<dir>. Requests routed to it return 502.`
      );
    }
  }
}

/**
 * Promote each S3 origin with no local BucketDeployment source (`s3-unresolved`)
 * to a deployed-S3 read-through origin (issue #405), building one
 * {@link S3OriginReader} per origin. This is the front/back-split path: the CDK
 * repo defines the distribution + bucket but the static files were uploaded out
 * of band, so there is nothing in the cloud assembly to serve locally. Under
 * `--from-cfn-stack`, the bucket's physical NAME is resolved from deployed state
 * (`ListStackResources`) and the reader serves it from real S3 on demand.
 *
 * Returns the readers (keyed by origin id, handed to the server) + the
 * origin-id -> bucket-name map (re-applied on each `--watch` reload via
 * {@link annotateDeployedS3Origins}, since the pure resolver re-emits the origin
 * as `s3-unresolved`). A no-op without `--from-cfn-stack` or when the bucket's
 * physical id is not in state (the origin stays `s3-unresolved` -> the existing
 * boot WARN + 502, with `--origin <id>=<dir>` as the escape hatch).
 */
export async function resolveDeployedS3Origins(
  distribution: ResolvedDistribution,
  stacks: StackInfo[],
  options: LocalStartCloudFrontOptions,
  profileCredentials: ResolvedProfileCredentials | undefined,
  logger: ReturnType<typeof getLogger>,
  extraStateProviders?: ExtraStateProviders
): Promise<{ readers: Map<string, S3OriginReader>; buckets: Map<string, string> }> {
  const readers = new Map<string, S3OriginReader>();
  const buckets = new Map<string, string>();
  if (!isCfnFlagPresent(options)) return { readers, buckets };

  const stack = stacks.find((s) => s.stackName === distribution.stackName);
  const synthRegion = stack?.region;
  // The bucket's region for the S3 client: explicit --stack-region / --region
  // wins, else the synth region the distribution's stack was synthesized for.
  const region = options.stackRegion ?? options.region ?? synthRegion;

  const provider = createLocalStateProvider(
    options as unknown as LocalStateSourceOptions,
    distribution.stackName,
    synthRegion,
    extraStateProviders
  );
  const record = provider ? await provider.load(distribution.stackName, synthRegion) : undefined;
  // The deployed distribution's physical id (for the GetDistributionConfig
  // fallback) — `ListStackResources` records it under the distribution's
  // logical id.
  const distributionId = record?.resources[distribution.logicalId]?.physicalId;

  for (const origin of [...distribution.origins.values()]) {
    if (origin.kind !== 's3-unresolved') continue;

    // Resolve the bucket NAME in priority order (issue #405 + follow-up):
    let bucketName: string | undefined;
    let via: string;
    if (origin.bucketLogicalId !== undefined) {
      // Same-stack CDK bucket: ListStackResources records the NAME as its physical id.
      bucketName = record?.resources[origin.bucketLogicalId]?.physicalId;
      via = 'deployed state';
    } else if (origin.bucketName !== undefined) {
      // External / imported bucket whose name is literal in the DomainName.
      bucketName = origin.bucketName;
      via = "the origin's DomainName";
    } else if (origin.deployedConfigOnly && distributionId) {
      // Bucket name is a pure intrinsic -> read the deployed distribution config.
      bucketName = await resolveDeployedOriginBucket({
        distributionId,
        originId: origin.originId,
        ...(profileCredentials !== undefined && { credentials: profileCredentials }),
      });
      via = 'GetDistributionConfig';
    } else {
      continue; // nothing to resolve from
    }
    if (!bucketName) continue; // unresolved -> leave as-is (warnUnsupported handles it)

    readers.set(
      origin.originId,
      createS3OriginReader(bucketName, {
        ...(region !== undefined && { region }),
        ...(profileCredentials !== undefined && { credentials: profileCredentials }),
        ...(options.cacheOrigin === true && { cache: true }),
      })
    );
    buckets.set(origin.originId, bucketName);
    distribution.origins.set(origin.originId, {
      kind: 's3-deployed',
      originId: origin.originId,
      bucketName,
    });
    logger.info(
      `Origin '${origin.originId}': no local BucketDeployment source; serving from deployed S3 ` +
        `(bucket=${bucketName}, resolved via ${via}) on demand under --from-cfn-stack.`
    );
  }
  return { readers, buckets };
}

/**
 * Re-apply the boot-time deployed-S3 promotion to a freshly re-synthed
 * distribution on a `--watch` reload: the pure resolver re-emits the origin as
 * `s3-unresolved`, so rewrite it back to `s3-deployed` (same bucket name) so it
 * dispatches to the boot-time reader. The S3 readers themselves are boot-time
 * only (like the Function URL origin containers), so nothing is rebuilt here.
 */
export function annotateDeployedS3Origins(
  distribution: ResolvedDistribution,
  buckets: Map<string, string>
): void {
  for (const [originId, bucketName] of buckets) {
    const origin = distribution.origins.get(originId);
    if (origin && origin.kind === 's3-unresolved') {
      distribution.origins.set(originId, { kind: 's3-deployed', originId, bucketName });
    }
  }
}

async function localStartCloudFrontCommand(
  target: string | undefined,
  options: LocalStartCloudFrontOptions,
  extraStateProviders?: ExtraStateProviders
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) logger.setLevel('debug');

  const originOverrides = parseOriginOverrides(options.origin);
  const tlsRequested =
    options.tls === true || options.tlsCert !== undefined || options.tlsKey !== undefined;

  await applyRoleArnIfSet({
    roleArn: options.roleArn,
    region: options.region,
    profile: options.profile,
  });

  const appCmd = resolveApp(options.app);
  if (!appCmd) {
    throw new LocalStartCloudFrontError(
      `No CDK app specified. Pass --app, set ${getEmbedConfig().envPrefix}_APP, or add "app" to cdk.json.`
    );
  }

  const basePort = parseInt(options.port, 10);
  if (!Number.isFinite(basePort) || basePort < 0 || basePort > 65535) {
    throw new LocalStartCloudFrontError(`--port must be 0..65535 (got ${options.port}).`);
  }

  // One synth + resolve pass; reused on the initial boot and every reload. The
  // backing stacks ride along so the boot path can resolve a Lambda Function
  // URL origin's backing function.
  const synthAndResolve = async (): Promise<{
    distribution: ResolvedDistribution;
    stacks: StackInfo[];
  }> => {
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

    const chosen = await resolveSingleTarget(target, {
      entries: listTargets(stacks).cloudFrontDistributions,
      message: 'Select a CloudFront distribution to serve',
      noun: 'CloudFront distributions',
      onMissing: () =>
        new LocalStartCloudFrontError(
          `${getEmbedConfig().cliName} start-cloudfront requires a <target>. ` +
            "Pass a distribution path like 'Stack/MyDist', or run it in a TTY to pick interactively."
        ),
    });
    // Pin the resolved target so reloads don't re-prompt.
    target = chosen;

    const { stack, logicalId } = resolveCloudFrontTarget(chosen, stacks);
    return {
      distribution: resolveCloudFrontDistribution({ stack, logicalId, originOverrides }),
      stacks,
    };
  };

  const initial = await synthAndResolve();

  // `--profile`-resolved static credentials, forwarded into a Function URL
  // origin Lambda's container (the front-door Lambda path has no profile
  // credentials-file bind-mount; the env overlay carries the creds) AND used by
  // the deployed-S3 origin reader below. Resolved before the origin promotion.
  const profileCredentials = options.profile
    ? await resolveProfileCredentials(options.profile)
    : undefined;

  // Promote any S3 origin with no local BucketDeployment source to a deployed-S3
  // read-through origin (issue #405), building one S3 reader per origin. No-op
  // without --from-cfn-stack. Run BEFORE warnUnsupported so a promoted origin
  // does not also emit the unresolved-source WARN.
  const deployedS3 = await resolveDeployedS3Origins(
    initial.distribution,
    initial.stacks,
    options,
    profileCredentials,
    logger,
    extraStateProviders
  );

  warnUnsupported(initial.distribution);
  // State-source + assume-role options threaded into the shared container-env
  // resolver so a Function URL origin Lambda gets its env vars + deployed
  // values + execution role, exactly like `cdkl invoke` (issue #380).
  const envOptions: LambdaContainerEnvOptions = {
    ...(options.fromCfnStack !== undefined && { fromCfnStack: options.fromCfnStack }),
    ...(options.assumeRole !== undefined && { assumeRole: options.assumeRole }),
    ...(options.region !== undefined && { region: options.region }),
    ...(options.profile !== undefined && { profile: options.profile }),
    ...(options.stackRegion !== undefined && { stackRegion: options.stackRegion }),
  };

  // Resolve + attach the cf KeyValueStore module to every KVS-reading function
  // (--kvs-file local map / --from-cfn-stack deployed GetKey). Independent of
  // the Lambda-origin boot; re-run on every --watch reload below.
  await attachKvsModules(
    initial.distribution,
    initial.stacks,
    options,
    profileCredentials,
    logger,
    extraStateProviders
  );

  // Boot a warm RIE container per Lambda Function URL origin (issue #376).
  // No Function URL origin -> empty map -> start-cloudfront stays pure-local.
  const bootOpts = {
    containerHost: options.host,
    skipPull: options.pull === false,
    envOptions,
    ...(profileCredentials !== undefined && { profileCredentials }),
  };
  const { invokers: lambdaInvokers, runners: lambdaRunners } = await bootLambdaUrlOrigins(
    initial.distribution,
    initial.stacks,
    bootOpts
  );
  // Boot a warm RIE container per Lambda@Edge function (issue #400). No
  // associations -> empty map -> no Docker for an all-S3 distribution.
  const { invokers: edgeInvokers, runners: edgeRunners } = await bootLambdaEdgeFunctions(
    initial.distribution,
    initial.stacks,
    bootOpts
  );

  // From here, the booted RIE containers are live but the shutdown handler is
  // not yet wired — a TLS-material or port-bind failure would otherwise strand
  // every booted Lambda container. Stop them all before rethrowing.
  let server: StartedCloudFrontServer;
  try {
    // TLS resolution (real termination opt-in). Resolved once at boot.
    let tls: FrontDoorTlsMaterials | undefined;
    if (tlsRequested) {
      tls = await resolveFrontDoorTlsMaterials({
        certPath: options.tlsCert,
        keyPath: options.tlsKey,
      });
    }

    server = await startCloudFrontServer({
      distribution: initial.distribution,
      host: options.host,
      port: basePort,
      ...(tls && { tls }),
      ...(lambdaInvokers.size > 0 && { lambdaInvokers }),
      ...(edgeInvokers.size > 0 && { edgeInvokers }),
      ...(deployedS3.readers.size > 0 && { s3OriginReaders: deployedS3.readers }),
    });
  } catch (err) {
    await Promise.all(
      [...lambdaRunners, ...edgeRunners].map((r) => r.stop().catch(() => undefined))
    );
    throw err;
  }

  // D8.4-style load-bearing banner: verify.sh greps for this exact prefix.
  process.stdout.write(
    `CloudFront distribution serving on ${server.url}  (${initial.distribution.logicalId})\n`
  );
  process.stdout.write('^C to stop.\n');

  // `--watch`: re-synth + swap the in-memory routing model on source change.
  // The viewer functions + S3 origins reload; a Lambda Function URL origin's
  // warm container is boot-time only and is NOT rebuilt here (consistent with
  // start-alb's Lambda targets), so a reload is just re-synth + re-resolve +
  // `server.update()` — the listening socket and the RIE containers are never
  // recreated.
  let watcher: FileWatcher | undefined;
  let reloadChain: Promise<unknown> = Promise.resolve();
  if (options.watch) {
    const watchRoot = process.cwd();
    const { ignored, shouldTrigger, excludePatterns } = createWatchPredicates({
      watchRoot,
      output: options.output,
      watchConfig: resolveWatchConfig(),
    });
    watcher = createFileWatcher({
      paths: [watchRoot],
      ignored,
      shouldTrigger,
      onChange: () => {
        logger.info('Detected source change; reloading...');
        const next = reloadChain.then(async () => {
          try {
            const reloaded = await synthAndResolve();
            // Re-apply the boot-time deployed-S3 promotion (the pure resolver
            // re-emits the origin as s3-unresolved). Before warnUnsupported so a
            // promoted origin does not re-emit the unresolved-source WARN.
            annotateDeployedS3Origins(reloaded.distribution, deployedS3.buckets);
            // Drop any read-through cache so the reload reflects fresh S3 content.
            for (const reader of deployedS3.readers.values()) reader.clearCache();
            warnUnsupported(reloaded.distribution);
            await attachKvsModules(
              reloaded.distribution,
              reloaded.stacks,
              options,
              profileCredentials,
              logger,
              extraStateProviders
            );
            server.update(reloaded.distribution);
            logger.info('Reload complete.');
          } catch (err) {
            logger.warn(
              `Reload failed; keeping the previous version serving: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
        reloadChain = next.catch(() => undefined);
      },
    });
    logger.info(
      `Watching ${watchRoot} for source changes (excluding ${excludePatterns.join(', ')}).`
    );
  }

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    if (watcher) {
      try {
        await watcher.close();
      } catch {
        /* best-effort */
      }
    }
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
    // Tear down any Lambda Function URL origin + Lambda@Edge containers.
    await Promise.all(
      [...lambdaRunners, ...edgeRunners].map((r) =>
        r.stop().catch((err) => {
          logger.debug(
            `Lambda runner stop failed: ${err instanceof Error ? err.message : String(err)}`
          );
        })
      )
    );
    // Release any deployed-S3 origin reader's S3 client socket pool.
    await Promise.all([...deployedS3.readers.values()].map((reader) => reader.close()));
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT', 130));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  // Block forever — signal handlers exit the process.
  await new Promise<never>(() => undefined);
}

export function createLocalStartCloudFrontCommand(
  opts: CreateLocalStartCloudFrontCommandOptions = {}
): Command {
  setEmbedConfig(opts.embedConfig);
  const cmd = new Command('start-cloudfront')
    .description(
      'Run a long-running local server that serves a CloudFront distribution: its S3 origin content (resolved ' +
        'from the BucketDeployment source in the cloud assembly) and its Lambda Function URL origins (the backing ' +
        'Lambda is run locally via RIE), plus its viewer-request / viewer-response CloudFront Functions, ' +
        'reproducing the distribution routing locally so a rewrite / routing change is verifiable in seconds. ' +
        'Serves S3 and Lambda Function URL origins; other custom origins and Lambda@Edge are not run (warn-and-skip). ' +
        'Tip: omit the target in a terminal to pick interactively.'
    )
    .argument(
      '[target]',
      "CloudFront distribution to serve. Accepts the CDK Construct path ('MyStack/MyDist'), an ancestor prefix, " +
        "or the stack-qualified logical id ('MyStack:MyDist'). When omitted in a TTY, an interactive picker opens."
    )
    .action(
      withErrorHandling(
        async (target: string | undefined, options: LocalStartCloudFrontOptions) => {
          await localStartCloudFrontCommand(target, options, opts.extraStateProviders);
        }
      )
    );

  addStartCloudFrontSpecificOptions(cmd);
  [...commonOptions(), ...appOptions(), ...contextOptions].forEach((opt) => cmd.addOption(opt));
  cmd.addOption(regionOption);
  return cmd;
}

/**
 * Register the `cdkl start-cloudfront`-only option block on top of the shared
 * common / app / context helpers. Shared between `cdkl start-cloudfront` and
 * any host CLI (e.g. cdkd) that wraps the distribution-serving command, so
 * adding or renaming a `start-cloudfront` flag here propagates to every
 * embedder without duplicate `.addOption(...)` blocks. Chainable: returns
 * `cmd`.
 */
export function addStartCloudFrontSpecificOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option('--port <port>', 'HTTP server port (default: auto-allocate)').default('0')
    )
    .addOption(new Option('--host <host>', 'Bind address').default('127.0.0.1'))
    .addOption(
      new Option(
        '--origin <originId=dir>',
        'Point a distribution origin at a local directory (repeatable). Use when cdk-local cannot resolve the ' +
          "origin's BucketDeployment source automatically (content uploaded out of band, or a non-CDK bucket)."
      ).argParser((value: string, prev: string[] | undefined) => [...(prev ?? []), value])
    )
    .addOption(
      new Option(
        '--kvs-file <kvsLogicalId=file.json>',
        "Back a CloudFront Function's KeyValueStore reads (cf.kvs().get()) with a local JSON map " +
          '(repeatable). The key is the AWS::CloudFront::KeyValueStore resource logical id; the file is a flat ' +
          '{ "key": "value" } object. The AWS-free alternative to --from-cfn-stack, which instead reads the ' +
          'deployed store via the GetKey API.'
      ).argParser((value: string, prev: string[] | undefined) => [...(prev ?? []), value])
    )
    .addOption(
      new Option(
        '--tls',
        'Terminate real TLS (HTTPS). Uses --tls-cert / --tls-key when supplied, else an auto-generated self-signed cert.'
      ).default(false)
    )
    .addOption(new Option('--tls-cert <path>', 'PEM server certificate for --tls (implies --tls).'))
    .addOption(new Option('--tls-key <path>', 'PEM server private key for --tls (implies --tls).'))
    .addOption(
      new Option(
        '--no-pull',
        "Skip 'docker pull' for a Lambda Function URL origin's base image (use the locally cached image)."
      )
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Bind to a deployed CloudFormation stack (ListStackResources). Resolves an S3 origin that has no local ' +
          'BucketDeployment source to its deployed bucket and serves it from real S3 on demand (the ' +
          'front/back-split case: files uploaded out of band), and resolves a Lambda Function URL / Lambda@Edge ' +
          "function's env vars to the deployed physical IDs / exports. Use for CDK apps deployed via the upstream " +
          'CDK CLI (`cdk deploy`). Bare form uses the resolved stack name; pass a value when the CFn stack name differs.'
      )
    )
    .addOption(
      new Option(
        '--cache-origin',
        'For a deployed-S3 origin (served from real S3 under --from-cfn-stack): keep fetched objects in memory ' +
          'for the session instead of re-reading on every request. Faster repeat reads / fewer S3 GETs, but an ' +
          'out-of-band S3 content change is not reflected until a --watch reload (which clears the cache) or a ' +
          'restart. Off by default (every request re-reads, always current). Not CloudFront CDN caching.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      )
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume a Lambda Function URL origin's deployed execution role and forward STS-issued temp " +
          'credentials into its container so the handler runs with the deployed permissions. Three forms: ' +
          '`--assume-role <arn>` (explicit ARN); `--assume-role` (bare, auto-resolves from state — requires ' +
          '--from-cfn-stack); `--no-assume-role` (opt out). Off by default (the dev shell credentials are forwarded).'
      )
    )
    .addOption(
      new Option(
        '--watch',
        "Hot-reload: re-synth + re-resolve the distribution when the CDK app's source changes (honors cdk.json " +
          'watch.include/exclude; cdk.out, node_modules, .git are always excluded). The server keeps the previous ' +
          'version serving when synth fails mid-reload.'
      ).default(false)
    );
}
