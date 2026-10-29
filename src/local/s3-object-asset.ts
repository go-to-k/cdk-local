import type { AssetManifest, FileAsset } from '../types/assets.js';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';

/**
 * Map an S3 object a template names back to the file asset staged for it in
 * cdk.out. Shared by `start-cloudfront` (a BucketDeployment's sources serve an
 * S3 origin), `start-web-function` (a revision's `CodeConfig.S3Object`) and
 * `start-microvm` (a `CodeArtifact.Uri`): all of them run or serve the LOCAL
 * asset and never download what was deployed.
 */

/**
 * Find the file asset in a stack's cdk.out manifest whose S3 destination is
 * `key` (exactly, or as the last segment of a prefixed key), falling back to
 * the manifest entry keyed by the key's hash (`<hash>.zip`).
 */
export function findFileAssetForObjectKey(
  manifest: AssetManifest,
  key: string
): { hash: string; asset: FileAsset } | undefined {
  for (const [hash, asset] of Object.entries(manifest.files ?? {})) {
    for (const dest of Object.values(asset.destinations ?? {})) {
      if (dest.objectKey === key || dest.objectKey.endsWith(`/${key}`)) return { hash, asset };
    }
  }
  const hash = key.replace(/^.*\//, '').replace(/\.zip$/, '');
  const byHash = Object.hasOwn(manifest.files ?? {}, hash) ? manifest.files[hash] : undefined;
  return byHash ? { hash, asset: byHash } : undefined;
}

/**
 * Whether a template resource is an `aws-s3-deployment` `BucketDeployment`
 * custom resource. CDK types it `Custom::CDKBucketDeployment<hash>`.
 */
export function isBucketDeploymentResource(resource: TemplateResource | undefined): boolean {
  return resource !== undefined && String(resource.Type).startsWith('Custom::CDKBucketDeployment');
}

/** A BucketDeployment's `SourceObjectKeys`, one per source; `[]` when absent. */
export function bucketDeploymentSourceObjectKeys(resource: TemplateResource): unknown[] {
  const keys = resource.Properties?.['SourceObjectKeys'];
  return Array.isArray(keys) ? keys : [];
}

/**
 * The outcome of resolving `Fn::Select [i, Fn::GetAtt [<deployment>, SourceObjectKeys]]`
 * (`Fn.select(i, deployment.objectKeys)` in CDK) to the deployment's i-th
 * source object key.
 *
 * - `resolved`: the deployment copies its sources as-is (`extract: false`), so
 *   the object at that key IS the i-th source's zip: `sourceObjectKey` is its
 *   key in the asset bucket, which {@link findFileAssetForObjectKey} matches.
 * - `extracts`: the deployment unpacks its sources (`extract: true`, the
 *   default), so no object holds the source zip and there is nothing to map.
 * - `object-keys-not-output`: `outputObjectKeys: false`, so the attribute is
 *   an empty list and the deployed `Fn::Select` fails.
 * - `prefixed-destination`: a `destinationKeyPrefix` puts the zip at
 *   `<prefix><key>` while the attribute still returns `<key>`, so the selected
 *   key names no object in the destination bucket.
 * - `index-out-of-range` / `source-key-not-literal`: the selected source is
 *   missing, or is not a CDK asset whose key synthesizes as a literal.
 */
export type BucketDeploymentObjectKeyResolution =
  | { kind: 'resolved'; deploymentLogicalId: string; index: number; sourceObjectKey: string }
  | { kind: 'extracts'; deploymentLogicalId: string; index: number }
  | { kind: 'object-keys-not-output'; deploymentLogicalId: string; index: number }
  | { kind: 'prefixed-destination'; deploymentLogicalId: string; index: number }
  | { kind: 'index-out-of-range'; deploymentLogicalId: string; index: number; sourceCount: number }
  | { kind: 'source-key-not-literal'; deploymentLogicalId: string; index: number };

/**
 * Resolve an `S3Object.Key`-like template value of the shape
 * `Fn::Select [i, Fn::GetAtt [<deployment>, SourceObjectKeys]]`, where
 * `<deployment>` is a BucketDeployment custom resource in `template`. Returns
 * `undefined` for any other value (a literal, another intrinsic, a GetAtt of a
 * resource that is not a BucketDeployment), leaving the caller's own error.
 */
export function resolveBucketDeploymentObjectKey(
  template: CloudFormationTemplate,
  value: unknown
): BucketDeploymentObjectKeyResolution | undefined {
  const select = asObject(value)?.['Fn::Select'];
  if (!Array.isArray(select) || select.length !== 2) return undefined;
  const index = selectIndex(select[0]);
  const deploymentLogicalId = sourceObjectKeysGetAttTarget(select[1]);
  if (index === undefined || deploymentLogicalId === undefined) return undefined;
  const resources = template.Resources ?? {};
  const deployment = Object.hasOwn(resources, deploymentLogicalId)
    ? resources[deploymentLogicalId]
    : undefined;
  if (!deployment || !isBucketDeploymentResource(deployment)) return undefined;

  // The handler reads each flag as the string a custom resource receives and
  // tests `== 'true'` with `'true'` as the default (CDK synthesizes `Extract`
  // only when set), so any other literal, `false` included, turns it off. A
  // non-literal value is treated as the default.
  const props = deployment.Properties ?? {};
  if (handlerFlag(props['Extract'])) return { kind: 'extracts', deploymentLogicalId, index };
  if (!handlerFlag(props['OutputObjectKeys'])) {
    return { kind: 'object-keys-not-output', deploymentLogicalId, index };
  }
  // The handler treats `/` like no prefix.
  const prefix = props['DestinationBucketKeyPrefix'];
  if (prefix !== undefined && prefix !== '' && prefix !== '/') {
    return { kind: 'prefixed-destination', deploymentLogicalId, index };
  }
  const keys = bucketDeploymentSourceObjectKeys(deployment);
  if (index >= keys.length) {
    return { kind: 'index-out-of-range', deploymentLogicalId, index, sourceCount: keys.length };
  }
  const sourceObjectKey = keys[index];
  if (typeof sourceObjectKey !== 'string' || sourceObjectKey.length === 0) {
    return { kind: 'source-key-not-literal', deploymentLogicalId, index };
  }
  return { kind: 'resolved', deploymentLogicalId, index, sourceObjectKey };
}

/** A BucketDeployment handler flag: on unless a literal other than `true` / `'true'`. */
function handlerFlag(value: unknown): boolean {
  if (value === undefined || value === true || value === 'true') return true;
  return typeof value === 'object' && value !== null;
}

/** `Fn::Select`'s index: a non-negative integer, or its decimal string. */
function selectIndex(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** The logical id of `Fn::GetAtt [<id>, SourceObjectKeys]` (array or dotted form). */
function sourceObjectKeysGetAttTarget(value: unknown): string | undefined {
  const getAtt = asObject(value)?.['Fn::GetAtt'];
  if (Array.isArray(getAtt)) {
    return getAtt.length === 2 && typeof getAtt[0] === 'string' && getAtt[1] === 'SourceObjectKeys'
      ? getAtt[0]
      : undefined;
  }
  if (typeof getAtt === 'string' && getAtt.endsWith('.SourceObjectKeys')) {
    const id = getAtt.slice(0, -'.SourceObjectKeys'.length);
    return id.length > 0 && !id.includes('.') ? id : undefined;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
