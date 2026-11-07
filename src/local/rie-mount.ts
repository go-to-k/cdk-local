import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { displayUntrustedValue } from '../utils/assembly-path.js';
import { userCacheHome } from '../utils/cache-home.js';
import { runDockerStreaming } from '../utils/docker-cmd.js';
import { displayToolOutput } from '../utils/ident-display.js';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from './embed-config.js';

/**
 * Mount the AWS Lambda Runtime Interface Emulator (RIE) into a container-image
 * Lambda and run it as the entrypoint (go-to-k/cdk-local#867).
 *
 * The invocation endpoint every image-Lambda launch POSTs to
 * (`/2015-03-31/functions/function/invocations` on `:8080`) exists only while
 * an RIE serves it. The AWS Lambda base images start one from
 * `/lambda-entrypoint.sh`, but an image on any other base (distroless,
 * scratch, alpine + a Lambda runtime client) has none, so the invoke reached
 * whatever the image's own process happened to serve. `sam local`'s answer,
 * and the one here: bind-mount an RIE at `/var/rapid/aws-lambda-rie`, make it
 * the entrypoint, and hand it the image's effective EntryPoint + Cmd as the
 * runtime to start. On an AWS base image that still works:
 * `/lambda-entrypoint.sh` execs the bootstrap directly once
 * `AWS_LAMBDA_RUNTIME_API` is set, which the outer RIE does for its child.
 *
 * **Where the binary comes from.** Copied out of
 * `public.ecr.aws/lambda/provided:al2023` — the same AWS base image registry
 * the ZIP-Lambda runtimes are pulled from — for the function's platform, then
 * cached per architecture under the user's cache home. No separate download
 * endpoint, nothing bundled.
 *
 * **Best effort.** When the binary cannot be obtained (no registry access,
 * `--no-pull` with nothing cached) a warning is logged once and the image runs
 * as before, so images that ship their own RIE keep working offline.
 */

/** Where the mounted RIE sits inside the container (`sam local`'s path). */
export const RIE_CONTAINER_PATH = '/var/rapid/aws-lambda-rie';

/** The AWS base image the RIE binary is copied out of. */
export const RIE_SOURCE_IMAGE = 'public.ecr.aws/lambda/provided:al2023';

/** The binary's path inside {@link RIE_SOURCE_IMAGE}. */
export const RIE_SOURCE_PATH = '/usr/local/bin/aws-lambda-rie';

const RIE_BASENAME = 'aws-lambda-rie';

/** ELF `e_machine` per docker platform: the cached binary must match it. */
const ELF_MACHINE_BY_PLATFORM: Readonly<Record<string, number>> = {
  'linux/amd64': 62, // EM_X86_64
  'linux/arm64': 183, // EM_AARCH64
};

export interface RieMount {
  hostPath: string;
  containerPath: string;
  readOnly: true;
}

/** The `docker run` shape that runs the image under the mounted RIE. */
export interface RieWrap {
  mount: RieMount;
  /** Always `[RIE_CONTAINER_PATH]`. */
  entryPoint: string[];
  /** The image's effective EntryPoint followed by its effective Cmd. */
  cmd: string[];
}

export interface RieWrapInput {
  /** The local image reference `docker run` will start. */
  image: string;
  /** `linux/amd64` / `linux/arm64`, from the function's `Architectures`. */
  platform: string;
  /** `ImageConfig.EntryPoint`; empty or absent means the image's own. */
  entryPoint?: readonly string[] | undefined;
  /** `ImageConfig.Command`; empty or absent means the image's own. */
  command?: readonly string[] | undefined;
  /** `--no-pull`: never pull {@link RIE_SOURCE_IMAGE}; use a cached copy only. */
  skipPull?: boolean;
}

/** The directory the per-architecture RIE binaries are cached in. */
export function rieCacheDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = userCacheHome(env);
  return root === undefined ? undefined : join(root, 'lambda-rie');
}

const inFlight = new Map<string, Promise<string>>();
/** One warning per process for a binary that cannot be obtained: it hits every function. */
let warnedNoBinary = false;

/**
 * Resolve how to run `input.image` under a mounted RIE, or `undefined` when
 * the image must run as-is: the program it starts already IS an RIE (two
 * emulators would contend for `:8080`), its config could not be read (warned
 * for that image), or the RIE binary could not be obtained (warned once per
 * process, since it then applies to every function).
 */
export async function resolveRieWrap(input: RieWrapInput): Promise<RieWrap | undefined> {
  const logger = getLogger().child('rie');
  let program: string[];
  try {
    const own =
      nonEmpty(input.entryPoint) && nonEmpty(input.command)
        ? { entrypoint: [], cmd: [] }
        : await inspectImageEntrypointCmd(input.image);
    const entryPoint = nonEmpty(input.entryPoint) ? [...input.entryPoint] : own.entrypoint;
    const cmd = nonEmpty(input.command) ? [...input.command] : own.cmd;
    program = [...entryPoint, ...cmd];
  } catch (err) {
    logger.warn(
      `Could not read the ENTRYPOINT / CMD of image ${displayUntrustedValue(input.image)} ` +
        `(${messageOf(err)}), so no Lambda Runtime Interface Emulator is mounted into it; it runs as built.`
    );
    return undefined;
  }
  if (program.length > 0 && isRieExecutable(program[0]!)) {
    logger.debug(
      `Image ${displayUntrustedValue(input.image)} already starts ${displayUntrustedValue(program[0]!)}; not mounting another RIE`
    );
    return undefined;
  }
  let hostPath: string;
  try {
    hostPath = await ensureRieBinary(input.platform, input.skipPull === true);
  } catch (err) {
    if (!warnedNoBinary) {
      warnedNoBinary = true;
      logger.warn(
        `Could not mount the Lambda Runtime Interface Emulator into container-image functions (${messageOf(err)}). ` +
          'They run as built, so only images that ship their own emulator (the AWS Lambda base images do) can be invoked.'
      );
    } else {
      logger.debug(
        `RIE mount skipped for ${displayUntrustedValue(input.image)}: ${messageOf(err)}`
      );
    }
    return undefined;
  }
  return {
    mount: { hostPath, containerPath: RIE_CONTAINER_PATH, readOnly: true },
    entryPoint: [RIE_CONTAINER_PATH],
    cmd: program,
  };
}

/**
 * Whether the program an image starts is itself an RIE: `aws-lambda-rie`, or a
 * release asset name like `aws-lambda-rie-arm64` copied in unrenamed. A
 * wrapper script that execs one unconditionally cannot be told apart.
 */
function isRieExecutable(path: string): boolean {
  return basename(path).startsWith(RIE_BASENAME);
}

/** An error's message, display-safe: docker's stderr may carry control bytes. */
function messageOf(err: unknown): string {
  return displayToolOutput(err instanceof Error ? err.message : String(err));
}

function nonEmpty(v: readonly string[] | undefined): v is readonly string[] {
  return v !== undefined && v.length > 0;
}

/**
 * The image's own `Config.Entrypoint` / `Config.Cmd`. Needed because
 * `docker run --entrypoint` makes docker DROP the image's default CMD, so the
 * RIE must be handed both explicitly.
 */
export async function inspectImageEntrypointCmd(
  image: string
): Promise<{ entrypoint: string[]; cmd: string[] }> {
  let stdout: string;
  try {
    ({ stdout } = await runDockerStreaming(
      ['image', 'inspect', '--format', '{{json .Config}}', image],
      { streamLive: false }
    ));
  } catch (err) {
    throw new Error(`docker image inspect failed: ${messageOf(err)}`);
  }
  const config = JSON.parse(stdout.trim()) as { Entrypoint?: unknown; Cmd?: unknown } | null;
  return {
    entrypoint: stringArray(config?.Entrypoint),
    cmd: stringArray(config?.Cmd),
  };
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : [];
}

/**
 * The host path of an RIE binary for `platform`, copying it out of
 * {@link RIE_SOURCE_IMAGE} into the cache on first use. One extraction per
 * platform per process; across processes the cache file is written to a
 * private temp name and renamed into place, so a reader never sees half a file.
 */
export async function ensureRieBinary(platform: string, skipPull: boolean): Promise<string> {
  const machine = ELF_MACHINE_BY_PLATFORM[platform];
  if (machine === undefined) throw new Error(`unsupported platform '${platform}'`);
  const root = rieCacheDirectory();
  if (root === undefined) throw new Error('no cache directory (HOME is not set)');
  const target = join(root, platform.replace('/', '-'), RIE_BASENAME);
  let run = inFlight.get(target);
  if (run === undefined) {
    run = (async (): Promise<string> => {
      if ((await isRegularFile(target)) && (await isElfFor(target, machine))) return target;
      await extractRie(platform, target, machine, skipPull);
      return target;
    })();
    inFlight.set(target, run);
    // A failure is not memoized: the next function (or `--watch` reload) retries.
    run.catch(() => inFlight.delete(target));
  }
  return run;
}

/** `lstat`, so a symlink (to a host file it would expose, say) is never one. */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function isElfFor(path: string, machine: number): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, 'r');
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    return (
      bytesRead === 20 &&
      header.readUInt32BE(0) === 0x7f454c46 && // \x7fELF
      header.readUInt16LE(18) === machine
    );
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function extractRie(
  platform: string,
  target: string,
  machine: number,
  skipPull: boolean
): Promise<void> {
  const logger = getLogger().child('rie');
  logger.info(
    skipPull
      ? `Copying the Lambda Runtime Interface Emulator for ${platform} out of the local ${RIE_SOURCE_IMAGE} image (one time)...`
      : `Fetching the Lambda Runtime Interface Emulator for ${platform} from ${RIE_SOURCE_IMAGE} (one time)...`
  );
  // Before `docker create`, so a failure here leaves no container behind.
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!skipPull) {
    try {
      await runDockerStreaming(['pull', '--platform', platform, RIE_SOURCE_IMAGE], {
        streamLive: false,
      });
    } catch (err) {
      throw new Error(`docker pull failed: ${messageOf(err)}`);
    }
  }
  // `docker create` pulls a missing image itself unless told not to, which
  // `--no-pull` must not allow.
  const createArgs = [
    'create',
    ...(skipPull ? ['--pull', 'never'] : []),
    '--platform',
    platform,
    RIE_SOURCE_IMAGE,
  ];
  let containerId: string;
  try {
    containerId = (await runDockerStreaming(createArgs, { streamLive: false })).stdout.trim();
  } catch (err) {
    throw new Error(
      `docker create failed: ${messageOf(err)}` +
        (skipPull
          ? ` (--no-pull: pull ${RIE_SOURCE_IMAGE} once, or run ${getEmbedConfig().binaryName} without --no-pull)`
          : '')
    );
  }
  const tmp = join(dir, `.${RIE_BASENAME}.${process.pid}.${randomBytes(4).toString('hex')}`);
  try {
    try {
      await runDockerStreaming(['cp', `${containerId}:${RIE_SOURCE_PATH}`, tmp], {
        streamLive: false,
      });
    } catch (err) {
      throw new Error(`docker cp failed: ${messageOf(err)}`);
    }
    // `docker cp` writes a symlink in the image AS a symlink: never follow one
    // into a host file with the ELF check, the chmod or the mount.
    if (!(await isRegularFile(tmp)) || !(await isElfFor(tmp, machine))) {
      throw new Error(`the copied ${RIE_SOURCE_PATH} is not a ${platform} executable`);
    }
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true, recursive: true }).catch(() => undefined);
    await runDockerStreaming(['rm', '-f', containerId], { streamLive: false }).catch(
      () => undefined
    );
  }
}
