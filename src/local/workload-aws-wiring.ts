// AWS endpoint / trust / credential wiring for workload containers.
//
// One process-wide object decides, per command run, what every workload
// container (Lambda, ECS, web function, MicroVM, AgentCore) receives on top of
// what its own command assembled:
//
//   - the host's endpoint override (`AWS_ENDPOINT_URL`,
//     `AWS_ENDPOINT_URL_<SERVICE>`, the profile's `endpoint_url`), forwarded
//     by default. A loopback endpoint keeps its URL; a loopback-forwarding
//     sidecar (`loopback-forwarder.ts`) makes it reachable inside the
//     container.
//   - a CA bundle (`--ca-bundle`, the host's `AWS_CA_BUNDLE`, or the profile's
//     `ca_bundle`), bind-mounted read-only with every runtime's trust variable
//     pointed at it.
//   - credentials from the host's default chain when the command's own flags
//     gave the container none.
//   - under `--aws-emulator`: the endpoint, ITS credentials only (the
//     host's real ones are scrubbed), its CA, and the emulator hygiene
//     variables. cdk-local's own AWS clients are pointed at the endpoint too.
//     Java gets the run's `truststore.p12` through `JAVA_TOOL_OPTIONS`, since
//     the JVM reads none of the PEM trust variables.
//   - under `--aws-emulator` with an `aws-emulator` sentinel in `--env-vars`
//     (mixed mode, `aws-emulator-mixed-mode.ts`): the developer's real
//     identity as in forward mode, each sentinel replaced by the re-signing
//     sidecar's endpoint, and a CA bundle that trusts the sidecar's per-run
//     CA and the emulator's. cdk-local's own clients stay on real AWS.
//
// The docker-run layer applies it (`runDetached`, the ECS task runner), so
// each command only activates it; a host CLI that embeds cdk-local calls the
// same exported functions.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { rootCertificates } from 'node:tls';
import { get as httpGet } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isLoopbackHostname } from '../utils/loopback-host.js';
import { getLogger } from '../utils/logger.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { describeCredentialLoadFailure } from './credential-error.js';
import { setAwsEndpointOverride } from '../utils/aws-proxy.js';
import { assumedRoleRecorded } from '../utils/workload-identity.js';
import type { CallerCredentials } from '../utils/workload-identity.js';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import { getEmbedConfig } from './embed-config.js';
import type { AwsEndpointOverride } from '../utils/aws-proxy.js';
import {
  AWS_EMULATOR_SENTINEL,
  MIXED_MODE_RESIGN_PORT,
  emulatedServicesOf,
  isAwsEmulatorSentinel,
  readAwsEmulatorSentinelsFromFile,
  validateAwsEmulatorSentinels,
} from './aws-emulator-mixed-mode.js';
import type { AwsEmulatorSentinel } from './aws-emulator-mixed-mode.js';
import { createMixedModeTlsMaterials } from './mixed-mode-tls.js';
import {
  MIXED_MODE_RESIGN_BODY_CAP_BYTES,
  type ResignSidecarConfig,
} from './emulator-resign-sidecar.js';

/** Variables a container's runtimes read for a custom CA bundle. */
export const CA_TRUST_ENV_KEYS = [
  'AWS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE',
] as const;

/**
 * The subset of {@link CA_TRUST_ENV_KEYS} set for a CA bundle that only the
 * host's AWS configuration names (`AWS_CA_BUNDLE`, a profile's `ca_bundle`):
 * the variables that ADD to a runtime's trust instead of replacing it.
 */
export const HOST_CA_TRUST_ENV_KEYS = ['AWS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'] as const;

/**
 * Variables removed from a container's env under `--aws-emulator`: each
 * can point an SDK at real credentials (a host profile name, a host
 * credentials / config file, a web-identity role).
 */
export const EMULATOR_SCRUBBED_ENV_KEYS = [
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
] as const;

const CREDENTIAL_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

/** A parsed endpoint URL. */
export interface ParsedAwsEndpoint {
  /** The URL as given, trailing slash removed. */
  url: string;
  hostname: string;
  port: number;
  /** True for `localhost` / `127.0.0.0/8` / `::1`. */
  loopback: boolean;
}

/**
 * An endpoint value as it may appear in a message: everything up to the LAST
 * `@` (userinfo) becomes `***`, and so does everything after the first `?` or
 * `#` that follows. Anchoring on the last `@` needs no URL parse, so a value
 * the parser rejects (no scheme, a stray `\`, a `/` or `?` inside the
 * password) cannot carry its credentials past it; a `@` in a path or query
 * over-masks the host, the safe direction. Only an `http(s):` prefix is kept
 * ahead of the mask: in `AKIA:secret@host` the `AKIA:` is userinfo, not a
 * scheme. Quoted / escaped for display.
 */
export function displayEndpointValue(value: string): string {
  const scheme = /^\s*https?:[/\\]*/i.exec(value)?.[0] ?? '';
  let rest = value.slice(scheme.length);
  const at = rest.lastIndexOf('@');
  if (at >= 0) rest = `***${rest.slice(at)}`;
  const tail = rest.search(/[?#]/);
  if (tail >= 0) rest = `${rest.slice(0, tail + 1)}***`;
  return displayUntrustedValue(`${scheme}${rest}`);
}

/**
 * Parse and validate an endpoint URL (`https://127.0.0.1:9297`). Throws a
 * user-facing error for anything that is not an `http(s)` URL without
 * credentials, path or query. The error never echoes the value's userinfo or
 * query ({@link displayEndpointValue}).
 */
export function parseAwsEndpoint(value: string, label = '--aws-emulator'): ParsedAwsEndpoint {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(
      `${label} ${displayEndpointValue(value)} is not a URL (expected e.g. https://127.0.0.1:9297).`
    );
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL, got ${displayEndpointValue(value)}.`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error(
      `${label} must be a bare scheme://host:port URL (no credentials, path or query), got ${displayEndpointValue(value)}.`
    );
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  return {
    url: `${u.protocol}//${u.host}`,
    hostname,
    port,
    loopback: isLoopbackHostname(u.hostname),
  };
}

/** The INI sections of an AWS config / credentials file. Minimal parser. */
export function parseIniSections(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (sec) {
      current = Object.create(null) as Record<string, string>;
      Object.defineProperty(out, sec[1]!, {
        value: current,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) {
      const k = line.slice(0, eq).trim();
      Object.defineProperty(current, k, {
        value: line.slice(eq + 1).trim(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

/** What a local AWS Emulator run wrote for one port. */
export interface EmulatorRunFiles {
  /** `~/.aws/emulator/<port>` */
  dir: string;
  /** True when the run directory exists (an AWS Emulator owns the port). */
  present: boolean;
  /** The run's keys (absent when the emulator runs with `--auth off`). */
  credentials?: CallerCredentials;
  /** Host path of the run's `ca.pem`, when present. */
  caPath?: string;
  /** Host path of the run's `truststore.p12` (the same CA, for Java), when present. */
  truststorePath?: string;
}

/**
 * Read `~/.aws/emulator/<port>/{emulator_credentials, ca.pem, truststore.p12}` — the files an
 * AWS Emulator run writes for its port. Never throws: missing or unreadable
 * files leave the field undefined.
 *
 * Host-side use case: a host CLI's own `--aws-emulator` handling reads the
 * same credentials for its own clients.
 */
export function readEmulatorRunFiles(port: number, homeDir: string = homedir()): EmulatorRunFiles {
  const dir = path.join(homeDir, '.aws', 'emulator', String(port));
  const present = existsSync(dir);
  const result: EmulatorRunFiles = { dir, present };
  if (!present) return result;
  try {
    const sections = parseIniSections(readFileSync(path.join(dir, 'emulator_credentials'), 'utf8'));
    const def = sections['default'] ?? Object.values(sections)[0];
    if (def?.['aws_access_key_id'] && def['aws_secret_access_key']) {
      result.credentials = {
        accessKeyId: def['aws_access_key_id'],
        secretAccessKey: def['aws_secret_access_key'],
        ...(def['aws_session_token'] ? { sessionToken: def['aws_session_token'] } : {}),
      };
    }
  } catch {
    // `--auth off`, or the file vanished: no credentials.
  }
  const ca = path.join(dir, 'ca.pem');
  if (existsSync(ca)) result.caPath = ca;
  const truststore = path.join(dir, 'truststore.p12');
  if (existsSync(truststore)) result.truststorePath = truststore;
  return result;
}

/** Placeholder keys for an endpoint that serves unsigned requests (`--auth off`). */
export const AUTH_OFF_PLACEHOLDER_CREDENTIALS: CallerCredentials = Object.freeze({
  accessKeyId: 'EMULATORAUTHOFF00000',
  secretAccessKey: '0000000000000000000000000000000000000000',
});

function profileName(env: NodeJS.ProcessEnv, profile: string | undefined): string {
  return profile || env['AWS_PROFILE'] || env['AWS_DEFAULT_PROFILE'] || 'default';
}

/**
 * The active profile's `endpoint_url` / `ca_bundle` /
 * `ignore_configured_endpoint_urls` from the shared config file
 * (`AWS_CONFIG_FILE`, else `~/.aws/config`). Never throws.
 */
export function readProfileEndpointSettings(
  env: NodeJS.ProcessEnv,
  profile: string | undefined,
  homeDir: string = homedir()
): { endpointUrl?: string; caBundle?: string; ignoreConfiguredEndpointUrls?: boolean } {
  const file = env['AWS_CONFIG_FILE'] || path.join(homeDir, '.aws', 'config');
  let sections: Record<string, Record<string, string>>;
  try {
    sections = parseIniSections(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const name = profileName(env, profile);
  const sec =
    name === 'default'
      ? (sections['default'] ?? sections['profile default'])
      : sections[`profile ${name}`];
  if (!sec) return {};
  return {
    ...(sec['endpoint_url'] ? { endpointUrl: sec['endpoint_url'] } : {}),
    ...(sec['ca_bundle'] ? { caBundle: sec['ca_bundle'] } : {}),
    ...(sec['ignore_configured_endpoint_urls']
      ? {
          ignoreConfiguredEndpointUrls:
            sec['ignore_configured_endpoint_urls'].toLowerCase() === 'true',
        }
      : {}),
  };
}

/**
 * Whether the host SDK ignores every configured endpoint: the env
 * `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` when set, else the active profile's
 * `ignore_configured_endpoint_urls` (the SDKs' own precedence).
 */
function ignoresConfiguredEndpointUrls(
  env: NodeJS.ProcessEnv,
  profile: string | undefined,
  homeDir: string | undefined
): boolean {
  const fromEnv = (env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] ?? '').trim();
  if (fromEnv !== '') return fromEnv.toLowerCase() === 'true';
  return readProfileEndpointSettings(env, profile, homeDir).ignoreConfiguredEndpointUrls === true;
}

/**
 * The endpoint overrides the host carries, as container env entries:
 * `AWS_ENDPOINT_URL` and every `AWS_ENDPOINT_URL_<SERVICE>` from `env`, plus
 * the active profile's `endpoint_url` as `AWS_ENDPOINT_URL` when the env sets
 * none. Empty when the host SDK ignores configured endpoints
 * (`AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true`, else the profile's
 * `ignore_configured_endpoint_urls = true`). Values that are not http(s) URLs
 * are skipped with a warning.
 */
export function collectHostEndpointOverrides(
  env: NodeJS.ProcessEnv,
  opts: { profile?: string | undefined; homeDir?: string } = {}
): Record<string, string> {
  if (ignoresConfiguredEndpointUrls(env, opts.profile, opts.homeDir)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === '') continue;
    if (k === 'AWS_ENDPOINT_URL' || /^AWS_ENDPOINT_URL_[A-Z0-9_]+$/.test(k)) {
      out[k] = v;
    }
  }
  if (out['AWS_ENDPOINT_URL'] === undefined) {
    const fromProfile = readProfileEndpointSettings(env, opts.profile, opts.homeDir).endpointUrl;
    if (fromProfile) out['AWS_ENDPOINT_URL'] = fromProfile;
  }
  for (const [k, v] of Object.entries(out)) {
    try {
      parseAwsEndpoint(v, k);
    } catch {
      getLogger().warn(`${k} is not an http(s) URL; it is not forwarded to workload containers.`);
      delete out[k];
    }
  }
  return out;
}

/** A bind mount the wiring adds to every workload container (always read-only). */
export interface WorkloadMount {
  hostPath: string;
  containerPath: string;
}

/**
 * Mixed mode (`--aws-emulator` plus at least one `aws-emulator` sentinel in
 * `--env-vars`). The wiring's `mode` stays `forward`: workloads keep the real
 * identity, and only sentinel-routed services reach the emulator, through the
 * re-signing sidecar.
 */
export interface MixedModeWiring {
  /** The emulated endpoint service ids, sorted: `['DYNAMODB', 'S3']`. */
  services: string[];
  /** The AWS Emulator the sentinels name. */
  emulatorEndpoint: ParsedAwsEndpoint;
  /** The port the re-signing sidecar listens on inside each workload. */
  resignPort: number;
  /** What a sentinel becomes in a workload's env: `https://127.0.0.1:<resignPort>`. */
  resignEndpoint: string;
  /**
   * Host path of the sidecar's config (JSON, mode 0600, in a 0700 temp dir):
   * its TLS key, the emulator's keys. Mounted read-only into the forwarder
   * container; removed by `dispose`.
   */
  resignConfigHostPath: string;
  /**
   * For host-side clients that must read the emulator (per-service name
   * resolution): its endpoint, CA and keys. Never installed process-wide.
   */
  emulatorClientOverride: AwsEndpointOverride;
}

/** The resolved wiring. Treat as immutable. */
export interface WorkloadAwsWiring {
  /** `emulator` under `--aws-emulator` alone, else `forward` (mixed mode included). */
  mode: 'forward' | 'emulator';
  /** Set in mixed mode ({@link MixedModeWiring}). */
  mixed?: MixedModeWiring;
  /** The endpoint under `emulator` mode. */
  emulatorEndpoint?: ParsedAwsEndpoint;
  /**
   * Env entries for every container. Under `forward` they are defaults (a key
   * the command already set wins); under `emulator` they are forced.
   */
  env: Record<string, string>;
  /** Keys removed from the container env (emulator mode). */
  scrubEnvKeys: readonly string[];
  /** Read-only bind mounts (the CA bundle). */
  mounts: WorkloadMount[];
  /** Loopback ports the forwarder must serve inside each container. */
  loopbackPorts: number[];
  /** Probe the endpoint's `/__admin/health` from the container network. */
  probeHealth: boolean;
  /** Host path of the CA bundle file (mounted, and used by the probe). */
  caHostPath?: string;
  /** `--no-pull`: the loopback forwarder image is not pulled. */
  skipPull?: boolean;
  /**
   * Under `emulator` mode: the ONLY credentials a container receives
   * (undefined → the container gets none). Unused under `forward`.
   */
  emulatorCredentials?: CallerCredentials;
  /** Remove temp files. Idempotent. */
  dispose: () => void;
}

/** Inputs to {@link resolveWorkloadAwsWiring}. */
export interface ResolveWorkloadAwsWiringOptions {
  /**
   * `--aws-emulator [url]`: `true` selects {@link DEFAULT_AWS_EMULATOR_URL}; a
   * URL's port selects the run directory `~/.aws/emulator/<port>/`.
   */
  awsEmulator?: string | true | undefined;
  /** `--ca-bundle <file>`. */
  caBundle?: string | undefined;
  /** `--profile`. */
  profile?: string | undefined;
  /** Environment to read (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Home directory (default `os.homedir()`). */
  homeDir?: string;
  /**
   * Host-side health probe of the emulator (default {@link probeAwsEmulatorHealth}).
   * Resolves `undefined` when healthy, else a short reason.
   */
  probeHealth?: (url: string, caPath: string | undefined) => Promise<string | undefined>;
  /** `--no-pull`: never pull the loopback forwarder image. */
  skipPull?: boolean | undefined;
  /**
   * The `aws-emulator` sentinels of the run's `--env-vars` file
   * ({@link readAwsEmulatorSentinelsFromFile}). With `awsEmulator` and at
   * least one sentinel the wiring is mixed mode; validate them first with
   * `validateAwsEmulatorSentinels`.
   */
  awsEmulatorSentinels?: readonly AwsEmulatorSentinel[] | undefined;
}

/**
 * Path of the AWS Emulator's Java trust store inside workload containers.
 *
 * Host-side use case: a host CLI that assembles its own container mounts
 * names the same path.
 */
export function getContainerJavaTruststorePath(): string {
  return `${getEmbedConfig().awsBindMountPath}/truststore.p12`;
}

/**
 * The `JAVA_TOOL_OPTIONS` that point a JVM at a password-less PKCS12 trust
 * store. The JVM reads none of the PEM variables in {@link CA_TRUST_ENV_KEYS},
 * so the AWS SDK for Java needs this to trust AWS Emulator's certificate.
 *
 * Host-side use case: a host CLI's own `--aws-emulator` env for a JVM it starts.
 */
export function javaTruststoreToolOptions(containerPath: string): string {
  return `-Djavax.net.ssl.trustStore=${containerPath} -Djavax.net.ssl.trustStoreType=PKCS12`;
}

/**
 * Combine a container's own `JAVA_TOOL_OPTIONS` with the wiring's. A value
 * that already names a trust store wins as-is (the user chose one); any other
 * value keeps its options and gets the wiring's appended.
 *
 * Host-side use case: a host CLI that sets `JAVA_TOOL_OPTIONS` on a container
 * env it assembles itself, without dropping the function's own JVM options.
 */
export function mergeJavaToolOptions(existing: string | undefined, wiring: string): string {
  const own = (existing ?? '').trim();
  if (own === '') return wiring;
  if (/-Djavax\.net\.ssl\.trustStore=/.test(own)) return own;
  return `${own} ${wiring}`;
}

/**
 * Copy the emulator's `truststore.p12` into a fresh temp file, mode 0644: the
 * run directory is private to the host user, and the container user may be
 * another one. Unlike {@link writeCaBundleFile} it copies the file as-is (it is
 * binary PKCS12): AWS Emulator's `truststore.p12` holds the run's CA
 * certificate only, no private key.
 */
function copyTruststoreFile(source: string): { hostPath: string; dispose: () => void } {
  const bytes = readFileSync(source);
  const dir = mkdtempSync(path.join(tmpdir(), `${getEmbedConfig().productName}-truststore-`));
  const hostPath = path.join(dir, 'truststore.p12');
  writeFileSync(hostPath, bytes, { mode: 0o644 });
  return { hostPath, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Path of the CA bundle inside workload containers. */
export function getContainerCaBundlePath(): string {
  return `${getEmbedConfig().awsBindMountPath}/ca-bundle.pem`;
}

function expandHome(p: string, homeDir: string): string {
  return p === '~' ? homeDir : p.startsWith('~/') ? path.join(homeDir, p.slice(2)) : p;
}

/**
 * Write `source`'s PEM followed by the public root CAs Node.js ships into a
 * fresh temp file, mode 0644 (a CA bundle is public, and the container user
 * may not be the host user). Appending the public roots keeps the variables
 * that REPLACE a runtime's trust store (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`,
 * `AWS_CA_BUNDLE`) from cutting the workload off from every other HTTPS host.
 * `extraCertsPem` adds more certificates (mixed mode: the re-signing
 * sidecar's per-run CA); with no `source` the bundle holds only those.
 */
export function writeCaBundleFile(
  source: string | undefined,
  extraCertsPem: readonly string[] = []
): { hostPath: string; dispose: () => void } {
  const certs: string[] = [];
  if (source !== undefined) {
    let pem: string;
    try {
      pem = readFileSync(source, 'utf8');
    } catch (err) {
      throw new Error(
        `CA bundle ${displayUntrustedValue(source)} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`
      );
    }
    // Certificates only: a "fullchain + key" PEM must not put its PRIVATE KEY
    // into a world-readable file mounted into every container.
    const found = pemCertificates(pem);
    if (found.length === 0) {
      throw new Error(`CA bundle ${displayUntrustedValue(source)} contains no PEM certificate.`);
    }
    certs.push(...found);
  }
  for (const extra of extraCertsPem) certs.push(...pemCertificates(extra));
  const dir = mkdtempSync(path.join(tmpdir(), `${getEmbedConfig().productName}-ca-`));
  const hostPath = path.join(dir, 'ca-bundle.pem');
  writeFileSync(hostPath, `${certs.join('\n')}\n${rootCertificates.join('\n')}\n`, {
    mode: 0o644,
  });
  return { hostPath, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function pemCertificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

/** The URL `--aws-emulator` uses when given no value: AWS Emulator's default. */
export const DEFAULT_AWS_EMULATOR_URL = 'https://127.0.0.1:9297';

/**
 * `GET <url>/__admin/health` from the host, trusting `caPath` (the run's
 * `ca.pem`) on top of the public roots. Resolves `undefined` on HTTP 200, else
 * a short reason (`ECONNREFUSED`, `HTTP_503`, a TLS error code). Never throws.
 *
 * Host-side use case: a host CLI's own `--aws-emulator` pre-flight.
 */
export function probeAwsEmulatorHealth(
  url: string,
  caPath: string | undefined
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let ca: string[] | undefined;
    try {
      ca = caPath ? [...rootCertificates, readFileSync(caPath, 'utf8')] : undefined;
    } catch {
      ca = undefined;
    }
    const target = `${url}/__admin/health`;
    const onResponse = (res: IncomingMessage): void => {
      res.resume();
      resolve(res.statusCode === 200 ? undefined : `HTTP_${res.statusCode ?? 0}`);
    };
    const req = target.startsWith('https:')
      ? httpsGet(target, { timeout: 3000, ...(ca ? { ca } : {}) }, onResponse)
      : httpGet(target, { timeout: 3000 }, onResponse);
    req.on('timeout', () => {
      req.destroy();
      resolve('ETIMEDOUT');
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERROR'));
  });
}

/** The error for an emulator the host cannot reach. */
function describeEmulatorUnreachable(ep: ParsedAwsEndpoint, reason: string): string {
  return (
    `--aws-emulator ${ep.url}: no AWS Emulator answers its health check at ${ep.url}/__admin/health ` +
    `(${reason}). Check that it is running on port ${ep.port} (\`aws-emulator -p ${ep.port}\`, or its ` +
    `Docker image published with \`-p 127.0.0.1:${ep.port}:${ep.port}\`), that the URL's port matches, and ` +
    `that it listens on an address this machine reaches (\`-b\`).`
  );
}

/**
 * The mixed-mode branch of {@link resolveWorkloadAwsWiring}: per-run TLS
 * material for the re-signing sidecar, its 0600 config, and a CA bundle that
 * trusts the sidecar's CA and the emulator's (plus the public roots, so real
 * AWS stays reachable). Host endpoint overrides are NOT forwarded: a host
 * `AWS_ENDPOINT_URL` aimed at the emulator would otherwise carry real-key
 * signatures to it.
 */
function resolveMixedModeWiring(args: {
  ep: ParsedAwsEndpoint;
  services: string[];
  credentials: CallerCredentials;
  /** Every CA the emulator's certificate may chain to: the run's `ca.pem`, `--ca-bundle`, `AWS_CA_BUNDLE`. */
  caSources: string[];
  disposers: (() => void)[];
  dispose: () => void;
  skipPull: boolean | undefined;
  /** The host's region, for a SigV4a request that names none (`*`). */
  region: string | undefined;
}): WorkloadAwsWiring {
  const { ep, services, credentials, caSources, disposers } = args;
  // Kept together, never one instead of another: a `--ca-bundle` for a
  // corporate proxy must not drop the trust in the emulator's own CA.
  const caPems: string[] = [];
  for (const source of caSources) {
    try {
      caPems.push(...pemCertificates(readFileSync(source, 'utf8')));
    } catch (err) {
      throw new Error(
        `--aws-emulator: the CA bundle ${displayUntrustedValue(source)} cannot be read ` +
          `(${(err as NodeJS.ErrnoException).code ?? 'error'}).`
      );
    }
  }
  const upstreamCaPem = caPems.length > 0 ? caPems.join('\n') : undefined;
  // The CA's private key never leaves createMixedModeTlsMaterials.
  const tls = createMixedModeTlsMaterials();
  const bundle = writeCaBundleFile(undefined, [...caPems, tls.caCertPem]);
  disposers.push(bundle.dispose);
  // Secrets (the sidecar's TLS key, the emulator's keys): a 0700 directory
  // holding one 0600 file, mounted read-only, removed by `dispose`.
  const dir = mkdtempSync(path.join(tmpdir(), `${getEmbedConfig().productName}-resign-`));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const resignConfigHostPath = path.join(dir, 'resign.json');
  const config: ResignSidecarConfig = {
    port: MIXED_MODE_RESIGN_PORT,
    upstream: ep.url,
    ...(upstreamCaPem ? { upstreamCaPem } : {}),
    certPem: tls.certPem,
    keyPem: tls.keyPem,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
    capBytes: MIXED_MODE_RESIGN_BODY_CAP_BYTES,
    ...(args.region ? { region: args.region } : {}),
  };
  writeFileSync(resignConfigHostPath, JSON.stringify(config), { mode: 0o600 });
  const containerPath = getContainerCaBundlePath();
  const trust: Record<string, string> = {};
  for (const k of CA_TRUST_ENV_KEYS) trust[k] = containerPath;
  return {
    mode: 'forward',
    mixed: {
      services,
      emulatorEndpoint: ep,
      resignPort: MIXED_MODE_RESIGN_PORT,
      resignEndpoint: `https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`,
      resignConfigHostPath,
      emulatorClientOverride: {
        endpoint: ep.url,
        ...(upstreamCaPem ? { caPem: upstreamCaPem } : {}),
        credentials: config.credentials,
      },
    },
    env: trust,
    scrubEnvKeys: [],
    mounts: [{ hostPath: bundle.hostPath, containerPath }],
    loopbackPorts: ep.loopback ? [ep.port, MIXED_MODE_RESIGN_PORT] : [MIXED_MODE_RESIGN_PORT],
    probeHealth: true,
    caHostPath: bundle.hostPath,
    ...(args.skipPull ? { skipPull: true } : {}),
    dispose: args.dispose,
  };
}

/**
 * Resolve the wiring for one command run. Pure apart from reading the
 * emulator run files / CA source and writing the CA temp file.
 *
 * Host-side use case: a host CLI computes the same wiring for the containers
 * it starts itself, then applies it with {@link applyWorkloadAwsWiringToEnv}
 * and {@link startLoopbackForwarder}.
 */
export async function resolveWorkloadAwsWiring(
  opts: ResolveWorkloadAwsWiringOptions
): Promise<WorkloadAwsWiring> {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const disposers: (() => void)[] = [];
  const dispose = (): void => {
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {
        /* best effort */
      }
    }
  };
  const caMount = (
    source: string,
    keys: readonly string[] = CA_TRUST_ENV_KEYS
  ): { hostPath: string; mounts: WorkloadMount[]; env: Record<string, string> } => {
    const file = writeCaBundleFile(expandHome(source, homeDir));
    disposers.push(file.dispose);
    const containerPath = getContainerCaBundlePath();
    const caEnv: Record<string, string> = {};
    for (const k of keys) caEnv[k] = containerPath;
    return {
      hostPath: file.hostPath,
      mounts: [{ hostPath: file.hostPath, containerPath }],
      env: caEnv,
    };
  };

  try {
    if (opts.awsEmulator) {
      const ep = parseAwsEndpoint(
        opts.awsEmulator === true ? DEFAULT_AWS_EMULATOR_URL : opts.awsEmulator,
        '--aws-emulator'
      );
      // AWS Emulator's own guidance: keep the IP. A host NAME (`localhost`)
      // makes the JS / Java / Go SDKs address S3 virtual-hosted style.
      if (ep.hostname === 'localhost') {
        ep.hostname = '127.0.0.1';
        ep.url = ep.url.replace('//localhost', '//127.0.0.1');
      }
      const run = readEmulatorRunFiles(ep.port, homeDir);
      const caSource = opts.caBundle || run.caPath || env['AWS_CA_BUNDLE'];
      const failure = await (opts.probeHealth ?? probeAwsEmulatorHealth)(
        ep.url,
        caSource ? expandHome(caSource, homeDir) : undefined
      );
      if (failure) throw new Error(describeEmulatorUnreachable(ep, failure));
      const mixedServices = emulatedServicesOf(opts.awsEmulatorSentinels ?? []);
      let credentials: CallerCredentials;
      if (run.credentials) credentials = run.credentials;
      else {
        // Healthy but no keys file: the emulator runs with `--auth off` and
        // accepts any signature. Fixed placeholder keys, never real ones.
        credentials = AUTH_OFF_PLACEHOLDER_CREDENTIALS;
        getLogger().info(
          `--aws-emulator: ${path.join(run.dir, 'emulator_credentials')} not found but the emulator is healthy, ` +
            (mixedServices.length > 0
              ? 'so it runs with --auth off; the re-signing sidecar signs with placeholder credentials.'
              : 'so it runs with --auth off; workload containers get placeholder credentials.')
        );
      }
      if (mixedServices.length > 0) {
        return resolveMixedModeWiring({
          ep,
          services: mixedServices,
          credentials,
          caSources: ep.url.startsWith('https:')
            ? [
                ...new Set(
                  [run.caPath, opts.caBundle, env['AWS_CA_BUNDLE']]
                    .filter((c): c is string => typeof c === 'string' && c !== '')
                    .map((c) => expandHome(c, homeDir))
                ),
              ]
            : [],
          disposers,
          dispose,
          skipPull: opts.skipPull,
          region: env['AWS_REGION'] || env['AWS_DEFAULT_REGION'] || undefined,
        });
      }
      const ca = caSource && ep.url.startsWith('https:') ? caMount(caSource) : undefined;
      // Java reads none of the PEM variables: mount the run's PKCS12 copy of
      // the same CA and point the JVM at it.
      let java: { mount: WorkloadMount; env: Record<string, string> } | undefined;
      if (run.truststorePath && ep.url.startsWith('https:')) {
        // Optional: an unreadable trust store skips only the Java wiring.
        let file: { hostPath: string; dispose: () => void } | undefined;
        try {
          file = copyTruststoreFile(run.truststorePath);
        } catch (err) {
          getLogger().warn(
            `--aws-emulator: ${run.truststorePath} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}); ` +
              'Java workloads get no JAVA_TOOL_OPTIONS trust store.'
          );
        }
        if (file) {
          disposers.push(file.dispose);
          const containerPath = getContainerJavaTruststorePath();
          java = {
            mount: { hostPath: file.hostPath, containerPath },
            env: { JAVA_TOOL_OPTIONS: javaTruststoreToolOptions(containerPath) },
          };
        }
      }
      return {
        mode: 'emulator',
        emulatorEndpoint: ep,
        env: {
          AWS_ENDPOINT_URL: ep.url,
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
          ...(ca?.env ?? {}),
          ...(java?.env ?? {}),
        },
        scrubEnvKeys: EMULATOR_SCRUBBED_ENV_KEYS,
        mounts: [...(ca?.mounts ?? []), ...(java ? [java.mount] : [])],
        loopbackPorts: ep.loopback ? [ep.port] : [],
        probeHealth: ca !== undefined,
        ...(ca ? { caHostPath: ca.hostPath } : {}),
        emulatorCredentials: credentials,
        ...(opts.skipPull ? { skipPull: true } : {}),
        dispose,
      };
    }

    const endpoints = collectHostEndpointOverrides(env, { profile: opts.profile, homeDir });
    let ca: ReturnType<typeof caMount> | undefined;
    if (opts.caBundle) ca = caMount(opts.caBundle);
    else {
      // A host-configured bundle that cannot be used is skipped with a warning
      // rather than failing every command (the JS SDK never read it). On the
      // host it governs AWS traffic only, so only the ADDITIVE variables are
      // set: `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` would REPLACE a handler's
      // trust store for every other HTTPS host too.
      const hostCa =
        env['AWS_CA_BUNDLE'] || readProfileEndpointSettings(env, opts.profile, homeDir).caBundle;
      if (hostCa) {
        try {
          ca = caMount(hostCa, HOST_CA_TRUST_ENV_KEYS);
        } catch (err) {
          getLogger().warn(`${(err as Error).message} It is not mounted into workload containers.`);
        }
      }
    }
    const ports = new Set<number>();
    for (const v of Object.values(endpoints)) {
      const ep = parseAwsEndpoint(v);
      if (ep.loopback) ports.add(ep.port);
    }
    return {
      mode: 'forward',
      env: { ...endpoints, ...(ca?.env ?? {}) },
      scrubEnvKeys: [],
      mounts: ca?.mounts ?? [],
      loopbackPorts: [...ports].sort((a, b) => a - b),
      probeHealth: false,
      ...(ca ? { caHostPath: ca.hostPath } : {}),
      ...(opts.skipPull ? { skipPull: true } : {}),
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

/**
 * The wiring's loopback ports that a container's FINAL env still points at
 * (`AWS_ENDPOINT_URL*`): when the template or `--env-vars` replaced the
 * forwarded endpoint, its port needs no forwarder. In mixed mode the
 * re-signing sidecar's port is among them when the env uses it, together with
 * the emulator's loopback port (the sidecar's upstream).
 */
export function effectiveLoopbackPorts(
  env: Readonly<Record<string, string>>,
  wiring: WorkloadAwsWiring
): number[] {
  const used = new Set<number>();
  for (const [k, v] of Object.entries(env)) {
    if (k !== 'AWS_ENDPOINT_URL' && !k.startsWith('AWS_ENDPOINT_URL_')) continue;
    try {
      const ep = parseAwsEndpoint(v, k);
      if (ep.loopback) used.add(ep.port);
    } catch {
      /* not a URL: nothing to forward */
    }
  }
  const mixed = wiring.mixed;
  if (mixed && used.has(mixed.resignPort) && mixed.emulatorEndpoint.loopback) {
    used.add(mixed.emulatorEndpoint.port);
  }
  return wiring.loopbackPorts.filter((p) => used.has(p));
}

/**
 * Split a container's forwarder ports ({@link effectiveLoopbackPorts}) into
 * the TCP ports the forwarder serves and, in mixed mode, the re-signing
 * sidecar's config when the container uses it. Pass the result to
 * `startLoopbackForwarder` / `buildNamespaceOwnerForwarderDockerArgs`
 * (`ports`, `resignConfigHostPath`).
 *
 * Host-side use case: a host CLI that starts its own forwarder for a mixed
 * mode workload.
 */
export function loopbackForwarderPlan(
  wiring: WorkloadAwsWiring,
  ports: readonly number[]
): { ports: number[]; resignConfigHostPath?: string } {
  const mixed = wiring.mixed;
  if (!mixed || !ports.includes(mixed.resignPort)) return { ports: [...ports] };
  return {
    ports: ports.filter((p) => p !== mixed.resignPort),
    resignConfigHostPath: mixed.resignConfigHostPath,
  };
}

/** True when the wiring adds nothing to a container. */
export function isEmptyWorkloadAwsWiring(w: WorkloadAwsWiring): boolean {
  return w.mode === 'forward' && Object.keys(w.env).length === 0 && w.mounts.length === 0;
}

/**
 * Apply the wiring to one container env. Returns a NEW env.
 *
 * - `forward`: wiring entries fill only keys the env does not set; when the env
 *   has no `AWS_ACCESS_KEY_ID` and `defaultCredentials` is given, those fill
 *   the triple (the command's `--assume-role` / `--profile` result, already in
 *   the env, keeps precedence).
 * - `emulator`: scrubbed keys are removed, wiring entries are forced, and the
 *   credential triple is REPLACED by the emulator's (removed when it has none),
 *   so no real credential reaches the container.
 * - mixed mode (`forward` with `mixed`): as `forward`, and every
 *   `AWS_ENDPOINT_URL_<SERVICE>` set to the `aws-emulator` sentinel becomes the
 *   re-signing sidecar's endpoint. A sentinel outside mixed mode throws: it
 *   would otherwise reach the SDK as an invalid URL.
 *
 * Host-side use case: a host CLI's own container env assembly.
 */
export function applyWorkloadAwsWiringToEnv(
  env: Readonly<Record<string, string>>,
  wiring: WorkloadAwsWiring,
  defaultCredentials?: CallerCredentials
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    Object.defineProperty(out, k, {
      value: v,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const [k, v] of Object.entries(out)) {
    if (!isAwsEmulatorSentinel(k, v)) continue;
    if (!wiring.mixed || k === 'AWS_ENDPOINT_URL') {
      throw new Error(
        `${k}="${AWS_EMULATOR_SENTINEL}" reached a workload container outside mixed mode. The sentinel is read ` +
          'from the --env-vars file, on an AWS_ENDPOINT_URL_<SERVICE> variable, and needs --aws-emulator [url].'
      );
    }
    out[k] = wiring.mixed.resignEndpoint;
  }
  const setCreds = (c: CallerCredentials | undefined): void => {
    for (const k of CREDENTIAL_KEYS) delete out[k];
    if (!c) return;
    out['AWS_ACCESS_KEY_ID'] = c.accessKeyId;
    out['AWS_SECRET_ACCESS_KEY'] = c.secretAccessKey;
    if (c.sessionToken) out['AWS_SESSION_TOKEN'] = c.sessionToken;
  };
  if (wiring.mode === 'emulator') {
    const ownJavaToolOptions = out['JAVA_TOOL_OPTIONS'];
    for (const k of wiring.scrubEnvKeys) delete out[k];
    Object.assign(out, wiring.env);
    // Forced like the rest, except that a container's own JVM options are
    // kept: the trust store options are appended to them.
    const javaToolOptions = wiring.env['JAVA_TOOL_OPTIONS'];
    if (javaToolOptions !== undefined) {
      out['JAVA_TOOL_OPTIONS'] = mergeJavaToolOptions(ownJavaToolOptions, javaToolOptions);
    }
    setCreds(wiring.emulatorCredentials);
  } else {
    for (const [k, v] of Object.entries(wiring.env)) {
      if (out[k] === undefined) out[k] = v;
    }
    if (defaultCredentials && !out['AWS_ACCESS_KEY_ID']) setCreds(defaultCredentials);
  }
  // Lambda and ECS both set AWS_DEFAULT_REGION next to AWS_REGION; boto3 reads
  // only the former, so without it a Python handler fails with NoRegionError.
  if (out['AWS_REGION'] && !out['AWS_DEFAULT_REGION'])
    out['AWS_DEFAULT_REGION'] = out['AWS_REGION'];
  return out;
}

/**
 * The host's default credential chain, for a container whose command flags
 * gave it no credentials (go-to-k/cdkd#6129): `AWS_PROFILE`, the shared
 * credentials / config files, SSO. Precedence stays `--assume-role` >
 * `--profile` > this chain, because it only fills an env with no
 * `AWS_ACCESS_KEY_ID`. After a `--role-arn` assume, the environment holds the
 * role, so the chain is read without its environment link. Memoized per
 * process; resolves `undefined` (debug-logged) when the chain finds nothing,
 * and answers `undefined` again without a walk for
 * {@link HOST_DEFAULT_CREDENTIALS_MISS_TTL_MS} after a miss.
 *
 * Host-side use case: the no-flag credential source for a host's own
 * container commands.
 */
export async function resolveHostDefaultCredentials(
  opts: { profile?: string | undefined } = {}
): Promise<CallerCredentials | undefined> {
  // Without env link after an assume (the env holds the role), else the full chain.
  const name = assumedRoleRecorded() ? profileName(process.env, opts.profile) : opts.profile;
  const key = `${assumedRoleRecorded() ? 'noenv' : 'chain'}:${name ?? ''}`;
  const miss = chainMisses.get(key);
  if (miss !== undefined && Date.now() - miss < CHAIN_MISS_TTL_MS) return undefined;
  let provider = chainProviders.get(key);
  if (!provider) {
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    // The SDK provider memoizes and refreshes expiring credentials itself, so
    // a long-running serve keeps handing new containers live keys.
    // `ignoreCache`: re-read the shared config / credentials files rather than
    // the SDK's process-wide copy, so a retry after a miss sees a profile or
    // keys written since (an SSO token file is read fresh either way).
    provider = defaultProvider({ ...(name ? { profile: name } : {}), ignoreCache: true });
    chainProviders.set(key, provider);
  }
  try {
    const c = await provider();
    chainMisses.delete(key);
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
    };
  } catch (err) {
    // Remember the miss briefly: a machine with no credentials would otherwise
    // pay the chain's metadata-service timeout on every container start.
    chainMisses.set(key, Date.now());
    getLogger().debug(
      `No credentials from the host default chain for workload containers: ${describeCredentialLoadFailure(err)}`
    );
    return undefined;
  }
}

/**
 * How long {@link resolveHostDefaultCredentials} remembers a miss: within it,
 * a call resolves `undefined` without walking the chain; after it, the chain
 * is walked again, so a credential source that appears later (an SSO login
 * during a long `--watch` session) is picked up.
 *
 * Host-side use case: a host calls `resolveHostDefaultCredentials` per
 * container and relies on this bound instead of caching misses itself.
 */
export const HOST_DEFAULT_CREDENTIALS_MISS_TTL_MS = 60_000;
const CHAIN_MISS_TTL_MS = HOST_DEFAULT_CREDENTIALS_MISS_TTL_MS;
const chainProviders = new Map<string, AwsCredentialIdentityProvider>();
const chainMisses = new Map<string, number>();
let active: WorkloadAwsWiring | undefined;
let exitHookInstalled = false;

/** The wiring the docker-run layer applies, if any. */
export function getActiveWorkloadAwsWiring(): WorkloadAwsWiring | undefined {
  return active;
}

/**
 * Install (or clear, with `undefined`) the wiring the docker-run layer applies
 * to every workload container this process starts. The previous wiring is
 * disposed.
 */
export function setActiveWorkloadAwsWiring(wiring: WorkloadAwsWiring | undefined): void {
  if (active && active !== wiring) active.dispose();
  active = wiring;
  if (wiring && !exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => active?.dispose());
  }
}

/** Test hook. */
export function resetWorkloadAwsWiringForTest(): void {
  active?.dispose();
  active = undefined;
  chainProviders.clear();
  chainMisses.clear();
  setAwsEndpointOverride(undefined);
}

/** Options a container command passes to {@link activateWorkloadAwsWiring}. */
export interface WorkloadAwsWiringCommandOptions {
  /** `--aws-emulator [url]` as commander parses it: `true` for the bare flag. */
  awsEmulator?: string | boolean | undefined;
  caBundle?: string | undefined;
  profile?: string | undefined;
  /** Commander's `--no-pull` (`false` when given): the forwarder image is not pulled either. */
  pull?: boolean | undefined;
  /**
   * `--env-vars <file>`: scanned for `aws-emulator` sentinels, which select
   * mixed mode (and need `--aws-emulator`).
   */
  envVars?: string | undefined;
}

/**
 * The env var that turns `--aws-emulator` on when the flag is absent:
 * `CDK_LOCAL_AWS_EMULATOR` for standalone cdk-local, `<envPrefix>_AWS_EMULATOR`
 * under a host's embed config (cdkd: `CDKD_AWS_EMULATOR`). A value of `1` /
 * `true` selects the default URL; any other non-empty value is the URL.
 */
export function awsEmulatorEnvName(): string {
  const { envPrefix } = getEmbedConfig();
  return envPrefix === 'CDKL' ? 'CDK_LOCAL_AWS_EMULATOR' : `${envPrefix}_AWS_EMULATOR`;
}

/** The `--aws-emulator` value from the flag, else the env var; `undefined` when off. */
export function resolveAwsEmulatorOption(
  flag: string | boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | true | undefined {
  if (typeof flag === 'string' && flag !== '') return flag;
  if (flag === true) return true;
  const raw = (env[awsEmulatorEnvName()] ?? '').trim();
  if (raw === '' || /^(0|false)$/i.test(raw)) return undefined;
  return /^(1|true)$/i.test(raw) ? true : raw;
}

/**
 * Resolve the wiring from a command's options, install it for the docker-run
 * layer, and — under `--aws-emulator` — point cdk-local's own AWS clients
 * (including the CloudFormation client behind `--from-cfn-stack`) at the
 * emulator with its credentials and CA. Call once at the start of a command,
 * before any AWS client is built. `envVars` (the command's `--env-vars` file)
 * is scanned for `aws-emulator` sentinels: one without `--aws-emulator` is an
 * error, and with it they select mixed mode, where cdk-local's own clients
 * stay on real AWS.
 *
 * Host-side use case: a host CLI's container commands call this with their
 * own options; the env var follows the embed config's `envPrefix`.
 */
export async function activateWorkloadAwsWiring(
  options: WorkloadAwsWiringCommandOptions
): Promise<WorkloadAwsWiring> {
  const awsEmulator = resolveAwsEmulatorOption(options.awsEmulator);
  const sentinels = readAwsEmulatorSentinelsFromFile(options.envVars);
  validateAwsEmulatorSentinels(sentinels, awsEmulator !== undefined, awsEmulatorEnvName());
  const wiring = await resolveWorkloadAwsWiring({
    awsEmulator,
    caBundle: options.caBundle,
    profile: options.profile,
    skipPull: options.pull === false,
    awsEmulatorSentinels: sentinels,
  });
  setActiveWorkloadAwsWiring(wiring);
  if (wiring.mixed) {
    // Mixed mode: cdk-local's own clients stay on real AWS; only the
    // per-service name resolution reads the emulator, with its own clients.
    setAwsEndpointOverride(undefined);
    getLogger().info(
      `Mixed mode: ${wiring.mixed.services.join(', ')} go to AWS Emulator at ${wiring.mixed.emulatorEndpoint.url} ` +
        `(re-signed with its keys); every other AWS call uses your real credentials.`
    );
  } else if (wiring.mode === 'emulator' && wiring.emulatorEndpoint) {
    setAwsEndpointOverride({
      endpoint: wiring.emulatorEndpoint.url,
      ...(wiring.caHostPath ? { caPem: readFileSync(wiring.caHostPath, 'utf8') } : {}),
      ...(wiring.emulatorCredentials ? { credentials: wiring.emulatorCredentials } : {}),
    });
    getLogger().info(
      `Using AWS Emulator at ${wiring.emulatorEndpoint.url} for ${getEmbedConfig().productName}'s AWS calls and every workload container.`
    );
  } else {
    setAwsEndpointOverride(undefined);
  }
  return wiring;
}
