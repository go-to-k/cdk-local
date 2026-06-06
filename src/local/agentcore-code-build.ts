import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDockerStreaming } from '../utils/docker-cmd.js';
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { isImageInLocalCache } from './ecr-puller.js';
import { getEmbedConfig } from './embed-config.js';

/**
 * Local from-source build for an AgentCore Runtime `CodeConfiguration`
 * (managed-runtime) artifact.
 *
 * Unlike the container artifact (which ships its own Dockerfile/image), a code
 * artifact is just source + an `EntryPoint` + a `Runtime`; AWS's managed
 * runtime runs the entrypoint, which self-serves the AgentCore HTTP contract
 * (`POST /invocations` + `GET /ping` on 8080) — typically via the
 * `bedrock-agentcore` SDK. Crucially, the managed runtime does NOT install
 * dependencies at runtime: deps are vendored INTO the bundle at deploy time
 * (e.g. `uv pip install --target`), and the runtime resolves them from the
 * bundle's dependency search path. We replicate that locally faithfully:
 * generate a Dockerfile for the runtime's base image that copies the bundle
 * and runs the entrypoint AS-IS (no install). So a bundle that forgot to
 * vendor its deps fails locally the same way it fails deployed
 * (`ModuleNotFoundError`) instead of passing locally only because we installed
 * them — `buildAgentCoreCodeImage` warns up-front with the vendoring recipe
 * when a dependency manifest is present without vendored deps. The resulting
 * container speaks the same 8080 contract, so the existing HTTP client drives
 * it unchanged.
 */

/** AgentCore CodeConfiguration `Runtime` enum → local Docker base image. */
const RUNTIME_BASE_IMAGES: Record<string, string> = {
  PYTHON_3_10: 'public.ecr.aws/docker/library/python:3.10-slim',
  PYTHON_3_11: 'public.ecr.aws/docker/library/python:3.11-slim',
  PYTHON_3_12: 'public.ecr.aws/docker/library/python:3.12-slim',
  PYTHON_3_13: 'public.ecr.aws/docker/library/python:3.13-slim',
  PYTHON_3_14: 'public.ecr.aws/docker/library/python:3.14-slim',
  NODE_22: 'public.ecr.aws/docker/library/node:22-slim',
};

/** Runtimes this CLI can build a from-source image for. */
export const SUPPORTED_CODE_RUNTIMES = Object.keys(RUNTIME_BASE_IMAGES);

export interface BuildAgentCoreCodeImageOptions {
  /** Absolute path to the extracted code-bundle source dir (the cdk.out asset). */
  sourceDir: string;
  /** `CodeConfiguration.Runtime` enum value. */
  runtime: string;
  /** `CodeConfiguration.EntryPoint` argv. */
  entryPoint: string[];
  /** Drives `--platform` (AgentCore requires arm64). */
  architecture: 'x86_64' | 'arm64';
  /** Skip the build and require the deterministic tag to already be cached. */
  noBuild?: boolean;
}

/**
 * Build (or, with `noBuild`, verify) a local image for a code artifact and
 * return its tag. The generated Dockerfile is written to a temp dir and built
 * with the source dir as the context, so the cdk.out asset is never mutated.
 */
export async function buildAgentCoreCodeImage(
  options: BuildAgentCoreCodeImageOptions
): Promise<string> {
  const logger = getLogger();
  const base = RUNTIME_BASE_IMAGES[options.runtime];
  if (!base) {
    throw new LocalInvokeBuildError(
      `AgentCore CodeConfiguration runtime '${options.runtime}' is not supported for local execution. ` +
        `Supported runtimes: ${SUPPORTED_CODE_RUNTIMES.join(', ')}.`
    );
  }

  const isNode = options.runtime.startsWith('NODE');
  await warnIfDependenciesNotVendored(options.sourceDir, options.runtime, isNode, logger);
  const dockerfile = renderCodeDockerfile(base, options.entryPoint, isNode);
  const tag = computeCodeImageTag(
    options.sourceDir,
    options.runtime,
    options.entryPoint,
    dockerfile
  );
  const platform = options.architecture === 'x86_64' ? 'linux/amd64' : 'linux/arm64';

  if (options.noBuild === true) {
    logger.info(`Skipping docker build (--no-build). Verifying ${tag} is in local registry...`);
    if (!(await isImageInLocalCache(tag))) {
      throw new LocalInvokeBuildError(
        `image '${tag}' not in local registry and --no-build is set; ` +
          'remove --no-build or run the build manually first.'
      );
    }
    return tag;
  }

  logger.info(
    `Building agent image from source (runtime=${options.runtime}, platform=${platform})...`
  );
  logger.debug(`Local tag: ${tag}`);

  const buildDir = await mkdtemp(
    join(tmpdir(), `${getEmbedConfig().resourceNamePrefix}-agentcore-code-`)
  );
  const dockerfilePath = join(buildDir, 'Dockerfile');
  try {
    await writeFile(dockerfilePath, dockerfile, 'utf-8');
    await runDockerStreaming(
      ['build', '--platform', platform, '--tag', tag, '--file', dockerfilePath, options.sourceDir],
      { progressLabel: `Building agent image (runtime=${options.runtime})` }
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new LocalInvokeBuildError(
      `docker build failed for AgentCore code artifact (${options.sourceDir})${stderr ? `: ${stderr}` : ''}`
    );
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return tag;
}

/**
 * Render the generated Dockerfile. Dependencies are NOT installed: the
 * AgentCore managed runtime resolves deps from the bundle (vendored at deploy
 * time), so we copy the bundle and run the EntryPoint as-is to match deployed
 * behavior. The EntryPoint is mapped to a CMD: a bare script (`app.py` /
 * `server.js`) is run by the interpreter, while an explicit launcher (e.g.
 * `opentelemetry-instrument`) is run verbatim.
 */
export function renderCodeDockerfile(base: string, entryPoint: string[], isNode: boolean): string {
  return (
    [
      `FROM ${base}`,
      'WORKDIR /app',
      'COPY . /app',
      'EXPOSE 8080',
      `CMD ${JSON.stringify(toCmdArgv(entryPoint, isNode))}`,
    ].join('\n') + '\n'
  );
}

/**
 * Warn when a code bundle declares a dependency manifest but does not appear to
 * vendor its dependencies. The AgentCore managed runtime does NOT install deps
 * at runtime, so an unvendored bundle that "works" only because something
 * installed deps for it would fail on deploy with `ModuleNotFoundError`. We run
 * the bundle as-is locally (matching deploy); this surfaces the likely cause
 * up-front with the vendoring recipe. Heuristic: a Python bundle is considered
 * vendored if it contains any `*.dist-info` dir (what `pip install --target`
 * leaves); a Node bundle if it has a `node_modules` dir.
 */
async function warnIfDependenciesNotVendored(
  sourceDir: string,
  runtime: string,
  isNode: boolean,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return;
  }
  const has = (name: string): boolean => entries.includes(name);

  if (isNode) {
    if (has('package.json') && !has('node_modules')) {
      logger.warn(
        `AgentCore code bundle '${sourceDir}' declares package.json but does not vendor node_modules. ` +
          'The AgentCore managed runtime does NOT install dependencies at runtime, so the deployed agent ' +
          "will fail to resolve them. Vendor dependencies into the bundle (e.g. 'npm install --omit=dev' " +
          'in the bundle dir) so the deploy artifact is self-contained. cdk-local runs the bundle as-is to ' +
          'match the deployed runtime.'
      );
    }
    return;
  }

  const manifest = await pythonManifestDeclaringDeps(sourceDir, entries);
  const vendored = entries.some((e) => e.endsWith('.dist-info'));
  if (manifest && !vendored) {
    const pyVersion = runtime.replace('PYTHON_', '').replace('_', '.');
    logger.warn(
      `AgentCore code bundle '${sourceDir}' declares ${manifest} but does not vendor its dependencies. ` +
        'The AgentCore managed runtime does NOT install dependencies at runtime, so the deployed agent will ' +
        'fail with ModuleNotFoundError. Vendor arm64 wheels into the bundle, e.g.:\n' +
        `  uv pip install --python-platform aarch64-manylinux2014 --python-version ${pyVersion} --target <bundle-dir> -r requirements.txt\n` +
        'cdk-local runs the bundle as-is to match the deployed runtime.'
    );
  }
}

/**
 * Map the EntryPoint argv to a Docker CMD argv. The managed runtime execs the
 * entrypoint as the program; a bare script file is run by the language
 * interpreter (`python` / `node`), while a non-script first token (a launcher
 * already on PATH, e.g. `opentelemetry-instrument`) is run verbatim.
 */
export function toCmdArgv(entryPoint: string[], isNode: boolean): string[] {
  const first = entryPoint[0] ?? '';
  const isScript = isNode ? /\.[cm]?js$/.test(first) : /\.py$/.test(first);
  if (!isScript) return entryPoint;
  return [isNode ? 'node' : 'python', ...entryPoint];
}

/**
 * Return the Python dependency manifest filename that declares at least one
 * real dependency, or undefined. A `requirements.txt` that is empty or only
 * comments/pip-options (the stdlib-only-agent case) declares nothing, so it
 * must not trigger the unvendored-deps warning.
 */
async function pythonManifestDeclaringDeps(
  sourceDir: string,
  entries: string[]
): Promise<string | undefined> {
  if (entries.includes('requirements.txt')) {
    const content = await readFile(join(sourceDir, 'requirements.txt'), 'utf-8').catch(() => '');
    const declares = content.split(/\r?\n/).some((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('#') && !t.startsWith('-');
    });
    if (declares) return 'requirements.txt';
  }
  if (entries.includes('pyproject.toml')) {
    const content = await readFile(join(sourceDir, 'pyproject.toml'), 'utf-8').catch(() => '');
    // PEP 621 `dependencies = ["..."]` with an entry, or a poetry deps table.
    const declares =
      /dependencies\s*=\s*\[\s*["']/.test(content) ||
      content.includes('[tool.poetry.dependencies]');
    if (declares) return 'pyproject.toml';
  }
  return undefined;
}

/** Deterministic local tag, stable for identical source + runtime + entrypoint. */
export function computeCodeImageTag(
  sourceDir: string,
  runtime: string,
  entryPoint: string[],
  dockerfile: string
): string {
  const hash = createHash('sha256')
    .update([sourceDir, runtime, entryPoint.join(' '), dockerfile].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `${getEmbedConfig().resourceNamePrefix}-agentcore-code-${hash}`;
}
