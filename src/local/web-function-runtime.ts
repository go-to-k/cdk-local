import { isAbsolute, posix, relative, resolve } from 'path';
import { CdkLocalError } from '../utils/error-handler.js';
import { displayIdent } from '../utils/ident-display.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { getEmbedConfig } from './embed-config.js';

/**
 * The runtime table for `cdkl start-web-function` — seam 2 of the two that keep
 * a new Lambda Web Function language out of the command (issue #831). One row
 * per `BuildConfig.RuntimeConfig.Runtime` id says which image runs the bundle,
 * where the code is mounted, how the server process starts and which env var
 * names the entry file. A new runtime (Python is expected) is a new row here;
 * the command, the artifact resolver and the container runner do not change.
 *
 * **Base image: the Lambda base image, with its entrypoint REPLACED.** The rows
 * use `public.ecr.aws/lambda/<lang>:<ver>` rather than a generic language image
 * because that is the Amazon Linux userland, glibc and runtime build the
 * deployed function runs on — a bundle carrying native modules built for Lambda
 * loads locally exactly as it does in the cloud. That image's own entrypoint is
 * `/lambda-entrypoint.sh`, the Runtime Interface Emulator, which serves the
 * event-invoke API and never starts a web server, so the runner always passes
 * `--entrypoint` with the row's interpreter and runs the entry file directly: a
 * web function is a plain HTTP server, not an event handler.
 */
export interface WebFunctionRuntimeSpec {
  /** The `RuntimeConfig.Runtime` id (e.g. `nodejs24.x`). */
  runtime: string;
  /** Image the server runs in. */
  baseImage: string;
  /** Absolute interpreter path inside {@link baseImage}, passed as `--entrypoint`. */
  interpreter: string;
  /** Where the code bundle is bind-mounted read-only, and the container workdir. */
  codeMountPath: string;
  /** The env var that names the entry file, relative to the package root. */
  entrypointEnv: string;
  /** The entry file when {@link entrypointEnv} is unset. */
  defaultEntrypoint: string;
  /** Architectures the cloud runtime offers; the first is the default `--platform`. */
  architectures: readonly ('arm64' | 'x86_64')[];
}

const RUNTIMES: Readonly<Record<string, WebFunctionRuntimeSpec>> = {
  'nodejs24.x': {
    runtime: 'nodejs24.x',
    baseImage: 'public.ecr.aws/lambda/nodejs:24',
    interpreter: '/var/lang/bin/node',
    codeMountPath: '/var/task',
    entrypointEnv: 'AWS_LAMBDA_NODEJS_ENTRYPOINT',
    defaultEntrypoint: 'index.js',
    architectures: ['arm64'],
  },
};

/** Every runtime id {@link resolveWebFunctionRuntime} accepts, sorted. */
export function supportedWebFunctionRuntimes(): string[] {
  return Object.keys(RUNTIMES).sort();
}

/**
 * Look up a web function runtime. An unknown id FAILS, naming the id and the
 * supported set — never a silent fall back to another runtime's image.
 */
export function resolveWebFunctionRuntime(runtime: string): WebFunctionRuntimeSpec {
  const spec = Object.hasOwn(RUNTIMES, runtime) ? RUNTIMES[runtime] : undefined;
  if (!spec) {
    throw new CdkLocalError(
      `Web function runtime ${displayIdent(runtime)} is not supported by ` +
        `${getEmbedConfig().cliName} start-web-function yet. Supported: ` +
        `${supportedWebFunctionRuntimes().join(', ')}.`,
      'LOCAL_START_WEB_FUNCTION_UNSUPPORTED_RUNTIME'
    );
  }
  return spec;
}

/** The container command line that starts the server for one bundle. */
export interface WebFunctionStartCommand {
  /** `--entrypoint` (the interpreter). */
  entryPoint: string[];
  /** Positional arguments after the image: the entry file's container path. */
  cmd: string[];
  /** The entry file, relative to the package root (for the boot log). */
  entryFile: string;
}

/**
 * Build the start command for a bundle: the row's interpreter running the entry
 * file named by the row's entrypoint env var (taken from the container env the
 * revision declares), else the row's default. The entry is checked on the HOST
 * before any container starts, so a bundle without `index.js` fails naming the
 * file and the env var rather than as a crash in the container log.
 */
export function buildWebFunctionStartCommand(
  spec: WebFunctionRuntimeSpec,
  codeDir: string,
  env: Readonly<Record<string, string>>,
  fileExists: (path: string) => boolean
): WebFunctionStartCommand {
  const configured = env[spec.entrypointEnv];
  const entryFile =
    configured !== undefined && configured.length > 0 ? configured : spec.defaultEntrypoint;
  const hostPath = resolve(codeDir, entryFile);
  const rel = relative(codeDir, hostPath);
  if (isAbsolute(entryFile) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new CdkLocalError(
      `${spec.entrypointEnv}=${displayUntrustedValue(entryFile)} must name a file inside the ` +
        `code bundle, relative to its root.`,
      'LOCAL_START_WEB_FUNCTION_ENTRYPOINT_OUTSIDE_BUNDLE'
    );
  }
  if (!fileExists(hostPath)) {
    throw new CdkLocalError(
      `The ${spec.runtime} web function entry file ${displayUntrustedValue(entryFile)} was not ` +
        `found in the code bundle ${displayUntrustedValue(codeDir)}. The runtime loads ` +
        `${spec.defaultEntrypoint} from the package root unless ${spec.entrypointEnv} names ` +
        `another file.`,
      'LOCAL_START_WEB_FUNCTION_ENTRYPOINT_MISSING'
    );
  }
  const containerPath = posix.join(spec.codeMountPath, rel.split('\\').join('/'));
  return { entryPoint: [spec.interpreter], cmd: [containerPath], entryFile };
}
