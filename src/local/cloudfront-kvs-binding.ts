import type { CompiledCloudFrontFunction } from './cloudfront-function-runtime.js';
import type { ResolvedDistribution } from './cloudfront-resolver.js';
import {
  createCloudFrontModule,
  createLocalFileKvsDataSource,
  type KvsDataSource,
} from './cloudfront-kvs.js';
import { createDeployedKvsDataSource, type KvsClientCredentials } from './cloudfront-kvs-client.js';

/**
 * Resolve the `cf` module for every CloudFront Function that reads a
 * KeyValueStore and attach it to the compiled function, so `cdkl
 * start-cloudfront`'s runtime serves `cf.kvs().get(...)` reads from the
 * deployed store (`--from-cfn-stack`) or a local JSON map (`--kvs-file`).
 *
 * Decoupled from state-provider / STS plumbing: the command layer supplies a
 * {@link ResolveKvsModulesOptions.resolveDeployedKvs} callback (built from the
 * `--from-cfn-stack` state provider) and the parsed `--kvs-file` map. That
 * keeps the AWS boundary in the command + makes this orchestration unit-testable
 * with a fake resolver. Re-run after each `--watch` reload so a re-synthesized
 * function rebinds.
 */

/** A resolved deployed KeyValueStore: its ARN (the `GetKey` `KvsARN`) + Id. */
export interface DeployedKvsRef {
  /** The deployed store ARN. */
  arn: string;
  /** The store Id (ARN last segment), for matching a `cf.kvs(<id>)` call. */
  id?: string;
}

export interface ResolveKvsModulesOptions {
  /**
   * Parsed `--kvs-file` map: the KeyValueStore resource logical id -> a local
   * JSON file backing its reads. Checked before the deployed store so a local
   * map wins when both are available.
   */
  kvsFiles?: Map<string, string>;
  /**
   * Resolve a `AWS::CloudFront::KeyValueStore` logical id to its deployed ARN
   * (under `--from-cfn-stack`). `undefined` return -> the store could not be
   * resolved (not deployed / no state); absent callback -> no deployed binding.
   */
  resolveDeployedKvs?: (kvsLogicalId: string) => Promise<DeployedKvsRef | undefined>;
  /** Region for the deployed `GetKey` client (CloudFront's `us-east-1` default). */
  region?: string;
  /** Credentials for the deployed `GetKey` client; SDK default chain when absent. */
  credentials?: KvsClientCredentials;
}

/**
 * Build + attach the `cf` module to every KVS-reading function in the
 * distribution. Returns boot warnings for associations that resolved to no
 * binding (the runtime then injects an unbound module so the read fails with a
 * clear actionable error). Idempotent per call — overwrites
 * `cloudfrontModule` so a `--watch` reload rebinds.
 */
export async function resolveKvsModulesForDistribution(
  distribution: ResolvedDistribution,
  options: ResolveKvsModulesOptions
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  for (const fn of collectKvsFunctions(distribution)) {
    const sources: KvsDataSource[] = [];
    for (const assoc of fn.kvsAssociations ?? []) {
      const source = await buildSourceForAssociation(assoc, options);
      if (source) {
        sources.push(source);
      } else {
        const ref = assoc.kvsLogicalId ?? '<store>';
        warnings.push(
          `CloudFront Function '${fn.logicalId}' reads KeyValueStore '${ref}', but no binding ` +
            `resolved it — cf.kvs() reads will fail. Pass --from-cfn-stack to read the deployed ` +
            `store, or --kvs-file ${ref}=<file.json> for a local map.`
        );
      }
    }
    // exactOptionalPropertyTypes: assign only when bound, else clear the slot so
    // a --watch reload that loses the binding falls back to the unbound module.
    if (sources.length > 0) {
      fn.cloudfrontModule = createCloudFrontModule(sources);
    } else {
      delete fn.cloudfrontModule;
    }
  }
  return { warnings };
}

/** Collect the unique compiled functions in the distribution that read a KVS. */
function collectKvsFunctions(distribution: ResolvedDistribution): CompiledCloudFrontFunction[] {
  const byLogicalId = new Map<string, CompiledCloudFrontFunction>();
  for (const behavior of distribution.behaviors) {
    for (const fn of [behavior.viewerRequest, behavior.viewerResponse]) {
      if (fn && fn.kvsAssociations && fn.kvsAssociations.length > 0) {
        byLogicalId.set(fn.logicalId, fn);
      }
    }
  }
  return [...byLogicalId.values()];
}

async function buildSourceForAssociation(
  assoc: NonNullable<CompiledCloudFrontFunction['kvsAssociations']>[number],
  options: ResolveKvsModulesOptions
): Promise<KvsDataSource | undefined> {
  // Local file wins when it covers this store (keyed by the KVS logical id).
  if (assoc.kvsLogicalId !== undefined) {
    const filePath = options.kvsFiles?.get(assoc.kvsLogicalId);
    if (filePath !== undefined) {
      return createLocalFileKvsDataSource({ id: assoc.kvsLogicalId, filePath });
    }
  }

  // Deployed store: a literal ARN is used directly; an intrinsic ref resolves
  // via the deployed-state callback.
  if (typeof assoc.arnValue === 'string' && assoc.arnValue.startsWith('arn:')) {
    return makeDeployedSource(assoc.arnValue, idFromArn(assoc.arnValue), options);
  }
  if (assoc.kvsLogicalId !== undefined && options.resolveDeployedKvs) {
    const ref = await options.resolveDeployedKvs(assoc.kvsLogicalId);
    if (ref) return makeDeployedSource(ref.arn, ref.id, options);
  }
  return undefined;
}

function makeDeployedSource(
  arn: string,
  id: string | undefined,
  options: ResolveKvsModulesOptions
): KvsDataSource {
  return createDeployedKvsDataSource({
    kvsArn: arn,
    ...(id !== undefined && { kvsId: id }),
    ...(options.region !== undefined && { region: options.region }),
    ...(options.credentials !== undefined && { credentials: options.credentials }),
  });
}

/** The KeyValueStore Id is the ARN's last `/`-segment. */
export function idFromArn(arn: string): string | undefined {
  const slash = arn.lastIndexOf('/');
  return slash >= 0 && slash < arn.length - 1 ? arn.slice(slash + 1) : undefined;
}
