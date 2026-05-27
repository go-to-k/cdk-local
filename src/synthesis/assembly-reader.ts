import type { CloudFormationStackArtifact } from '@aws-cdk/cloud-assembly-api';
import { Toolkit } from '@aws-cdk/toolkit-lib';
import type { CloudFormationTemplate } from '../types/resource.js';

/**
 * Stack information extracted from a CDK Cloud Assembly.
 *
 * This interface mirrors the shape cdkd's `src/local/**` files import,
 * so the ported source compiles without rewrites. The backing
 * implementation differs: cdkd parses `cdk.out/manifest.json` by hand
 * (PR #4 self-implemented synth); cdk-local delegates to
 * `@aws-cdk/toolkit-lib` (`Toolkit.fromCdkApp()` + `Toolkit.synth()`)
 * and maps each synthesized `CloudFormationStackArtifact` to a
 * `StackInfo` record.
 */
export interface StackInfo {
  /** Physical CloudFormation stack name (e.g., "MyStage-MyStack"). */
  stackName: string;

  /**
   * Hierarchical display name from CDK synth (e.g., "MyStage/MyStack"
   * for stacks under a Stage, or "MyStack" at the top level). Falls
   * back to `artifactId` when the artifact does not carry one.
   */
  displayName: string;

  /** Artifact ID in manifest (typically equals `stackName` for top-level stacks). */
  artifactId: string;

  /** Synthesized CloudFormation template (JSON). */
  template: CloudFormationTemplate;

  /** Asset manifest file path (absolute). Populated when the stack ships assets. */
  assetManifestPath?: string | undefined;

  /** Stack dependency names (other stack artifact IDs this stack depends on). */
  dependencyNames: string[];

  /** Target region from CDK environment (`Stack.region`). */
  region?: string | undefined;

  /** Target account from CDK environment (`Stack.account`). */
  account?: string | undefined;

  /**
   * Stack-level termination protection (CDK `Stack.terminationProtection`).
   * Informational only for cdk-local — local execution does not honor
   * deploy-time termination protection.
   */
  terminationProtection?: boolean | undefined;

  /**
   * Per-logical-id absolute file paths of nested templates one level
   * below this stack — populated when the parent template contains
   * `AWS::CloudFormation::Stack` resources whose
   * `Metadata['aws:asset:path']` points at the child's
   * `<file>.nested.template.json` sibling in the same `cdk.out`
   * directory.
   *
   * TODO(phase-2d-2): populate from the synthesized assembly. Until the
   * 4 CLI factories actually consume nested templates, leaving this
   * `undefined` is non-fatal for cdk-local's smoke path.
   */
  nestedTemplates?: Record<string, string> | undefined;
}

/**
 * Reads and parses a CDK Cloud Assembly via `@aws-cdk/toolkit-lib`.
 *
 * Two accepted inputs:
 *
 *   - `read(cdkAppCommand)` — pass a CDK app entrypoint command (the
 *     same string `cdk.json`'s `app` field carries, e.g.
 *     `"npx tsx bin/app.ts"`). Internally invokes `Toolkit.fromCdkApp()`,
 *     which forks the CDK app as a subprocess with the standard
 *     `CDK_OUTDIR` / `CDK_CONTEXT_JSON` / `CDK_DEFAULT_*` env contract,
 *     waits for the assembly to materialize, then synths it.
 *
 *   - `readFromDirectory(assemblyDir)` — point at an existing `cdk.out`
 *     directory produced by a prior `cdk synth`. Skips the subprocess
 *     hop; useful in CI where the synth step has already run.
 *
 * Both paths produce the same `StackInfo[]` shape so downstream
 * consumers (Lambda resolver, route discovery, ECS task resolver, etc.)
 * do not branch on the input mode.
 */
/**
 * Read options forwarded to `Toolkit.fromCdkApp` / `Toolkit.fromAssemblyDirectory`.
 */
export interface AssemblyReadOptions {
  /** Output directory for synthesized assembly (default: `cdk.out`). */
  outdir?: string;
  /** Additional env vars passed to the CDK app subprocess (e.g. `AWS_PROFILE`, `AWS_REGION`). */
  env?: Record<string, string | undefined>;
}

export class AssemblyReader {
  /**
   * Synthesize the CDK app and return `StackInfo` for every stack
   * artifact in the resulting Cloud Assembly.
   */
  async read(cdkAppCommand: string, options: AssemblyReadOptions = {}): Promise<StackInfo[]> {
    const toolkit = new Toolkit();
    const source = await toolkit.fromCdkApp(cdkAppCommand, {
      ...(options.outdir !== undefined && { outdir: options.outdir }),
      ...(options.env !== undefined && { env: options.env }),
    });
    const cached = await toolkit.synth(source);
    try {
      return cached.cloudAssembly.stacks.map((stack) => mapStackArtifact(stack));
    } finally {
      await cached.dispose();
    }
  }

  /**
   * Read a pre-synthesized Cloud Assembly directory (no subprocess).
   */
  async readFromDirectory(assemblyDir: string): Promise<StackInfo[]> {
    const toolkit = new Toolkit();
    const source = await toolkit.fromAssemblyDirectory(assemblyDir);
    const cached = await toolkit.synth(source);
    try {
      return cached.cloudAssembly.stacks.map((stack) => mapStackArtifact(stack));
    } finally {
      await cached.dispose();
    }
  }
}

function mapStackArtifact(stack: CloudFormationStackArtifact): StackInfo {
  const info: StackInfo = {
    stackName: stack.stackName,
    displayName: stack.displayName ?? stack.id,
    artifactId: stack.id,
    template: stack.template as CloudFormationTemplate,
    dependencyNames: stack.dependencies.map((d) => d.id),
  };
  if (stack.environment.region) {
    info.region = stack.environment.region;
  }
  if (stack.environment.account) {
    info.account = stack.environment.account;
  }
  if (stack.terminationProtection !== undefined) {
    info.terminationProtection = stack.terminationProtection;
  }
  return info;
}
