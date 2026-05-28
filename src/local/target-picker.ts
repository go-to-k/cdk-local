import { isCancel, multiselect, select } from '@clack/prompts';
import {
  CdkLocalError,
  InteractiveTtyRequiredError,
  TargetSelectionCancelledError,
} from '../utils/error-handler.js';
import { getEmbedConfig } from './embed-config.js';
import type { TargetEntry } from './target-lister.js';

/**
 * True when both stdin and stdout are TTYs — the precondition for any
 * interactive prompt. In a pipe / CI / non-interactive shell this is
 * false and the caller must fall back (error, or the command's default
 * behavior) rather than block on a prompt that can never be answered.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function toOption(entry: TargetEntry): { value: string; label: string; hint?: string } {
  // The display path is the recommended copy-paste form; fall back to the
  // stack-qualified logical ID when the resource has no `aws:cdk:path`.
  const value = entry.displayPath ?? entry.qualifiedId;
  const option: { value: string; label: string; hint?: string } = { value, label: value };
  if (entry.displayPath) option.hint = entry.qualifiedId;
  return option;
}

/**
 * Prompt for exactly one target. Caller must have already confirmed a
 * TTY ({@link isInteractive}) and a non-empty `entries`. Throws
 * {@link TargetSelectionCancelledError} on Ctrl+C / Esc.
 */
export async function pickOneTarget(message: string, entries: TargetEntry[]): Promise<string> {
  const chosen = await select({ message, options: entries.map(toOption) });
  if (isCancel(chosen)) throw new TargetSelectionCancelledError();
  return chosen as string;
}

/**
 * Prompt for one or more targets (at least one required). Caller must
 * have already confirmed a TTY and a non-empty `entries`. Throws
 * {@link TargetSelectionCancelledError} on Ctrl+C / Esc.
 */
export async function pickManyTargets(message: string, entries: TargetEntry[]): Promise<string[]> {
  const chosen = await multiselect({ message, options: entries.map(toOption), required: true });
  if (isCancel(chosen)) throw new TargetSelectionCancelledError();
  return chosen as string[];
}

interface ResolveParams {
  /** Whether `-i/--interactive` was passed. */
  interactive: boolean;
  /** Candidate targets for this command's category. */
  entries: TargetEntry[];
  /** Prompt header, e.g. "Select a Lambda function to invoke". */
  message: string;
  /** Plural noun for the empty-candidates error, e.g. "Lambda functions". */
  noun: string;
  /** The command's existing "target argument is required" error, thrown when omitted in a non-TTY context. */
  onMissing: () => CdkLocalError;
}

function ensureCanPrompt(interactive: boolean, onMissing: () => CdkLocalError): void {
  if (isInteractive()) return;
  if (interactive) {
    throw new InteractiveTtyRequiredError(
      '`-i/--interactive` requires an interactive terminal, but stdin/stdout is not a TTY.'
    );
  }
  // Target omitted in a non-interactive context — preserve the command's
  // original "required argument" behavior.
  throw onMissing();
}

function ensureHasCandidates(count: number, noun: string): void {
  if (count > 0) return;
  throw new InteractiveTtyRequiredError(
    `No ${noun} found in this CDK app to choose from. Run \`${getEmbedConfig().cliName} list\` to see what is available.`
  );
}

/**
 * Resolve a single positional target, prompting interactively when the
 * user passed `-i/--interactive` or omitted the target in a TTY.
 *
 * - `provided` set and no `-i` → returned as-is (no prompt).
 * - `-i` set → always prompt (any `provided` value is ignored).
 * - omitted, TTY → prompt.
 * - omitted, no TTY → `onMissing()` (the command's required-arg error).
 */
export async function resolveSingleTarget(
  provided: string | undefined,
  params: ResolveParams
): Promise<string> {
  if (provided && !params.interactive) return provided;
  ensureCanPrompt(params.interactive, params.onMissing);
  ensureHasCandidates(params.entries.length, params.noun);
  return pickOneTarget(params.message, params.entries);
}

/**
 * Resolve one or more positional targets (the `start-service` variadic
 * shape), prompting with a multi-select when appropriate. Same trigger
 * rules as {@link resolveSingleTarget}.
 */
export async function resolveMultiTarget(
  provided: string[],
  params: ResolveParams
): Promise<string[]> {
  if (provided.length > 0 && !params.interactive) return provided;
  ensureCanPrompt(params.interactive, params.onMissing);
  ensureHasCandidates(params.entries.length, params.noun);
  return pickManyTargets(params.message, params.entries);
}
