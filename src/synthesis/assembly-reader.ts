import type { CloudFormationTemplate } from '../types/resource.js';

/**
 * Stack information extracted from a CDK Cloud Assembly.
 *
 * This interface mirrors cdkd's `StackInfo` shape so files ported from
 * cdkd `src/local/**` can `import type { StackInfo }` unchanged. The
 * backing implementation differs: cdkd parses `cdk.out/manifest.json`
 * by hand (PR #4 self-implemented synth); cdk-local delegates to
 * `@aws-cdk/toolkit-lib` (Phase 2d implements the adapter that maps
 * toolkit-lib's `CloudAssembly` → `StackInfo[]`).
 */
export interface StackInfo {
  /** Physical CloudFormation stack name (e.g., "MyStage-MyStack"). */
  stackName: string;

  /**
   * Hierarchical display name from CDK synth (e.g., "MyStage/MyStack"
   * for stacks under a Stage, or "MyStack" at the top level). Falls
   * back to `stackName` when the assembly does not carry one.
   */
  displayName: string;

  /** Artifact ID in manifest. */
  artifactId: string;

  /** CloudFormation template. */
  template: CloudFormationTemplate;

  /** Asset manifest file path (absolute). */
  assetManifestPath?: string | undefined;

  /** Stack dependency names (other stacks this stack depends on). */
  dependencyNames: string[];

  /** Target region from CDK environment. */
  region?: string | undefined;

  /** Target account from CDK environment. */
  account?: string | undefined;

  /**
   * Stack-level termination protection (CDK `Stack.terminationProtection`).
   * cdk-local does not deploy / destroy, so this field is informational
   * only — callers may surface it in `cdkl --help` / debug output.
   */
  terminationProtection?: boolean | undefined;

  /**
   * Per-logical-id absolute file paths of nested templates one level
   * below this stack — populated when the parent template contains
   * `AWS::CloudFormation::Stack` resources whose
   * `Metadata['aws:asset:path']` points at the child's
   * `<file>.nested.template.json` sibling in the same `cdk.out`
   * directory.
   */
  nestedTemplates?: Record<string, string> | undefined;
}

/**
 * Reads and parses a CDK Cloud Assembly via `@aws-cdk/toolkit-lib`.
 *
 * Phase 2b: stub. Phase 2d will implement `read(cdkAppPath)` using
 * `Toolkit.fromCdkApp()` + `Toolkit.synth()` and map each synthesized
 * stack artifact into the `StackInfo` shape above. Until then, calling
 * `read()` throws — only the `StackInfo` type re-export is consumed.
 */
export class AssemblyReader {
  async read(_cdkAppPath: string): Promise<StackInfo[]> {
    throw new Error(
      'AssemblyReader.read is not yet implemented (Phase 2d will wire @aws-cdk/toolkit-lib).'
    );
  }
}
