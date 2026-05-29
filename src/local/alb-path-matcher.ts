/**
 * Issue #123 — match a request against an ALB listener's rules, in priority
 * order. Covers `path-pattern` (path glob) and `host-header` (Host glob)
 * conditions; a rule may carry one of each and both must match (ALB ANDs
 * conditions of different fields).
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
 * ALB host-header semantics:
 *
 *   - Matched against the request `Host` header, **case-insensitive** (DNS
 *     hostnames are case-insensitive). The port suffix (`:8080`) is stripped
 *     before matching, mirroring ALB's host comparison.
 *   - Same `*` / `?` glob alphabet as path-pattern, anchored both ends.
 *
 * Rule precedence: ALB evaluates listener rules in ascending `Priority`
 * (lower number = higher priority); the first rule whose condition(s) match
 * wins. A `path-pattern` / `host-header` condition can carry multiple values,
 * each matched as an OR within the condition. When no rule matches, the caller
 * falls back to the listener's default action.
 */

/** One routing rule, generic over the target it selects. */
export interface AlbPathRule<T> {
  /** ALB rule priority (lower = evaluated first). */
  priority: number;
  /** The rule's `path-pattern` condition values (OR-matched). Empty = no path constraint. */
  pathPatterns: string[];
  /** The rule's `host-header` condition values (OR-matched). Empty = no host constraint. */
  hostPatterns?: string[];
  /** What this rule routes to (e.g. a pool, a resolved target). */
  target: T;
}

/** The request facts a rule is evaluated against. */
export interface AlbRequestMatch {
  /** Request URL path (query string is stripped before matching). */
  path: string;
  /** Request `Host` header (port suffix is stripped before host matching). */
  host?: string;
}

/**
 * Return the target of the highest-priority rule whose conditions all match
 * `req`, or `undefined` when none match (caller uses the default). Rules are
 * evaluated in ascending priority; the input order is irrelevant.
 *
 * Accepts either a request facts object or a bare path string (the path-only
 * form keeps the original signature working for callers that have no Host).
 */
export function matchAlbPathRule<T>(
  req: AlbRequestMatch | string,
  rules: readonly AlbPathRule<T>[]
): T | undefined {
  const { path, host } = typeof req === 'string' ? { path: req, host: undefined } : req;
  const requestPath = pathOf(path);
  const requestHost = host !== undefined ? hostOf(host) : undefined;
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (ruleMatches(rule, requestPath, requestHost)) return rule.target;
  }
  return undefined;
}

/**
 * Whether a single rule's conditions all match. A `path-pattern` /
 * `host-header` condition is satisfied when ANY of its values match (OR); a
 * rule with both fields requires both to match (AND). An empty pattern list
 * for a field means "no constraint on that field" (the condition was absent).
 */
function ruleMatches<T>(
  rule: AlbPathRule<T>,
  requestPath: string,
  requestHost: string | undefined
): boolean {
  if (rule.pathPatterns.length > 0) {
    if (!rule.pathPatterns.some((pattern) => globToRegExp(pattern, false).test(requestPath))) {
      return false;
    }
  }
  const hostPatterns = rule.hostPatterns ?? [];
  if (hostPatterns.length > 0) {
    // No Host header to match against -> a host-constrained rule cannot match.
    if (requestHost === undefined) return false;
    if (!hostPatterns.some((pattern) => globToRegExp(pattern, true).test(requestHost))) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a single ALB `path-pattern` value matches a request path. The path
 * must already be query-stripped, or pass a raw URL and it is stripped here.
 */
export function albPathPatternMatches(pattern: string, requestPath: string): boolean {
  return globToRegExp(pattern, false).test(pathOf(requestPath));
}

/**
 * Whether a single ALB `host-header` value matches a request Host. Both the
 * pattern and the host are lower-cased (host comparison is case-insensitive),
 * and the host's port suffix is stripped.
 */
export function albHostPatternMatches(pattern: string, requestHost: string): boolean {
  return globToRegExp(pattern, true).test(hostOf(requestHost));
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

/**
 * Normalize a `Host` header for matching: drop any `:port` suffix and lower-case
 * it (DNS hostnames are case-insensitive). IPv6 literals (`[::1]:8080`) keep the
 * bracketed address and only the trailing port is removed.
 */
function hostOf(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[')) {
    // IPv6 literal: `[addr]` or `[addr]:port`.
    const close = trimmed.indexOf(']');
    if (close !== -1) return trimmed.slice(0, close + 1).toLowerCase();
    return trimmed.toLowerCase();
  }
  const colon = trimmed.indexOf(':');
  const bare = colon === -1 ? trimmed : trimmed.slice(0, colon);
  return bare.toLowerCase();
}

const REGEXP_META = /[.+^${}()|[\]\\]/;

/**
 * Translate an ALB `*` / `?` glob into an anchored RegExp: `*` -> `.*`,
 * `?` -> `.`, every other character is escaped and matched literally. Host
 * patterns match case-insensitively (the `i` flag) and the pattern is
 * lower-cased to pair with the lower-cased host; path patterns are
 * case-sensitive.
 */
function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const source = caseInsensitive ? pattern.toLowerCase() : pattern;
  let body = '';
  for (const ch of source) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else if (REGEXP_META.test(ch)) body += `\\${ch}`;
    else body += ch;
  }
  return new RegExp(`^${body}$`);
}
