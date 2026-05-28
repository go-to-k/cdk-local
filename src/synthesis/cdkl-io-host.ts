import { NonInteractiveIoHost, type IoMessage } from '@aws-cdk/toolkit-lib';

/**
 * Custom IoHost that prevents cdk-local from coloring CDK app subprocess
 * stderr lines as errors.
 *
 * `@aws-cdk/toolkit-lib` classifies every line a synthesized CDK app
 * emits on stderr as `CDK_ASSEMBLY_E1002` — an error-level message —
 * which the default `NonInteractiveIoHost` colors red via chalk. CDK
 * apps routinely emit non-error progress on stderr (e.g. the
 * "Bundling asset ..." lines `aws-cdk-lib`'s asset bundlers print at
 * synth time), so the default styling fires red on benign output and
 * trains users to dismiss the color in the UI.
 *
 * cdk-local re-classifies `CDK_ASSEMBLY_E1002` as info-level so the
 * line renders in the default terminal color. Real CDK app failures
 * still surface — toolkit-lib raises an `AssemblyError` when the
 * subprocess exits non-zero and the parent throws straight out of
 * `Synthesizer.synthesize()`. The only change here is the color of the
 * progress lines mid-synth.
 *
 * It also re-classifies the synth-success notifications
 * (`CDK_TOOLKIT_I1901` single-stack / `CDK_TOOLKIT_I1902` multi-stack,
 * "Successfully synthesized to ...") from `result` level to `info`.
 * toolkit-lib sends `result`-level messages to stdout unconditionally,
 * which pollutes the stdout of every synthesizing command. Re-leveling
 * to `info` routes them to stderr in a normal terminal. This matters
 * most for `cdkl list`, whose stdout is a parseable target list — that
 * command additionally writes its own `Synthesizing...` status to
 * stderr so its stdout is exactly the list. These are status lines no
 * caller parses from cdk-local's stdout.
 */
export class CdklIoHost extends NonInteractiveIoHost {
  async notify(msg: IoMessage<unknown>): Promise<void> {
    if (
      msg.code === 'CDK_ASSEMBLY_E1002' ||
      msg.code === 'CDK_TOOLKIT_I1901' ||
      msg.code === 'CDK_TOOLKIT_I1902'
    ) {
      return super.notify({ ...msg, level: 'info' });
    }
    return super.notify(msg);
  }
}
