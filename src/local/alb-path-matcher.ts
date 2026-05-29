/**
 * Issue #123 (path-pattern slice) — match a request path against an ALB
 * listener's `path-pattern` rules, in priority order.
 *
 * ALB path-pattern semantics (NOT the same as API Gateway route matching, so
 * this is a dedicated matcher rather than a reuse of `route-matcher.ts`):
 *
 *   - Matched against the **path only** — the query string is excluded.
 *   - **Case-sensitive**.
 *   - Two wildcards: `*` matches 0 or more characters (including `/`), and `?`
 *     matches exactly 1 character. Every other character is literal.
 *   - The pattern matches the **entire** path (anchored both ends), so
 *     `/api/*` matches `/api/` and `/api/v1/x` but not `/api` (no trailing
 *     character for `*` to begin after the slash) and not `/apix`.
 *
 * Rule precedence: ALB evaluates listener rules in ascending `Priority`
 * (lower number = higher priority); the first rule whose condition matches
 * wins. A rule's `path-pattern` condition can carry multiple values, matched
 * as an OR. When no rule matches, the caller falls back to the listener's
 * default action.
 */

/** One path-pattern routing rule, generic over the target it selects. */
export interface AlbPathRule<T> {
  /** ALB rule priority (lower = evaluated first). */
  priority: number;
  /** The rule's `path-pattern` condition values (OR-matched). */
  pathPatterns: string[];
  /** What this rule routes to (e.g. a pool, a resolved target). */
  target: T;
}

/**
 * Return the target of the highest-priority rule whose `path-pattern` matches
 * `requestPath`, or `undefined` when none match (caller uses the default).
 * Rules are evaluated in ascending priority; the input order is irrelevant.
 */
export function matchAlbPathRule<T>(
  requestPath: string,
  rules: readonly AlbPathRule<T>[]
): T | undefined {
  const path = pathOf(requestPath);
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (rule.pathPatterns.some((pattern) => albPathPatternMatches(pattern, path))) {
      return rule.target;
    }
  }
  return undefined;
}

/**
 * Whether a single ALB `path-pattern` value matches a request path. The path
 * must already be query-stripped, or pass a raw URL and it is stripped here.
 */
export function albPathPatternMatches(pattern: string, requestPath: string): boolean {
  return globToRegExp(pattern).test(pathOf(requestPath));
}

/** Strip the query string / fragment so only the URL path is matched. */
function pathOf(url: string): string {
  let end = url.length;
  const q = url.indexOf('?');
  if (q !== -1) end = q;
  const h = url.indexOf('#');
  if (h !== -1 && h < end) end = h;
  return url.slice(0, end);
}

const REGEXP_META = /[.+^${}()|[\]\\]/;

/**
 * Translate an ALB path-pattern glob into an anchored, case-sensitive RegExp:
 * `*` -> `.*`, `?` -> `.`, every other character is escaped and matched
 * literally.
 */
function globToRegExp(pattern: string): RegExp {
  let body = '';
  for (const ch of pattern) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else if (REGEXP_META.test(ch)) body += `\\${ch}`;
    else body += ch;
  }
  return new RegExp(`^${body}$`);
}
