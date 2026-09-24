import type { DockerImageAssetSource } from '../types/assets.js';
import { sanitizeServiceExceptionMessage } from '../local/credential-error.js';
import { getEmbedConfig } from '../local/embed-config.js';
import { assemblyPathEscape, renderAssemblyPathEscape } from '../utils/assembly-path.js';
import { getLogger } from '../utils/logger.js';
import { cacheOptionToFlag } from './docker-cache-option.js';

/**
 * Warnings for the BuildKit passthroughs of a Docker asset — the host paths
 * `docker build` reads or writes **as the asset manifest wrote them**
 * (`dockerFile`, `dockerBuildContexts`, `dockerBuildSecrets`, `dockerBuildSsh`,
 * `cacheFrom`, `cacheTo`, `dockerOutputs`).
 *
 * **WARN, never refuse.** These are forwarded exactly as the CDK CLI forwards
 * them, and a legitimate project uses them to reach outside the assembly (a
 * `--secret src=~/.npmrc`, a shared `--build-context`). What was missing is
 * the line saying so: the CloudFormation template does not show any of them,
 * so a hand-modified assembly could read a host file into a build or write
 * build output anywhere with no signal. Same decision, and the same parser, as
 * the host CLI that embeds this engine (go-to-k/cdkd#3497); cdk-local's builds
 * were the ones that never warned.
 *
 * Tolerant by construction: this only ever ADDS a line and must never be why a
 * legitimate build fails.
 */

type PassthroughField =
  | 'dockerFile'
  | 'dockerBuildContexts'
  | 'dockerBuildSecrets'
  | 'dockerBuildSsh'
  | 'cacheFrom'
  | 'cacheTo'
  | 'dockerOutputs';

interface HostPathRef {
  field: PassthroughField;
  /** The key or index that located it, WITHOUT brackets. */
  where: string;
  path: string;
  /** Whether BuildKit WRITES there — decided by a `dest=` key, not by the field. */
  write: boolean;
}

/**
 * Every candidate host path in a buildx option value: a part with a key yields
 * its value when the key is `src` / `source` / `dest` (the keys that make
 * BuildKit open a file), and a part without a key yields itself.
 *
 * Over-inclusive on purpose for a BARE part: a non-path string resolves inside
 * the build context and is dropped before anything is printed. A keyed part is
 * limited to the three file keys because `ref=` / `scope=` / `env=` are not
 * paths, and taking them announced a registry ref as a host read.
 *
 * Known incomplete, and both misses cost a WARNING, never a refusal: a quoted
 * CSV value containing a comma is split wrongly here; a leading or trailing
 * space is trimmed here while buildx keeps it (an over-warn only).
 */
function candidateHostPaths(
  value: string,
  opts: { bareIsWrite: boolean }
): { path: string; write: boolean }[] {
  const out: { path: string; write: boolean }[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      const bare = part.trim();
      if (bare.length > 0) out.push({ path: bare, write: opts.bareIsWrite });
      continue;
    }
    // buildx lower-cases keys and accepts `source` as an alias for `src`.
    const key = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (v.length === 0) continue;
    if (key !== 'src' && key !== 'source' && key !== 'dest') continue;
    // `bareIsWrite` governs the BARE branch only: letting it decide a keyed
    // part made `type=image,push=true` a write.
    out.push({ path: v, write: key === 'dest' });
  }
  return out;
}

/**
 * Every host path this source hands to BuildKit. Each field is judged as the
 * RENDERED argv string `buildDockerBuildCommand` pushes, not as the struct —
 * nothing there is quoted, so CSV smuggled into a key or a `params` value
 * reaches BuildKit and must reach this walk too.
 */
function hostPathsOf(source: DockerImageAssetSource): HostPathRef[] {
  const refs: HostPathRef[] = [];

  if (source.dockerFile) {
    refs.push({ field: 'dockerFile', where: 'dockerFile', path: source.dockerFile, write: false });
  }
  // `--build-context ${k}=${v}`: buildx takes everything after the FIRST `=`.
  // Not through `candidateHostPaths`, since this value is not CSV and a
  // legitimate path may contain a comma.
  for (const [k, v] of Object.entries(source.dockerBuildContexts ?? {})) {
    const rendered = `${k}=${v}`;
    // `oci-layout://<path>` names a HOST directory behind a scheme; judged
    // with the scheme it would fold one level deeper and read as contained.
    const contextPath = rendered
      .slice(rendered.indexOf('=') + 1)
      .trim()
      .replace(/^oci-layout:\/\//, '');
    if (contextPath.length === 0) continue;
    refs.push({ field: 'dockerBuildContexts', where: k, path: contextPath, write: false });
  }
  // `--ssh <id>=<path>[,<path>]`: buildx splits the WHOLE string at the FIRST
  // `=`, so the left side is the id and every comma-separated entry right of
  // it is a path. `default` (no `=`) is the agent socket and has no path.
  const ssh = source.dockerBuildSsh ?? '';
  const sshEq = ssh.indexOf('=');
  (sshEq < 0 ? [] : ssh.slice(sshEq + 1).split(',')).forEach((entry, i) => {
    const p = entry.trim();
    if (p.length > 0) {
      refs.push({ field: 'dockerBuildSsh', where: String(i), path: p, write: false });
    }
  });
  // `--secret id=${k},${v}`, unquoted — so a KEY can carry `,src=...`.
  for (const [k, v] of Object.entries(source.dockerBuildSecrets ?? {})) {
    for (const { path: p, write } of candidateHostPaths(`id=${k},${v}`, {
      bareIsWrite: false,
    })) {
      refs.push({ field: 'dockerBuildSecrets', where: k, path: p, write });
    }
  }
  (source.cacheFrom ?? []).forEach((c, i) => {
    for (const { path: p, write } of candidateHostPaths(cacheOptionToFlag(c), {
      bareIsWrite: false,
    })) {
      refs.push({ field: 'cacheFrom', where: String(i), path: p, write });
    }
  });
  if (source.cacheTo) {
    for (const { path: p, write } of candidateHostPaths(cacheOptionToFlag(source.cacheTo), {
      bareIsWrite: false,
    })) {
      refs.push({ field: 'cacheTo', where: 'cacheTo', path: p, write });
    }
  }
  // `--output=<path>` shorthand: the bare form IS a destination.
  (source.dockerOutputs ?? []).forEach((o, i) => {
    for (const { path: p, write } of candidateHostPaths(o, { bareIsWrite: true })) {
      refs.push({ field: 'dockerOutputs', where: String(i), path: p, write });
    }
  });

  return refs;
}

/**
 * Lines already printed this process; a repeat drops to debug. Replicas and
 * reloads rebuild the same asset, and the same line N times is a storm.
 */
const warnedPassthroughs = new Set<string>();

/** Test seam; a process serves one assembly, so the set is per invocation. */
export function resetBuildKitPassthroughWarnings(): void {
  warnedPassthroughs.clear();
}

/**
 * Warn for each BuildKit passthrough whose host path leaves the assembly.
 *
 * `base` is the build context directory (what BuildKit resolves a relative
 * value against — the build's cwd); `bound` is the app's outdir. Called above
 * the spawn so the line precedes the read or write it describes.
 *
 * No "inside the build context" exemption is needed, unlike a builder that
 * honours an absolute context: `buildDockerImage` has already contained the
 * context within `bound`, so a path inside the context is inside the bound.
 */
export function warnEscapingBuildKitPaths(
  source: DockerImageAssetSource,
  base: string,
  bound: string
): void {
  const logger = getLogger().child('assets');
  for (const ref of hostPathsOf(source)) {
    const escape = assemblyPathEscape(base, bound, ref.path);
    if (escape === undefined) continue;
    const verb = ref.write ? 'WRITE to' : 'read';
    const line =
      `Docker asset ${ref.field}` +
      (ref.where === ref.field ? '' : `['${sanitizeServiceExceptionMessage(ref.where)}']`) +
      ` names a host path outside the assembly, which ` +
      renderAssemblyPathEscape(
        escape,
        bound,
        'load',
        `${getEmbedConfig().productName} will ${verb} it during the image build, matching ` +
          `the CDK CLI — a pre-synthesized assembly is trusted input. If you did not ` +
          `produce this assembly, that is a host path it chose and the CloudFormation ` +
          `template does not show.`
      );
    if (warnedPassthroughs.has(line)) {
      logger.debug(line);
      continue;
    }
    warnedPassthroughs.add(line);
    logger.warn(line);
  }
}
