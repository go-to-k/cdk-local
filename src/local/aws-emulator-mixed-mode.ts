// AWS Emulator mixed mode (go-to-k/cdkd#6150): send only the services an
// `--env-vars` file chooses to AWS Emulator, and everything else to real AWS.
//
// The choice is the sentinel value `"aws-emulator"` on a standard
// `AWS_ENDPOINT_URL_<SERVICE>` variable, under `Parameters` (every workload)
// or a per-resource section (one workload):
//
//   { "Parameters": { "AWS_ENDPOINT_URL_DYNAMODB": "aws-emulator" } }
//
// The sentinel is valid only with `--aws-emulator [url]`, which names the
// emulator. When at least one is present the run is in mixed mode: the
// workload keeps the developer's REAL identity, each sentinel becomes the
// endpoint of the re-signing sidecar (`emulator-resign-sidecar.ts`), which
// signs that service's requests again with the emulator's keys, and
// `--from-cfn-stack` names resolve per service (emulated services from the
// emulator, the rest from real AWS). A literal URL never re-signs.
//
// This module holds the pure parts: finding and validating sentinels, mapping
// a CloudFormation resource type to an endpoint service, and the composite
// state provider. The wiring lives in `workload-aws-wiring.ts`.

import { readEnvVarsFileText, type EnvOverrideFile } from './env-resolver.js';
import { AWS_ENDPOINT_SERVICE_IDS } from './aws-endpoint-service-ids.js';
import type { AwsEmulatorWorkload } from '../utils/aws-proxy.js';
import type { LocalStateProvider, LocalStateRecord } from './local-state-provider.js';
import type { ResourceState } from '../types/state.js';
import { getLogger } from '../utils/logger.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';

/** The `--env-vars` value that routes one service to AWS Emulator. */
export const AWS_EMULATOR_SENTINEL = 'aws-emulator';

/**
 * The port the re-signing sidecar listens on, on `127.0.0.1` inside each
 * workload that uses a sentinel. Picked to be unlikely to clash with an app
 * port; a workload that already listens on it gets an error naming it.
 */
export const MIXED_MODE_RESIGN_PORT = 47297;

/** One sentinel found in an `--env-vars` file. */
export interface AwsEmulatorSentinel {
  /** The file section: `Parameters`, a logical ID, a CDK path or a container name. */
  section: string;
  /** The variable: `AWS_ENDPOINT_URL_DYNAMODB`. */
  key: string;
  /** The endpoint service id from the variable name: `DYNAMODB`. Empty for a bare `AWS_ENDPOINT_URL`. */
  service: string;
}

const ENDPOINT_KEY = /^AWS_ENDPOINT_URL(?:_([A-Z0-9_]+))?$/;

/** True when `key` / `value` is a sentinel (`AWS_ENDPOINT_URL[_<SERVICE>]` = `aws-emulator`). */
export function isAwsEmulatorSentinel(key: string, value: unknown): boolean {
  return (
    typeof value === 'string' && value.trim() === AWS_EMULATOR_SENTINEL && ENDPOINT_KEY.test(key)
  );
}

/**
 * Every sentinel in a parsed `--env-vars` file, in file order.
 *
 * Host-side use case: a host CLI that reads `--env-vars` itself decides
 * mixed mode (and validates it) from the same scan.
 */
export function findAwsEmulatorSentinels(
  overrides: EnvOverrideFile | Record<string, unknown> | undefined
): AwsEmulatorSentinel[] {
  const found: AwsEmulatorSentinel[] = [];
  if (!overrides || typeof overrides !== 'object') return found;
  for (const [section, map] of Object.entries(overrides)) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (!isAwsEmulatorSentinel(key, value)) continue;
      found.push({ section, key, service: ENDPOINT_KEY.exec(key)![1] ?? '' });
    }
  }
  return found;
}

/** A parsed `--env-vars` file and its sentinels ({@link readAwsEmulatorEnvVarsFile}). */
export interface AwsEmulatorEnvVarsScan {
  /** The parsed file, or `undefined` when there is none or it is not a JSON object. */
  overrides: Readonly<Record<string, unknown>> | undefined;
  sentinels: AwsEmulatorSentinel[];
}

/**
 * Read and parse the `--env-vars` file at `filePath` and find its sentinels.
 * A missing path, an unreadable file or invalid JSON yields none: the
 * command's own `--env-vars` reader reports those. The file is read through
 * `readEnvVarsFileText`, so a pipe-backed path (`<(jq ...)`, `/dev/stdin`, a
 * FIFO) is consumed once and the command's own read gets the same text.
 */
export function readAwsEmulatorEnvVarsFile(filePath: string | undefined): AwsEmulatorEnvVarsScan {
  if (!filePath) return { overrides: undefined, sentinels: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readEnvVarsFileText(filePath));
  } catch {
    return { overrides: undefined, sentinels: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { overrides: undefined, sentinels: [] };
  }
  const overrides = parsed as Record<string, unknown>;
  return { overrides, sentinels: findAwsEmulatorSentinels(overrides) };
}

/**
 * {@link findAwsEmulatorSentinels} over the `--env-vars` file at `filePath`
 * ({@link readAwsEmulatorEnvVarsFile}).
 */
export function readAwsEmulatorSentinelsFromFile(
  filePath: string | undefined
): AwsEmulatorSentinel[] {
  return readAwsEmulatorEnvVarsFile(filePath).sentinels;
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
 * The endpoint service ids routed to AWS Emulator for ONE workload: the
 * sentinels its final env carries. That is the `Parameters` sentinels, then
 * each of its own sections in file order, where a sentinel adds a service and
 * any other value of the same variable (`null`, a literal URL) removes it, as
 * the env merge does. Sorted.
 *
 * Host-side use case: a host routes its own pre-start calls for a workload the
 * way that workload's runtime calls go.
 */
export function emulatedServicesForWorkload(
  overrides: Readonly<Record<string, unknown>> | undefined,
  workload: AwsEmulatorWorkload
): string[] {
  const out = new Set<string>();
  const apply = (map: unknown): void => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      const service = ENDPOINT_KEY.exec(key)?.[1];
      if (service === undefined) continue;
      if (isAwsEmulatorSentinel(key, value)) out.add(service);
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
 * Refuse sentinels that cannot work: one on the bare `AWS_ENDPOINT_URL`
 * (every service: that is plain `--aws-emulator`), one whose suffix is not an
 * AWS SDK endpoint service id (the SDKs never read that variable, so the
 * workload's calls would go to real AWS; the error names the SDK spelling when
 * one matches), and any sentinel without `--aws-emulator` (the error names the
 * flag and its env var).
 *
 * Host-side use case: a host CLI validates its own `--env-vars` the same way.
 */
export function validateAwsEmulatorSentinels(
  sentinels: readonly AwsEmulatorSentinel[],
  awsEmulatorOn: boolean,
  envVarName = 'CDK_LOCAL_AWS_EMULATOR'
): void {
  const first = sentinels[0];
  if (!first) return;
  const where = (s: AwsEmulatorSentinel): string =>
    `${s.key} under ${displayUntrustedValue(s.section)}`;
  const bare = sentinels.find((s) => s.service === '');
  if (bare) {
    throw new Error(
      `--env-vars sets ${where(bare)} to "${AWS_EMULATOR_SENTINEL}", but the sentinel routes ONE service ` +
        `(AWS_ENDPOINT_URL_<SERVICE>). To send every service to AWS Emulator, use --aws-emulator without a sentinel.`
    );
  }
  const unknown = sentinels.find((s) => !AWS_ENDPOINT_SERVICE_IDS.has(s.service));
  if (unknown) {
    const fix = correctServiceIdSpelling(unknown.service);
    throw new Error(
      `--env-vars sets ${where(unknown)} to "${AWS_EMULATOR_SENTINEL}", but the AWS SDKs do not read ` +
        `${unknown.key}, so the workload's calls would still go to real AWS. ` +
        (fix
          ? `Use AWS_ENDPOINT_URL_${fix}.`
          : "The suffix must be the service's SDK endpoint id (its serviceId, uppercased, spaces as underscores).")
    );
  }
  if (!awsEmulatorOn) {
    throw new Error(
      `--env-vars sets ${where(first)} to "${AWS_EMULATOR_SENTINEL}", which needs --aws-emulator [url] ` +
        `(or ${envVarName}) to name the AWS Emulator to route it to.`
    );
  }
}

/** The distinct endpoint service ids of `sentinels`, sorted: `['DYNAMODB', 'S3']`. */
export function emulatedServicesOf(sentinels: readonly AwsEmulatorSentinel[]): string[] {
  return [...new Set(sentinels.map((s) => s.service).filter((s) => s !== ''))].sort();
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
 * Whether a CloudFormation resource type (`AWS::DynamoDB::Table`) belongs to
 * one of the emulated endpoint services (`['DYNAMODB']`).
 *
 * Host-side use case: a host's own per-service name resolution (cdkd's
 * `--from-state`).
 */
export function resourceTypeMatchesEmulatedService(
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

/** How many unresolved resources the real-side-missing warning names. */
const MISSING_LIST_LIMIT = 10;

/** Inputs to {@link createMixedModeStateProvider}. */
export interface MixedModeStateProviderOptions {
  /** The provider reading real AWS. */
  real: LocalStateProvider;
  /** The same kind of provider, reading the stack deployed into AWS Emulator. */
  emulator: LocalStateProvider;
  /** Endpoint service ids routed to the emulator ({@link emulatedServicesOf}). */
  emulatedServices: readonly string[];
}

/**
 * A state provider that resolves names per service: a resource whose type
 * belongs to an emulated service takes its record from the emulator's copy of
 * the stack, every other resource from real AWS. `--env-vars` values still
 * override the result, as they do for any provider (they are applied after
 * state substitution).
 *
 * - When the emulator has no such stack, emulated resources keep their real
 *   names, with one warning.
 * - When real AWS has no such stack but the emulator does, only the emulated
 *   resources resolve; one warning per stack names the others (now
 *   unresolved) and the remedy.
 * - Outputs come from real AWS; an output whose value is the real physical ID
 *   of an emulated resource takes the emulator's ID instead. Outputs only the
 *   emulator's stack has are added.
 * - The deployed-function env fallback (`--from-cfn-stack` `Fn::GetAtt`)
 *   reads real AWS, with the same physical-ID swap applied to its values.
 * - Cross-stack resolution (`Fn::ImportValue`) and every other lookup use the
 *   real provider.
 *
 * `emulatedServices` is the run's set ({@link emulatedServicesOf}) unless the
 * caller resolves names for one workload, which passes that workload's own set
 * ({@link emulatedServicesForWorkload}).
 *
 * Host-side use case: cdkd wraps its own `--from-state` provider pair.
 */
export function createMixedModeStateProvider(
  opts: MixedModeStateProviderOptions
): LocalStateProvider {
  const { real, emulator, emulatedServices } = opts;
  const swaps = new Map<string, string>();
  const warned = new Set<string>();
  const warnedReal = new Set<string>();
  const swap = (v: string): string => swaps.get(v) ?? v;
  const provider: LocalStateProvider = {
    label: real.label,
    async load(stackName, synthRegion): Promise<LocalStateRecord | undefined> {
      const [r, e] = await Promise.all([
        real.load(stackName, synthRegion),
        emulator.load(stackName, synthRegion),
      ]);
      if (!e) {
        if (r && !warned.has(stackName)) {
          const emulatedInReal = Object.values(r.resources).some((res) =>
            resourceTypeMatchesEmulatedService(res.resourceType, emulatedServices)
          );
          if (emulatedInReal) {
            warned.add(stackName);
            const why = emulator.getLastLoadError?.();
            getLogger().warn(
              `${real.label}: stack ${displayUntrustedValue(stackName)} could not be read from AWS Emulator` +
                `${why ? ` (${why})` : ''}; resources of the emulated services (${emulatedServices.join(', ')}) ` +
                'keep their real AWS names. Override them with --env-vars, or deploy the stack into the emulator.'
            );
          }
        }
        return r;
      }
      const emulated = (res: ResourceState): boolean =>
        resourceTypeMatchesEmulatedService(res.resourceType, emulatedServices);
      if (!r) {
        const resources: Record<string, ResourceState> = {};
        const dropped: string[] = [];
        for (const [id, res] of Object.entries(e.resources)) {
          if (emulated(res)) resources[id] = res;
          else
            dropped.push(
              `${displayUntrustedValue(id)} (${displayUntrustedValue(res.resourceType)})`
            );
        }
        if (dropped.length > 0 && !warnedReal.has(stackName)) {
          warnedReal.add(stackName);
          const why = real.getLastLoadError?.();
          const shown = dropped.slice(0, MISSING_LIST_LIMIT).join(', ');
          const more =
            dropped.length > MISSING_LIST_LIMIT
              ? ` and ${dropped.length - MISSING_LIST_LIMIT} more`
              : '';
          getLogger().warn(
            `${real.label}: stack ${displayUntrustedValue(stackName)} could not be read from real AWS` +
              `${why ? ` (${why})` : ''}, only from AWS Emulator; resources outside the emulated services ` +
              `(${emulatedServices.join(', ')}) stay unresolved: ${shown}${more}. Deploy the stack to real AWS ` +
              'too, under the same stack name (the same CDK context, e.g. -c stage=dev), or override them with --env-vars.'
          );
        }
        return { resources, outputs: { ...e.outputs }, region: e.region };
      }
      const resources: Record<string, ResourceState> = { ...r.resources };
      for (const [id, res] of Object.entries(e.resources)) {
        if (!emulated(res)) continue;
        const realRes = r.resources[id];
        if (realRes?.physicalId && res.physicalId && realRes.physicalId !== res.physicalId) {
          swaps.set(realRes.physicalId, res.physicalId);
        }
        resources[id] = res;
      }
      const outputs: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.outputs)) outputs[k] = v;
      for (const [k, v] of Object.entries(r.outputs)) outputs[k] = swap(v);
      return { resources, outputs, region: r.region };
    },
    buildCrossStackResolver: (region) => real.buildCrossStackResolver(region),
    dispose(): void {
      try {
        real.dispose();
      } finally {
        emulator.dispose();
      }
    },
  };
  if (real.resolveDeployedFunctionEnv) {
    const fn = real.resolveDeployedFunctionEnv.bind(real);
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
  if (real.resolveTemplateSsmParameters) {
    provider.resolveTemplateSsmParameters = real.resolveTemplateSsmParameters.bind(real);
  }
  if (real.getLastLoadError) provider.getLastLoadError = real.getLastLoadError.bind(real);
  return provider;
}
