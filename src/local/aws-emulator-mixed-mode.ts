// AWS Emulator mixed mode (go-to-k/cdkd#6150): `--aws-emulator` makes the
// emulator the target for everything; `"real-aws"` in the `--env-vars` file
// carves out the services that must reach real AWS.
//
// An exception is the value `"real-aws"` on a standard
// `AWS_ENDPOINT_URL_<SERVICE>` variable, under `Parameters` (every workload)
// or a per-resource section (one workload):
//
//   { "Parameters": { "AWS_ENDPOINT_URL_SECRETS_MANAGER": "real-aws" } }
//
// Every service without an exception stays on the emulator, however many
// exceptions there are, so a forgotten entry fails CLOSED: the call reaches
// the emulator, never a shared real environment. With at least one exception
// the run is in mixed mode: the workload holds the developer's REAL identity,
// its global `AWS_ENDPOINT_URL` is the re-signing sidecar
// (`emulator-resign-sidecar.ts`), which signs every request again with the
// emulator's keys, and each excepted service gets its real regional endpoint
// in its own `AWS_ENDPOINT_URL_<SERVICE>` (a service-specific variable wins
// over the global one in the AWS SDKs). Names resolve per service: excepted
// services from real AWS, the rest from the emulator.
//
// Without `--aws-emulator` an exception is a no-op (everything is real AWS
// already): the variable is dropped, so one `--env-vars` file serves both
// runs. The pre-inversion sentinel `"aws-emulator"` is refused in both modes.
//
// This module holds the pure parts: finding and validating exceptions, the
// real endpoint of a service, mapping a CloudFormation resource type to an
// endpoint service, and the composite state provider. The wiring lives in
// `workload-aws-wiring.ts`.

import { readEnvVarsFileText, type EnvOverrideFile } from './env-resolver.js';
import { AWS_ENDPOINT_SERVICE_IDS } from './aws-endpoint-service-ids.js';
import { AWS_ENDPOINT_PREFIX_OVERRIDES, AWS_GLOBAL_ENDPOINTS } from './aws-real-endpoints.js';
import type { AwsEmulatorWorkload } from '../utils/aws-proxy.js';
import type { LocalStateProvider, LocalStateRecord } from './local-state-provider.js';
import type { ResourceState } from '../types/state.js';
import { getLogger } from '../utils/logger.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';

/** The `--env-vars` value that sends one service to real AWS under `--aws-emulator`. */
export const REAL_AWS_SENTINEL = 'real-aws';

/**
 * The pre-inversion sentinel (`"aws-emulator"` = send this service to the
 * emulator). Refused with a migration message wherever it appears.
 */
export const LEGACY_AWS_EMULATOR_SENTINEL = 'aws-emulator';

/**
 * The port the re-signing sidecar listens on, on `127.0.0.1` inside each
 * workload in mixed mode. Picked to be unlikely to clash with an app port; a
 * workload that already listens on it gets an error naming it.
 */
export const MIXED_MODE_RESIGN_PORT = 47297;

/** One endpoint-variable sentinel found in an `--env-vars` file. */
export interface RealAwsException {
  /** The file section: `Parameters`, a logical ID, a CDK path or a container name. */
  section: string;
  /** The variable: `AWS_ENDPOINT_URL_SECRETS_MANAGER`. */
  key: string;
  /** The endpoint service id from the variable name: `SECRETS_MANAGER`. Empty for a bare `AWS_ENDPOINT_URL`. */
  service: string;
}

const ENDPOINT_KEY = /^AWS_ENDPOINT_URL(?:_([A-Z0-9_]+))?$/;

function isSentinel(key: string, value: unknown, sentinel: string): boolean {
  return typeof value === 'string' && value.trim() === sentinel && ENDPOINT_KEY.test(key);
}

/** True when `key` / `value` is an exception (`AWS_ENDPOINT_URL[_<SERVICE>]` = `real-aws`). */
export function isRealAwsSentinel(key: string, value: unknown): boolean {
  return isSentinel(key, value, REAL_AWS_SENTINEL);
}

/** True when `key` / `value` is the refused pre-inversion sentinel (`aws-emulator`). */
export function isLegacyAwsEmulatorSentinel(key: string, value: unknown): boolean {
  return isSentinel(key, value, LEGACY_AWS_EMULATOR_SENTINEL);
}

function findSentinels(
  overrides: EnvOverrideFile | Record<string, unknown> | undefined,
  match: (key: string, value: unknown) => boolean
): RealAwsException[] {
  const found: RealAwsException[] = [];
  if (!overrides || typeof overrides !== 'object') return found;
  for (const [section, map] of Object.entries(overrides)) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (!match(key, value)) continue;
      found.push({ section, key, service: ENDPOINT_KEY.exec(key)![1] ?? '' });
    }
  }
  return found;
}

/**
 * Every `"real-aws"` exception in a parsed `--env-vars` file, in file order.
 *
 * Host-side use case: a host CLI that reads `--env-vars` itself decides
 * mixed mode (and validates it) from the same scan.
 */
export function findRealAwsExceptions(
  overrides: EnvOverrideFile | Record<string, unknown> | undefined
): RealAwsException[] {
  return findSentinels(overrides, isRealAwsSentinel);
}

/** Every refused pre-inversion `"aws-emulator"` sentinel in a parsed `--env-vars` file. */
export function findLegacyAwsEmulatorSentinels(
  overrides: EnvOverrideFile | Record<string, unknown> | undefined
): RealAwsException[] {
  return findSentinels(overrides, isLegacyAwsEmulatorSentinel);
}

/** A parsed `--env-vars` file and its sentinels ({@link readAwsEmulatorEnvVarsFile}). */
export interface AwsEmulatorEnvVarsScan {
  /** The parsed file, or `undefined` when there is none or it is not a JSON object. */
  overrides: Readonly<Record<string, unknown>> | undefined;
  /** The `"real-aws"` exceptions. */
  exceptions: RealAwsException[];
  /** The refused `"aws-emulator"` sentinels. */
  legacySentinels: RealAwsException[];
}

/**
 * Read and parse the `--env-vars` file at `filePath` and find its sentinels.
 * A missing path, an unreadable file or invalid JSON yields none: the
 * command's own `--env-vars` reader reports those. The file is read through
 * `readEnvVarsFileText`, so a pipe-backed path (`<(jq ...)`, `/dev/stdin`, a
 * FIFO) is consumed once and the command's own read gets the same text.
 */
export function readAwsEmulatorEnvVarsFile(filePath: string | undefined): AwsEmulatorEnvVarsScan {
  const none: AwsEmulatorEnvVarsScan = {
    overrides: undefined,
    exceptions: [],
    legacySentinels: [],
  };
  if (!filePath) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readEnvVarsFileText(filePath));
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none;
  const overrides = parsed as Record<string, unknown>;
  return {
    overrides,
    exceptions: findRealAwsExceptions(overrides),
    legacySentinels: findLegacyAwsEmulatorSentinels(overrides),
  };
}

/**
 * Whether the `--env-vars` section `section` applies to `workload`, by the
 * rules the env merge uses: a Lambda / AgentCore section is its logical ID or
 * its `aws:cdk:path` (or a prefix of it ending at `/`), an ECS section is the
 * container name.
 */
function sectionAppliesTo(section: string, workload: AwsEmulatorWorkload): boolean {
  if (section === 'Parameters') return false;
  if (workload.logicalId !== undefined && section === workload.logicalId) return true;
  if (workload.containerName !== undefined && section === workload.containerName) return true;
  const path = workload.cdkPath;
  return path !== undefined && (path === section || path.startsWith(`${section}/`));
}

/**
 * The endpoint service ids excepted to real AWS for ONE workload: the
 * exceptions its final env carries. That is the `Parameters` exceptions, then
 * each of its own sections in file order, where `"real-aws"` adds a service
 * and any other value of the same variable (`null`, a literal URL) removes it,
 * as the env merge does. Sorted. The empty workload (`{}`) gets the
 * `Parameters` exceptions alone.
 *
 * Host-side use case: a host routes its own pre-start calls for a workload the
 * way that workload's runtime calls go.
 */
export function realAwsServicesForWorkload(
  overrides: Readonly<Record<string, unknown>> | undefined,
  workload: AwsEmulatorWorkload
): string[] {
  const out = new Set<string>();
  const apply = (map: unknown): void => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      const service = ENDPOINT_KEY.exec(key)?.[1];
      if (service === undefined) continue;
      if (isRealAwsSentinel(key, value)) out.add(service);
      // Only what the env merge applies replaces it: `null` clears, a
      // primitive overwrites; any other shape is skipped there, so here too.
      else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        out.delete(service);
      }
    }
  };
  if (!overrides) return [];
  apply(overrides['Parameters']);
  for (const [section, map] of Object.entries(overrides)) {
    if (sectionAppliesTo(section, workload)) apply(map);
  }
  return [...out].sort();
}

/**
 * The AWS SDK spelling of a mistyped endpoint service id, when one matches it
 * with underscores ignored (`SECRETSMANAGER` -> `SECRETS_MANAGER`).
 */
function correctServiceIdSpelling(service: string): string | undefined {
  const bare = service.replace(/_/g, '');
  for (const id of AWS_ENDPOINT_SERVICE_IDS) if (id.replace(/_/g, '') === bare) return id;
  return undefined;
}

/**
 * The migration message for a pre-inversion `"aws-emulator"` sentinel.
 * Exported so a host CLI refuses it with the same words.
 */
export function legacyAwsEmulatorSentinelMessage(s: RealAwsException): string {
  return (
    `--env-vars sets ${s.key} under ${displayUntrustedValue(s.section)} to "${LEGACY_AWS_EMULATOR_SENTINEL}", ` +
    'which is no longer supported: --aws-emulator now sends EVERY service to AWS Emulator, and the ' +
    `--env-vars file marks only the exceptions that must reach real AWS, with "${REAL_AWS_SENTINEL}". ` +
    `Remove the "${LEGACY_AWS_EMULATOR_SENTINEL}" entries, and mark each service that must stay on real AWS ` +
    `instead, e.g. "AWS_ENDPOINT_URL_SECRETS_MANAGER": "${REAL_AWS_SENTINEL}".`
  );
}

/**
 * Refuse sentinels that cannot work, from a {@link readAwsEmulatorEnvVarsFile}
 * scan:
 *
 * - a pre-inversion `"aws-emulator"` sentinel, in either mode (migration message);
 * - under `--aws-emulator`: `"real-aws"` on the bare `AWS_ENDPOINT_URL` (every
 *   service to real AWS is running without the flag), and an exception whose
 *   suffix is not an AWS SDK endpoint service id (the SDKs never read that
 *   variable, so the service would silently stay on the emulator; the error
 *   names the SDK spelling when one matches).
 *
 * Without `--aws-emulator` every `"real-aws"` is accepted: it is a no-op there
 * (`applyWorkloadAwsWiringToEnv` drops it), so one file serves both runs.
 *
 * Host-side use case: a host CLI validates its own `--env-vars` the same way.
 */
export function validateAwsEmulatorEnvVars(
  scan: Pick<AwsEmulatorEnvVarsScan, 'exceptions' | 'legacySentinels'>,
  awsEmulatorOn: boolean
): void {
  const legacy = scan.legacySentinels[0];
  if (legacy) throw new Error(legacyAwsEmulatorSentinelMessage(legacy));
  if (!awsEmulatorOn) return;
  if (scan.exceptions.some((s) => s.service === '')) {
    throw new Error(
      `--env-vars: "AWS_ENDPOINT_URL": "${REAL_AWS_SENTINEL}" would send every AWS call to real AWS, which is ` +
        'what running without --aws-emulator does. Remove --aws-emulator to run against real AWS, or keep it ' +
        'and mark only the services that must reach real AWS, e.g. ' +
        `"AWS_ENDPOINT_URL_SECRETS_MANAGER": "${REAL_AWS_SENTINEL}".`
    );
  }
  const unknown = scan.exceptions.find((s) => !AWS_ENDPOINT_SERVICE_IDS.has(s.service));
  if (unknown) {
    const fix = correctServiceIdSpelling(unknown.service);
    throw new Error(
      `--env-vars sets ${unknown.key} under ${displayUntrustedValue(unknown.section)} to "${REAL_AWS_SENTINEL}", ` +
        `but the AWS SDKs do not read ${unknown.key}, so the workload's calls would still go to AWS Emulator. ` +
        (fix
          ? `Use AWS_ENDPOINT_URL_${fix}.`
          : "The suffix must be the service's SDK endpoint id (its serviceId, uppercased, spaces as underscores).")
    );
  }
}

/** The distinct endpoint service ids of `exceptions`, sorted: `['SECRETS_MANAGER', 'STS']`. */
export function realAwsServicesOf(exceptions: readonly RealAwsException[]): string[] {
  return [...new Set(exceptions.map((s) => s.service).filter((s) => s !== ''))].sort();
}

/**
 * The real AWS endpoint an excepted service gets in its
 * `AWS_ENDPOINT_URL_<SERVICE>`, for a workload in `region`:
 * `https://<endpoint prefix>.<region>.<DNS suffix>` (`SECRETS_MANAGER` in
 * `us-east-1` -> `https://secretsmanager.us-east-1.amazonaws.com`;
 * `amazonaws.com.cn` in the China regions). S3 gets its regional endpoint,
 * where the SDKs address buckets virtual-hosted style as they do by default.
 *
 * A service served by one global endpoint (IAM, Route 53, CloudFront,
 * Organizations, ...) gets that endpoint only when the workload's region is
 * the endpoint's signing region: an SDK signs a request to an explicit
 * endpoint for its own region, which a global endpoint refuses ("Credential
 * should be scoped to a valid region"). Anywhere else, and in the China /
 * GovCloud / isolated partitions, it throws a message that names the cause.
 *
 * Host-side use case: a host CLI assembling a container env itself.
 */
export function realAwsEndpointFor(service: string, region: string): string {
  const prefix = AWS_ENDPOINT_PREFIX_OVERRIDES[service] ?? service.toLowerCase().replace(/_/g, '');
  const isolated = /^(us|eu)-iso[a-z]*-/.test(region);
  const china = region.startsWith('cn-');
  const gov = region.startsWith('us-gov-');
  const global = AWS_GLOBAL_ENDPOINTS[prefix];
  if (isolated || (global && (china || gov))) {
    throw new Error(
      `--env-vars marks AWS_ENDPOINT_URL_${service} "${REAL_AWS_SENTINEL}", but ${displayUntrustedValue(region)} ` +
        `has no known real ${service} endpoint. Set AWS_ENDPOINT_URL_${service} to the real ` +
        'endpoint URL instead (a literal URL is passed through as-is).'
    );
  }
  if (global) {
    if (global.signingRegion !== region) {
      throw new Error(
        `--env-vars marks AWS_ENDPOINT_URL_${service} "${REAL_AWS_SENTINEL}", but ${service} is served by one ` +
          `global endpoint (https://${global.hostname}) that accepts only requests signed for ` +
          `${global.signingRegion}, and an SDK signs a request to an explicit endpoint for the workload's region ` +
          `(${displayUntrustedValue(region)}), which that endpoint refuses. Leave ${service} on AWS Emulator, or ` +
          `run the workload in ${global.signingRegion}.`
      );
    }
    return `https://${global.hostname}`;
  }
  return `https://${prefix}.${region}.${china ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
}

/**
 * Endpoint service ids (underscores removed) whose CloudFormation namespace
 * is not the same word. Every other id matches its namespace uppercased
 * (`DYNAMODB` / `DynamoDB`, `SECRETS_MANAGER` / `SecretsManager`).
 */
const SERVICE_NAMESPACE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  EVENTBRIDGE: ['EVENTS'],
  SFN: ['STEPFUNCTIONS'],
  CLOUDWATCHLOGS: ['LOGS'],
  COGNITOIDENTITYPROVIDER: ['COGNITO'],
  COGNITOIDENTITY: ['COGNITO'],
  FIREHOSE: ['KINESISFIREHOSE'],
  OPENSEARCH: ['OPENSEARCHSERVICE'],
  ELASTICSEARCHSERVICE: ['ELASTICSEARCH'],
};

/**
 * Whether a CloudFormation resource type (`AWS::SecretsManager::Secret`)
 * belongs to one of the endpoint services `services` (`['SECRETS_MANAGER']`).
 *
 * Host-side use case: a host's own per-service name resolution (cdkd's
 * `--from-state`).
 */
export function resourceTypeMatchesService(
  resourceType: string,
  services: readonly string[]
): boolean {
  const ns = /^AWS::([A-Za-z0-9]+)::/.exec(resourceType)?.[1]?.toUpperCase();
  if (!ns) return false;
  return services.some((s) => {
    const id = s.replace(/_/g, '').toUpperCase();
    return id === ns || (SERVICE_NAMESPACE_ALIASES[id] ?? []).includes(ns);
  });
}

/** How many unresolved resources the emulator-side-missing warning names. */
const MISSING_LIST_LIMIT = 10;

/** Inputs to {@link createMixedModeStateProvider}. */
export interface MixedModeStateProviderOptions {
  /** The provider reading the stack deployed into AWS Emulator: the primary side. */
  emulator: LocalStateProvider;
  /** The same kind of provider, reading real AWS: only the excepted services' resources. */
  real: LocalStateProvider;
  /** Endpoint service ids excepted to real AWS ({@link realAwsServicesForWorkload}). */
  realServices: readonly string[];
}

/**
 * A state provider that resolves names per service: a resource whose type
 * belongs to an excepted (`"real-aws"`) service takes its record from the
 * real AWS copy of the stack, every other resource from the stack deployed
 * into AWS Emulator. `--env-vars` values still override the result, as they do
 * for any provider (they are applied after state substitution).
 *
 * - When real AWS has no such stack, excepted resources keep their emulator
 *   names, with one warning.
 * - When the emulator has no such stack but real AWS does, only the excepted
 *   resources resolve; one warning per stack names the others (now
 *   unresolved) and the remedy. Nothing else is read from real AWS.
 * - Outputs come from the emulator; an output whose value is the emulator's
 *   physical ID of an excepted resource takes the real ID instead.
 * - The deployed-function env fallback (`--from-cfn-stack` `Fn::GetAtt`) and
 *   cross-stack resolution (`Fn::ImportValue`) read the emulator's side, with
 *   the same physical-ID swap applied to the function env. SSM-backed
 *   template parameters follow the SSM route.
 * - The deployed execution / runtime role ARNs (assumed for the workload's
 *   real identity) come from real AWS.
 *
 * `realServices` is the workload's own set ({@link realAwsServicesForWorkload}),
 * or the `Parameters` set for names that serve no single workload.
 *
 * Host-side use case: cdkd wraps its own `--from-state` provider pair.
 */
export function createMixedModeStateProvider(
  opts: MixedModeStateProviderOptions
): LocalStateProvider {
  const { real, emulator, realServices } = opts;
  const swaps = new Map<string, string>();
  const warned = new Set<string>();
  const warnedEmulator = new Set<string>();
  const swap = (v: string): string => swaps.get(v) ?? v;
  const excepted = (res: ResourceState): boolean =>
    resourceTypeMatchesService(res.resourceType, realServices);
  const provider: LocalStateProvider = {
    label: emulator.label,
    async load(stackName, synthRegion): Promise<LocalStateRecord | undefined> {
      const [e, r] = await Promise.all([
        emulator.load(stackName, synthRegion),
        real.load(stackName, synthRegion),
      ]);
      if (!r) {
        if (e && !warned.has(stackName) && Object.values(e.resources).some(excepted)) {
          warned.add(stackName);
          const why = real.getLastLoadError?.();
          getLogger().warn(
            `${emulator.label}: stack ${displayUntrustedValue(stackName)} could not be read from real AWS` +
              `${why ? ` (${why})` : ''}; resources of the services marked "${REAL_AWS_SENTINEL}" ` +
              `(${realServices.join(', ')}) keep their AWS Emulator names. Override them with --env-vars, ` +
              'or deploy the stack to real AWS too.'
          );
        }
        return e;
      }
      if (!e) {
        const resources: Record<string, ResourceState> = {};
        const dropped: string[] = [];
        for (const [id, res] of Object.entries(r.resources)) {
          if (excepted(res)) resources[id] = res;
          else
            dropped.push(
              `${displayUntrustedValue(id)} (${displayUntrustedValue(res.resourceType)})`
            );
        }
        if (dropped.length > 0 && !warnedEmulator.has(stackName)) {
          warnedEmulator.add(stackName);
          const why = emulator.getLastLoadError?.();
          const shown = dropped.slice(0, MISSING_LIST_LIMIT).join(', ');
          const more =
            dropped.length > MISSING_LIST_LIMIT
              ? ` and ${dropped.length - MISSING_LIST_LIMIT} more`
              : '';
          getLogger().warn(
            `${emulator.label}: stack ${displayUntrustedValue(stackName)} could not be read from AWS Emulator` +
              `${why ? ` (${why})` : ''}, only from real AWS; resources outside the services marked ` +
              `"${REAL_AWS_SENTINEL}" (${realServices.join(', ')}) stay unresolved: ${shown}${more}. Deploy the ` +
              'stack into AWS Emulator under the same stack name (the same CDK context, e.g. -c stage=dev), or ' +
              'override them with --env-vars.'
          );
        }
        return { resources, outputs: {}, region: r.region };
      }
      const resources: Record<string, ResourceState> = { ...e.resources };
      for (const [id, res] of Object.entries(r.resources)) {
        if (!excepted(res)) continue;
        const emuRes = e.resources[id];
        if (emuRes?.physicalId && res.physicalId && emuRes.physicalId !== res.physicalId) {
          swaps.set(emuRes.physicalId, res.physicalId);
        }
        resources[id] = res;
      }
      const outputs: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.outputs)) outputs[k] = swap(v);
      return { resources, outputs, region: e.region };
    },
    buildCrossStackResolver: (region) => emulator.buildCrossStackResolver(region),
    dispose(): void {
      try {
        emulator.dispose();
      } finally {
        real.dispose();
      }
    },
  };
  if (emulator.resolveDeployedFunctionEnv) {
    const fn = emulator.resolveDeployedFunctionEnv.bind(emulator);
    provider.resolveDeployedFunctionEnv = async (id) => {
      const env = await fn(id);
      if (!env) return env;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) out[k] = swap(v);
      return out;
    };
  }
  if (real.resolveLambdaExecutionRoleArn) {
    provider.resolveLambdaExecutionRoleArn = real.resolveLambdaExecutionRoleArn.bind(real);
  }
  if (real.resolveAgentCoreRuntimeRoleArn) {
    provider.resolveAgentCoreRuntimeRoleArn = real.resolveAgentCoreRuntimeRoleArn.bind(real);
  }
  // The real side's SSM client routes per service (`service: 'SSM'`): the
  // emulator unless SSM is excepted for the workload.
  if (real.resolveTemplateSsmParameters) {
    provider.resolveTemplateSsmParameters = real.resolveTemplateSsmParameters.bind(real);
  }
  if (emulator.getLastLoadError) {
    provider.getLastLoadError = emulator.getLastLoadError.bind(emulator);
  }
  return provider;
}
