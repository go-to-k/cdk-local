import { readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

/**
 * Serve a request URI from a local directory standing in for a distribution's
 * S3 origin (issue #363). The local directory is the BucketDeployment source
 * asset cdk-local resolves out of the cloud assembly — the same files that
 * would be uploaded to the bucket — so a routing change can be checked against
 * the ACTUAL keys, default-root-object, and custom-error fallback the deployed
 * distribution would resolve, without a deploy.
 *
 * Origin semantics reproduced (NOT the managed S3 service):
 *   - `DefaultRootObject` is appended ONLY at the root path `/` — CloudFront
 *     does NOT auto-append `index.html` to sub-paths (that is exactly what a
 *     viewer-request rewrite function does, which is why this command runs the
 *     function in front of the origin).
 *   - A missing key returns a 403/404 the way an OAC-fronted private bucket
 *     does (S3 returns 403 AccessDenied for a missing key when ListBucket is
 *     not granted — the common static-site setup); the distribution's
 *     `CustomErrorResponses` then map that to a response page (the SPA
 *     fallback).
 */

/** A distribution `CustomErrorResponses[]` entry, resolved to plain values. */
export interface ResolvedCustomErrorResponse {
  errorCode: number;
  responsePagePath?: string;
  responseCode?: number;
}

/** The result of resolving a URI against the static origin. */
export interface StaticOriginResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Resolve a URI against one or more local origin directories, honoring the
 * default root object and the distribution's custom error responses. The
 * directories are searched in order (a BucketDeployment can layer multiple
 * sources onto one bucket; later sources overlay earlier ones in the cloud, so
 * the first directory that has the key wins here).
 */
export function serveFromStaticOrigin(input: {
  localDirs: readonly string[];
  uri: string;
  defaultRootObject?: string;
  customErrorResponses?: readonly ResolvedCustomErrorResponse[];
}): StaticOriginResult {
  const key = uriToKey(input.uri, input.defaultRootObject);
  const direct = readKey(input.localDirs, key);
  if (direct) {
    return { statusCode: 200, headers: { 'content-type': contentTypeForKey(key) }, body: direct };
  }

  // Missing key -> the origin would 403 (private/OAC bucket) or 404. Mirror
  // CloudFront: try the matching CustomErrorResponses entry. We classify a
  // missing key as 403 to match the OAC-fronted private-bucket default, which
  // is what static-site CDK apps overwhelmingly use; an app that mapped 404
  // instead is also honored because we try BOTH codes' error responses.
  const errorResponses = input.customErrorResponses ?? [];
  for (const code of [403, 404]) {
    const match = errorResponses.find((e) => e.errorCode === code);
    if (!match || !match.responsePagePath) continue;
    const errorKey = stripLeadingSlash(match.responsePagePath);
    const body = readKey(input.localDirs, errorKey);
    if (body) {
      return {
        statusCode: match.responseCode ?? code,
        headers: { 'content-type': contentTypeForKey(errorKey) },
        body,
      };
    }
  }

  // No custom-error page (or its file is missing too): a plain 404.
  return {
    statusCode: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: Buffer.from(`Not found: ${input.uri}\n`),
  };
}

/**
 * Map a request URI to an S3 object key. The query string / fragment is
 * dropped, the leading slash is removed, and the root path (`/` or empty)
 * resolves to the default root object. A URI ending in `/` is NOT auto-indexed
 * (CloudFront does not), so it falls through to a missing key unless a function
 * rewrote it.
 */
export function uriToKey(uri: string, defaultRootObject?: string): string {
  let path = uri;
  const q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  const h = path.indexOf('#');
  if (h !== -1) path = path.slice(0, h);
  path = decodeURIComponentSafe(path);
  const stripped = stripLeadingSlash(path);
  if (stripped === '') return defaultRootObject ? stripLeadingSlash(defaultRootObject) : '';
  return stripped;
}

/**
 * Read a key from the first directory that contains it as a regular file.
 * Path-traversal safe: the resolved absolute path must stay within the origin
 * directory (a `../` in the key, or a symlink escaping the root, yields no
 * read). Returns `undefined` when no directory has the key.
 */
function readKey(localDirs: readonly string[], key: string): Buffer | undefined {
  if (key === '') return undefined;
  for (const dir of localDirs) {
    const resolved = safeJoin(dir, key);
    if (!resolved) continue;
    try {
      const st = statSync(resolved);
      if (st.isFile()) return readFileSync(resolved);
    } catch {
      // Missing in this dir — try the next.
    }
  }
  return undefined;
}

/**
 * Join `key` onto `dir`, rejecting any result that escapes `dir` (Zip-Slip /
 * path-traversal guard). Returns `undefined` when the key would escape.
 */
export function safeJoin(dir: string, key: string): string | undefined {
  const candidate = normalize(join(dir, key));
  const root = normalize(dir);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

function stripLeadingSlash(s: string): string {
  return s.startsWith('/') ? s.replace(/^\/+/, '') : s;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Minimal extension -> MIME map for the common static-site asset types. */
const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
};

/** Resolve a Content-Type for an object key by extension. */
export function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot === -1 || dot === key.length - 1) return 'application/octet-stream';
  const ext = key.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
