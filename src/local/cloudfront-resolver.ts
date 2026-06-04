import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { AssetManifest, FileAsset } from '../types/assets.js';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import {
  compileCloudFrontFunction,
  type CloudFrontKvsAssociation,
  type CompiledCloudFrontFunction,
} from './cloudfront-function-runtime.js';
import type { ResolvedCustomErrorResponse } from './cloudfront-static-origin.js';
import { resolveResponseHeadersPolicyCors, type CorsConfig } from './cors-handler.js';

/**
 * Resolve a synthesized `AWS::CloudFront::Distribution` into the in-memory
 * routing model `cdkl start-cloudfront` serves (issue #363): each cache
 * behavior's path pattern + viewer-request / viewer-response CloudFront
 * Functions, the origin each behavior targets, and the distribution's custom
 * error responses. This is the static-site / SPA shape — an S3 origin whose
 * content is resolved from the BucketDeployment source asset in the cloud
 * assembly + CloudFront Functions doing the routing.
 *
 * Scope (v1, issue #363): S3 origins only. A custom (non-S3) origin and a
 * Lambda@Edge `LambdaFunctionAssociations` association are recorded but
 * WARN-and-skip at request time — cdk-local does not emulate them. The origin's
 * local content is resolved by walking the distribution's S3 origins back to
 * their `Custom::CDKBucketDeployment` source asset; an origin with no
 * resolvable local source is surfaced as `s3-unresolved` so the boot path can
 * WARN and the user can point it at a directory with `--origin <id>=<dir>`.
 */

/** A CloudFront Function wired to a cache behavior, compiled and ready to run. */
export interface ResolvedCloudFrontFunction extends CompiledCloudFrontFunction {}

/** One resolved cache behavior (the default behavior, or a `CacheBehaviors[]` entry). */
export interface ResolvedBehavior {
  /**
   * The behavior's `PathPattern` (`*` / `?` glob). `undefined` for the default
   * cache behavior — the catch-all evaluated when no other behavior matches.
   */
  pathPattern?: string;
  /** The `TargetOriginId` this behavior forwards to. */
  targetOriginId: string;
  /** `ViewerProtocolPolicy` (informational locally; see start-cloudfront docs). */
  viewerProtocolPolicy?: string;
  /** Compiled `viewer-request` function, if associated. */
  viewerRequest?: ResolvedCloudFrontFunction;
  /** Compiled `viewer-response` function, if associated. */
  viewerResponse?: ResolvedCloudFrontFunction;
  /**
   * True when the behavior carries a `LambdaFunctionAssociations` (Lambda@Edge)
   * — recorded so the boot path WARNs that it is not run locally.
   */
  hasLambdaEdge: boolean;
  /**
   * CORS config resolved from the behavior's `ResponseHeadersPolicyId` ->
   * `AWS::CloudFront::ResponseHeadersPolicy` `CorsConfig`. When set, the
   * server answers a matching OPTIONS preflight and adds
   * `Access-Control-Allow-Origin` to actual responses, reproducing
   * CloudFront's edge CORS. Absent for an AWS-managed policy id (literal,
   * not fetchable) or a policy with no CORS block.
   */
  cors?: CorsConfig;
}

/** A resolved origin: an S3 origin, a Lambda Function URL origin, or a custom origin. */
export type ResolvedOrigin =
  | { kind: 's3'; originId: string; localDirs: string[] }
  | { kind: 's3-unresolved'; originId: string; bucketLogicalId?: string }
  | {
      /**
       * A Lambda Function URL custom origin (`origins.FunctionUrlOrigin`):
       * served by invoking the backing Lambda locally (issue #376). The
       * `functionLogicalId` is the `AWS::Lambda::Function` the Function URL
       * fronts; `functionUrlLogicalId` is the `AWS::Lambda::Url` resource.
       */
      kind: 'lambda-url';
      originId: string;
      functionLogicalId: string;
      functionUrlLogicalId: string;
    }
  | { kind: 'custom'; originId: string; domainName: string };

/** The fully resolved distribution `cdkl start-cloudfront` serves. */
export interface ResolvedDistribution {
  /** The distribution's CloudFormation logical id. */
  logicalId: string;
  /** The stack the distribution lives in. */
  stackName: string;
  /** `DefaultRootObject` (e.g. `index.html`), if set. */
  defaultRootObject?: string;
  /** Default behavior first, then `CacheBehaviors[]` in declared order. */
  behaviors: ResolvedBehavior[];
  /** Origins keyed by `Id`. */
  origins: Map<string, ResolvedOrigin>;
  /** `CustomErrorResponses[]`, resolved to plain numbers / paths. */
  customErrorResponses: ResolvedCustomErrorResponse[];
}

export const CLOUDFRONT_DISTRIBUTION_TYPE = 'AWS::CloudFront::Distribution';
const CLOUDFRONT_FUNCTION_TYPE = 'AWS::CloudFront::Function';
const S3_BUCKET_TYPE = 'AWS::S3::Bucket';
const LAMBDA_URL_TYPE = 'AWS::Lambda::Url';
const LAMBDA_FUNCTION_TYPE = 'AWS::Lambda::Function';

/**
 * Resolve a distribution logical id within a stack into its routing model.
 * `originOverrides` maps an origin id to a local directory (the `--origin`
 * escape hatch); a covered origin is served from that directory regardless of
 * BucketDeployment resolution.
 */
export function resolveCloudFrontDistribution(args: {
  stack: StackInfo;
  logicalId: string;
  originOverrides?: Map<string, string>;
}): ResolvedDistribution {
  const { stack, logicalId } = args;
  const template = stack.template;
  const resource = (template.Resources ?? {})[logicalId];
  if (!resource || resource.Type !== CLOUDFRONT_DISTRIBUTION_TYPE) {
    throw new Error(
      `Resource '${logicalId}' in stack ${stack.stackName} is not an ${CLOUDFRONT_DISTRIBUTION_TYPE}.`
    );
  }
  const distConfig = (resource.Properties ?? {})['DistributionConfig'];
  if (!distConfig || typeof distConfig !== 'object') {
    throw new Error(`Distribution '${logicalId}' has no DistributionConfig.`);
  }
  const dc = distConfig as Record<string, unknown>;

  const functionsByLogicalId = compileDistributionFunctions(template);
  const behaviors = resolveBehaviors(dc, functionsByLogicalId, logicalId, template);
  const origins = resolveOrigins(dc, template, stack, args.originOverrides ?? new Map());
  const customErrorResponses = resolveCustomErrorResponses(dc);

  const result: ResolvedDistribution = {
    logicalId,
    stackName: stack.stackName,
    behaviors,
    origins,
    customErrorResponses,
  };
  if (typeof dc['DefaultRootObject'] === 'string' && dc['DefaultRootObject'] !== '') {
    result.defaultRootObject = dc['DefaultRootObject'];
  }
  return result;
}

/** Compile every `AWS::CloudFront::Function` in the template, keyed by logical id. */
function compileDistributionFunctions(
  template: CloudFormationTemplate
): Map<string, CompiledCloudFrontFunction> {
  const out = new Map<string, CompiledCloudFrontFunction>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type !== CLOUDFRONT_FUNCTION_TYPE) continue;
    const props = resource.Properties ?? {};
    const code = props['FunctionCode'];
    if (typeof code !== 'string') {
      getLogger().warn(
        `CloudFront Function '${logicalId}' has a non-inline FunctionCode; cdk-local can only run inline function code. Skipping.`
      );
      continue;
    }
    const config = props['FunctionConfig'];
    const configObj =
      config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
    const runtime =
      typeof configObj['Runtime'] === 'string'
        ? (configObj['Runtime'] as string)
        : 'cloudfront-js-1.0';
    const compiled = compileCloudFrontFunction(logicalId, code, runtime);
    const kvsAssociations = extractKvsAssociations(configObj);
    if (kvsAssociations.length > 0) compiled.kvsAssociations = kvsAssociations;
    out.set(logicalId, compiled);
  }
  return out;
}

/**
 * Extract a function's `FunctionConfig.KeyValueStoreAssociations[]` into the
 * compiled-function carrier, pre-resolving each association's KVS resource
 * logical id from the `KeyValueStoreARN` intrinsic so the command layer can
 * bind it (deployed store under `--from-cfn-stack`, or a `--kvs-file` map).
 */
export function extractKvsAssociations(
  functionConfig: Record<string, unknown>
): CloudFrontKvsAssociation[] {
  const raw = Array.isArray(functionConfig['KeyValueStoreAssociations'])
    ? (functionConfig['KeyValueStoreAssociations'] as unknown[])
    : [];
  const out: CloudFrontKvsAssociation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const arnValue = (entry as Record<string, unknown>)['KeyValueStoreARN'];
    if (arnValue === undefined) continue;
    const kvsLogicalId = pickKvsLogicalIdFromArn(arnValue);
    out.push({ arnValue, ...(kvsLogicalId !== undefined && { kvsLogicalId }) });
  }
  return out;
}

/**
 * Unwrap a `KeyValueStoreARN` value to the `AWS::CloudFront::KeyValueStore`
 * logical id when it is an intrinsic reference to a same-template store. CDK /
 * CloudFormation synthesize it as `Fn::GetAtt[<Kvs>, 'Arn']`, a `Ref`, or
 * `Fn::Sub: '${<Kvs>.Arn}'`. Returns `undefined` for a literal ARN string (an
 * imported / out-of-stack store).
 */
export function pickKvsLogicalIdFromArn(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const getAtt = obj['Fn::GetAtt'];
  if (Array.isArray(getAtt) && getAtt.length === 2 && typeof getAtt[0] === 'string') {
    return getAtt[0];
  }
  if (typeof obj['Ref'] === 'string') return obj['Ref'];
  const sub = obj['Fn::Sub'];
  const subTemplate = typeof sub === 'string' ? sub : Array.isArray(sub) ? sub[0] : undefined;
  if (typeof subTemplate === 'string') {
    const match = /^\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9]+)?\}$/.exec(subTemplate.trim());
    if (match) return match[1]!;
  }
  return undefined;
}

function resolveBehaviors(
  dc: Record<string, unknown>,
  functions: Map<string, CompiledCloudFrontFunction>,
  distLogicalId: string,
  template: CloudFormationTemplate
): ResolvedBehavior[] {
  const behaviors: ResolvedBehavior[] = [];
  const def = dc['DefaultCacheBehavior'];
  if (def && typeof def === 'object') {
    behaviors.push(
      resolveBehavior(def as Record<string, unknown>, undefined, functions, distLogicalId, template)
    );
  }
  const extra = Array.isArray(dc['CacheBehaviors']) ? (dc['CacheBehaviors'] as unknown[]) : [];
  for (const b of extra) {
    if (!b || typeof b !== 'object') continue;
    const behavior = b as Record<string, unknown>;
    // CFn requires a literal `PathPattern` on every non-default behavior. A
    // missing / non-literal (intrinsic) value is malformed: defaulting it to a
    // catch-all `*` would silently shadow the default behavior for ALL
    // requests, so skip it with a WARN instead.
    if (typeof behavior['PathPattern'] !== 'string') {
      getLogger().warn(
        `Distribution '${distLogicalId}': a cache behavior has no literal PathPattern; cdk-local cannot route it and is skipping it.`
      );
      continue;
    }
    behaviors.push(
      resolveBehavior(behavior, behavior['PathPattern'], functions, distLogicalId, template)
    );
  }
  return behaviors;
}

function resolveBehavior(
  behavior: Record<string, unknown>,
  pathPattern: string | undefined,
  functions: Map<string, CompiledCloudFrontFunction>,
  distLogicalId: string,
  template: CloudFormationTemplate
): ResolvedBehavior {
  const resolved: ResolvedBehavior = {
    targetOriginId:
      typeof behavior['TargetOriginId'] === 'string' ? (behavior['TargetOriginId'] as string) : '',
    hasLambdaEdge: Array.isArray(behavior['LambdaFunctionAssociations'])
      ? (behavior['LambdaFunctionAssociations'] as unknown[]).length > 0
      : false,
  };
  if (pathPattern !== undefined) resolved.pathPattern = pathPattern;
  // CloudFront CORS lives on the behavior's ResponseHeadersPolicy, not the
  // origin — resolve it so the server reproduces the edge CORS (preflight +
  // actual-response ACAO). Per behavior, so CacheBehaviors[] keep their own.
  const cors = resolveResponseHeadersPolicyCors(template, behavior['ResponseHeadersPolicyId']);
  if (cors) resolved.cors = cors;
  if (typeof behavior['ViewerProtocolPolicy'] === 'string') {
    resolved.viewerProtocolPolicy = behavior['ViewerProtocolPolicy'] as string;
  }
  const assocs = Array.isArray(behavior['FunctionAssociations'])
    ? (behavior['FunctionAssociations'] as unknown[])
    : [];
  for (const a of assocs) {
    if (!a || typeof a !== 'object') continue;
    const assoc = a as Record<string, unknown>;
    const eventType = assoc['EventType'];
    const fnLogicalId = pickFunctionLogicalIdFromArn(assoc['FunctionARN'] ?? assoc['FunctionArn']);
    if (!fnLogicalId) {
      getLogger().warn(
        `Distribution '${distLogicalId}': a FunctionAssociation references a function ARN cdk-local could not resolve to a local AWS::CloudFront::Function; it will not run.`
      );
      continue;
    }
    const fn = functions.get(fnLogicalId);
    if (!fn) continue;
    if (eventType === 'viewer-request') resolved.viewerRequest = fn;
    else if (eventType === 'viewer-response') resolved.viewerResponse = fn;
  }
  return resolved;
}

/**
 * Unwrap a `FunctionAssociations[].FunctionARN` intrinsic to the
 * `AWS::CloudFront::Function` logical id. CDK synthesizes it as
 * `{Fn::GetAtt: [<logicalId>, "FunctionARN"]}`.
 */
export function pickFunctionLogicalIdFromArn(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const getAtt = (value as Record<string, unknown>)['Fn::GetAtt'];
  if (Array.isArray(getAtt) && getAtt.length === 2 && typeof getAtt[0] === 'string') {
    return getAtt[0];
  }
  return undefined;
}

function resolveOrigins(
  dc: Record<string, unknown>,
  template: CloudFormationTemplate,
  stack: StackInfo,
  overrides: Map<string, string>
): Map<string, ResolvedOrigin> {
  const out = new Map<string, ResolvedOrigin>();
  const origins = Array.isArray(dc['Origins']) ? (dc['Origins'] as unknown[]) : [];
  // Resolve the manifest once (shared across origins).
  const manifest = loadStackManifest(stack);
  for (const o of origins) {
    if (!o || typeof o !== 'object') continue;
    const origin = o as Record<string, unknown>;
    const originId = typeof origin['Id'] === 'string' ? (origin['Id'] as string) : undefined;
    if (!originId) continue;

    const overrideDir = overrides.get(originId);
    if (overrideDir) {
      out.set(originId, { kind: 's3', originId, localDirs: [resolveDir(overrideDir)] });
      continue;
    }

    const bucketLogicalId = pickBucketLogicalIdFromOrigin(origin, template);
    const isS3 = origin['S3OriginConfig'] !== undefined || bucketLogicalId !== undefined;
    if (!isS3) {
      // A Lambda Function URL custom origin (origins.FunctionUrlOrigin) is the
      // one custom origin cdk-local serves: the backing Lambda is the user's
      // own application compute, run locally via RIE (issue #376).
      const lambdaUrl = resolveLambdaUrlOrigin(origin, template, originId);
      if (lambdaUrl) {
        out.set(originId, lambdaUrl);
        continue;
      }
      out.set(originId, {
        kind: 'custom',
        originId,
        domainName: describeDomainName(origin['DomainName']),
      });
      continue;
    }

    const localDirs =
      bucketLogicalId && manifest
        ? resolveBucketDeploymentDirs(template, manifest, stack, bucketLogicalId)
        : [];
    if (localDirs.length > 0) {
      out.set(originId, { kind: 's3', originId, localDirs });
    } else {
      out.set(originId, {
        kind: 's3-unresolved',
        originId,
        ...(bucketLogicalId !== undefined && { bucketLogicalId }),
      });
    }
  }
  return out;
}

/**
 * Read a stack's asset manifest, or `undefined` when it ships no assets / is
 * unreadable. We already hold the absolute manifest path on {@link StackInfo},
 * so we read + parse it directly rather than going through the by-stack-name
 * loader.
 */
function loadStackManifest(stack: StackInfo): AssetManifest | undefined {
  if (!stack.assetManifestPath) return undefined;
  try {
    return JSON.parse(readFileSync(stack.assetManifestPath, 'utf-8')) as AssetManifest;
  } catch (err) {
    getLogger().warn(
      `Could not read asset manifest at ${stack.assetManifestPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * Walk a bucket's `Custom::CDKBucketDeployment*` custom resources back to the
 * local source-asset directories that were staged for it. Returns the resolved
 * local directories (one per matching BucketDeployment source) — empty when the
 * bucket has no BucketDeployment (content uploaded out of band) or the source
 * object key cannot be matched to a manifest file asset.
 */
export function resolveBucketDeploymentDirs(
  template: CloudFormationTemplate,
  manifest: AssetManifest,
  stack: StackInfo,
  bucketLogicalId: string
): string[] {
  const manifestDir = stack.assetManifestPath ? dirname(stack.assetManifestPath) : undefined;
  if (!manifestDir) return [];
  const dirs: string[] = [];
  for (const resource of Object.values(template.Resources ?? {})) {
    if (!String(resource.Type).startsWith('Custom::CDKBucketDeployment')) continue;
    const props = resource.Properties ?? {};
    if (refLogicalId(props['DestinationBucketName']) !== bucketLogicalId) continue;
    const keys = Array.isArray(props['SourceObjectKeys']) ? props['SourceObjectKeys'] : [];
    for (const key of keys) {
      if (typeof key !== 'string') continue; // non-literal (intrinsic) -> unresolved
      const asset = findFileAssetByObjectKey(manifest, key);
      if (!asset) continue;
      dirs.push(resolve(manifestDir, asset.source.path));
    }
  }
  return dirs;
}

/**
 * Find the file asset whose published object key equals `objectKey`. The
 * BucketDeployment `SourceObjectKeys` carries the published key
 * (`<hash>.zip`); matching on the destination object key is more robust than
 * guessing how the hash maps to the manifest key.
 */
function findFileAssetByObjectKey(
  manifest: AssetManifest,
  objectKey: string
): FileAsset | undefined {
  for (const asset of Object.values(manifest.files ?? {})) {
    for (const dest of Object.values(asset.destinations ?? {})) {
      if (dest.objectKey === objectKey) return asset;
    }
  }
  // Fallback: the key is `<hash>.zip`; match the manifest entry by hash.
  const hash = objectKey.replace(/\.zip$/, '');
  return manifest.files?.[hash];
}

/**
 * Extract the S3 bucket logical id an origin's `DomainName` points at. CDK
 * synthesizes an S3 origin's `DomainName` as
 * `{Fn::GetAtt: [<bucket>, "RegionalDomainName"]}` (or `DomainName` /
 * `WebsiteURL`). Returns the logical id only when it resolves to an
 * `AWS::S3::Bucket` in the template.
 */
export function pickBucketLogicalIdFromOrigin(
  origin: Record<string, unknown>,
  template: CloudFormationTemplate
): string | undefined {
  const candidate = getAttLogicalId(origin['DomainName']);
  if (!candidate) return undefined;
  const resource = (template.Resources ?? {})[candidate];
  if (resource && resource.Type === S3_BUCKET_TYPE) return candidate;
  return undefined;
}

function getAttLogicalId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const getAtt = (value as Record<string, unknown>)['Fn::GetAtt'];
  if (Array.isArray(getAtt) && getAtt.length === 2 && typeof getAtt[0] === 'string') {
    return getAtt[0];
  }
  return undefined;
}

/**
 * Resolve a Lambda Function URL custom origin (`origins.FunctionUrlOrigin`) to
 * its backing `AWS::Lambda::Function` logical id, or `undefined` when the
 * origin is not a Function URL (a generic custom HTTP origin). CDK synthesizes
 * a FunctionUrlOrigin's `DomainName` from the Function URL by stripping the
 * scheme + trailing slash:
 * `Fn::Select[2, Fn::Split['/', Fn::GetAtt[<UrlLogicalId>, 'FunctionUrl']]]`.
 * The `AWS::Lambda::Url` resource's `TargetFunctionArn` then points at the
 * function (a `Ref` or `Fn::GetAtt[<fn>, 'Arn']`).
 */
function resolveLambdaUrlOrigin(
  origin: Record<string, unknown>,
  template: CloudFormationTemplate,
  originId: string
): Extract<ResolvedOrigin, { kind: 'lambda-url' }> | undefined {
  const urlLogicalId = pickFunctionUrlLogicalIdFromOrigin(origin['DomainName']);
  if (!urlLogicalId) return undefined;
  const urlResource = (template.Resources ?? {})[urlLogicalId];
  if (!urlResource || urlResource.Type !== LAMBDA_URL_TYPE) return undefined;
  const functionLogicalId = pickTargetFunctionLogicalId(
    (urlResource.Properties ?? {})['TargetFunctionArn']
  );
  if (!functionLogicalId) return undefined;
  const fnResource = (template.Resources ?? {})[functionLogicalId];
  if (!fnResource || fnResource.Type !== LAMBDA_FUNCTION_TYPE) return undefined;
  return { kind: 'lambda-url', originId, functionLogicalId, functionUrlLogicalId: urlLogicalId };
}

/**
 * Unwrap a FunctionUrlOrigin `DomainName` to its `AWS::Lambda::Url` logical id.
 * Matches the exact synthesized shape
 * `{Fn::Select: [2, {Fn::Split: ['/', {Fn::GetAtt: [<UrlLogicalId>, 'FunctionUrl']}]}]}`.
 */
export function pickFunctionUrlLogicalIdFromOrigin(value: unknown): string | undefined {
  const select = asIntrinsic(value, 'Fn::Select');
  if (!Array.isArray(select) || select.length !== 2 || select[0] !== 2) return undefined;
  const split = asIntrinsic(select[1], 'Fn::Split');
  if (!Array.isArray(split) || split.length !== 2 || split[0] !== '/') return undefined;
  const getAtt = asIntrinsic(split[1], 'Fn::GetAtt');
  if (
    Array.isArray(getAtt) &&
    getAtt.length === 2 &&
    typeof getAtt[0] === 'string' &&
    getAtt[1] === 'FunctionUrl'
  ) {
    return getAtt[0];
  }
  return undefined;
}

/**
 * Unwrap an `AWS::Lambda::Url` `TargetFunctionArn` to the function logical id.
 * CDK emits either a `Ref` (the function's name reference) or a
 * `Fn::GetAtt[<fn>, 'Arn']`.
 */
export function pickTargetFunctionLogicalId(value: unknown): string | undefined {
  return refLogicalId(value) ?? getAttLogicalId(value);
}

/** Read an intrinsic's payload (e.g. the `Fn::Select` array) from a wrapper object. */
function asIntrinsic(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function refLogicalId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = (value as Record<string, unknown>)['Ref'];
  return typeof ref === 'string' ? ref : undefined;
}

function resolveCustomErrorResponses(dc: Record<string, unknown>): ResolvedCustomErrorResponse[] {
  const raw = Array.isArray(dc['CustomErrorResponses'])
    ? (dc['CustomErrorResponses'] as unknown[])
    : [];
  const out: ResolvedCustomErrorResponse[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const entry = e as Record<string, unknown>;
    if (typeof entry['ErrorCode'] !== 'number') continue;
    const resolved: ResolvedCustomErrorResponse = { errorCode: entry['ErrorCode'] as number };
    if (typeof entry['ResponsePagePath'] === 'string')
      resolved.responsePagePath = entry['ResponsePagePath'];
    if (typeof entry['ResponseCode'] === 'number')
      resolved.responseCode = entry['ResponseCode'] as number;
    out.push(resolved);
  }
  return out;
}

function describeDomainName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '<unknown>';
}

function resolveDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}

/** True when a template resource is an `AWS::CloudFront::Distribution`. */
export function isCloudFrontDistribution(resource: TemplateResource): boolean {
  return resource.Type === CLOUDFRONT_DISTRIBUTION_TYPE;
}
