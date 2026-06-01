import type { ResolvedEcsService } from './ecs-service-resolver.js';
import type { ResolvedEcsImage } from './ecs-task-resolver.js';

/**
 * Issue #234 — detect whether a booted ECS service's representative
 * container image is a local CDK docker-image asset (i.e. one the
 * `--watch` reload pathway can actually rebuild from local source) or
 * a deployed-registry pin (ECR / public registry) the rolling primitive
 * would re-pull byte-identical from on every save.
 *
 * The "representative" container picks the first essential container,
 * falling back to the first container if no container is marked
 * essential — same heuristic {@link loadAssetContextForTarget} (the
 * source-change classifier's context loader) uses for picking the
 * image whose asset hash drives the rebuild-vs-soft-reload decision.
 * Multi-essential tasks with mixed image kinds are rare; both call
 * sites of this helper (the boot-time `--watch` warn + the reload-time
 * skip guard) match on that same first-essential anchor so the
 * verdict surfaced to the user aligns with what the classifier sees.
 *
 * Host-side use case: cdkd and other shim hosts that wrap
 * `runEcsServiceEmulator` reuse this helper to produce the same
 * boot-time WARN + reload-time skip diagnostics under `--watch` when
 * the deployed image is pinned by `--from-cfn-stack` against a
 * `ContainerImage.fromEcrRepository(...)` service. Without this
 * helper a host would silently inherit the same no-op-disguised-as-
 * success symptom issue #234 documents.
 *
 * @internal — not part of the semver-covered public surface; exposed
 * via `cdk-local/internal` only. The stable entry point for hosts is
 * the emulator (`runEcsServiceEmulator`); call this directly only if
 * you need to reproduce the per-target image-kind classification.
 */

/**
 * Returns the first essential container's image, falling back to the
 * first container if none are marked essential. `undefined` when the
 * service has no containers (degenerate; the resolver would have
 * already warned).
 */
function representativeImage(service: ResolvedEcsService): ResolvedEcsImage | undefined {
  const essential = service.task.containers.find((c) => c.essential) ?? service.task.containers[0];
  return essential?.image;
}

/**
 * Returns true when the service's representative container image is a
 * local CDK docker-image asset (`ContainerImage.fromAsset(...)`-style)
 * — i.e. the `--watch` reload pathway has a local source tree to
 * rebuild from. Returns false when the image is an ECR pin
 * (`ContainerImage.fromEcrRepository(repo, tag)`-style; typically
 * surfaced under `--from-cfn-stack`) or a public-registry pin
 * (`ContainerImage.fromRegistry('nginx:latest')`-style). In both
 * "false" cases the rolling primitive would re-pull byte-identical
 * content on every save and disguise a no-op as a successful reload.
 *
 * Mirrors the bail-out branch in {@link loadAssetContextForTarget}:
 * when this returns false, the source-change classifier sees
 * `undefined` for the asset context and returns
 * `{ kind: 'rebuild', reason: 'target image is not a CDK docker-image asset' }`.
 */
export function isLocalCdkAssetImage(service: ResolvedEcsService): boolean {
  const image = representativeImage(service);
  return image !== undefined && image.kind === 'cdk-asset';
}

/**
 * Returns a short human-readable label for the deployed-registry URI
 * the representative container image is pinned to, or `undefined`
 * when the image IS a local CDK asset (in which case the boot-time
 * warn does not fire). For `ecr` images this surfaces the full
 * `<acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` URI; for
 * `public` images this surfaces the registry URI as-is
 * (e.g. `public.ecr.aws/foo/bar:tag` or `nginx:latest`). The boot-time
 * warn includes this so the user can see which image is pinning the
 * service to a no-source-edit-pickup configuration.
 */
export function describePinnedImageUri(service: ResolvedEcsService): string | undefined {
  const image = representativeImage(service);
  if (!image) return undefined;
  if (image.kind === 'cdk-asset') return undefined;
  return image.uri;
}

/**
 * Per-target outcome from {@link listPinnedTargets}: the target name +
 * an optional deployed-registry URI label (undefined when the image is
 * a local CDK asset and so is NOT pinned).
 */
export interface PinnedTargetEntry {
  /** ECS service target string (e.g. `StackName/ServiceConstructPath`). */
  target: string;
  /**
   * Human-readable deployed-registry URI for the pinned image, or
   * `undefined` when the helper bucketed the target as NOT pinned (the
   * caller filters by presence of this entry — entries are only emitted
   * for targets whose representative image is NOT a local CDK asset).
   */
  label?: string;
}
/**
 * Issue #242 / N1 — dedupe pinned-target detection across the two
 * sites that need it during a `cdkl start-service` / `cdkl start-alb`
 * boot:
 *
 *   1. The `--image-override` engine's pre-boot resolution
 *      ({@link resolveImageOverrides}) — needs the pinned set + per-
 *      target deployed-registry URI labels so the picker + boot-prompt
 *      hint can name the image the user is overriding.
 *   2. The post-boot WARN loop in `runEcsServiceEmulator` — surfaces a
 *      per-target WARN naming the deployed-registry URI for every
 *      pinned target the override engine did NOT cover.
 *
 * Before this helper both sites re-walked `isLocalCdkAssetImage` +
 * `describePinnedImageUri` independently. The semantic computation is
 * identical — given a `ResolvedEcsService`, decide pinned vs local-
 * asset and (for pinned targets) surface the URI label. Hoisting the
 * walk here keeps the two call sites in lock-step and gives both a
 * single test surface.
 *
 * Returns one entry per pinned target in the input's iteration order.
 * Targets whose representative image is a local CDK asset are
 * filtered out — the caller never sees them.
 */
export function listPinnedTargets(
  resolvedServices: Iterable<{ target: string; service: ResolvedEcsService }>
): PinnedTargetEntry[] {
  const out: PinnedTargetEntry[] = [];
  for (const { target, service } of resolvedServices) {
    if (isLocalCdkAssetImage(service)) continue;
    const label = describePinnedImageUri(service);
    out.push({ target, ...(label !== undefined && { label }) });
  }
  return out;
}
