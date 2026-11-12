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
//   - under `--emulator-endpoint`: the endpoint, ITS credentials only (the
//     host's real ones are scrubbed), its CA, and the emulator hygiene
//     variables. cdk-local's own AWS clients are pointed at the endpoint too.
//
// The docker-run layer applies it (`runDetached`, the ECS task runner), so
// each command only activates it; a host CLI that embeds cdk-local calls the
// same exported functions.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { rootCertificates } from 'node:tls';
import { isLoopbackHostname } from '../utils/loopback-host.js';
import { getLogger } from '../utils/logger.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { describeCredentialLoadFailure } from './credential-error.js';
import { setAwsEndpointOverride } from '../utils/aws-proxy.js';
import { assumedRoleRecorded } from '../utils/workload-identity.js';
import type { CallerCredentials } from '../utils/workload-identity.js';
import { getEmbedConfig } from './embed-config.js';

/** Variables a container's runtimes read for a custom CA bundle. */
export const CA_TRUST_ENV_KEYS = [
  'AWS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_FILE',
] as const;

/**
 * Variables removed from a container's env under `--emulator-endpoint`: each
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
 * Parse and validate an endpoint URL (`https://127.0.0.1:9297`). Throws a
 * user-facing error for anything that is not an `http(s)` URL without
 * credentials, path or query.
 */
export function parseAwsEndpoint(value: string, label = '--emulator-endpoint'): ParsedAwsEndpoint {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(
      `${label} ${displayUntrustedValue(value)} is not a URL (expected e.g. https://127.0.0.1:9297).`
    );
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL, got ${displayUntrustedValue(value)}.`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error(
      `${label} must be a bare scheme://host:port URL (no credentials, path or query), got ${displayUntrustedValue(value)}.`
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
}

/**
 * Read `~/.aws/emulator/<port>/{emulator_credentials, ca.pem}` — the files an
 * AWS Emulator run writes for its port. Never throws: missing or unreadable
 * files leave the field undefined.
 *
 * Host-side use case: a host CLI's own `--emulator-endpoint` handling reads the
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
 * The active profile's `endpoint_url` / `ca_bundle` from the shared config
 * file (`AWS_CONFIG_FILE`, else `~/.aws/config`). Never throws.
 */
export function readProfileEndpointSettings(
  env: NodeJS.ProcessEnv,
  profile: string | undefined,
  homeDir: string = homedir()
): { endpointUrl?: string; caBundle?: string } {
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
  };
}

/**
 * The endpoint overrides the host carries, as container env entries:
 * `AWS_ENDPOINT_URL` and every `AWS_ENDPOINT_URL_<SERVICE>` from `env`, plus
 * the active profile's `endpoint_url` as `AWS_ENDPOINT_URL` when the env sets
 * none. Empty when `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true` (the SDK's own
 * opt-out). Values that are not http(s) URLs are skipped with a warning.
 */
export function collectHostEndpointOverrides(
  env: NodeJS.ProcessEnv,
  opts: { profile?: string | undefined; homeDir?: string } = {}
): Record<string, string> {
  if ((env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] ?? '').toLowerCase() === 'true') return {};
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

/** The resolved wiring. Treat as immutable. */
export interface WorkloadAwsWiring {
  /** `emulator` under `--emulator-endpoint`, else `forward`. */
  mode: 'forward' | 'emulator';
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
  /** `--emulator-endpoint` (or the `<envPrefix>_EMULATOR_ENDPOINT` value). */
  emulatorEndpoint?: string | undefined;
  /** `--ca-bundle <file>`. */
  caBundle?: string | undefined;
  /** `--profile`. */
  profile?: string | undefined;
  /** Environment to read (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Home directory (default `os.homedir()`). */
  homeDir?: string;
  /**
   * Fallback credentials for an emulator endpoint that has no
   * `emulator_credentials` (not an AWS Emulator run). Default: the host's
   * credential chain WITHOUT its environment link.
   */
  resolveFallbackCredentials?: () => Promise<CallerCredentials | undefined>;
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
 */
export function writeCaBundleFile(source: string): { hostPath: string; dispose: () => void } {
  let pem: string;
  try {
    pem = readFileSync(source, 'utf8');
  } catch (err) {
    throw new Error(
      `CA bundle ${displayUntrustedValue(source)} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`
    );
  }
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`CA bundle ${displayUntrustedValue(source)} contains no PEM certificate.`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), `${getEmbedConfig().productName}-ca-`));
  const hostPath = path.join(dir, 'ca-bundle.pem');
  writeFileSync(hostPath, `${pem.trimEnd()}\n${rootCertificates.join('\n')}\n`, { mode: 0o644 });
  return { hostPath, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The host chain minus env vars: the profile named by `profile` / `AWS_PROFILE`, else `default`. */
async function chainWithoutEnv(
  env: NodeJS.ProcessEnv,
  profile: string | undefined
): Promise<CallerCredentials | undefined> {
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  try {
    const c = await defaultProvider({ profile: profileName(env, profile) })();
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
    };
  } catch (err) {
    getLogger().debug(
      `No credentials from the host profile chain: ${describeCredentialLoadFailure(err)}`
    );
    return undefined;
  }
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
    source: string
  ): { hostPath: string; mounts: WorkloadMount[]; env: Record<string, string> } => {
    const file = writeCaBundleFile(expandHome(source, homeDir));
    disposers.push(file.dispose);
    const containerPath = getContainerCaBundlePath();
    const caEnv: Record<string, string> = {};
    for (const k of CA_TRUST_ENV_KEYS) caEnv[k] = containerPath;
    return {
      hostPath: file.hostPath,
      mounts: [{ hostPath: file.hostPath, containerPath }],
      env: caEnv,
    };
  };

  try {
    if (opts.emulatorEndpoint) {
      const ep = parseAwsEndpoint(opts.emulatorEndpoint);
      const run = ep.loopback ? readEmulatorRunFiles(ep.port, homeDir) : undefined;
      const caSource = opts.caBundle || run?.caPath || env['AWS_CA_BUNDLE'];
      const ca = caSource && ep.url.startsWith('https:') ? caMount(caSource) : undefined;
      let credentials: CallerCredentials | undefined;
      if (run?.credentials) credentials = run.credentials;
      else if (run?.present) credentials = AUTH_OFF_PLACEHOLDER_CREDENTIALS;
      else {
        credentials = await (
          opts.resolveFallbackCredentials ?? (() => chainWithoutEnv(env, opts.profile))
        )();
        getLogger().warn(
          `--emulator-endpoint: no AWS Emulator run files for port ${ep.port}; workload containers get the ` +
            `credentials your AWS profile resolves (environment variables are not used). Make sure they are the endpoint's.`
        );
      }
      return {
        mode: 'emulator',
        emulatorEndpoint: ep,
        env: {
          AWS_ENDPOINT_URL: ep.url,
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
          ...(ca?.env ?? {}),
        },
        scrubEnvKeys: EMULATOR_SCRUBBED_ENV_KEYS,
        mounts: ca?.mounts ?? [],
        loopbackPorts: ep.loopback ? [ep.port] : [],
        probeHealth: run?.present === true && ca !== undefined,
        ...(ca ? { caHostPath: ca.hostPath } : {}),
        ...(credentials ? { emulatorCredentials: credentials } : {}),
        dispose,
      };
    }

    const endpoints = collectHostEndpointOverrides(env, { profile: opts.profile, homeDir });
    const caSource =
      opts.caBundle ||
      env['AWS_CA_BUNDLE'] ||
      readProfileEndpointSettings(env, opts.profile, homeDir).caBundle;
    const ca = caSource ? caMount(caSource) : undefined;
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
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
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
  const setCreds = (c: CallerCredentials | undefined): void => {
    for (const k of CREDENTIAL_KEYS) delete out[k];
    if (!c) return;
    out['AWS_ACCESS_KEY_ID'] = c.accessKeyId;
    out['AWS_SECRET_ACCESS_KEY'] = c.secretAccessKey;
    if (c.sessionToken) out['AWS_SESSION_TOKEN'] = c.sessionToken;
  };
  if (wiring.mode === 'emulator') {
    for (const k of wiring.scrubEnvKeys) delete out[k];
    Object.assign(out, wiring.env);
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
 * process; resolves `undefined` (debug-logged) when the chain finds nothing.
 *
 * Host-side use case: the no-flag credential source for a host's own
 * container commands.
 */
export function resolveHostDefaultCredentials(
  opts: { profile?: string | undefined } = {}
): Promise<CallerCredentials | undefined> {
  defaultChain ??= (async () => {
    if (assumedRoleRecorded()) return chainWithoutEnv(process.env, opts.profile);
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    try {
      const c = await defaultProvider(opts.profile ? { profile: opts.profile } : {})();
      return {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
      };
    } catch (err) {
      getLogger().debug(
        `No credentials from the host default chain for workload containers: ${describeCredentialLoadFailure(err)}`
      );
      return undefined;
    }
  })();
  return defaultChain;
}

let defaultChain: Promise<CallerCredentials | undefined> | undefined;
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
  defaultChain = undefined;
  setAwsEndpointOverride(undefined);
}

/** Options a container command passes to {@link activateWorkloadAwsWiring}. */
export interface WorkloadAwsWiringCommandOptions {
  emulatorEndpoint?: string | undefined;
  caBundle?: string | undefined;
  profile?: string | undefined;
}

/** The env var naming the emulator endpoint when the flag is absent. */
export function emulatorEndpointEnvName(): string {
  return `${getEmbedConfig().envPrefix}_EMULATOR_ENDPOINT`;
}

/**
 * Resolve the wiring from a command's options, install it for the docker-run
 * layer, and — under `--emulator-endpoint` — point cdk-local's own AWS clients
 * (including the CloudFormation client behind `--from-cfn-stack`) at the
 * endpoint with its credentials and CA. Call once at the start of a command,
 * before any AWS client is built.
 *
 * Host-side use case: a host CLI's container commands call this with their
 * own options; the endpoint env var follows the embed config's `envPrefix`.
 */
export async function activateWorkloadAwsWiring(
  options: WorkloadAwsWiringCommandOptions
): Promise<WorkloadAwsWiring> {
  const envEndpoint = process.env[emulatorEndpointEnvName()];
  const emulatorEndpoint = options.emulatorEndpoint || (envEndpoint ? envEndpoint : undefined);
  const wiring = await resolveWorkloadAwsWiring({
    emulatorEndpoint,
    caBundle: options.caBundle,
    profile: options.profile,
  });
  setActiveWorkloadAwsWiring(wiring);
  if (wiring.mode === 'emulator' && wiring.emulatorEndpoint) {
    setAwsEndpointOverride({
      endpoint: wiring.emulatorEndpoint.url,
      ...(wiring.caHostPath ? { caPem: readFileSync(wiring.caHostPath, 'utf8') } : {}),
      ...(wiring.emulatorCredentials ? { credentials: wiring.emulatorCredentials } : {}),
    });
    getLogger().info(
      `Using the AWS endpoint ${wiring.emulatorEndpoint.url} for cdk-local's AWS calls and every workload container.`
    );
  } else {
    setAwsEndpointOverride(undefined);
  }
  return wiring;
}
