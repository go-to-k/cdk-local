import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { getLogger } from '../utils/logger.js';
import { flattenToOneLine } from './credential-error.js';

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
  /**
   * Refuse a file whose REAL path leaves its directory (a symlink pointing
   * elsewhere). Set for directories the asset manifest named; an `--origin`
   * override is the user's own directory and is served as-is.
   */
  containLinks?: boolean;
  /**
   * Directories under which a key with a `.`-prefixed component (other than
   * `.well-known`) is not served — the accepted absolute `--no-staging` source
   * folders, judged on the request key AND on the file's real path.
   */
  hideDotfilesIn?: readonly string[];
  uri: string;
  defaultRootObject?: string;
  customErrorResponses?: readonly ResolvedCustomErrorResponse[];
}): StaticOriginResult {
  const key = uriToKey(input.uri, input.defaultRootObject);
  const containLinks = input.containLinks === true;
  const hideIn = new Set(input.hideDotfilesIn ?? []);
  const direct = readKey(input.localDirs, key, containLinks, hideIn);
  if (direct) {
    return { statusCode: 200, headers: { 'content-type': contentTypeForKey(key) }, body: direct };
  }

  // Missing key -> the origin would 403 (private/OAC bucket) or 404. Mirror
  // CloudFront: try the matching CustomErrorResponses entry. We classify a
  // missing key as 403 to match the OAC-fronted private-bucket default, which
  // is what static-site CDK apps overwhelmingly use; an app that mapped 404
  // instead is also honored because we try BOTH codes' error responses.
  for (const candidate of resolveErrorResponseCandidates(input.customErrorResponses)) {
    const body = readKey(input.localDirs, candidate.errorKey, containLinks, hideIn);
    if (body) {
      return {
        statusCode: candidate.responseCode,
        headers: { 'content-type': contentTypeForKey(candidate.errorKey) },
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

/** A `CustomErrorResponses` entry resolved to the object key to serve + the status to return. */
export interface ErrorResponseCandidate {
  /** The object key of the error page (leading slash stripped). */
  errorKey: string;
  /** The status code to return when this error page is served. */
  responseCode: number;
}

/**
 * Resolve the ordered list of custom-error-page candidates to try when an
 * origin object is missing/forbidden, shared by the local-dir static origin and
 * the deployed-S3 read-through origin so the 403-then-404 priority + the
 * `ResponseCode` mapping live in ONE place. We try 403 first then 404 because a
 * missing key on an OAC-fronted private bucket returns 403 AccessDenied (the
 * common static-site setup), but an app that mapped 404 instead is also honored.
 */
export function resolveErrorResponseCandidates(
  customErrorResponses?: readonly ResolvedCustomErrorResponse[]
): ErrorResponseCandidate[] {
  const errorResponses = customErrorResponses ?? [];
  const out: ErrorResponseCandidate[] = [];
  for (const code of [403, 404]) {
    const match = errorResponses.find((e) => e.errorCode === code);
    if (!match || !match.responsePagePath) continue;
    out.push({
      errorKey: stripLeadingSlash(match.responsePagePath),
      responseCode: match.responseCode ?? code,
    });
  }
  return out;
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
 * Path-traversal safe: a `../` in the key never leaves the origin directory
 * (`safeJoin`, always), and with `containLinks` neither does a symlink.
 * Returns `undefined` when no directory has the key.
 *
 * The symlink half is {@link realPathInsideRoot}, not `safeJoin`: `safeJoin`
 * judges the path's TEXT, and `statSync` / `readFileSync` follow links, so a
 * `cdk.out/asset.x/index.html -> ~/.aws/credentials` inside a contained origin
 * directory used to be served (go-to-k/cdk-local#745).
 */
function readKey(
  localDirs: readonly string[],
  key: string,
  containLinks: boolean,
  hideDotfilesIn: ReadonlySet<string>
): Buffer | undefined {
  if (key === '') return undefined;
  for (const dir of localDirs) {
    const joined = safeJoin(dir, key);
    if (!joined) continue;
    let resolved = joined;
    if (containLinks) {
      const real = realPathInsideRoot(dir, joined);
      if (real === false) continue;
      // Read the REAL path that was judged, so the final component is not
      // re-followed. A concurrent rewrite of the assembly's directories is
      // out of scope, as for every containment check here.
      if (real !== undefined) resolved = real;
    }
    if (hideDotfilesIn.has(dir) && isHiddenKey(dir, key, resolved)) {
      // Warn only for an entry that EXISTS: requests for made-up hidden keys
      // must not grow the dedupe set or the log (any page in the user's
      // browser can reach this loopback server).
      if (isExistingFile(resolved)) warnHiddenKey(dir, key);
      continue;
    }
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

/**
 * `file`'s REAL path (every symbolic link followed by the kernel) when it lies
 * inside `root`'s real path; `false` when it leaves it, with a warning once per
 * file; `undefined` when either does not resolve — the read after it fails the
 * same way, so it reaches nothing.
 */
function realPathInsideRoot(root: string, file: string): string | false | undefined {
  let realFile: string;
  let realRoot: string;
  try {
    realFile = realpathSync.native(file);
    realRoot = realpathSync.native(root);
  } catch {
    return undefined;
  }
  const rel = relative(realRoot, realFile);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return realFile;
  }
  if (!warnedEscapes.has(file)) {
    warnedEscapes.add(file);
    getLogger().warn(
      `Not serving '${flattenToOneLine(file)}': it is a symbolic link to ` +
        `'${flattenToOneLine(realFile)}', outside the origin directory ` +
        `'${flattenToOneLine(root)}' the asset manifest named. ` +
        `Answering as if the key did not exist.`
    );
  }
  return false;
}

/** Files already warned about; a browser re-requests the same key. */
const warnedEscapes = new Set<string>();

/**
 * Whether a key under an accepted absolute `--no-staging` folder names a
 * hidden entry — on the request key itself, or on the file's REAL path relative
 * to the folder's real path (a link inside the folder pointing at `.env`).
 * `.well-known` is the one hidden name served, for parity with a deployed
 * bucket's ACME / app-association files. The caller warns, and only for an
 * entry that exists.
 */
function isHiddenKey(dir: string, key: string, resolved: string): boolean {
  const hidden = (rel: string): boolean =>
    rel.split(/[\\/]/).some((c) => c.startsWith('.') && c !== '.well-known');
  // Only for an entry that EXISTS: a missing key has no real path, and the
  // lexical one relative to the folder's real path can read `../../tmp/...`
  // (a symlinked parent such as `/tmp` -> `/private/tmp`), whose `..` would
  // flag every plain 404 as hidden.
  let realRel = '';
  try {
    realRel = relative(realpathSync.native(dir), realpathSync.native(resolved));
  } catch {
    realRel = '';
  }
  return hidden(key) || hidden(realRel);
}

function isExistingFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Warn once per (origin, key) that a hidden entry was withheld. */
function warnHiddenKey(dir: string, key: string): void {
  const warnKey = `${dir}\0${key}`;
  if (warnedHiddenKeys.has(warnKey)) return;
  warnedHiddenKeys.add(warnKey);
  getLogger().warn(
    `Not serving '${flattenToOneLine(key)}' from '${flattenToOneLine(dir)}': it is a hidden ` +
      `entry in a cdk synth --no-staging source folder (your own tree, not a staged asset). ` +
      `Answering as if the key did not exist.`
  );
}

/** Hidden keys already warned about. */
const warnedHiddenKeys = new Set<string>();

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
