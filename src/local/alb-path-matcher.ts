/**
 * Issue #123 — match a request against an ALB listener's rules, in priority
 * order. Covers all six ALB rule-condition fields: `path-pattern` (path glob),
 * `host-header` (Host glob), `http-header` (named-header glob), `http-request-method`
 * (exact method), `query-string` (key / value glob pairs), and `source-ip`
 * (CIDR). A rule may carry up to one of each and all present conditions must
 * match (ALB ANDs conditions of different fields).
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
 * ALB http-header semantics:
 *
 *   - A condition names one HTTP header (e.g. `User-Agent`) and one or more
 *     value globs (`*` / `?`, case-insensitive). The condition matches when
 *     ANY value of that header (a multi-valued header is treated as the list
 *     of its values) matches ANY glob.
 *   - Header NAME lookup is case-insensitive (HTTP).
 *   - A rule may carry multiple http-header conditions (different names);
 *     they AND.
 *
 * ALB http-request-method semantics:
 *
 *   - One condition with a list of method names (OR-matched). **Exact match,
 *     no wildcards**, case-sensitive uppercase (ALB requires uppercase).
 *
 * ALB query-string semantics:
 *
 *   - One condition with a list of `{ Key?, Value }` pairs (OR-matched). Both
 *     `Key` (optional) and `Value` accept the `*` / `?` glob alphabet;
 *     matching is case-insensitive. When `Key` is omitted, ANY key with a
 *     value matching the `Value` glob satisfies the entry.
 *   - Repeated query-string parameters (`?a=1&a=2`) match if ANY value
 *     satisfies the entry.
 *
 * ALB source-ip semantics:
 *
 *   - One condition with a list of CIDR ranges (OR-matched). Each value is an
 *     IPv4 or IPv6 CIDR. The request matches when the connection's source IP
 *     falls inside ANY listed range. IPv4-mapped IPv6 source addresses (the
 *     `::ffff:a.b.c.d` form Node reports for IPv4 on a dual-stack listener)
 *     are unmapped before matching.
 *   - Local-front-door caveat: a request that comes in on `127.0.0.1` is what
 *     the rule sees; CIDR rules narrower than `127.0.0.0/8` will not match
 *     locally without `X-Forwarded-For` plumbing (deferred).
 *
 * Rule precedence: ALB evaluates listener rules in ascending `Priority`
 * (lower number = higher priority); the first rule whose condition(s) match
 * wins. A condition with multiple values OR-matches; conditions of different
 * fields AND. When no rule matches, the caller falls back to the listener's
 * default action.
 */

/** One http-header condition: a header name + its OR-matched value globs. */
export interface AlbHttpHeaderCondition {
  /** Header name (case-insensitive lookup). */
  name: string;
  /** OR-matched value globs (`*` / `?`, case-insensitive). */
  values: readonly string[];
}

/** One query-string condition value: an optional key glob + a required value glob. */
export interface AlbQueryStringCondition {
  /** Optional key glob; absent = any key. */
  key?: string;
  /** Required value glob. */
  value: string;
}

/** One routing rule, generic over the target it selects. */
export interface AlbPathRule<T> {
  /** ALB rule priority (lower = evaluated first). */
  priority: number;
  /** The rule's `path-pattern` condition values (OR-matched). Empty = no path constraint. */
  pathPatterns: string[];
  /** The rule's `host-header` condition values (OR-matched). Empty = no host constraint. */
  hostPatterns?: string[];
  /** The rule's `http-header` conditions (each AND'd; values within OR). Empty = no header constraint. */
  httpHeaderConditions?: readonly AlbHttpHeaderCondition[];
  /** The rule's `http-request-method` values (OR-matched, exact). Empty = no method constraint. */
  httpRequestMethods?: readonly string[];
  /** The rule's `query-string` `{ Key?, Value }` pairs (OR-matched). Empty = no query-string constraint. */
  queryStringConditions?: readonly AlbQueryStringCondition[];
  /** The rule's `source-ip` CIDR values (OR-matched). Empty = no source-IP constraint. */
  sourceIpCidrs?: readonly string[];
  /** What this rule routes to (e.g. a pool, a resolved target). */
  target: T;
}

/** The request facts a rule is evaluated against. */
export interface AlbRequestMatch {
  /** Request URL path (query string is split out before matching path-pattern). */
  path: string;
  /** Request `Host` header (port suffix is stripped before host matching). */
  host?: string;
  /** Raw incoming request headers (multi-value supported); names are looked up case-insensitively. */
  headers?: NodeJS.Dict<string | string[]>;
  /** HTTP request method (e.g. `GET`); compared case-sensitively to the rule's uppercase values. */
  method?: string;
  /** Connection source IP for source-ip rule matching. */
  sourceIp?: string;
}

/**
 * Return the target of the highest-priority rule whose conditions all match
 * `req`, or `undefined` when none match (caller uses the default). Rules are
 * evaluated in ascending priority; the input order is irrelevant.
 *
 * Accepts either a request facts object or a bare path string (the path-only
 * form keeps the original signature working for callers that have no Host /
 * headers / method / source IP).
 */
export function matchAlbPathRule<T>(
  req: AlbRequestMatch | string,
  rules: readonly AlbPathRule<T>[]
): T | undefined {
  const facts: AlbRequestMatch = typeof req === 'string' ? { path: req } : req;
  const requestPath = pathOf(facts.path);
  const requestQuery = queryOf(facts.path);
  const requestHost = facts.host !== undefined ? hostOf(facts.host) : undefined;
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (ruleMatches(rule, requestPath, requestQuery, requestHost, facts)) return rule.target;
  }
  return undefined;
}

/**
 * Whether a single rule's conditions all match. Each present condition field
 * is OR-matched within (multiple values) and AND'd across fields. An empty /
 * absent condition list means "no constraint on that field" (the condition was
 * absent on the rule).
 */
function ruleMatches<T>(
  rule: AlbPathRule<T>,
  requestPath: string,
  requestQuery: string,
  requestHost: string | undefined,
  facts: AlbRequestMatch
): boolean {
  if (rule.pathPatterns.length > 0) {
    if (!rule.pathPatterns.some((pattern) => globToRegExp(pattern, false).test(requestPath))) {
      return false;
    }
  }
  const hostPatterns = rule.hostPatterns ?? [];
  if (hostPatterns.length > 0) {
    if (requestHost === undefined) return false;
    if (!hostPatterns.some((pattern) => globToRegExp(pattern, true).test(requestHost))) {
      return false;
    }
  }
  const headerConditions = rule.httpHeaderConditions ?? [];
  if (headerConditions.length > 0) {
    if (!headerConditions.every((cond) => httpHeaderConditionMatches(cond, facts.headers))) {
      return false;
    }
  }
  const methods = rule.httpRequestMethods ?? [];
  if (methods.length > 0) {
    if (facts.method === undefined) return false;
    if (!methods.includes(facts.method)) return false;
  }
  const queryConditions = rule.queryStringConditions ?? [];
  if (queryConditions.length > 0) {
    const params = parseQueryParams(requestQuery);
    if (!queryConditions.some((cond) => queryStringConditionMatches(cond, params))) {
      return false;
    }
  }
  const cidrs = rule.sourceIpCidrs ?? [];
  if (cidrs.length > 0) {
    if (facts.sourceIp === undefined) return false;
    const ip = unmapV4MappedV6(facts.sourceIp);
    if (!cidrs.some((cidr) => albCidrMatches(cidr, ip))) return false;
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

/**
 * Whether an `http-header` condition matches the request's headers. The
 * header name is looked up case-insensitively; each listed value glob is
 * matched case-insensitively against every value of that header (multi-valued
 * headers count each value separately).
 */
export function httpHeaderConditionMatches(
  cond: AlbHttpHeaderCondition,
  headers: NodeJS.Dict<string | string[]> | undefined
): boolean {
  if (!headers) return false;
  const targetName = cond.name.toLowerCase();
  const rawValue = headerLookup(headers, targetName);
  if (rawValue === undefined) return false;
  const headerValues = Array.isArray(rawValue) ? rawValue : [rawValue];
  return cond.values.some((glob) => {
    const re = globToRegExp(glob, true);
    return headerValues.some((v) => re.test(v.toLowerCase()));
  });
}

/**
 * Whether a single `query-string` condition `{ Key?, Value }` matches the
 * request's parsed query parameters. Both Key and Value are case-insensitive
 * `*` / `?` globs; when `Key` is absent, ANY parameter whose value matches the
 * Value glob satisfies the condition.
 */
export function queryStringConditionMatches(
  cond: AlbQueryStringCondition,
  params: ReadonlyArray<{ key: string; value: string }>
): boolean {
  const valueRe = globToRegExp(cond.value, true);
  const keyRe = cond.key !== undefined ? globToRegExp(cond.key, true) : undefined;
  return params.some((p) => {
    if (keyRe !== undefined && !keyRe.test(p.key.toLowerCase())) return false;
    return valueRe.test(p.value.toLowerCase());
  });
}

/**
 * Whether an IPv4 or IPv6 address falls inside an IPv4 or IPv6 CIDR. Returns
 * `false` for mismatched families (an IPv4 address tested against an IPv6
 * CIDR, or vice versa) and for unparseable input.
 */
export function albCidrMatches(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const addr = parseIpAddress(ip);
  if (!addr) return false;
  if (parsed.family !== addr.family) return false;
  return matchBitPrefix(parsed.bytes, addr.bytes, parsed.prefixLength);
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
 * Pull the raw query string (`a=1&b=2`) out of a URL. Returns the empty string
 * when the URL has no `?`. The fragment is dropped.
 */
function queryOf(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return '';
  const rest = url.slice(q + 1);
  const h = rest.indexOf('#');
  return h === -1 ? rest : rest.slice(0, h);
}

/**
 * Decode a raw query string into a flat list of `{ key, value }` entries
 * (preserving repeats), URI-decoding both sides and treating `+` as a space
 * (the `application/x-www-form-urlencoded` convention browsers use). Pairs
 * with no `=` are treated as `{ key, value: '' }`.
 */
function parseQueryParams(query: string): Array<{ key: string; value: string }> {
  if (!query) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    out.push({ key: decodeQueryPart(rawKey), value: decodeQueryPart(rawValue) });
  }
  return out;
}

function decodeQueryPart(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
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

/** Case-insensitive header lookup against a Node-style headers dict. */
function headerLookup(
  headers: NodeJS.Dict<string | string[]>,
  lowerCaseName: string
): string | string[] | undefined {
  // Most callers already pass lower-cased keys (Node's IncomingMessage does),
  // so a direct lookup is the fast path; fall back to a scan otherwise.
  const direct = headers[lowerCaseName];
  if (direct !== undefined) return direct;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerCaseName) return headers[key];
  }
  return undefined;
}

const REGEXP_META = /[.+^${}()|[\]\\]/;

/**
 * Translate an ALB `*` / `?` glob into an anchored RegExp: `*` -> `.*`,
 * `?` -> `.`, every other character is escaped and matched literally. The
 * `caseInsensitive` form lower-cases the pattern (callers pair it with a
 * lower-cased input); path patterns are case-sensitive.
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

interface CidrParsed {
  family: 'v4' | 'v6';
  bytes: Uint8Array;
  prefixLength: number;
}

interface IpParsed {
  family: 'v4' | 'v6';
  bytes: Uint8Array;
}

/** Parse a CIDR (`ip/prefix`) into its address bytes + prefix length. */
function parseCidr(cidr: string): CidrParsed | undefined {
  const slash = cidr.indexOf('/');
  if (slash === -1) return undefined;
  const addrPart = cidr.slice(0, slash);
  const prefixPart = cidr.slice(slash + 1);
  if (!/^\d+$/.test(prefixPart)) return undefined;
  const prefixLength = parseInt(prefixPart, 10);
  const addr = parseIpAddress(addrPart);
  if (!addr) return undefined;
  const maxPrefix = addr.family === 'v4' ? 32 : 128;
  if (prefixLength < 0 || prefixLength > maxPrefix) return undefined;
  return { family: addr.family, bytes: addr.bytes, prefixLength };
}

/** Parse an IPv4 (`1.2.3.4`) or IPv6 address into its byte representation. */
function parseIpAddress(ip: string): IpParsed | undefined {
  if (ip.includes('.') && !ip.includes(':')) {
    return parseIpv4(ip);
  }
  if (ip.includes(':')) {
    return parseIpv6(ip);
  }
  return undefined;
}

function parseIpv4(ip: string): IpParsed | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^\d+$/.test(part)) return undefined;
    const n = parseInt(part, 10);
    if (n < 0 || n > 255) return undefined;
    bytes[i] = n;
  }
  return { family: 'v4', bytes };
}

/**
 * Parse a textual IPv6 address (incl. `::` shorthand and IPv4-suffix form like
 * `::ffff:1.2.3.4`) into its 16-byte representation.
 */
function parseIpv6(ip: string): IpParsed | undefined {
  // Strip bracketed form (`[::1]` -> `::1`).
  let s = ip;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

  // Split off an embedded IPv4 suffix (`::ffff:1.2.3.4`).
  let v4Suffix: Uint8Array | undefined;
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4Part = s.slice(lastColon + 1);
    const parsed = parseIpv4(v4Part);
    if (!parsed) return undefined;
    v4Suffix = parsed.bytes;
    s = s.slice(0, lastColon) + ':0:0';
  }

  const doubleColon = s.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = s.split(':');
    tail = [];
  } else {
    head = s.slice(0, doubleColon) === '' ? [] : s.slice(0, doubleColon).split(':');
    tail = s.slice(doubleColon + 2) === '' ? [] : s.slice(doubleColon + 2).split(':');
  }
  if (head.length + tail.length > 8) return undefined;
  if (doubleColon === -1 && head.length !== 8) return undefined;

  const groups: number[] = new Array(8).fill(0);
  for (let i = 0; i < head.length; i++) {
    const g = parseHexGroup(head[i]!);
    if (g === undefined) return undefined;
    groups[i] = g;
  }
  for (let i = 0; i < tail.length; i++) {
    const g = parseHexGroup(tail[tail.length - 1 - i]!);
    if (g === undefined) return undefined;
    groups[7 - i] = g;
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  if (v4Suffix) {
    bytes[12] = v4Suffix[0]!;
    bytes[13] = v4Suffix[1]!;
    bytes[14] = v4Suffix[2]!;
    bytes[15] = v4Suffix[3]!;
  }
  return { family: 'v6', bytes };
}

function parseHexGroup(g: string): number | undefined {
  if (g.length === 0 || g.length > 4) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(g)) return undefined;
  return parseInt(g, 16);
}

/**
 * Unmap an IPv4-mapped IPv6 source IP (`::ffff:a.b.c.d` or `::ffff:NNNN:NNNN`)
 * to its bare IPv4 form. Node reports `::ffff:127.0.0.1` for an IPv4 client on
 * a dual-stack listener; rules that name a v4 CIDR should still match.
 */
function unmapV4MappedV6(ip: string): string {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return ip;
  const suffix = m[1]!;
  if (suffix.includes('.')) return suffix;
  // `::ffff:7f00:1` form -> reconstruct dotted quad.
  const parts = suffix.split(':');
  if (parts.length !== 2) return ip;
  const high = parseInt(parts[0]!, 16);
  const low = parseInt(parts[1]!, 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return ip;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** Whether the first `prefixLength` bits of `a` equal those of `b`. */
function matchBitPrefix(a: Uint8Array, b: Uint8Array, prefixLength: number): boolean {
  if (a.length !== b.length) return false;
  const fullBytes = Math.floor(prefixLength / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (a[i] !== b[i]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits);
  return (a[fullBytes]! & mask) === (b[fullBytes]! & mask);
}
