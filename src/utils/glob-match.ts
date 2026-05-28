/**
 * Minimal glob -> RegExp matcher for `cdk.json` `watch.include` /
 * `watch.exclude` patterns (used by `cdkl start-api --watch` source-tree
 * watching).
 *
 * chokidar v4 dropped built-in glob support, so the watcher translates
 * the cdk.json watch globs into matcher predicates here. Supported
 * syntax (the subset CDK's own `cdk watch` config uses):
 *
 *   - `**` — any number of path segments (incl. zero), crosses `/`.
 *   - `*`  — any run of characters except `/`.
 *   - `?`  — a single character except `/`.
 *   - a pattern with no `/` matches its basename at any depth
 *     (`node_modules` is treated as `** / node_modules`), mirroring
 *     gitignore / cdk-watch behavior.
 *
 * Every pattern also matches the contents of a directory it names
 * (`node_modules` matches `node_modules/x/y`) so a directory exclude
 * prunes the whole subtree. Brace / extglob / character-class syntax is
 * NOT supported — cdk.json watch configs don't use it.
 *
 * Paths are matched in POSIX form (forward slashes); the matcher
 * normalizes Windows separators before testing.
 */

export type GlobMatcher = (relPath: string) => boolean;

const REGEX_SPECIALS = '.+^${}()|[]\\';

function globToRegExp(glob: string): RegExp | null {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (g === '') return null;
  // A pattern with no slash matches its basename at any depth.
  if (!g.includes('/')) g = `**/${g}`;

  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === undefined) break;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          // `**/` — zero or more leading path segments.
          i++;
          re += '(?:.*/)?';
        } else {
          // `**` — anything, including `/`.
          re += '.*';
        }
      } else {
        // `*` — anything except `/`.
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (REGEX_SPECIALS.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  // Trailing `(?:/.*)?` lets a directory pattern also match its contents.
  return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * Compile a list of globs into a single matcher. The returned predicate
 * is `true` when the (relative, POSIX-normalized) path matches ANY
 * pattern. An empty or all-invalid pattern list yields a matcher that
 * never matches.
 */
export function createGlobMatcher(patterns: readonly string[]): GlobMatcher {
  const regexps: RegExp[] = [];
  for (const p of patterns) {
    const re = globToRegExp(p);
    if (re) regexps.push(re);
  }
  return (relPath: string): boolean => {
    const norm = relPath.replace(/\\/g, '/');
    return regexps.some((re) => re.test(norm));
  };
}
