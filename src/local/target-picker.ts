import { MultiSelectPrompt } from '@clack/core';
import {
  confirm,
  isCancel,
  select,
  S_BAR,
  S_BAR_END,
  S_BAR_START,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
} from '@clack/prompts';
import {
  CdkLocalError,
  InteractiveTtyRequiredError,
  TargetSelectionCancelledError,
} from '../utils/error-handler.js';
import { getEmbedConfig } from './embed-config.js';
import type { TargetEntry } from './target-lister.js';

// Minimal raw-ANSI helpers (cdk-local has no color-lib dependency; the
// logger uses raw escapes too). Kept local to the picker render.
const ANSI = {
  cyan: (s: string): string => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string): string => `\x1b[2m${s}\x1b[0m`,
  green: (s: string): string => `\x1b[32m${s}\x1b[0m`,
};

type PickerOption = { value: string; label: string; hint?: string };

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
  // Surface the API surface kind (REST API v1 / HTTP API v2 / Function URL /
  // WebSocket) as the hint so otherwise-similar start-api targets are
  // distinguishable. The stack-qualified logical ID is intentionally NOT
  // shown — this is a CDK tool, so the display path is the natural
  // identifier; `cdkl list -l` still prints the logical ID when needed.
  if (entry.kind) option.hint = entry.kind;
  return option;
}

/**
 * Prompt for exactly one target. Caller must have already confirmed a
 * TTY ({@link isInteractive}) and a non-empty `entries`. Throws
 * {@link TargetSelectionCancelledError} on Ctrl+C / Esc.
 */
export async function pickOneTarget(message: string, entries: TargetEntry[]): Promise<string> {
  const chosen = await select({
    message: `${message} (up/down to move, enter to select)`,
    options: entries.map(toOption),
  });
  if (isCancel(chosen)) throw new TargetSelectionCancelledError();
  return chosen as string;
}

/**
 * The selected-value array after a bulk action — `all` selects every
 * option, `none` clears the selection. Pure (no prompt state) so the
 * arrow-key bulk-select wiring is unit-testable without a TTY.
 */
export function bulkSelectValues(options: PickerOption[], action: 'all' | 'none'): string[] {
  return action === 'all' ? options.map((o) => o.value) : [];
}

/** Pre-compute the aligned `[kind] ` tag per option (blank when no kind). */
function kindTags(opts: PickerOption[]): string[] {
  const raw = opts.map((o) => (o.hint ? `[${o.hint}] ` : ''));
  const width = Math.max(0, ...raw.map((t) => t.length));
  return raw.map((t) => t.padEnd(width));
}

/**
 * Prompt for one or more targets. Caller must have already confirmed a TTY
 * and a non-empty `entries`. Throws {@link TargetSelectionCancelledError}
 * on Ctrl+C / Esc, on an empty selection (the user chose nothing), or when
 * the confirmation step is declined.
 *
 * Built on `@clack/core`'s `MultiSelectPrompt` (rather than the high-level
 * `multiselect`) so it can add bulk-selection keys the high-level wrapper
 * does not expose: Up/Down move, Space toggles, **Right selects all**,
 * **Left clears all**, Enter confirms. `MultiSelectPrompt` tracks the
 * selection in `this.value`, so the Right/Left handlers set it directly —
 * the same mechanism the built-in `toggleAll` uses.
 *
 * Rows start UNSELECTED. Each row is prefixed with its surface kind
 * (`[HTTP API v2] MyApi`) — always shown, padded so labels align. Submitting
 * with nothing selected exits cleanly; a non-empty selection goes through a
 * Y/n confirmation before returning.
 */
export async function pickManyTargets(message: string, entries: TargetEntry[]): Promise<string[]> {
  const opts: PickerOption[] = entries.map(toOption);
  const tags = kindTags(opts);

  const prompt = new MultiSelectPrompt<PickerOption>({
    options: opts,
    // Allow an empty submit — handled below as "exit", rather than clack's
    // built-in "select at least one" error, which the user found confusing.
    required: false,
    render() {
      const header = `${S_BAR_START}  ${message}`;
      if (this.state === 'submit' || this.state === 'cancel') {
        const n = (this.value ?? []).length;
        return `${header}\n${S_BAR}  ${`${n} selected`}`;
      }
      const selected = new Set(this.value ?? []);
      const rows = this.options.map((opt, i) => {
        const isActive = i === this.cursor;
        const isSelected = selected.has(opt.value);
        const box = isSelected
          ? S_CHECKBOX_SELECTED
          : isActive
            ? S_CHECKBOX_ACTIVE
            : S_CHECKBOX_INACTIVE;
        // Whole row coloured by state: active = cyan, selected = green,
        // otherwise plain (the terminal's default fg — never dim/grey, which
        // is hard to read). The `[kind]` tag follows the row's colour.
        const text = `${tags[i]}${opt.label}`;
        const coloured = isActive ? ANSI.cyan(text) : isSelected ? ANSI.green(text) : text;
        return `${S_BAR}  ${box} ${coloured}`;
      });
      const keys = ANSI.dim('space toggle · → all · ← none · enter confirm');
      return `${header}\n${rows.join('\n')}\n${S_BAR}  ${keys}\n${S_BAR_END}`;
    },
  });

  // Right selects every row; Left clears. MultiSelectPrompt uses Up/Down for
  // the cursor and Space to toggle, so Left/Right are free. Setting
  // `prompt.value` is exactly how the built-in toggleAll works; the prompt
  // re-renders after each keypress.
  prompt.on('key', (_char, info) => {
    if (info?.name === 'right') prompt.value = bulkSelectValues(opts, 'all');
    else if (info?.name === 'left') prompt.value = bulkSelectValues(opts, 'none');
  });

  const picked = await prompt.prompt();
  if (isCancel(picked)) throw new TargetSelectionCancelledError();
  const values = (picked as string[] | undefined) ?? [];
  // Nothing selected -> exit cleanly instead of doing something surprising.
  if (values.length === 0) throw new TargetSelectionCancelledError();

  // Confirmation step before committing to the (possibly large) run.
  const summary = values.length === 1 ? '1 target' : `${values.length} targets`;
  const ok = await confirm({ message: `Run ${summary}?` });
  if (isCancel(ok) || ok !== true) throw new TargetSelectionCancelledError();
  return values;
}

interface ResolveParams {
  /** Candidate targets for this command's category. */
  entries: TargetEntry[];
  /** Prompt header, e.g. "Select a Lambda function to invoke". */
  message: string;
  /** Plural noun for the empty-candidates error, e.g. "Lambda functions". */
  noun: string;
  /** The command's existing "target argument is required" error, thrown when omitted in a non-TTY context. */
  onMissing: () => CdkLocalError;
}

function ensureCanPrompt(onMissing: () => CdkLocalError): void {
  if (isInteractive()) return;
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
 * target is omitted in a TTY.
 *
 * - `provided` set → returned as-is (no prompt).
 * - omitted, TTY → prompt.
 * - omitted, no TTY → `onMissing()` (the command's required-arg error).
 */
export async function resolveSingleTarget(
  provided: string | undefined,
  params: ResolveParams
): Promise<string> {
  if (provided) return provided;
  ensureCanPrompt(params.onMissing);
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
  if (provided.length > 0) return provided;
  ensureCanPrompt(params.onMissing);
  ensureHasCandidates(params.entries.length, params.noun);
  return pickManyTargets(params.message, params.entries);
}
