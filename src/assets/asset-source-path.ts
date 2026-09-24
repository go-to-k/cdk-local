import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sanitizeServiceExceptionMessage } from '../local/credential-error.js';
import { getEmbedConfig } from '../local/embed-config.js';
import {
  type AssemblyPathEscape,
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
   *   leading separator, so `/etc` lands at `<manifestDir>/etc` and is judged
   *   there, by the relative arm.
   *   `buildDockerImage` (string concatenation) and the AgentCore code
   *   bundle's `getAssetSourcePath` (`path.join`) are these.
   * - `'honour'` — the sink `path.resolve`s, so an absolute value is used as
   *   written. It is judged as the absolute path it is and REFUSED outside the
   *   bound. The `--watch` soft-reload source of a container image is this: its
   *   boot build FOLDS an absolute value (`'fold'`), so a real
   *   `cdk synth --no-staging` assembly never boots a container to reload,
   *   and accepting the value would serve only a hostile layout.
   * - `'honour-warn'` — as `'honour'`, but an absolute value outside the bound
   *   (lexically or through a symlink) may be ACCEPTED WITH A WARNING naming
   *   it: `cdk synth --no-staging` writes exactly this shape, and here it is
   *   usable — the same decision as `Metadata['aws:asset:path']` (#744). Only
   *   when it is a PROJECT folder, though (see {@link originScopeRefusal}):
   *   its real path must lie inside a project root (the cwd, or the git work
   *   tree holding the outdir) with no `.`-prefixed component in between, and
   *   it must not be `/`, the home directory or an ancestor of either the home
   *   directory or the outdir. Anything else is refused. The start-cloudfront
   *   S3 origin is this.
   */
  absolute: 'fold' | 'honour' | 'honour-warn';
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
 * app's outdir — lexically, or through a symbolic link. The one exception is
 * an ABSOLUTE value under `'honour-warn'`, which is ACCEPTED with a warning
 * when it is a non-hidden folder inside the user's project, and refused
 * otherwise (see {@link AssetSourcePathOptions.absolute}).
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

  if (isAbsolute(value) && opts.absolute !== 'fold') {
    const absolute = resolve(value);
    const escape = absoluteAssemblyPathEscape(assetOutdir, absolute);
    if (escape !== undefined && opts.absolute === 'honour') {
      throw wrapError(
        `${subject} has an absolute ${field}='${shownValue}' which ` +
          renderAssemblyPathEscape(escape, assetOutdir, action)
      );
    }
    if (escape !== undefined) {
      // `'honour-warn'` (maintainer decisions on #755's follow-ups): ACCEPTED
      // with a warning only as a `cdk synth --no-staging` source folder — a
      // non-hidden directory inside the user's project. Anything else hands a
      // host directory the assembly chose to the reader, and is refused.
      const refusal = originScopeRefusal(absolute, assetOutdir);
      if (refusal !== undefined) {
        throw wrapError(
          `${subject} has an absolute ${field}='${shownValue}' which ${refusal}. ` +
            `An absolute ${field} is accepted only as a cdk synth --no-staging source ` +
            `folder: a non-hidden directory inside your project (the current directory, ` +
            `or the git work tree holding the output directory). Refusing to ${action}.`
        );
      }
      warnAbsoluteOutsideAssembly(opts, absolute, escape);
      return absolute;
    }
    if (namesTheSameDirectory(assetOutdir, absolute)) {
      warnWholeAssemblyAsSource(opts, absolute);
    }
    return absolute;
  }

  // `'fold'`, or a relative value: the sink joins it under `manifestDir`.
  // `resolveAssemblyPath` joins with `path.join`, which folds an absolute value
  // exactly as `path.join` and a `${a}/${b}` concatenation do, so the verdict
  // is about the path the sink opens.
  const resolved = resolveAssemblyPath(manifestDir, value, { containWithin: assetOutdir });
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
 * Why an accepted-absolute root is too broad to be a `--no-staging` source, or
 * `undefined`. `root` is already a real path ({@link realPath}); the other
 * sides are resolved the same way, so a link to `/` or to `$HOME` is the same
 * root:
 *
 * - `/` — the whole filesystem;
 * - the user's home directory (`os.homedir()`) or any ANCESTOR of it
 *   (`/Users`, `/home`) — each contains `~/.aws` / `~/.ssh`; a project folder
 *   UNDER home is fine. The ancestor arm matters when the project is not under
 *   home (`/tmp`, `/workspaces`), where the outdir arm does not cover it;
 * - an ANCESTOR of the app's outdir, which contains the assembly and
 *   everything beside it.
 */
function broadRootReason(root: string, assetOutdir: string): string | undefined {
  if (root === resolve('/')) return 'names the filesystem root';
  if (containsOrIs(root, realPath(homedir()))) {
    return 'names your home directory or a directory containing it';
  }
  if (containsOrIs(root, realPath(assetOutdir))) {
    return "names a directory containing the app's output directory";
  }
  return undefined;
}

/**
 * Why an `'honour-warn'` absolute root is refused, or `undefined` to accept it
 * with the warning. Every comparison is on REAL paths, so a symlink whose
 * target leaves the project is refused however it is spelled.
 *
 * 1. {@link broadRootReason} — roots no `--no-staging` source can be.
 * 2. The root must lie STRICTLY inside a project root
 *    ({@link projectRoots}), and no path component between that project root
 *    and the origin may begin with `.` — so `.git`, `.aws`, `.ssh` inside the
 *    repo are refused. A monorepo sibling
 *    (`<repo>/packages/web/dist` beside `<repo>/packages/infra/cdk.out`) is
 *    inside the git work tree and accepted.
 */
function originScopeRefusal(absolute: string, assetOutdir: string): string | undefined {
  const root = realPath(absolute);
  const broad = broadRootReason(root, assetOutdir);
  if (broad !== undefined) return broad;
  const projects = projectRoots(assetOutdir);
  let hidden: string | undefined;
  let isProjectRoot = false;
  for (const project of projects) {
    const rel = relative(project, root);
    if (rel === '') isProjectRoot = true;
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const dotted = rel.split(sep).find((c) => c.startsWith('.'));
    if (dotted === undefined) return undefined;
    hidden = dotted;
  }
  if (isProjectRoot) {
    return 'is your project root itself; name a folder inside it';
  }
  if (hidden !== undefined) {
    return `passes through the hidden directory '${sanitizeServiceExceptionMessage(hidden)}' inside your project`;
  }
  const shown = projects.map((p) => `'${sanitizeServiceExceptionMessage(p)}'`).join(' or ');
  return projects.length === 0
    ? 'is outside any usable project root (the current directory and the git work tree are too broad to scope it)'
    : `resolves to '${sanitizeServiceExceptionMessage(root)}', outside your project (${shown})`;
}

/**
 * The directories an accepted absolute origin may live in: the process cwd,
 * and the nearest ancestor of the outdir holding a `.git` entry (a directory,
 * or a FILE in a linked worktree / submodule). Both real paths; `git` is not
 * spawned. A candidate that is `/`, the home directory or an ancestor of it
 * is DROPPED rather than used — running from `~` must not widen the scope to
 * all of home.
 */
function projectRoots(assetOutdir: string): string[] {
  const roots: string[] = [];
  const usable = (p: string): boolean =>
    p !== resolve('/') && !containsOrIs(p, realPath(homedir()));
  const cwd = realPath(process.cwd());
  if (usable(cwd)) roots.push(cwd);
  let dir = realPath(assetOutdir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      if (usable(dir) && !roots.includes(dir)) roots.push(dir);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** `outer` is `inner` itself or an ancestor of it (both real paths). */
function containsOrIs(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * `realpath(3)` of `p`, or — when `p` does not exist — the real path of its
 * deepest existing ancestor with the rest re-appended, so a not-yet-existing
 * path under a symlinked parent (`/tmp` -> `/private/tmp`) compares in the
 * same spelling as its existing neighbours. A DANGLING link component is
 * followed by hand (`readlink`), so `project/site -> /outside/missing` is
 * judged as `/outside/missing` — the place a later-created target would be
 * served from — not as `project/site`.
 */
function realPath(p: string, hops = 0): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    const realParent = realPath(parent, hops);
    let link: string | undefined;
    try {
      link = readlinkSync(abs);
    } catch {
      link = undefined;
    }
    // The hop cap mirrors the OS's own `ELOOP` limit; past it the path cannot
    // be opened anyway.
    if (link !== undefined && hops < 40) return realPath(resolve(realParent, link), hops + 1);
    return join(realParent, basename(abs));
  }
}

/**
 * Absolute-outside lines already printed this process (deduped for the same
 * reason as {@link warnedWholeAssembly}).
 */
const warnedAbsoluteOutside = new Set<string>();

function warnAbsoluteOutsideAssembly(
  opts: AssetSourcePathOptions,
  absolute: string,
  escape: AssemblyPathEscape
): void {
  const logger = getLogger().child('assets');
  const line =
    `${opts.subject} has an absolute ${opts.field} pointing outside the assembly: ` +
    `'${sanitizeServiceExceptionMessage(absolute)}'` +
    (escape.escape === 'symlink'
      ? ` (through a symbolic link to '${sanitizeServiceExceptionMessage(escape.realPath)}')`
      : '') +
    `. ${getEmbedConfig().productName} will ${opts.sink}. ` +
    // The `--no-staging` sentence only where that flag is a plausible cause:
    // no CDK synth writes an absolute path INSIDE the outdir that a link
    // carries out.
    (escape.escape === 'lexical'
      ? `This is what cdk synth --no-staging emits, and is expected for it; if you ` +
        `did not synthesize with that flag, treat this assembly as untrusted.`
      : `No CDK synth writes this, so treat this assembly as untrusted unless you ` +
        `made that link yourself.`);
  if (warnedAbsoluteOutside.has(line)) {
    logger.debug(line);
    return;
  }
  warnedAbsoluteOutside.add(line);
  logger.warn(line);
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
  warnedAbsoluteOutside.clear();
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
