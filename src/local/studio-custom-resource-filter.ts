import type { StudioTarget, StudioTargetGroup } from './studio-server.js';

/**
 * Substrings / patterns that identify a Lambda as part of CDK's custom-resource
 * or provider-framework plumbing rather than the user's own application code.
 *
 * Matched case-INSENSITIVELY against a target's display path / qualified id.
 * Each entry corresponds to a well-known CDK-generated construct:
 *
 * - `framework-onEvent` / `framework-onTimeout` / `framework-isComplete` —
 *   the provider-framework (`@aws-cdk/custom-resources` `Provider`) handlers.
 * - `/Provider/` — the `Provider` construct segment that wraps a custom
 *   resource's lifecycle Lambdas.
 * - `LogRetention` — the singleton log-retention custom resource CDK injects
 *   when a construct sets `logRetention`.
 * - `BucketNotificationsHandler` — the S3 bucket-notifications custom resource.
 * - `AwsCustomResource` — the `aws-custom-resource` SDK-call construct.
 * - `AWS679f53fac002430cb0da5b7982bd2287` — the singleton logical id CDK emits
 *   for the `AwsCustomResource` provider Lambda.
 * - `CustomResourceProvider` — the low-level `CustomResourceProvider` framework
 *   Lambda (used by many L2 constructs).
 * - `cdkbucketdeployment` — the `BucketDeployment` asset-copy Lambda (the
 *   logical id is `CustomCDKBucketDeployment<hash>`, the construct path node is
 *   `Custom::CDKBucketDeployment<hash>` — the shared substring covers both).
 * - `CDKMetadata` — the CDK metadata resource (not a Lambda, but cheap to
 *   exclude defensively if it ever surfaces as one).
 */
const CUSTOM_RESOURCE_PATTERNS: readonly string[] = [
  'framework-onevent',
  'framework-ontimeout',
  'framework-iscomplete',
  '/provider/',
  'logretention',
  'bucketnotificationshandler',
  'awscustomresource',
  'aws679f53fac002430cb0da5b7982bd2287',
  'customresourceprovider',
  'cdkbucketdeployment',
  'cdkmetadata',
];

/**
 * Classify a studio Lambda target as a CDK custom-resource / provider-framework
 * Lambda (vs the user's own application code). Matches the target's display
 * path / qualified id against {@link CUSTOM_RESOURCE_PATTERNS}
 * case-insensitively.
 *
 * Host-side use case: a host CLI building its own studio (or `cdkl list`-style
 * UI) reuses this to hide CDK-generated plumbing Lambdas — provider-framework
 * onEvent/onTimeout/isComplete handlers, log-retention, bucket-notifications,
 * AwsCustomResource, BucketDeployment — from the default target list, so the
 * user sees only their own functions. Pure / side-effect-free.
 */
export function isCustomResourceLambdaTarget(entry: StudioTarget): boolean {
  const haystack = `${entry.id} ${entry.qualifiedId}`.toLowerCase();
  return CUSTOM_RESOURCE_PATTERNS.some((p) => haystack.includes(p));
}

/** Options for {@link filterStudioCustomResources}. */
export interface FilterStudioCustomResourcesOptions {
  /**
   * When true, custom-resource / provider Lambdas are KEPT (the opt-in
   * `--include-custom-resources` behaviour). When false / omitted they are
   * dropped from the `lambda` group.
   */
  include?: boolean;
}

/**
 * Drop CDK custom-resource / provider-framework Lambdas from the `lambda` group
 * of `groups` (issue #323). Only the `lambda` group is touched — every other
 * group (api / ecs / alb / agentcore) is returned unchanged — and within it
 * only entries {@link isCustomResourceLambdaTarget} matches are removed.
 *
 * Pass `{ include: true }` to keep them (the `--include-custom-resources`
 * opt-in), in which case `groups` is returned unchanged.
 *
 * Host-side use case: `cdkl studio` (and any host CLI embedding the studio
 * building blocks) applies this after the `--stack` display filter so the
 * default target list shows only the user's own Lambdas, not CDK's generated
 * plumbing. Returns a new array (the matching group is rebuilt); inputs are not
 * mutated.
 */
export function filterStudioCustomResources(
  groups: StudioTargetGroup[],
  opts: FilterStudioCustomResourcesOptions = {}
): StudioTargetGroup[] {
  if (opts.include) return groups;
  return groups.map((g) => {
    if (g.kind !== 'lambda') return g;
    return { ...g, entries: g.entries.filter((e) => !isCustomResourceLambdaTarget(e)) };
  });
}
