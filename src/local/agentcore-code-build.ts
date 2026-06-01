import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * `bedrock-agentcore` SDK. We replicate that locally: generate a Dockerfile
 * for the runtime's base image, install the bundle's dependencies, and run the
 * entrypoint. The resulting container speaks the same 8080 contract, so the
 * existing HTTP client drives it unchanged.
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
 * Render the generated Dockerfile. Dependencies are installed conditionally
 * (a bundle may vendor them or ship none), and the EntryPoint is mapped to a
 * CMD: a bare script (`app.py` / `server.js`) is run by the interpreter, while
 * an explicit launcher (e.g. `opentelemetry-instrument`) is run verbatim.
 */
export function renderCodeDockerfile(base: string, entryPoint: string[], isNode: boolean): string {
  const installStep = isNode
    ? 'RUN if [ -f package.json ]; then npm install --omit=dev; fi'
    : 'RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; ' +
      'elif [ -f pyproject.toml ]; then pip install --no-cache-dir .; fi';
  return (
    [
      `FROM ${base}`,
      'WORKDIR /app',
      'COPY . /app',
      installStep,
      'EXPOSE 8080',
      `CMD ${JSON.stringify(toCmdArgv(entryPoint, isNode))}`,
    ].join('\n') + '\n'
  );
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
