import { AssemblyReader, type StackInfo, type AssemblyReadOptions } from './assembly-reader.js';

/**
 * Synthesis options accepted by the four `cdkl` commands.
 *
 * Mirrors the cdkd `SynthesisOptions` shape so ported source files
 * compile without rewrites. cdk-local delegates the heavy lifting to
 * `@aws-cdk/toolkit-lib`'s `Toolkit.fromCdkApp()` (via {@link AssemblyReader}),
 * which handles subprocess execution + manifest parsing + context
 * resolution internally — there is no per-field substitution layer like
 * cdkd's hand-rolled `AppExecutor` / `ContextStore` / context-provider
 * loop.
 */
export interface SynthesisOptions {
  /** CDK app command or pre-synthesized assembly directory (cdk.json `app`). */
  app: string;
  /** Output directory for synthesis (default: `cdk.out`). */
  output?: string;
  /** AWS profile passed to the CDK app subprocess via `AWS_PROFILE`. */
  profile?: string;
  /** AWS region passed to the CDK app subprocess via `AWS_REGION` / `CDK_DEFAULT_REGION`. */
  region?: string;
  /**
   * Context key-value pairs (CLI `-c`/`--context`).
   *
   * Accepted for API parity with the cdkd shape, but currently NOT
   * forwarded to the CDK app subprocess — cdk-local relies on
   * `cdk.json` / `cdk.context.json` for context. CLI overrides land in
   * a Phase 2d-2 follow-up.
   */
  context?: Record<string, string>;
}

export interface SynthesisResult {
  /** All stacks in the assembly. */
  stacks: StackInfo[];
}

/**
 * Thin wrapper around {@link AssemblyReader} that mimics cdkd's
 * `Synthesizer` API so the ported `cdkl invoke` / `start-api` /
 * `run-task` / `start-service` source compiles without rewrites.
 */
export class Synthesizer {
  async synthesize(opts: SynthesisOptions): Promise<SynthesisResult> {
    const reader = new AssemblyReader();
    const readOpts: AssemblyReadOptions = {};
    if (opts.output !== undefined) {
      readOpts.outdir = opts.output;
    }
    const env: Record<string, string | undefined> = {};
    if (opts.profile !== undefined) {
      env['AWS_PROFILE'] = opts.profile;
    }
    if (opts.region !== undefined) {
      env['AWS_REGION'] = opts.region;
      env['CDK_DEFAULT_REGION'] = opts.region;
    }
    if (Object.keys(env).length > 0) {
      readOpts.env = env;
    }
    const stacks = await reader.read(opts.app, readOpts);
    return { stacks };
  }
}
