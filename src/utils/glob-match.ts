/**
 * Minimal, linear-time glob matcher for `cdk.json` `watch.include` /
 * `watch.exclude` patterns (used by `cdkl start-api --watch` source-tree
 * watching).
 *
 * chokidar v4 dropped built-in glob support, so the watcher matches the
 * cdk.json watch globs here. Supported syntax (the subset CDK's own
 * `cdk watch` config uses):
 *
 *   - `**` (a whole path segment) — matches zero or more path segments,
 *     i.e. crosses `/`.
 *   - `*`  — any run of characters except `/` (within one segment).
 *   - `?`  — a single character except `/`.
 *   - a pattern with no `/` matches its basename at any depth
 *     (`node_modules` is treated as `**` + `/node_modules`), mirroring
 *     gitignore / cdk-watch behavior.
 *
 * A pattern also matches the CONTENTS of a directory it names
 * (`node_modules` matches `node_modules/x/y`) so a directory exclude
 * prunes the whole subtree. Brace / extglob / character-class syntax is
 * NOT supported — cdk.json watch configs don't use it.
 *
 * Matching is implemented with two classic two-pointer wildcard passes
 * (one over path segments for `**`, one within a segment for `*` / `?`)
 * rather than a translated `RegExp`. This is deliberate: a `RegExp`
 * built from many `*` (each `[^/]*`) backtracks catastrophically on a
 * non-matching input, and these matchers run on EVERY watched file
 * event with user-supplied patterns. The two-pointer form is O(n*m) and
 * cannot blow up.
 *
 * Paths are matched in POSIX form (forward slashes); the matcher
 * normalizes Windows separators before testing.
 */

export type GlobMatcher = (relPath: string) => boolean;

/**
 * Normalize a glob and split it into path-segment tokens. Returns
 * `null` for an empty pattern (callers skip it). A slash-free pattern is
 * prefixed with a `**` token so it matches its basename at any depth.
 */
function compilePattern(glob: string): string[] | null {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (g === '') return null;
  if (!g.includes('/')) return ['**', g];
  return g.split('/');
}

/**
 * Linear wildcard match for ONE path segment (no `/`). `*` matches any
 * run of characters, `?` matches exactly one. Classic two-pointer
 * algorithm with single backtrack pointer — O(len(pat) * len(str)),
 * never exponential.
 */
function matchSegment(pat: string, str: string): boolean {
  let s = 0;
  let p = 0;
  let starP = -1;
  let starS = 0;
  while (s < str.length) {
    const pc = pat[p];
    if (p < pat.length && (pc === str[s] || pc === '?')) {
      s++;
      p++;
    } else if (pc === '*') {
      starP = p;
      starS = s;
      p++;
    } else if (starP !== -1) {
      p = starP + 1;
      starS++;
      s = starS;
    } else {
      return false;
    }
  }
  while (pat[p] === '*') p++;
  return p === pat.length;
}

/**
 * Match a compiled pattern's segment tokens against a path's segments. A
 * `**` token matches zero or more path segments; every other token
 * matches exactly one segment via {@link matchSegment}. The pattern
 * matches when it consumes a PREFIX of the path (the contents rule), so
 * a directory pattern also matches everything beneath it. Single
 * backtrack pointer over `**` — O(patSegs * pathSegs), never
 * exponential.
 */
function matchSegments(pat: readonly string[], path: readonly string[]): boolean {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;
  while (si < path.length) {
    if (pi === pat.length) return true; // pattern consumed -> contents match
    if (pat[pi] === '**') {
      starPi = pi;
      starSi = si;
      pi++;
    } else if (matchSegment(pat[pi] as string, path[si] as string)) {
      pi++;
      si++;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      starSi++;
      si = starSi;
    } else {
      return false;
    }
  }
  if (pi === pat.length) return true;
  while (pi < pat.length && pat[pi] === '**') pi++;
  return pi === pat.length;
}

/**
 * Compile a list of globs into a single matcher. The returned predicate
 * is `true` when the (relative, POSIX-normalized) path matches ANY
 * pattern. An empty or all-invalid pattern list yields a matcher that
 * never matches.
 */
export function createGlobMatcher(patterns: readonly string[]): GlobMatcher {
  const compiled: string[][] = [];
  for (const p of patterns) {
    const segs = compilePattern(p);
    if (segs) compiled.push(segs);
  }
  return (relPath: string): boolean => {
    const pathSegs = relPath.replace(/\\/g, '/').split('/');
    return compiled.some((pat) => matchSegments(pat, pathSegs));
  };
}
