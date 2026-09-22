import { readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Containment for a path a Cloud Assembly names.
 *
 * A Lambda's `Metadata['aws:asset:path']` is a string chosen by whoever WROTE
 * the assembly. `cdkl invoke -a <dir>` / `cdkl start-api -a <dir>` consume a
 * PRE-SYNTHESIZED assembly with no CDK subprocess in between, so nothing
 * upstream validates it, and the value ends up as a read-only BIND MOUNT at
 * `/var/task` (or `/opt` for a layer) in a container running handler code the
 * same assembly supplied.
 *
 * `path.join` does NOT honour a leading separator, so an ABSOLUTE value stays
 * inside the directory (`join('/tmp/cdk.out', '/abs/foo')` is
 * `/tmp/cdk.out/abs/foo`). The shape that leaves it is `..`:
 * `join('/tmp/cdk.out', '../../victim')` resolves outside the assembly. That
 * asymmetry is why {@link absoluteAssemblyPathEscape} exists beside
 * {@link resolveAssemblyPath} rather than falling out of it.
 *
 * An import-free LEAF, so any layer may import it.
 */

export type ResolvedAssemblyPath =
  | {
      readonly contained: true;
      /** The path the caller should use — what `path.join` would have produced. */
      readonly path: string;
    }
  | {
      readonly contained: false;
      readonly escape: 'lexical';
      /** The lexically resolved path, for the refusal message. */
      readonly path: string;
    }
  | {
      readonly contained: false;
      readonly escape: 'symlink';
      readonly path: string;
      /** Where the symbolic link(s) actually lead. */
      readonly realPath: string;
    };

export type AssemblyPathEscape = Extract<ResolvedAssemblyPath, { contained: false }>;

/**
 * `true` when `candidate` names something strictly beneath `base`, both given
 * as already-resolved absolute paths.
 *
 * The `..` test is SEPARATOR-AWARE rather than a bare `startsWith('..')`,
 * which would also reject a legitimate sibling named `..foo`. The empty-string
 * case is `base` itself; callers decide whether that counts as an escape,
 * because an asset path legitimately names a DIRECTORY while a template path
 * does not.
 */
function isInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  if (rel === '' || rel === '..') return false;
  if (rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

/**
 * `realpath(3)`, or `undefined` for a path that does not fully resolve.
 *
 * `.native` is load-bearing and must not be simplified to `fs.realpathSync`.
 * The plain form is a JavaScript walker that folds `..` LEXICALLY, so it
 * disagrees with the kernel on a target carrying a `..` after a symlinked
 * component — answering `ENOENT` for a path the kernel resolves, and on a
 * case-insensitive filesystem (APFS by default) it can spin on the same shape.
 * `.native` is libuv's `realpath(3)` and throws the same
 * `ENOENT` / `ELOOP` / `EACCES`.
 */
function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** `fs.readlinkSync`, or `undefined` when `p` is not a symbolic link. */
function tryReadlink(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Link follows before the walk gives up and reports the path as unresolvable.
 * It does NOT refuse: an exhausted budget answers `undefined`, which leaves
 * the symlink arm silent and the lexical verdict standing. Safe because the OS
 * gives up first (macOS caps at 32, `ELOOP`), so a chain that reaches this cap
 * is one nothing can open anyway.
 */
const MAX_LINK_HOPS = 40;

/**
 * Unresolvable path COMPONENTS the climb walks before giving up. Bounds the
 * recursion below, which is one frame per component, so a pathological value
 * cannot raise a `RangeError` from inside {@link tryRealpath}'s own `try` (its
 * `catch` would swallow the crash into a silent `undefined`).
 */
const MAX_PATH_COMPONENTS = 1000;

/**
 * Where `target` REALLY points, for a path that may not exist yet.
 *
 * `realpathSync` answers only for a path that fully resolves, and it throws
 * `ENOENT` for a DANGLING symbolic link exactly as it does for an absent file.
 * `cdkl start-api` resolves an asset path without an existence check, so an
 * absent or dangling component must not silence the symlink arm.
 *
 * Each unresolvable component is therefore handled by hand: climb to the
 * deepest ancestor that DOES resolve, then re-apply the remaining components,
 * following any symbolic link with `readlink` and re-resolving its target.
 * `undefined` means the walk could not resolve the path at all.
 *
 * For a path that FULLY RESOLVES the answer is the kernel's and is exact. For
 * one that does not exist yet this is a best-effort MODEL of kernel
 * resolution; the known edge is a `..` INSIDE an unresolvable link's target,
 * folded lexically here while the kernel folds it only after following each
 * preceding component.
 */
function resolveThroughLinks(target: string, hops = 0, climbs = 0): string | undefined {
  const direct = tryRealpath(target);
  if (direct !== undefined) return direct;
  if (hops >= MAX_LINK_HOPS) return undefined;
  if (climbs >= MAX_PATH_COMPONENTS) return undefined;

  const parent = dirname(target);
  // `dirname` is idempotent at a root, which `realpathSync` above would have
  // resolved — so reaching here means there is nothing left to climb.
  if (parent === target) return undefined;

  // The climb costs no hop: `hops` bounds the LINK chain, and a deep path of
  // absent components is not one.
  const realParent = resolveThroughLinks(parent, hops, climbs + 1);
  if (realParent === undefined) return undefined;

  const link = tryReadlink(target);
  if (link === undefined) {
    // The component simply does not exist. Whatever lives there lands under
    // the real parent.
    return join(realParent, basename(target));
  }
  // A link whose target does not resolve yet: follow it by hand, relative to
  // the directory the link REALLY lives in (`realParent`, not
  // `dirname(target)`) — a target with a leading `..` folds against the real
  // directory, and folding it against the lexical parent reads an escape as
  // contained.
  return resolveThroughLinks(resolve(realParent, link), hops + 1, climbs);
}

/**
 * Resolve an assembly-supplied `candidate` against `dir` and report whether
 * the result stays inside it.
 *
 * The lexical arm joins exactly the way the call sites used to (`path.join`,
 * NOT `path.resolve`), so the verdict is about the path the caller will
 * actually use. `join`'s handling of an absolute candidate makes this arm
 * strictly more permissive than a `resolve`-based one would be; an absolute
 * value is therefore answered by {@link absoluteAssemblyPathEscape} instead,
 * because this function structurally cannot.
 *
 * The SYMLINK arm exists because the lexical arm alone leaves an equivalent
 * hole: `cdk.out/link -> /etc` plus a candidate of `link/passwd` is lexically
 * contained and still reaches `/etc/passwd`. Both sides go through
 * {@link resolveThroughLinks}, so an assembly directory REACHED through a link
 * (macOS spells `/tmp` as `/private/tmp`) is unaffected.
 *
 * The verdict is about the assembly AS IT SITS ON DISK. It is NOT a defence
 * against a process rewriting that directory concurrently — the caller uses
 * the path after this returns.
 */
export function resolveAssemblyPath(
  dir: string,
  candidate: string,
  options?: {
    /**
     * Contain within THIS directory instead of `dir`.
     *
     * A value still RESOLVES against `dir` — that part is the caller's own
     * `path.join` and must not change — but the containment test runs against
     * a wider root. The one case is an asset path below a `cdk.Stage`:
     * `cdk synth` stages a Stage's assets into the APP's outdir while the
     * Stage's manifest sits in `cdk.out/assembly-<Stage>/`, so upstream emits
     * `../asset.<hash>` by design.
     *
     * This widens the BASE, never the RULE: `path.relative` must still be
     * non-empty, non-`..`-prefixed and relative, so `../../victim` is refused
     * from a Stage manifest exactly as from a top-level one.
     *
     * `containWithin` must never carry an assembly-supplied value; it is the
     * user's own outdir. A WRONG bound is not uniformly safe — a DISJOINT one
     * refuses everything, but an ANCESTOR of the real one WIDENS
     * (`containWithin: '/'` admits `/etc/passwd`).
     */
    containWithin?: string;
  }
): ResolvedAssemblyPath {
  const base = resolve(dir);
  const bound = options?.containWithin === undefined ? base : resolve(options.containWithin);
  const joined = resolve(join(base, candidate));

  if (!isInside(bound, joined)) {
    return { contained: false, escape: 'lexical', path: joined };
  }

  // The same resolver on the bound, so an assembly directory that is itself
  // reached through a link does not make every candidate look like an escape.
  const realBound = resolveThroughLinks(bound);
  if (realBound !== undefined) {
    const realTarget = resolveThroughLinks(joined);
    if (realTarget !== undefined && !isInside(realBound, realTarget)) {
      return { contained: false, escape: 'symlink', path: joined, realPath: realTarget };
    }
  }

  return { contained: true, path: joined };
}

/**
 * Whether an ALREADY-ABSOLUTE assembly-supplied path lies outside `bound`.
 *
 * {@link resolveAssemblyPath} cannot answer this, and the reason is structural
 * rather than an oversight: its lexical arm joins with `path.join`, which does
 * NOT honour a leading separator, so an absolute candidate is folded INTO the
 * directory and the verdict would describe a path no caller opens. A site that
 * HONOURS an absolute value needs the verdict about the value itself.
 *
 * The callers are `cdkl invoke`'s and `cdkl start-api`'s
 * `Metadata['aws:asset:path']` resolution. Those honour an absolute path
 * because `cdk synth --no-staging` emits one — CDK writes the asset's absolute
 * SOURCE directory under `aws:cdk:disable-asset-staging`, usually outside the
 * outdir — and they WARN rather than refuse when it leaves the bound, so this
 * returns a verdict rather than throwing.
 *
 * It lives HERE so the containment rule has one spelling: it reuses this
 * module's own {@link isInside} and {@link resolveThroughLinks}, symlink arm
 * included, rather than letting a caller re-spell `path.relative` and drift.
 *
 * `bound` itself is NOT an escape, unlike in {@link resolveAssemblyPath},
 * where an empty `path.relative` means "names the directory rather than a file
 * inside it". An asset path legitimately names a DIRECTORY, so a value equal
 * to the bound is inside it and reporting it as outside would be false.
 */
export function absoluteAssemblyPathEscape(
  bound: string,
  absolutePath: string
): AssemblyPathEscape | undefined {
  const resolvedBound = resolve(bound);
  const target = resolve(absolutePath);

  if (!isInside(resolvedBound, target) && target !== resolvedBound) {
    return { contained: false, escape: 'lexical', path: target };
  }

  const realBound = resolveThroughLinks(resolvedBound);
  if (realBound !== undefined) {
    const realTarget = resolveThroughLinks(target);
    if (realTarget !== undefined && !isInside(realBound, realTarget) && realTarget !== realBound) {
      return { contained: false, escape: 'symlink', path: target, realPath: realTarget };
    }
  }
  return undefined;
}

/**
 * The shared tail of a containment refusal: what the value resolved to, what
 * it escaped, and why that means the assembly is not CDK-generated. The call
 * site supplies its own subject ("Lambda 'X' has ... which ") and its own
 * error class. `action` completes "Refusing to ...".
 */
export function renderAssemblyPathEscape(
  escape: AssemblyPathEscape,
  dir: string,
  action = 'load'
): string {
  const provenance =
    `CDK emits assembly paths that stay inside the assembly directory; one that leaves it ` +
    `indicates the synth output was hand-modified or generated by a non-CDK toolchain. ` +
    `Refusing to ${action}.`;
  const base = resolve(dir);
  // The SYMLINK arm compares against the base as the KERNEL sees it, because
  // that is what `escape.realPath` is. With `-a /tmp/cdk.out` on macOS
  // (`/tmp -> /private/tmp`) a link to the directory itself would otherwise
  // print "outside '/tmp/cdk.out'", a false clause about a path that IS the
  // directory.
  const realBase = resolveThroughLinks(base) ?? base;
  if (escape.escape === 'symlink') {
    if (escape.realPath === realBase) {
      return (
        `resolves to '${escape.path}', a symbolic link to the directory ` +
        `'${base}' itself rather than to a path inside it. ${provenance}`
      );
    }
    return (
      `resolves to '${escape.path}', which leads through a symbolic link to ` +
      `'${escape.realPath}', outside '${base}'. ${provenance}`
    );
  }
  if (escape.path === base) {
    return `names the directory '${base}' itself rather than a path inside it. ${provenance}`;
  }
  return `resolves to '${escape.path}', outside '${base}'. ${provenance}`;
}
