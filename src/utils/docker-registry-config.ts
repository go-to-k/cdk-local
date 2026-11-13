import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { isAwsServiceRoutedToEmulator, type AwsEmulatorWorkload } from './aws-proxy.js';
import { getEmbedConfig } from '../local/embed-config.js';

/**
 * The docker client config a registry-contacting docker spawn (`pull`, `build`)
 * uses under `--aws-emulator` (go-to-k/cdk-local#917).
 *
 * AWS Emulator's ECR hands out repository URIs on the REAL
 * `<account>.dkr.ecr.<region>.amazonaws.com` host and serves no registry docker
 * can reach, so any registry request docker makes to an ECR host is a request
 * to real ECR. Docker answers it with whatever the host's client config holds
 * for that host: a `credHelpers` entry (`docker-credential-ecr-login`, which
 * signs with the host's real AWS identity), a token an earlier `docker login`
 * left in the `credsStore`, or an inline `auths` entry. Unless a `"real-aws"`
 * exception names ECR, the docker spawn therefore gets a per-run
 * `DOCKER_CONFIG` holding NO credential for any ECR host (`public.ecr.aws`
 * included, which then pulls anonymously); every other host keeps its
 * credentials, so Docker Hub and private non-AWS registries work as before.
 *
 * Outside `--aws-emulator`, and when ECR is excepted, the host's own config is
 * used unchanged.
 */

/** The `AWS_ENDPOINT_URL_<ID>` suffix of ECR (the SDK `serviceId`). */
const ECR_SERVICE_ID = 'ECR';

/**
 * Entries of the host's docker config directory the per-run directory links
 * to, so the client still reaches the daemon and runs as before: `contexts`
 * (the `currentContext`'s endpoint, e.g. Docker Desktop's socket under
 * `~/.docker/run/`; without it docker falls back to `/var/run/docker.sock`,
 * which Docker Desktop need not provide), `cli-plugins` (`buildx`; Docker
 * Desktop installs it there as a symlink) and `buildx` (the selected builder).
 * None of them holds a registry credential.
 */
const LINKED_ENTRIES = ['contexts', 'cli-plugins', 'buildx'] as const;

/**
 * Whether a docker config `auths` / `credHelpers` key names an ECR registry
 * host. Deliberately LOOSER than `parseEcrRegistryHost` (which must never point
 * a login at a host AWS does not own): here a false positive only withholds a
 * credential, so any host carrying an ECR label (`dkr.ecr`, `dkr.ecr-fips`,
 * `dkr-ecr`, `dkr-ecr-fips`) matches, in any partition, with or without a
 * scheme, port or path.
 */
export function isEcrRegistryConfigKey(key: string): boolean {
  const host = key
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]!
    .toLowerCase();
  // `public.ecr.aws` too: its pulls work anonymously, and a helper there
  // (`ecr-login`) would fetch an ECR Public token with the host's identity.
  return (
    /(^|\.)dkr[.-]ecr(-fips)?\./.test(host) ||
    host === 'public.ecr.aws' ||
    host.startsWith('public.ecr.aws:')
  );
}

/**
 * The host docker config with every credential for an ECR host removed.
 *
 * - `auths` and `credHelpers` entries keyed by an ECR host are dropped; every
 *   other entry is kept.
 * - `credsStore` applies to EVERY host without a `credHelpers` entry, and it
 *   may hold an ECR token from an earlier `docker login`, so it is removed; each
 *   remaining `auths` key with no inline `auth` (docker writes `{}` there for a
 *   login it put in the store) gets a `credHelpers` entry naming the store, so
 *   those logins still work. A store entry with no `auths` key is lost (the
 *   pull is anonymous), never sent.
 * - Every other key (`currentContext`, `proxies`, `cliPluginsExtraDirs`, ...)
 *   is kept as written.
 */
export function stripEcrCredentials(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  const credsStore =
    typeof config['credsStore'] === 'string' && config['credsStore'] !== ''
      ? config['credsStore']
      : undefined;
  delete out['credsStore'];

  const auths: Record<string, unknown> = {};
  const helpers: Record<string, unknown> = {};
  const hostAuths = asRecord(config['auths']);
  for (const [key, value] of Object.entries(hostAuths)) {
    if (isEcrRegistryConfigKey(key)) continue;
    auths[key] = value;
    const inline = asRecord(value);
    if (credsStore !== undefined && typeof inline['auth'] !== 'string') {
      helpers[key] = credsStore;
    }
  }
  for (const [key, value] of Object.entries(asRecord(config['credHelpers']))) {
    if (isEcrRegistryConfigKey(key)) continue;
    helpers[key] = value;
  }
  if ('auths' in config) out['auths'] = auths;
  if (Object.keys(helpers).length > 0) out['credHelpers'] = helpers;
  else delete out['credHelpers'];
  return out;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** The host docker client's config directory: `DOCKER_CONFIG`, else `~/.docker`. */
export function hostDockerConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = env['DOCKER_CONFIG'];
  // Absolute: a relative value would make the links below dangle (a link's
  // relative target resolves against the link's own directory).
  return own !== undefined && own !== '' ? path.resolve(own) : path.join(homedir(), '.docker');
}

let strippedDir: string | undefined;
let exitHookInstalled = false;

/**
 * Write (once per process) the per-run docker config directory: the host's
 * `config.json` through {@link stripEcrCredentials} (mode 0600 in a 0700
 * directory), plus links to the host's {@link LINKED_ENTRIES}. Removed on
 * normal exit; a process killed outright (SIGKILL) leaves it under the OS temp
 * directory, readable by this user only.
 * A host config that is missing or not JSON yields an empty one: docker then
 * runs with no credential at all, which is the safe side.
 */
function ensureStrippedConfigDir(): string {
  if (strippedDir !== undefined && existsSync(strippedDir)) return strippedDir;
  const hostDir = hostDockerConfigDir();
  let hostConfig: Record<string, unknown> = {};
  try {
    hostConfig = asRecord(JSON.parse(readFileSync(path.join(hostDir, 'config.json'), 'utf-8')));
  } catch {
    hostConfig = {};
  }
  const dir = mkdtempSync(
    path.join(tmpdir(), `${getEmbedConfig().resourceNamePrefix}-docker-config-`)
  );
  const stripped = stripEcrCredentials(hostConfig);
  for (const entry of LINKED_ENTRIES) {
    const target = path.join(hostDir, entry);
    if (!existsSync(target)) continue;
    try {
      // A junction on Windows needs no symlink privilege.
      symlinkSync(target, path.join(dir, entry), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // A plugin or builder link that cannot be made only loses that entry.
      // Without `contexts`, a `currentContext` naming a context docker cannot
      // find makes EVERY docker call fail, so the default context is used.
      if (entry === 'contexts') delete stripped['currentContext'];
    }
  }
  writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(stripped, null, 2)}\n`, {
    mode: 0o600,
  });
  strippedDir = dir;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      if (strippedDir !== undefined) rmSync(strippedDir, { recursive: true, force: true });
    });
  }
  return dir;
}

/**
 * The `env` a docker spawn that contacts a registry (`pull`, `build`) passes:
 * under `--aws-emulator`, unless a `"real-aws"` exception names ECR for
 * `workload` (or, without one, in `Parameters`), `DOCKER_CONFIG` names a
 * per-run directory with no ECR credential ({@link stripEcrCredentials});
 * otherwise `DOCKER_CONFIG` keeps the host's own value (unset stays unset).
 *
 * `runDockerStreaming` / `runDockerForeground` apply the `Parameters` answer to
 * every spawn by default, so a site that knows its workload passes this
 * explicitly to route by that workload's own exceptions.
 */
export function dockerRegistryEnv(
  workload?: AwsEmulatorWorkload
): Record<string, string | undefined> {
  if (!isAwsServiceRoutedToEmulator(ECR_SERVICE_ID, workload)) {
    // Both host values, so the stripped `Parameters` default `runDocker*` puts
    // underneath is fully replaced (unset stays unset).
    return {
      DOCKER_CONFIG: process.env['DOCKER_CONFIG'],
      DOCKER_AUTH_CONFIG: process.env['DOCKER_AUTH_CONFIG'],
      REGISTRY_AUTH_FILE: process.env['REGISTRY_AUTH_FILE'],
    };
  }
  const dir = ensureStrippedConfigDir();
  return {
    DOCKER_CONFIG: dir,
    // podman (CDK_DOCKER) reads its own auth file, not DOCKER_CONFIG; pointed
    // here it reads only the stripped one. A `credential-helpers` entry in
    // podman's registries.conf is system configuration and out of reach.
    REGISTRY_AUTH_FILE: path.join(dir, 'config.json'),
    ...strippedAuthConfigEnv(process.env['DOCKER_AUTH_CONFIG']),
  };
}

/**
 * `DOCKER_AUTH_CONFIG` (credentials as config JSON in the environment, read on
 * top of the config file) through {@link stripEcrCredentials}. Unset stays
 * unset; a value that is not JSON is dropped (unset), never passed on.
 */
function strippedAuthConfigEnv(value: string | undefined): Record<string, string | undefined> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { DOCKER_AUTH_CONFIG: undefined };
    }
    return {
      DOCKER_AUTH_CONFIG: JSON.stringify(stripEcrCredentials(parsed as Record<string, unknown>)),
    };
  } catch {
    return { DOCKER_AUTH_CONFIG: undefined };
  }
}

/** Test hook: remove the per-run directory and forget it. */
export function resetDockerRegistryConfigForTest(): void {
  if (strippedDir !== undefined) rmSync(strippedDir, { recursive: true, force: true });
  strippedDir = undefined;
}
