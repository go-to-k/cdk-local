import { isAbsolute, resolve } from 'node:path';
import { sanitizeServiceExceptionMessage } from '../local/credential-error.js';
import { getEmbedConfig } from '../local/embed-config.js';
import {
  absoluteAssemblyPathEscape,
  namesTheSameDirectory,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../utils/assembly-path.js';
import { getLogger } from '../utils/logger.js';

/**
 * Containment for a path an ASSET MANIFEST names (go-to-k/cdk-local#745).
 *
 * `<stack>.assets.json` is written by whoever wrote the assembly, and its
 * `files[*].source.path` / `dockerImages[*].source.directory` become things
 * cdk-local READS: a Docker build context (every container build reaches
 * `buildDockerImage`), the working directory of a `source.executable`, the
 * directory `start-cloudfront` serves as an S3 origin, the source tree an
 * AgentCore code bundle is built from, and the directory a `--watch` soft
 * reload `docker cp`s into a running container. Each used to be a raw join, so
 * `../../..` reached any directory on the host.
 *
 * One function, so the sites cannot disagree about the rule. What they DO
 * differ in is how their own join treats an ABSOLUTE value, and each site
 * states that through {@link AssetSourcePathOptions.absolute}: a value is
 * judged as the path the sink will really open, never as some other spelling.
 *
 * The bound is the app's OUTDIR (`assetPathDirs(stack).assetOutdir`), never the
 * manifest's own directory: a `cdk.Stage` stages its assets one level above its
 * manifest, so CDK itself writes `../asset.<hash>` there. See
 * `resolveAssemblyPath`'s `containWithin` note for why the bound must be the
 * user's directory and never an assembly-supplied one.
 */
export interface AssetSourcePathOptions {
  /** Where a relative value resolves FROM — the manifest's directory. */
  manifestDir: string;
  /** The manifest-supplied value. Attacker-chosen under a hand-modified assembly. */
  value: string;
  /** The containment bound: the app's outdir. */
  assetOutdir: string;
  /**
   * How the SINK joins an absolute value, which decides how it is judged:
   *
   * - `'fold'` — the sink concatenates or `path.join`s, which does NOT honour a
   *   leading separator, so `/etc` lands at `<manifestDir>/etc`. The leading
   *   separators are stripped and the remainder takes the relative arm.
   *   `buildDockerImage` (string concatenation) and the AgentCore code
   *   bundle's `getAssetSourcePath` (`path.join`) are these.
   * - `'honour'` — the sink `path.resolve`s, so an absolute value is used as
   *   written. It is judged as the absolute path it is and REFUSED outside the
   *   bound, not warned about: the start-cloudfront S3 origin and the `--watch`
   *   soft-reload source are these.
   */
  absolute: 'fold' | 'honour';
  /** The manifest field, for the message. */
  field: 'source.path' | 'source.directory';
  /** Subject clause, already safe to print (e.g. `Docker image asset`). */
  subject: string;
  /** Completes "Refusing to ...". */
  action: string;
  /** Completes "<product> will ..." in the whole-assembly warning. */
  sink: string;
  /** The call site's own error class. */
  wrapError: (message: string) => Error;
}

/**
 * Resolve a manifest-supplied asset path and REFUSE it when it leaves the
 * app's outdir — lexically, or through a symbolic link.
 *
 * Returns the RESOLVED, normalized absolute path, and callers must use THAT
 * rather than re-joining the raw value. It matters for the kernel: a raw
 * `<dir>/sub/link/..` handed to the OS applies `..` AFTER following `link`,
 * while every lexical model folds it first. Opening the normalized path makes
 * the judged path and the opened path the same string, so the `<link>/..`
 * shape has no second reading left to exploit.
 *
 * Naming the bound ITSELF (`.`, or `..` from a Stage manifest) is accepted —
 * an asset source is a directory by design, and the absolute arm treats the
 * bound as inside, so the two arms must agree — but it is WARNED about,
 * because it hands the whole assembly to the sink.
 */
export function resolveAssetSourcePath(opts: AssetSourcePathOptions): string {
  const { manifestDir, value, assetOutdir, field, subject, action, wrapError } = opts;
  const shownValue = sanitizeServiceExceptionMessage(value);

  if (isAbsolute(value) && opts.absolute === 'honour') {
    const absolute = resolve(value);
    const escape = absoluteAssemblyPathEscape(assetOutdir, absolute);
    if (escape !== undefined) {
      throw wrapError(
        `${subject} has an absolute ${field}='${shownValue}' which ` +
          `${renderAssemblyPathEscape(escape, assetOutdir, action)} ` +
          `(cdk synth --no-staging writes absolute asset paths; ` +
          `${getEmbedConfig().productName} uses only assets staged inside the assembly here, ` +
          `so re-synthesize without it.)`
      );
    }
    if (namesTheSameDirectory(assetOutdir, absolute)) {
      warnWholeAssemblyAsSource(opts, absolute);
    }
    return absolute;
  }

  // `'fold'`, or a relative value: the sink joins it under `manifestDir`.
  // Stripping the leading separators is exactly what `path.join` and a
  // `${a}/${b}` concatenation do to an absolute value, so the verdict is about
  // the path the sink opens.
  const relative = isAbsolute(value) ? value.replace(/^[/\\]+/, '') : value;
  const resolved = resolveAssemblyPath(manifestDir, relative, { containWithin: assetOutdir });
  if (resolved.contained) return resolved.path;
  // "IS the bound", not "lands inside it": with `<parent>/back -> cdk.out`, a
  // value of `../back` is accepted and warned, while `../back/asset.abc` is
  // still refused although it too lands inside the assembly. Fail-closed;
  // re-deciding containment through links for every value is
  // `resolveAssemblyPath`'s job, not this arm's.
  if (namesTheSameDirectory(assetOutdir, resolved.path)) {
    warnWholeAssemblyAsSource(opts, resolved.path);
    return resolved.path;
  }
  throw wrapError(
    `${subject} has ${field}='${shownValue}' which ` +
      renderAssemblyPathEscape(resolved, assetOutdir, action)
  );
}

/**
 * Whole-assembly lines already printed this process. A `start-service` with
 * `DesiredCount: 3` builds per replica and again per crash-loop restart, so an
 * undeduped line is a storm, and a storm is not read. Repeats drop to debug;
 * the WORK is never deduped.
 */
const warnedWholeAssembly = new Set<string>();

/** Test seam; a process serves one assembly, so the set is per invocation. */
export function resetWholeAssemblyWarnings(): void {
  warnedWholeAssembly.clear();
}

function warnWholeAssemblyAsSource(opts: AssetSourcePathOptions, outdir: string): void {
  const logger = getLogger().child('assets');
  const line =
    `${opts.subject} has ${opts.field} naming the assembly's output directory ITSELF: ` +
    `'${sanitizeServiceExceptionMessage(outdir)}'. ${getEmbedConfig().productName} will ` +
    `${opts.sink} — that is the WHOLE assembly, every template and every staged asset, ` +
    `not one asset directory. No CDK synth emits this, so treat this assembly as ` +
    `untrusted unless you wrote that path yourself.`;
  if (warnedWholeAssembly.has(line)) {
    logger.debug(line);
    return;
  }
  warnedWholeAssembly.add(line);
  logger.warn(line);
}
