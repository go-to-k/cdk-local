import { NonInteractiveIoHost, type IoMessage } from '@aws-cdk/toolkit-lib';
import { renderLogText, resolveConfiguredLogLevel } from '../utils/logger.js';

/** An SGR (colour / style) escape — the only ANSI sequence a message may carry. */
// eslint-disable-next-line no-control-regex -- ESC is exactly what is matched.
const ANSI_SGR_RE = /\u001b\[[0-9;]*m/g;

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
 *
 * When `CDKL_LOG_LEVEL` resolves to `warn` / `error` (set by `cdkl studio`
 * on its single-shot `cdkl invoke` child), the synth-progress notifications
 * above — and any other non-`warn`/`error` toolkit message — are dropped
 * entirely, so cdk-local's own synth chatter never reaches the child's
 * stderr. This keeps the studio LOGS panel free of "Successfully
 * synthesized to ..." / asset-bundling noise; real synth failures still
 * surface (toolkit raises `AssemblyError` on non-zero subprocess exit, and
 * `warn` / `error` messages still pass through).
 *
 * It also DROPS the "Supply a stack id (...) to display its template."
 * line `Toolkit.synth()` emits when an assembly has more than one stack.
 * That hint is CDK CLI advice for picking a single stack to print a
 * template for — irrelevant to cdk-local, which synthesizes the whole app
 * and never prints templates. toolkit-lib emits it via
 * `ioHelper.defaults.info(...)` with NO message `code`, so it can only be
 * matched on its text; left unfiltered it pollutes the output of every
 * multi-stack `start-alb` / `start-service` / `studio` synth (it surfaced
 * in the studio ALB-serve LOGS panel).
 *
 * Every relayed message's TEXT goes through {@link renderToolkitMessageText}
 * (go-to-k/cdk-local#827): a toolkit message interpolates assembly-chosen text
 * (a stack id, a metadata annotation, a line the CDK app wrote to stderr), and
 * `NonInteractiveIoHost` writes it straight to the stream, bypassing cdk-local's
 * logger and so its control escape.
 */
export class CdklIoHost extends NonInteractiveIoHost {
  private readonly suppressNonWarnings = (() => {
    const level = resolveConfiguredLogLevel();
    return level === 'warn' || level === 'error';
  })();

  async notify(msg: IoMessage<unknown>): Promise<void> {
    if (isStackIdTemplateHint(msg)) {
      return;
    }

    const reclassified =
      msg.code === 'CDK_ASSEMBLY_E1002' ||
      msg.code === 'CDK_TOOLKIT_I1901' ||
      msg.code === 'CDK_TOOLKIT_I1902'
        ? { ...msg, level: 'info' as const }
        : msg;

    if (
      this.suppressNonWarnings &&
      reclassified.level !== 'warn' &&
      reclassified.level !== 'error'
    ) {
      return;
    }
    if (typeof reclassified.message !== 'string') return super.notify(reclassified);
    return super.notify({
      ...reclassified,
      message: renderToolkitMessageText(reclassified.message),
    });
  }
}

/**
 * Render a toolkit message's text the way cdk-local's logger renders its own
 * ({@link renderLogText}), after STRIPPING its SGR colour escapes rather than
 * escaping them: toolkit-lib colours a stack id or a hint with chalk, and a
 * TTY would otherwise show that colour as literal `\u001b[1m` text. The level
 * colour `NonInteractiveIoHost.formatMessage` adds is applied AFTER this, so it
 * survives. Stripping runs FIRST, so an ESC the strip leaves adjacent to a
 * `[` (`\x1b\x1b[0m[2J`) is still escaped by the second step.
 */
export function renderToolkitMessageText(text: string): string {
  return renderLogText(text.replace(ANSI_SGR_RE, ''));
}

/**
 * Detects the multi-stack "Supply a stack id (...) to display its template."
 * hint `Toolkit.synth()` emits with no message `code`. The stack ids inside
 * the parens may carry chalk colour codes, but the literal prefix and suffix
 * are plain text, so a prefix+suffix text match is robust to colour.
 */
function isStackIdTemplateHint(msg: IoMessage<unknown>): boolean {
  return (
    msg.code === undefined &&
    typeof msg.message === 'string' &&
    msg.message.startsWith('Supply a stack id ') &&
    msg.message.includes('to display its template')
  );
}
