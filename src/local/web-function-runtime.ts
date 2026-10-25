import { existsSync } from 'fs';
import { isAbsolute, posix, relative, resolve, sep } from 'path';
import { CdkLocalError } from '../utils/error-handler.js';
import { displayIdent } from '../utils/ident-display.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { getEmbedConfig } from './embed-config.js';

/**
 * The runtime table for `cdkl start-web-function` — seam 2 of the two that keep
 * a new Lambda Web Function language out of the command (issue #831). One row
 * per `BuildConfig.RuntimeConfig.Runtime` id says which image runs the bundle,
 * where the code is mounted, and — through its own {@link
 * WebFunctionRuntimeSpec.buildStart} — the whole container command line. A row
 * decides that shape itself: Node runs "interpreter + entry file", a Python row
 * can run a module or an ASGI server (`python -m app`, `uvicorn app:app`). A
 * new runtime is a new row here; callers use only the row's result.
 *
 * **Base image: the Lambda base image, with its entrypoint REPLACED.** The rows
 * use `public.ecr.aws/lambda/<lang>:<ver>` rather than a generic language image
 * because that is the Amazon Linux userland, glibc and runtime build the
 * deployed function runs on — a bundle carrying native modules built for Lambda
 * loads locally exactly as it does in the cloud. That image's own entrypoint is
 * `/lambda-entrypoint.sh`, the Runtime Interface Emulator, which serves the
 * event-invoke API and never starts a web server, so every row's start command
 * sets `--entrypoint`: a web function is a plain HTTP server, not an event
 * handler.
 */
export interface WebFunctionRuntimeSpec {
  /** The `RuntimeConfig.Runtime` id (e.g. `nodejs24.x`). */
  runtime: string;
  /** Image the server runs in. */
  baseImage: string;
  /** Where the code bundle is bind-mounted read-only, and the container workdir. */
  codeMountPath: string;
  /** Architectures the cloud runtime offers; the first is the default `--platform`. */
  architectures: readonly ('arm64' | 'x86_64')[];
  /**
   * The container command line for one bundle, from the container env the
   * revision declares and the bundle's host directory. Validates whatever the
   * row needs (an entry file, a module) BEFORE any container starts.
   */
  buildStart(
    env: Readonly<Record<string, string>>,
    codeDir: string,
    deps?: { fileExists?: (path: string) => boolean }
  ): WebFunctionStartCommand;
}

/** The container command line that starts the server for one bundle. */
export interface WebFunctionStartCommand {
  /** `--entrypoint` and its leading arguments. */
  entryPoint: string[];
  /** Positional arguments after the image. */
  cmd: string[];
  /** What is started, for the boot log and the readiness error (e.g. `index.js`). */
  label: string;
}

const NODE_CODE_MOUNT = '/var/task';
const NODE_ENTRYPOINT_ENV = 'AWS_LAMBDA_NODEJS_ENTRYPOINT';
const NODE_DEFAULT_ENTRY = 'index.js';

/**
 * Node: the interpreter runs the entry file named by
 * `AWS_LAMBDA_NODEJS_ENTRYPOINT` (an empty value counts as unset), else
 * `index.js`, relative to the package root. The file is checked on the HOST,
 * so a bundle without it fails naming the file and the env var rather than as
 * a crash in the container log. Exported for unit testing.
 */
export function buildNodeEntryFileStart(
  runtime: string,
  env: Readonly<Record<string, string>>,
  codeDir: string,
  fileExists: (path: string) => boolean = existsSync
): WebFunctionStartCommand {
  const configured = env[NODE_ENTRYPOINT_ENV];
  const entryFile =
    configured !== undefined && configured.length > 0 ? configured : NODE_DEFAULT_ENTRY;
  const hostPath = resolve(codeDir, entryFile);
  const rel = relative(codeDir, hostPath);
  if (
    isAbsolute(entryFile) ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new CdkLocalError(
      `${NODE_ENTRYPOINT_ENV}=${displayUntrustedValue(entryFile)} must name a file inside the ` +
        `code bundle, relative to its root.`,
      'LOCAL_START_WEB_FUNCTION_ENTRYPOINT_OUTSIDE_BUNDLE'
    );
  }
  if (!fileExists(hostPath)) {
    throw new CdkLocalError(
      `The ${runtime} web function entry file ${displayUntrustedValue(entryFile)} was not ` +
        `found in the code bundle ${displayUntrustedValue(codeDir)}. The runtime loads ` +
        `${NODE_DEFAULT_ENTRY} from the package root unless ${NODE_ENTRYPOINT_ENV} names ` +
        `another file.`,
      'LOCAL_START_WEB_FUNCTION_ENTRYPOINT_MISSING'
    );
  }
  const posixRel = sep === '\\' ? rel.split('\\').join('/') : rel;
  return {
    entryPoint: ['/var/lang/bin/node'],
    cmd: [posix.join(NODE_CODE_MOUNT, posixRel)],
    label: entryFile,
  };
}

/** The built-in rows. */
export const WEB_FUNCTION_RUNTIMES: Readonly<Record<string, WebFunctionRuntimeSpec>> = {
  'nodejs24.x': {
    runtime: 'nodejs24.x',
    baseImage: 'public.ecr.aws/lambda/nodejs:24',
    codeMountPath: NODE_CODE_MOUNT,
    architectures: ['arm64'],
    buildStart: (env, codeDir, deps) =>
      buildNodeEntryFileStart('nodejs24.x', env, codeDir, deps?.fileExists),
  },
};

/** Every runtime id {@link resolveWebFunctionRuntime} accepts, sorted. */
export function supportedWebFunctionRuntimes(
  table: Readonly<Record<string, WebFunctionRuntimeSpec>> = WEB_FUNCTION_RUNTIMES
): string[] {
  return Object.keys(table).sort();
}

/**
 * Look up a web function runtime. An unknown id FAILS, naming the id and the
 * supported set — never a silent fall back to another runtime's image. `table`
 * is the built-in one unless a caller (a unit test, a host) supplies its own.
 */
export function resolveWebFunctionRuntime(
  runtime: string,
  table: Readonly<Record<string, WebFunctionRuntimeSpec>> = WEB_FUNCTION_RUNTIMES
): WebFunctionRuntimeSpec {
  const spec = Object.hasOwn(table, runtime) ? table[runtime] : undefined;
  if (!spec) {
    throw new CdkLocalError(
      `Web function runtime ${displayIdent(runtime)} is not supported by ` +
        `${getEmbedConfig().cliName} start-web-function yet. Supported: ` +
        `${supportedWebFunctionRuntimes(table).join(', ')}.`,
      'LOCAL_START_WEB_FUNCTION_UNSUPPORTED_RUNTIME'
    );
  }
  return spec;
}

/** The default `--platform` for a row: its first architecture. */
export function defaultWebFunctionPlatform(spec: WebFunctionRuntimeSpec): string {
  return spec.architectures[0] === 'x86_64' ? 'linux/amd64' : 'linux/arm64';
}
