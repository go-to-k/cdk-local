import { existsSync, rmSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { AssetManifestLoader } from '../assets/asset-manifest-loader.js';
import { resolveAssetSourcePath } from '../assets/asset-source-path.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { describeStacks, selectTargetStack } from '../cli/stack-matcher.js';
import { CdkLocalError } from '../utils/error-handler.js';
import { displayIdent, displayStackName } from '../utils/ident-display.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { getEmbedConfig } from './embed-config.js';
import { assetPathDirs, materializeAssetCodeDir, parseTarget } from './lambda-resolver.js';
import { findFileAssetForObjectKey } from './web-function-artifact.js';

/** `AWS::Lambda::MicrovmImage` — a Dockerfile-built image MicroVMs run from. */
export const MICROVM_IMAGE_TYPE = 'AWS::Lambda::MicrovmImage';

/** The ingress port a MicroVM endpoint forwards to without `X-aws-proxy-port`. */
export const MICROVM_DEFAULT_INGRESS_PORT = 8080;

/** The hook names, in the order the cloud drives them. */
export type MicrovmBuildHook = 'ready' | 'validate';
export type MicrovmRuntimeHook = 'run' | 'suspend' | 'resume' | 'terminate';
export type MicrovmHookName = MicrovmBuildHook | MicrovmRuntimeHook;

/** An `ENABLED` hook and its `<Hook>TimeoutInSeconds`, when a literal. */
export interface MicrovmHookConfig {
  timeoutSeconds: number | undefined;
}

/** The parts of a `MicrovmImage` the local run reads. */
export interface MicrovmImageConfig {
  logicalId: string;
  /** `Name` when a literal string, else the logical id. */
  name: string;
  /** `CodeArtifact.Uri`'s S3 key (the part after `s3://<bucket>/`). */
  codeKey: string;
  /** `arm64` / `x86_64` from `CpuConfigurations[0].Architecture`; `undefined` when absent. */
  architecture: 'arm64' | 'x86_64' | undefined;
  /** `EnvironmentVariables` as a map; values may still be intrinsics. */
  environment: Record<string, unknown>;
  /** `Hooks.Port`, when a literal number. */
  hooksPort: number | undefined;
  /** Every hook whose value is `ENABLED`. */
  hooks: Partial<Record<MicrovmHookName, MicrovmHookConfig>>;
  /** Template properties the local run does not reproduce, for the boot warning. */
  unemulated: string[];
}

/** A `start-microvm` target could not be resolved; the message names the next step. */
export class MicrovmResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrovmResolutionError';
    Object.setPrototypeOf(this, MicrovmResolutionError.prototype);
  }
}

/** A resolved `start-microvm` target. */
export interface ResolvedMicrovmImage {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
}

/**
 * Resolve a `cdkl start-microvm <target>` argument to ONE `MicrovmImage`: a
 * stack-qualified logical id, a construct path, or a bare logical id in a
 * single-stack app — the same forms and stack-selection rule as every other
 * command.
 */
export function resolveMicrovmImageTarget(
  target: string,
  stacks: StackInfo[]
): ResolvedMicrovmImage {
  if (stacks.length === 0) {
    throw new MicrovmResolutionError('No stacks found in the synthesized assembly.');
  }
  const parsed = parseTarget(target);
  const selection = selectTargetStack(parsed, target, stacks);
  let stack: StackInfo;
  switch (selection.kind) {
    case 'found':
      stack = selection.stack;
      break;
    case 'no-prefix':
      throw new MicrovmResolutionError(
        `Multiple stacks in app, target ${displayIdent(parsed.pathOrId)} is missing a stack prefix. ` +
          `Use StackName:<logicalId> or StackName/... (path form). Available stacks: ${describeStacks(stacks)}.`
      );
    case 'not-found':
      throw new MicrovmResolutionError(
        `Stack ${displayStackName(selection.pattern)} not found. Available stacks: ${describeStacks(stacks)}.`
      );
    case 'ambiguous':
      throw new MicrovmResolutionError(
        `Stack pattern ${displayStackName(selection.pattern)} matched ${selection.matched.length} stacks: ` +
          `${describeStacks(selection.matched)}. Use a more specific pattern, or the stack's display path.`
      );
  }
  const resources = stack.template.Resources ?? {};
  const images = Object.keys(resources).filter((id) => resources[id]?.Type === MICROVM_IMAGE_TYPE);
  const notFound = (): MicrovmResolutionError =>
    new MicrovmResolutionError(
      `Target ${displayStackName(target)} not found. ` +
        (images.length > 0
          ? `MicroVM images in ${displayStackName(stack.stackName)}: ${images.map((id) => displayIdent(id)).join(', ')}.`
          : `No ${MICROVM_IMAGE_TYPE} resources found in ${displayStackName(stack.stackName)}.`)
    );
  if (parsed.isPath) {
    const matches = resolveCdkPathToLogicalIds(
      parsed.pathOrId,
      buildCdkPathIndex(stack.template)
    ).filter(({ logicalId }) => resources[logicalId]?.Type === MICROVM_IMAGE_TYPE);
    if (matches.length === 1) {
      const id = matches[0]!.logicalId;
      return { stack, logicalId: id, resource: resources[id]! };
    }
    if (matches.length > 1) {
      throw new MicrovmResolutionError(
        `Target ${displayStackName(target)} matches ${matches.length} ${MICROVM_IMAGE_TYPE} resources: ` +
          `${matches.map((m) => displayIdent(m.logicalId)).join(', ')}. Refine the path or use the ` +
          `StackName:<logicalId> form.`
      );
    }
    throw notFound();
  }
  const resource = resources[parsed.pathOrId];
  if (!resource) throw notFound();
  if (resource.Type !== MICROVM_IMAGE_TYPE) {
    throw new MicrovmResolutionError(
      `Resource ${displayIdent(parsed.pathOrId)} in ${displayStackName(stack.stackName)} is ` +
        `${displayIdent(resource.Type)}, not a MicroVM image. ` +
        `${getEmbedConfig().cliName} start-microvm runs ${MICROVM_IMAGE_TYPE} targets.`
    );
  }
  return { stack, logicalId: parsed.pathOrId, resource };
}

const HOOK_KEYS: Record<
  MicrovmHookName,
  { group: 'MicrovmImageHooks' | 'MicrovmHooks'; key: string }
> = {
  ready: { group: 'MicrovmImageHooks', key: 'Ready' },
  validate: { group: 'MicrovmImageHooks', key: 'Validate' },
  run: { group: 'MicrovmHooks', key: 'Run' },
  suspend: { group: 'MicrovmHooks', key: 'Suspend' },
  resume: { group: 'MicrovmHooks', key: 'Resume' },
  terminate: { group: 'MicrovmHooks', key: 'Terminate' },
};

/**
 * Read a `MicrovmImage`'s properties into what the local run needs. Fails on
 * what cannot run at all — a `CodeArtifact.Uri` that is not an S3 URI with a
 * literal key, an enabled hook with no literal `Hooks.Port` — naming the
 * property; everything it does not reproduce lands in `unemulated`.
 */
export function readMicrovmImageConfig(
  logicalId: string,
  resource: TemplateResource
): MicrovmImageConfig {
  const subject = `MicroVM image ${displayIdent(logicalId)}`;
  const props = resource.Properties ?? {};
  const name =
    typeof props['Name'] === 'string' && props['Name'].length > 0 ? props['Name'] : logicalId;

  const uri = asObject(props['CodeArtifact'])?.['Uri'];
  const codeKey = s3KeyOfUri(uri);
  if (codeKey === undefined) {
    throw new CdkLocalError(
      `${subject} has a CodeArtifact.Uri whose object key is not a literal ` +
        `(${describeValue(uri)}). The code must come from a CDK asset in this app (for example ` +
        `an s3assets.Asset of a directory holding the Dockerfile, passing asset.s3ObjectUrl), ` +
        `whose key synthesizes as a literal.`,
      'LOCAL_START_MICROVM_CODE_URI_NOT_LITERAL'
    );
  }

  const cpu = props['CpuConfigurations'];
  const archRaw = Array.isArray(cpu) ? asObject(cpu[0])?.['Architecture'] : undefined;
  const architecture = typeof archRaw === 'string' ? normalizeArchitecture(archRaw) : undefined;

  const environment: Record<string, unknown> = {};
  const envRaw = props['EnvironmentVariables'];
  const unemulated: string[] = [];
  if (Array.isArray(envRaw)) {
    for (const entry of envRaw) {
      const e = asObject(entry);
      if (e && typeof e['Key'] === 'string') environment[e['Key']] = e['Value'];
    }
  } else if (envRaw !== undefined) {
    unemulated.push(
      'EnvironmentVariables is an intrinsic rather than a list, so none of its variables reach the ' +
        'container (supply them with --env-vars)'
    );
  }

  const hooksObj = asObject(props['Hooks']);
  const hooks: Partial<Record<MicrovmHookName, MicrovmHookConfig>> = {};
  for (const [hook, where] of Object.entries(HOOK_KEYS) as [
    MicrovmHookName,
    (typeof HOOK_KEYS)[MicrovmHookName],
  ][]) {
    const group = asObject(hooksObj?.[where.group]);
    const value = group?.[where.key];
    if (value === undefined || value === 'DISABLED') continue;
    if (value !== 'ENABLED') {
      throw new CdkLocalError(
        `${subject} has Hooks.${where.group}.${where.key} ${describeValue(value)}; only the literal ` +
          `ENABLED or DISABLED can run locally.`,
        'LOCAL_START_MICROVM_HOOK_VALUE'
      );
    }
    const timeout = group?.[`${where.key}TimeoutInSeconds`];
    hooks[hook] = {
      timeoutSeconds: typeof timeout === 'number' && timeout > 0 ? timeout : undefined,
    };
  }
  const port = hooksObj?.['Port'];
  const hooksPort =
    typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : undefined;
  if (Object.keys(hooks).length > 0 && hooksPort === undefined) {
    throw new CdkLocalError(
      `${subject} enables lifecycle hooks (${Object.keys(hooks).join(', ')}) but has no literal ` +
        `Hooks.Port. Lambda requires the hooks port whenever a hook is configured; set Hooks.Port ` +
        `to the port the application serves /aws/lambda-microvms/runtime/v1/ on.`,
      'LOCAL_START_MICROVM_NO_HOOKS_PORT'
    );
  }

  const present = (key: string): boolean => {
    const v = props[key];
    return v !== undefined && !(Array.isArray(v) && v.length === 0);
  };
  if (present('EgressNetworkConnectors')) {
    unemulated.push("EgressNetworkConnectors (the container uses Docker's default network egress)");
  }
  if (present('AdditionalOsCapabilities')) {
    unemulated.push(
      "AdditionalOsCapabilities (the container runs with Docker's default capabilities)"
    );
  }
  if (present('Resources')) {
    unemulated.push('Resources sizing (the container gets no memory limit)');
  }
  if (present('Logging')) {
    unemulated.push(
      'Logging (container output is printed here instead of sent to CloudWatch Logs)'
    );
  }

  return { logicalId, name, codeKey, architecture, environment, hooksPort, hooks, unemulated };
}

/** `ARM_64` / `arm64` → `arm64`, `X86_64` / `x86_64` → `x86_64`. */
function normalizeArchitecture(raw: string): 'arm64' | 'x86_64' | undefined {
  const s = raw.toLowerCase().replace(/_/g, '');
  if (s === 'arm64') return 'arm64';
  if (s === 'x8664') return 'x86_64';
  return undefined;
}

/**
 * The object key of an `s3://<bucket>/<key>` URI as CDK synthesizes it — a
 * literal, an `Fn::Join` (`asset.s3ObjectUrl` under the default synthesizer)
 * or an `Fn::Sub`. The bucket may be an intrinsic; the key must be literal.
 * Exported for unit testing.
 */
export function s3KeyOfUri(value: unknown): string | undefined {
  const flat = flattenTemplateString(value);
  if (flat === undefined) return undefined;
  const m = /^s3:\/\/[^/]*\/(.+)$/.exec(flat);
  if (!m) return undefined;
  const key = m[1]!;
  return key.includes('\u0000') || key.includes('${') ? undefined : key;
}

/** A template string with every non-literal part replaced by NUL. */
function flattenTemplateString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const obj = asObject(value);
  if (!obj) return undefined;
  const join = obj['Fn::Join'];
  if (Array.isArray(join) && typeof join[0] === 'string' && Array.isArray(join[1])) {
    return (join[1] as unknown[]).map((p) => flattenTemplateString(p) ?? '\u0000').join(join[0]);
  }
  const sub = obj['Fn::Sub'];
  if (typeof sub === 'string') return sub.replace(/\$\{[^}]*\}/g, '\u0000');
  if (Array.isArray(sub) && typeof sub[0] === 'string') {
    return sub[0].replace(/\$\{[^}]*\}/g, '\u0000');
  }
  return '\u0000';
}

/** The image's code bundle on the host: a directory holding the `Dockerfile`. */
export interface MicrovmCodeArtifact {
  /** The build context — the asset directory, or an extracted copy of a `.zip`. */
  contextDir: string;
  /** Set when `contextDir` was extracted from a `.zip` asset; {@link disposeMicrovmCodeArtifact} removes it. */
  tmpDir?: string;
  /** The matched asset's manifest key (its source hash), for the image tag. */
  assetHash: string;
}

/**
 * Resolve `CodeArtifact.Uri` against the stack's cdk.out file assets and
 * return the build context (a `.zip` source is extracted, with the same
 * containment check every asset read goes through). A URI that matches no
 * local asset fails naming it: cdk-local does not download deployed code.
 */
export async function resolveMicrovmCodeArtifact(
  stack: StackInfo,
  config: MicrovmImageConfig,
  loader: AssetManifestLoader = new AssetManifestLoader()
): Promise<MicrovmCodeArtifact> {
  const subject = `MicroVM image ${displayUntrustedValue(config.logicalId)} code artifact`;
  const notFound = (): CdkLocalError =>
    new CdkLocalError(
      `${subject} (key ${displayUntrustedValue(config.codeKey)}) matches no file asset in this app's ` +
        `cdk.out. ${getEmbedConfig().cliName} start-microvm builds code that comes from a CDK asset in ` +
        `this app (for example an s3assets.Asset of a directory holding the Dockerfile); it does not ` +
        `download deployed code. Re-synthesize the app, or point CodeArtifact.Uri at an asset.`,
      'LOCAL_START_MICROVM_CODE_ASSET_NOT_FOUND'
    );
  const manifestPath = stack.assetManifestPath;
  if (!manifestPath) throw notFound();
  const manifestDir = dirname(manifestPath);
  const manifest = await loader.loadStackManifest(stack, manifestDir);
  const match = manifest ? findFileAssetForObjectKey(manifest, config.codeKey) : undefined;
  if (!match) throw notFound();
  if (typeof match.asset.source.path !== 'string' || match.asset.source.path.length === 0) {
    throw new CdkLocalError(
      `${subject} matches file asset ${displayIdent(match.hash)}, which has no source.path (it is ` +
        `produced by source.executable at publish time), so there is no staged bundle in cdk.out ` +
        `to build. Give the image an asset of a directory or a .zip file.`,
      'LOCAL_START_MICROVM_CODE_ASSET_NO_PATH'
    );
  }
  const sourcePath = resolveAssetSourcePath({
    manifestDir,
    value: match.asset.source.path,
    assetOutdir: assetPathDirs(stack).assetOutdir,
    absolute: 'honour-warn',
    field: 'source.path',
    subject,
    action: 'build it',
    sink: 'send that directory to docker build as the MicroVM image context',
    wrapError: (message) =>
      new CdkLocalError(message, 'LOCAL_START_MICROVM_CODE_SOURCE_ESCAPES_ASSEMBLY'),
  });
  if (!existsSync(sourcePath)) {
    throw new CdkLocalError(
      `${subject} source ${displayUntrustedValue(sourcePath)} does not exist. Re-synthesize the app and retry.`,
      'LOCAL_START_MICROVM_CODE_SOURCE_MISSING'
    );
  }
  if (!statSync(sourcePath).isDirectory() && !sourcePath.endsWith('.zip')) {
    throw new CdkLocalError(
      `${subject} source ${displayUntrustedValue(sourcePath)} is neither a directory nor a .zip ` +
        `archive, so it is not a code bundle.`,
      'LOCAL_START_MICROVM_CODE_SOURCE_NOT_BUNDLE'
    );
  }
  const materialized = materializeAssetCodeDir(sourcePath);
  const artifact: MicrovmCodeArtifact = {
    contextDir: materialized.dir,
    ...(materialized.tmpDir !== undefined && { tmpDir: materialized.tmpDir }),
    assetHash: match.hash,
  };
  if (!existsSync(join(materialized.dir, 'Dockerfile'))) {
    disposeMicrovmCodeArtifact(artifact);
    throw new CdkLocalError(
      `${subject} has no Dockerfile at its root. A MicroVM image's code artifact is a zip with a ` +
        `Dockerfile at the root plus the application files.`,
      'LOCAL_START_MICROVM_NO_DOCKERFILE'
    );
  }
  return artifact;
}

/** Remove what {@link resolveMicrovmCodeArtifact} extracted. Idempotent, best-effort. */
export function disposeMicrovmCodeArtifact(artifact: MicrovmCodeArtifact | undefined): void {
  if (artifact?.tmpDir === undefined) return;
  try {
    if (existsSync(artifact.tmpDir)) rmSync(artifact.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return displayUntrustedValue(value);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return displayUntrustedValue(json ?? String(value));
}
