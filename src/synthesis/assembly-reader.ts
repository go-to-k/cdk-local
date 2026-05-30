import {
  AssetManifestArtifact,
  type CloudFormationStackArtifact,
} from '@aws-cdk/cloud-assembly-api';
import { Toolkit, CdkAppMultiContext, BaseCredentials } from '@aws-cdk/toolkit-lib';
import { CdklIoHost } from './cdkl-io-host.js';
import type { CloudFormationTemplate } from '../types/resource.js';

/**
 * Stack information extracted from a CDK Cloud Assembly.
 *
 * cdk-local delegates synthesis to `@aws-cdk/toolkit-lib`
 * (`Toolkit.fromCdkApp()` + `Toolkit.synth()`) and maps each synthesized
 * `CloudFormationStackArtifact` to a `StackInfo` record.
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
  /**
   * AWS profile used for toolkit-lib's OWN AWS calls — most importantly
   * the synth-time context lookups (assume `cdk-hnb659fds-lookup-role-*`
   * + the SSM / VPC / etc. provider call). Without this, those lookups
   * fall back to the parent process's default credential chain even
   * when `--profile` was supplied, so a cross-account lookup-role
   * assume resolves with the wrong account and synthesis aborts with
   * `AssemblyError: Found errors`. Setting `env.AWS_PROFILE` alone is
   * not enough: that only reaches the forked CDK app subprocess, not
   * the lookup machinery that runs in this process.
   */
  profile?: string;
  /** Default region for toolkit-lib's own AWS calls (context lookups). */
  region?: string;
  /**
   * Working directory the CDK app subprocess is executed in. Defaults
   * to the current process cwd. When `context` is also set, this is
   * also the directory `CdkAppMultiContext` resolves `cdk.json` /
   * `cdk.context.json` / `~/.cdk.json` against.
   */
  workingDirectory?: string;
  /**
   * Commandline context overrides (CDK CLI `-c key=value`).
   *
   * Threaded through `CdkAppMultiContext(workingDirectory, context)` so
   * cdk.json / cdk.context.json / ~/.cdk.json remain the base layer and
   * CLI overrides win for keys they touch. Empty / undefined leaves
   * toolkit-lib's default context store (CdkAppMultiContext with no
   * commandline context) in place.
   */
  context?: Record<string, string>;
}

export class AssemblyReader {
  /**
   * Synthesize the CDK app and return `StackInfo` for every stack
   * artifact in the resulting Cloud Assembly.
   */
  async read(cdkAppCommand: string, options: AssemblyReadOptions = {}): Promise<StackInfo[]> {
    const toolkit = new Toolkit({
      ioHost: new CdklIoHost(),
      sdkConfig: {
        baseCredentials: BaseCredentials.awsCliCompatible({
          ...(options.profile !== undefined && { profile: options.profile }),
          ...(options.region !== undefined && { defaultRegion: options.region }),
        }),
      },
    });
    const hasContextOverrides =
      options.context !== undefined && Object.keys(options.context).length > 0;
    const source = await toolkit.fromCdkApp(cdkAppCommand, {
      ...(options.outdir !== undefined && { outdir: options.outdir }),
      ...(options.env !== undefined && { env: options.env }),
      ...(options.workingDirectory !== undefined && {
        workingDirectory: options.workingDirectory,
      }),
      ...(hasContextOverrides && {
        contextStore: new CdkAppMultiContext(
          options.workingDirectory ?? process.cwd(),
          options.context
        ),
      }),
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
   *
   * `failOnMissingContext: false` matches CDK CLI's own behavior for
   * `cdk deploy --app cdk.out`. CDK CLI's `cxapp/exec.js` bypasses
   * `Toolkit.fromAssemblyDirectory()` entirely on this path and builds
   * the assembly via `@aws-cdk/cloud-assembly-api`'s `CloudAssembly`
   * directly, which does NOT enforce a missing-context check; then
   * `cxapp/cloud-executable.js` attempts a single context-provider
   * resolve, and if no progress is made it returns the assembly as-is
   * with `manifest.missing` still populated. The strict default that
   * `fromAssemblyDirectory()` carries is a toolkit-lib decision aimed
   * at programmatic deploy callers, not parity with CDK CLI semantics.
   *
   * cdk-local's needs are looser still: we only read the synthesized
   * template, and under `--from-cfn-stack` runtime values come from
   * the deployed CFN stack anyway. Refusing here just makes the
   * pre-synth flow unusable for any app that relies on context
   * lookups (SSM / VPC / AMI / etc.), without any safety benefit.
   */
  async readFromDirectory(assemblyDir: string): Promise<StackInfo[]> {
    const toolkit = new Toolkit({ ioHost: new CdklIoHost() });
    const source = await toolkit.fromAssemblyDirectory(assemblyDir, {
      failOnMissingContext: false,
    });
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
  // Locate the AssetManifestArtifact among the stack's dependencies and
  // surface its absolute path. Downstream resolvers (`lambda-resolver.ts`,
  // `ecs-task-resolver.ts`, etc.) read `dirname(assetManifestPath)` to find
  // the cdk.out directory where every `asset.<hash>` subdirectory lives —
  // without this, the fallback `process.cwd()` resolves asset directories
  // against the user's CWD instead of cdk.out, so `cdkl invoke`'s
  // asset-directory existence check fires a `LocalInvokeResolutionError`
  // for every Lambda whose code was synthesized as a separate asset.
  const assetManifest = stack.dependencies.find(
    (d): d is AssetManifestArtifact => d instanceof AssetManifestArtifact
  );
  if (assetManifest) {
    info.assetManifestPath = assetManifest.file;
  }
  return info;
}
