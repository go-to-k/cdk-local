import { readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sanitizeServiceExceptionMessage } from '../local/credential-error.js';

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
 * EVERY path this module RENDERS goes through {@link displayUntrustedValue}, for
 * the reason the mitigation itself depends on: the warning and the refusal
 * exist FOR a hand-modified assembly, so the path is attacker-chosen and lands
 * on a log line. `path.resolve` preserves control characters, so an
 * unsanitized value can carry `\x1b[2K\r` and `\n` and erase the warning it
 * appears in, forging benign lines in its place; and a value carrying a quote
 * can close a boundary the message drew around it and write a clause of its
 * own. Since the decision here is "accept and WARN", a forgeable warning is no
 * warning at all. Same direction as `src/utils/role-arn.ts`, which already
 * reaches into `credential-error.ts` for the one spelling of the line rule.
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
  // WIN32 ONLY, and unreachable on POSIX: `path.relative` returns an absolute
  // path when the two sides share no root, which needs drive letters or a UNC
  // prefix. Kept because `path` is the PLATFORM's here, so this file is the
  // Windows verdict too.
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
 *
 * KNOW THAT EXHAUSTING THIS FAILS OPEN, and why that is accepted rather than
 * unnoticed. Unlike {@link MAX_LINK_HOPS}, which has the OS's own `ELOOP` cap
 * behind it, nothing else stops a path of 1 001 absent components: the climb
 * gives up, the symlink arm goes silent, and a value that would land outside
 * reads as CONTAINED on the lexical verdict alone. It is not reachable in
 * effect — such a path cannot exist, so `cdkl invoke`'s `existsSync` refuses it
 * and `start-api`'s `docker run` fails to mount it — but that safety lives in
 * the CONSUMERS, not here. A consumer that neither checks existence nor mounts
 * would need its own answer.
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
 * preceding component. That edge is benign for THESE callers rather than in
 * general: it needs the target to be absent, and both consumers resolve the
 * path and then open or mount it, so the divergence is between this model and
 * a path nothing can reach. A caller that CREATED a file through such a path
 * would need an `lstat` of its own.
 *
 * `EACCES` is folded into "does not resolve" along with `ENOENT`, so a link
 * under a directory this process cannot traverse reads as contained. Same
 * bound: the consumer's own `existsSync` / mount runs as the same user and
 * fails identically.
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
 * returns a verdict rather than throwing. The asset-MANIFEST readers that
 * honour an absolute value take the same verdict: `'honour-warn'` (the
 * start-cloudfront origin) warns when the value is a folder inside the user's
 * project not under a credential or version-control directory, and refuses
 * otherwise, `'honour'` (the soft-reload
 * sources) refuses (#745).
 *
 * It lives HERE so the containment rule has one spelling: it reuses this
 * module's own {@link isInside} and {@link resolveThroughLinks}, symlink arm
 * included, rather than letting a caller re-spell `path.relative` and drift.
 *
 * `bound` itself is NOT an escape, unlike in {@link resolveAssemblyPath},
 * where an empty `path.relative` means "names the directory rather than a file
 * inside it". An asset path legitimately names a DIRECTORY, so a value equal
 * to the bound is inside it and reporting it as outside would be false.
 *
 * THE REAL PATHS DECIDE IN BOTH DIRECTIONS, which is the one place this
 * deliberately does more than {@link resolveAssemblyPath}'s lexical-first
 * ordering. The lexical verdict here is about a SPELLING, and two spellings of
 * the same directory are common rather than exotic: macOS resolves `/tmp` to
 * `/private/tmp` and `/var` to `/private/var`, and a user may symlink `cdk.out`
 * itself. With an outdir of `/tmp/cdk.out` and a `--no-staging` value of
 * `/private/tmp/cdk.out/src`, a lexical-only verdict cries "pointing outside
 * the assembly ... treat this assembly as untrusted" about an asset that is
 * plainly inside it — and this arm exists to make an UNEXPECTED path visible,
 * so a false alarm is the failure that costs it its meaning.
 *
 * Exonerating requires the kernel to answer for BOTH operands: an unresolvable
 * one leaves the lexical verdict standing, so the arm stays loud when it cannot
 * see. (`resolveAssemblyPath` cannot take the same shape: its verdict is about
 * a path built with `path.join`, and letting a real path overrule the lexical
 * `..` there would answer about a location the caller never opens.)
 */
export function absoluteAssemblyPathEscape(
  bound: string,
  absolutePath: string
): AssemblyPathEscape | undefined {
  const resolvedBound = resolve(bound);
  const target = resolve(absolutePath);
  const lexicallyOutside = !isInside(resolvedBound, target) && target !== resolvedBound;

  const realBound = resolveThroughLinks(resolvedBound);
  const realTarget = resolveThroughLinks(target);
  const reallyOutside =
    realBound === undefined || realTarget === undefined
      ? undefined
      : !isInside(realBound, realTarget) && realTarget !== realBound;

  if (lexicallyOutside) {
    // `false` is the kernel saying the two spellings name the same place.
    // `undefined` is "could not look", which must not silence the arm.
    if (reallyOutside === false) return undefined;
    return { contained: false, escape: 'lexical', path: target };
  }
  if (reallyOutside === true) {
    return { contained: false, escape: 'symlink', path: target, realPath: realTarget! };
  }
  return undefined;
}

/**
 * Whether `candidate` names the SAME directory as `bound` — lexically, or
 * through a symbolic link on either side.
 *
 * An asset source legitimately names a DIRECTORY, so a value that resolves
 * onto the output directory itself is not an escape; but it hands the WHOLE
 * assembly to the sink, which is worth a line. A caller that re-spells this as
 * `resolve(a) === resolve(b)` misses every second spelling of the bound
 * (macOS `/tmp` vs `/private/tmp`, a symlinked `cdk.out`), and
 * {@link absoluteAssemblyPathEscape} exonerates exactly those spellings as
 * inside — so the equality beside it would stay silent for them.
 *
 * Conservative on failure: an unresolvable side answers from the lexical
 * comparison alone, so it can only say "not the same", never wrongly claim
 * identity.
 */
export function namesTheSameDirectory(bound: string, candidate: string): boolean {
  const resolvedBound = resolve(bound);
  const target = resolve(candidate);
  if (target === resolvedBound) return true;
  const realBound = resolveThroughLinks(resolvedBound);
  const realTarget = resolveThroughLinks(target);
  return realBound !== undefined && realTarget !== undefined && realBound === realTarget;
}

/**
 * The escape verdict for an assembly-supplied path WITHOUT throwing, taking
 * whichever arm the value's own shape calls for: {@link absoluteAssemblyPathEscape}
 * for an absolute value, {@link resolveAssemblyPath} for a relative one.
 *
 * For a caller that only WARNS and has many values to judge — the BuildKit
 * passthroughs in `src/assets/buildkit-passthrough-warnings.ts`. `base` is what
 * a relative value resolves against, `bound` what it must stay inside.
 * Returns `undefined` when the value is fine, including when it names `bound`
 * itself ({@link namesTheSameDirectory}).
 */
export function assemblyPathEscape(
  base: string,
  bound: string,
  candidate: string
): AssemblyPathEscape | undefined {
  if (isAbsolute(candidate)) return absoluteAssemblyPathEscape(bound, candidate);
  const resolved = resolveAssemblyPath(base, candidate, { containWithin: bound });
  if (resolved.contained || namesTheSameDirectory(bound, resolved.path)) return undefined;
  return resolved;
}

/**
 * The shared tail of a containment refusal: what the value resolved to, what
 * it escaped, and why that means the assembly is not CDK-generated. The call
 * site supplies its own subject ("Lambda 'X' has ... which ") and its own
 * error class. `action` completes "Refusing to ..." and is REQUIRED rather
 * than defaulted: a default is a branch no caller takes, so it can neither be
 * fenced nor be right for the next caller.
 *
 * `provenanceOverride` replaces that whole closing sentence for a caller that
 * does NOT refuse — the BuildKit passthrough warnings, where "Refusing to ..."
 * would be a false statement about a value that is forwarded anyway.
 */
export function renderAssemblyPathEscape(
  escape: AssemblyPathEscape,
  dir: string,
  action: string,
  provenanceOverride?: string
): string {
  const provenance =
    provenanceOverride ??
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
  // Every rendered operand is attacker-chosen; see this module's header for
  // why each goes through `displayUntrustedValue`, with no quotes of ours.
  const shownPath = displayUntrustedValue(escape.path);
  const shownBase = displayUntrustedValue(base);
  if (escape.escape === 'symlink') {
    if (escape.realPath === realBase) {
      return (
        `resolves to ${shownPath}, a symbolic link to the directory ` +
        `${shownBase} itself rather than to a path inside it. ${provenance}`
      );
    }
    return (
      `resolves to ${shownPath}, which leads through a symbolic link to ` +
      `${displayUntrustedValue(escape.realPath)}, outside ${shownBase}. ${provenance}`
    );
  }
  if (escape.path === base) {
    return `names the directory ${shownBase} itself rather than a path inside it. ${provenance}`;
  }
  return `resolves to ${shownPath}, outside ${shownBase}. ${provenance}`;
}

/**
 * A letter or digit that neither draws as a blank nor reads as a quote.
 * `\p{L}` alone admits both, so two classes are carved out: the
 * default-ignorables, which hold letters that draw as a blank (the Hangul
 * fillers U+3164 and U+FFA0), and the quote-shaped letters — the Spacing
 * Modifier Letters block (U+02BA reads as `"`, U+02BC as `'`) plus the ones
 * outside it (U+0374, U+0559, U+07F4-U+07F5, U+A78B-U+A78C, and the halfwidth
 * sound marks U+FF9E-U+FF9F). Not all of `\p{Lm}`: U+30FC is in it, and it is
 * an ordinary character of a Japanese directory name.
 */
const VISIBLE_LETTER = new RegExp(
  String.raw`^(?![\p{Default_Ignorable_Code_Point}\u02b0-\u02ff\u0374\u0559\u07f4\u07f5\ua78b\ua78c\uff9e\uff9f])[\p{L}\p{N}]$`,
  'u'
);

/**
 * A combining mark, which counts only DIRECTLY after a visible letter (or a
 * mark that itself counted): on a space or on punctuation it draws on its own,
 * and U+030B / U+030E there look like a quote.
 */
const COMBINING_MARK = /^\p{M}$/u;

/**
 * A default-ignorable code point, which draws as NOTHING. Tested before the
 * mark rule, because some are combining marks (U+034F, U+17B4, U+180B, the
 * variation selectors U+FE00-U+FE0F and U+E0100-U+E01EF): after a letter they
 * would otherwise pass as bare, and `/home/me/.ss\u034fh` would print exactly
 * like `.ssh` while naming a different path. The host's classifier
 * (go-to-k/cdkd#3509) does not carve these out; this one does.
 */
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/**
 * The ASCII a bare value may carry besides letters and digits. Everything else
 * — any whitespace, any quote, any other symbol — takes the boundary, which
 * costs a legitimate path nothing but a pair of quotes.
 */
const BARE_PUNCTUATION = /^[/\\._~+@:=-]$/;

/**
 * Classify each code point: `bare` (allowed in a bare value), `shown` (shown
 * as itself inside the boundary), or `escaped`. An ALLOWLIST, because a
 * denylist has to enumerate every character that draws as a blank or reads as
 * a quote.
 *
 * Each test is ONE character and this walks the value — never `^(...)+$` over
 * the whole of it: alternatives that overlap under a quantifier backtrack
 * exponentially on a long value that fails near its end.
 */
function classify(chars: readonly string[]): Array<'bare' | 'shown' | 'escaped'> {
  let afterLetter = false;
  return chars.map((ch) => {
    if (DEFAULT_IGNORABLE.test(ch)) {
      afterLetter = false;
      return 'escaped';
    }
    if (COMBINING_MARK.test(ch)) return afterLetter ? 'bare' : 'escaped';
    afterLetter = VISIBLE_LETTER.test(ch);
    if (afterLetter || BARE_PUNCTUATION.test(ch)) return 'bare';
    return ch >= ' ' && ch <= '~' ? 'shown' : 'escaped';
  });
}

/**
 * Render an untrusted value — a filesystem path, identifier or command an
 * assembly chose, or a key a request supplied — into cdk-local's own prose
 * (go-to-k/cdk-local#758; the host's `displayAssemblyPath`, go-to-k/cdkd#3509).
 * The caller writes NO quotes around the result.
 *
 * `sanitizeServiceExceptionMessage` alone is not enough inside quotes of ours:
 * it flattens control characters and passes `'`, so a value carrying one
 * closed the quote and wrote a clause of its own into the message. This keeps
 * a plain value bare and puts any other one inside a JSON string literal.
 * Inside it, `"` and `\` are escaped as JSON escapes them, and so is every
 * character that is neither printable ASCII nor a visible letter — a curly or
 * fullwidth quote that could pass for the boundary's own closing `"`, and a
 * blank that could pass for a space. The result stays valid JSON: `JSON.parse`
 * returns the sanitized value.
 *
 * A legitimate value with a space or any symbol outside `/ \ . _ ~ + @ : = -`
 * (`/Users/me/My Project/cdk.out`) renders quoted; a non-ASCII letter is
 * shown as itself, and a non-letter non-ASCII character (an emoji, `©`) as
 * its `\u` escape. A value the sanitizer ALTERED (a control character
 * flattened, an over-long value truncated) did not arrive plain, so it always
 * takes the boundary. The empty string renders as `""`.
 *
 * The sanitizer also CAPS the value at 512 code points, so a longer path
 * prints truncated (inside the boundary, with its true length named). That
 * is deliberate: an unbounded assembly-chosen value would otherwise make the
 * log line as long as the attacker likes, and a real path is far shorter.
 */
export function displayUntrustedValue(value: string): string {
  const clean = sanitizeServiceExceptionMessage(value);
  // `Array.from` walks CODE POINTS, so a lone surrogate arrives alone and is
  // escaped rather than shown.
  const chars = Array.from(clean);
  const kinds = classify(chars);
  if (clean === value && chars.length > 0 && kinds.every((k) => k === 'bare')) return clean;
  let body = '';
  chars.forEach((ch, i) => {
    if (ch === '"' || ch === '\\') body += `\\${ch}`;
    else if (kinds[i] !== 'escaped') body += ch;
    else {
      for (let u = 0; u < ch.length; u++) {
        body += `\\u${ch.charCodeAt(u).toString(16).padStart(4, '0')}`;
      }
    }
  });
  return `"${body}"`;
}
