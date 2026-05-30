import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * PEM materials for an HTTPS front-door listener: a server cert + its private
 * key. Buffers so they pass straight to `https.createServer({ cert, key })`.
 */
export interface FrontDoorTlsMaterials {
  certPem: Buffer;
  keyPem: Buffer;
}

/**
 * Resolve a single global cert/key pair for HTTPS front-door listeners. When
 * BOTH `certPath` and `keyPath` are supplied, those PEM files are read from
 * disk. When neither is supplied, a long-lived self-signed cert is cached
 * under `$XDG_CACHE_HOME/cdk-local/alb-https/` (defaulting to
 * `~/.cache/cdk-local/alb-https/`) and reused across boots; it is regenerated
 * when missing or within `regenerateWithinDays` of expiry. Pairing is enforced
 * — supplying exactly one of `--tls-cert` / `--tls-key` is rejected with a
 * clear error before the server starts.
 *
 * The self-signed cert path subprocesses `openssl req -x509 ...`. `openssl`
 * is on macOS / Linux dev boxes and Docker base images by default; absence
 * surfaces as an actionable error pointing at the BYO recipe.
 */
export async function resolveFrontDoorTlsMaterials(opts: {
  certPath: string | undefined;
  keyPath: string | undefined;
  cacheDir?: string;
  /** Days before expiry at which the cached cert is regenerated. Default 30. */
  regenerateWithinDays?: number;
  /** Validity period for a freshly generated cert, in days. Default 825. */
  validityDays?: number;
}): Promise<FrontDoorTlsMaterials> {
  const hasCert = opts.certPath !== undefined && opts.certPath !== '';
  const hasKey = opts.keyPath !== undefined && opts.keyPath !== '';
  if (hasCert !== hasKey) {
    const set = hasCert ? '--tls-cert' : '--tls-key';
    const missing = hasCert ? '--tls-key' : '--tls-cert';
    throw new Error(
      `${set} is set but ${missing} is missing. ` +
        'Both --tls-cert and --tls-key must be set together, or both left unset to use an ' +
        'auto-generated self-signed cert.'
    );
  }
  if (hasCert && hasKey) {
    return {
      certPem: readPemOrThrow(opts.certPath!, '--tls-cert'),
      keyPem: readPemOrThrow(opts.keyPath!, '--tls-key'),
    };
  }
  return ensureSelfSignedCert({
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    regenerateWithinDays: opts.regenerateWithinDays ?? 30,
    validityDays: opts.validityDays ?? 825,
  });
}

/** Default cache dir for the auto-generated self-signed cert. */
export function defaultCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg && xdg !== '' ? xdg : join(homedir(), '.cache');
  return join(base, 'cdk-local', 'alb-https');
}

const CERT_FILENAME = 'cert.pem';
const KEY_FILENAME = 'key.pem';

interface SelfSignedOptions {
  cacheDir: string;
  regenerateWithinDays: number;
  validityDays: number;
}

async function ensureSelfSignedCert(opts: SelfSignedOptions): Promise<FrontDoorTlsMaterials> {
  const logger = getLogger().child('front-door-tls');
  const certPath = join(opts.cacheDir, CERT_FILENAME);
  const keyPath = join(opts.cacheDir, KEY_FILENAME);

  // Reuse the cached pair when both files exist AND the cert is not expiring
  // soon. A near-expiry regeneration keeps long-running shells healthy
  // without forcing a manual cleanup.
  if (cachedPairIsFresh(certPath, keyPath, opts.regenerateWithinDays)) {
    return {
      certPem: readFileSync(certPath),
      keyPem: readFileSync(keyPath),
    };
  }

  mkdirSync(opts.cacheDir, { recursive: true });
  try {
    await runOpenssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=localhost',
      '-days',
      String(opts.validityDays),
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to auto-generate a self-signed cert via openssl: ${msg}. ` +
        'Install openssl, or supply --tls-cert <path> + --tls-key <path> with your own PEM files. ' +
        'Recipe: openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem ' +
        '-subj "/CN=localhost" -days 365.'
    );
  }
  logger.info(
    `ALB front-door: generated self-signed cert at ${certPath} (valid ${opts.validityDays} days)`
  );
  return {
    certPem: readFileSync(certPath),
    keyPem: readFileSync(keyPath),
  };
}

function cachedPairIsFresh(certPath: string, keyPath: string, regenWithinDays: number): boolean {
  try {
    statSync(certPath);
    statSync(keyPath);
  } catch {
    return false;
  }
  try {
    const notAfter = readCertNotAfter(certPath);
    if (notAfter === undefined) return false;
    const renewAt = notAfter.getTime() - regenWithinDays * 86_400_000;
    return Date.now() < renewAt;
  } catch {
    return false;
  }
}

/**
 * Read a cert's `notAfter` expiry timestamp. Used to decide whether to
 * regenerate the cached self-signed cert proactively. Returns `undefined`
 * when the cert is unreadable (caller then regenerates).
 */
function readCertNotAfter(certPath: string): Date | undefined {
  try {
    // `crypto.X509Certificate` parses a PEM/DER cert and exposes the `validTo`
    // string. Available since Node 15.6 — well within the >=20 engine floor.
    const cert = new X509Certificate(readFileSync(certPath));
    const parsed = new Date(cert.validTo);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

async function runOpenssl(args: string[]): Promise<void> {
  await execFileAsync('openssl', args, { timeout: 30_000 });
}

function readPemOrThrow(path: string, flagName: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${flagName}: cannot read PEM file at '${path}': ${msg}`);
  }
}

/**
 * Write a freshly generated cert/key pair to disk under `dir` and return
 * the paths. Used by tests so the helper code path stays the same as the
 * runtime path.
 */
export function _writeSelfSignedForTest(
  dir: string,
  materials: FrontDoorTlsMaterials
): {
  certPath: string;
  keyPath: string;
} {
  mkdirSync(dirname(join(dir, CERT_FILENAME)), { recursive: true });
  const certPath = join(dir, CERT_FILENAME);
  const keyPath = join(dir, KEY_FILENAME);
  writeFileSync(certPath, materials.certPem);
  writeFileSync(keyPath, materials.keyPem);
  return { certPath, keyPath };
}
