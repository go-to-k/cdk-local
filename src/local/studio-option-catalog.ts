/**
 * Auto-derived full-flag catalog for `cdkl studio` (issue #301).
 *
 * The per-target {@link OPTION_SPECS} in `studio-option-specs.ts` is a
 * CURATED subset — the handful of flags worth a rich control (a checkbox, a
 * KV editor, an add-row list). But a command like `cdkl start-api` accepts
 * many more flags than studio renders a control for, and hiding them makes
 * the UI strictly less capable than the headless CLI.
 *
 * This module closes that gap by INTROSPECTING each runnable kind's Commander
 * command factory and emitting the complete flag list (name + description).
 * The studio UI serializes it into the page and renders, inside a collapsed
 * "All options" section, (a) the full catalog as a read-only reference and
 * (b) a raw extra-args input (see {@link tokenizeRawArgs}) so any flag the
 * curated controls don't expose can still be passed verbatim. Auto-derivation
 * means the catalog can never drift from the command's real option set.
 *
 * Session-global flags (handled by the studio Session bar / `studio-child-args`)
 * and the auto-added `--help` / `--version` are excluded — passing them per-run
 * would conflict with the session-wide wiring.
 */

import { createLocalInvokeCommand } from '../cli/commands/local-invoke.js';
import { createLocalInvokeAgentCoreCommand } from '../cli/commands/local-invoke-agentcore.js';
import { createLocalStartApiCommand } from '../cli/commands/local-start-api.js';
import { createLocalStartAlbCommand } from '../cli/commands/local-start-alb.js';
import { createLocalStartServiceCommand } from '../cli/commands/local-start-service.js';
import { createLocalStartCloudFrontCommand } from '../cli/commands/local-start-cloudfront.js';
import { createLocalStartAgentCoreCommand } from '../cli/commands/local-start-agentcore.js';
import { createLocalRunTaskCommand } from '../cli/commands/local-run-task.js';
import { getEmbedConfig, setEmbedConfig, type CdkLocalEmbedConfig } from './embed-config.js';
import { OPTION_SPECS } from './studio-option-specs.js';
import type { StudioTargetKind } from './studio-events.js';
import type { Command } from 'commander';

/** One flag the underlying command accepts. */
export interface FlagInfo {
  /** The Commander flags string, e.g. `-e, --event <file>` or `--tls`. */
  flags: string;
  /** The option's help description (may be empty). */
  description: string;
  /** The long flag name, e.g. `--tls` / `--no-pull` (the control's value key). */
  long: string;
  /** True when the flag takes a value (`<x>` / `[x]`) — render an input/select. */
  takesValue: boolean;
  /** True for a `--no-xxx` negate flag (a boolean that emits the bare flag). */
  negate: boolean;
  /** True for a variadic value flag (`<x...>`). */
  variadic: boolean;
  /** The placeholder parsed from the flags' value token (`<file>` -> `file`). */
  placeholder?: string;
  /** The allowed values when the option declares `.choices(...)`. */
  choices?: string[];
  /**
   * True when the studio UI should auto-render an input control for this flag
   * in the "All options" section: it is NEITHER curated (a rich control already
   * exists in {@link OPTION_SPECS}) NOR studio-managed (injected by studio
   * itself — see {@link CATALOG_MANAGED_FLAGS}). A non-renderable flag stays in
   * the catalog (so the count / reference is complete) but the UI skips it.
   */
  renderable: boolean;
}

/** The full flag catalog for one runnable kind. */
export interface KindFlagCatalog {
  /** The headless subcommand these flags belong to, e.g. `start-api`. */
  command: string;
  /** Every flag the command accepts, minus session-global + help/version. */
  flags: FlagInfo[];
}

/**
 * Long flag names handled by the session bar / `studio-child-args` (forwarded
 * to every spawned child once, session-wide). Excluded from the per-target
 * catalog so a user does not re-specify them per-run and collide with the
 * session-wide value. Plus the Commander-managed `--help` / `--version`.
 */
export const CATALOG_EXCLUDED_FLAGS: ReadonlySet<string> = new Set([
  '--app',
  '--profile',
  '--region',
  '--context',
  '--from-cfn-stack',
  '--assume-role',
  '--help',
  '--version',
]);

/**
 * Long flags studio INJECTS or binds itself per run, so the "All options"
 * section must NOT auto-render an editable control for them (a user-set value
 * would collide with — or break — studio's own wiring). They still appear in
 * the catalog (so it stays a complete reference), just `renderable: false`; a
 * power user can still force one via the raw extra-args input, which is
 * appended last.
 *
 * - `--event` / `--response-file`: studio writes the composed event /
 *   response-capture file and passes these itself (the invoke kinds).
 * - `--host` / `--port`: the serve-manager binds the listen host/port and the
 *   capture proxy fronts it; a user override would desync the proxy URL.
 * - `--watch`: the session-global Session-bar toggle (appended by the
 *   serve-manager from the mutable config), not a per-run flag.
 * - `--image-override` / `--no-interactive-overrides` / `--strict-overrides`:
 *   the OVERRIDE-SELECTION flags. `--image-override` is threaded by the
 *   dedicated Dockerfile picker (a generic control would produce a half-wired
 *   override); the other two govern the picker's TTY prompt / strictness,
 *   which studio drives itself (the child is non-interactive).
 *
 * Deliberately NOT managed (so they auto-render as controls): the build-input
 * pass-throughs `--image-build-arg` / `--image-build-secret` / `--image-target`.
 * The Dockerfile picker only threads `--image-override`, so excluding these
 * would leave them reachable ONLY via the raw extra-args box — the exact UX
 * gap the auto-rendered controls exist to close. A user rebuilding a pinned
 * image from a local Dockerfile legitimately needs to pass build args /
 * secrets / a target stage, so they get a control (variadic → one value per
 * control; the raw-args box remains for multiple).
 */
export const CATALOG_MANAGED_FLAGS: ReadonlySet<string> = new Set([
  '--event',
  '--response-file',
  '--host',
  '--port',
  '--watch',
  '--image-override',
  '--no-interactive-overrides',
  '--strict-overrides',
]);

/**
 * The runnable kind -> command factory + headless subcommand name. Mirrors
 * the kind->verb maps in `studio-dispatch` (`INVOKE_VERBS`) and
 * `studio-serve-manager` (`SERVE_SPECS`); studio spawns these commands as
 * children, so their flag sets are exactly what a per-run override may carry.
 */
type FlagCommandFactory = (opts?: { embedConfig?: CdkLocalEmbedConfig }) => Command;

const KIND_FACTORIES: Record<StudioTargetKind, { command: string; factory: FlagCommandFactory }> = {
  lambda: { command: 'invoke', factory: createLocalInvokeCommand },
  agentcore: { command: 'invoke-agentcore', factory: createLocalInvokeAgentCoreCommand },
  api: { command: 'start-api', factory: createLocalStartApiCommand },
  alb: { command: 'start-alb', factory: createLocalStartAlbCommand },
  ecs: { command: 'start-service', factory: createLocalStartServiceCommand },
  'ecs-task': { command: 'run-task', factory: createLocalRunTaskCommand },
  cloudfront: { command: 'start-cloudfront', factory: createLocalStartCloudFrontCommand },
  'agentcore-ws': { command: 'start-agentcore', factory: createLocalStartAgentCoreCommand },
};

let cached: Partial<Record<StudioTargetKind, KindFlagCatalog>> | undefined;

/**
 * Parse the value-token placeholder out of a Commander flags string for a
 * value-taking option: `-e, --event <file>` -> `file`,
 * `--platform <platform>` -> `platform`, `--lb-port <listener=host>` ->
 * `listener=host`. The trailing `...` of a variadic token is dropped. Returns
 * undefined for a boolean flag (no `<...>` / `[...]` token), so the input
 * placeholder falls back to a generic hint.
 */
export function parseFlagPlaceholder(flags: string): string | undefined {
  const m = /[<[]([^>\]]+)[>\]]/.exec(flags);
  if (!m || m[1] === undefined) return undefined;
  return m[1].replace(/\.\.\.$/, '').trim() || undefined;
}

/**
 * Build (and memoize) the full per-kind flag catalog by introspecting each
 * runnable kind's Commander command factory.
 *
 * Each factory calls `setEmbedConfig(opts.embedConfig)` at construction — with
 * no opts that resets the active embed config to cdk-local defaults, which
 * would wipe a host CLI's branding. So the active config is snapshotted and
 * each factory is re-handed it: branding is preserved AND the derived flag
 * descriptions reflect the host's active branding. The `finally` restore is a
 * belt-and-suspenders against a factory that ignores the passed config.
 * Memoized: the factories are instantiated exactly once per process, not per
 * page render.
 */
export function buildFlagCatalog(): Partial<Record<StudioTargetKind, KindFlagCatalog>> {
  if (cached) return cached;
  const savedEmbedConfig = getEmbedConfig();
  try {
    const out: Partial<Record<StudioTargetKind, KindFlagCatalog>> = {};
    for (const kind of Object.keys(KIND_FACTORIES) as StudioTargetKind[]) {
      const { command, factory } = KIND_FACTORIES[kind];
      const cmd = factory({ embedConfig: savedEmbedConfig });
      // The flags this kind already renders a rich curated control for — they
      // must NOT also get an auto-rendered control in the "All options"
      // section. A `showWhen`-gated curated scalar (e.g. `--tls-cert`) is in
      // OPTION_SPECS too, so it is covered by the same set.
      const curated = new Set((OPTION_SPECS[kind] ?? []).map((s) => s.flag));
      const flags: FlagInfo[] = [];
      for (const opt of cmd.options) {
        if (opt.hidden) continue;
        if (opt.long && CATALOG_EXCLUDED_FLAGS.has(opt.long)) continue;
        const long = opt.long ?? '';
        // Commander marks a value-taking option via `.required` (`<x>`) or
        // `.optional` (`[x]`); a bare / negate flag is a boolean.
        const takesValue = Boolean(opt.required || opt.optional);
        const negate = Boolean(opt.negate);
        const variadic = Boolean(opt.variadic);
        const choices = Array.isArray(opt.argChoices) ? [...opt.argChoices] : undefined;
        const placeholder = parseFlagPlaceholder(opt.flags);
        const renderable = long !== '' && !curated.has(long) && !CATALOG_MANAGED_FLAGS.has(long);
        const info: FlagInfo = {
          flags: opt.flags,
          description: opt.description ?? '',
          long,
          takesValue,
          negate,
          variadic,
          renderable,
        };
        if (placeholder !== undefined) info.placeholder = placeholder;
        if (choices) info.choices = choices;
        flags.push(info);
      }
      out[kind] = { command, flags };
    }
    cached = out;
    return out;
  } finally {
    // Restore branding (ResolvedEmbedConfig is a superset of the input shape).
    setEmbedConfig(savedEmbedConfig);
  }
}

/**
 * Test-only: clear the memoized catalog so a test can force a fresh build
 * (e.g. to exercise the embed-config snapshot/restore path under custom
 * branding, which the memoized fast-path would otherwise skip). Not part of
 * the production flow.
 */
export function __resetFlagCatalogCacheForTest(): void {
  cached = undefined;
}

/**
 * Tokenize a raw extra-args string into discrete argv elements, honoring
 * single / double quotes and backslash escaping so values with spaces survive
 * (`--name "two words"` -> `['--name', 'two words']`). studio spawns children
 * WITHOUT a shell (argv array), so the tokens are appended verbatim — there is
 * no shell-injection surface; the child command still validates each arg.
 *
 * Returns `[]` for an empty / whitespace-only input. Throws on an unterminated
 * quote so a malformed raw-args string fails as a clean boundary error rather
 * than spawning a child with a mis-split argv.
 */
export function tokenizeRawArgs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        // Inside double quotes a backslash escapes the next char (shell-like).
        current += raw[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < raw.length) {
      current += raw[++i];
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    throw new Error(`Raw extra args have an unterminated ${quote} quote.`);
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Per-run values for the auto-rendered "All options" controls, keyed by the
 * long flag (e.g. `{ '--no-pull': true, '--platform': 'linux/amd64' }`). A
 * boolean value drives a checkbox flag; a string value drives an input / select
 * flag. This is the catalog counterpart of `OPTION_SPECS`' {@link OptionValues}
 * — kept separate because these flags carry NO curated control / validation
 * spec; they are validated structurally against the flag catalog instead.
 */
export type CatalogValues = Record<string, boolean | string>;

/**
 * Build the argv fragment for the auto-rendered "All options" controls from the
 * UI-posted {@link CatalogValues}, validating each key against the kind's flag
 * catalog. Emits `--flag` for a checked boolean (bare/negate) flag and
 * `--flag <value>` for a non-empty value flag. Blank / false values are
 * omitted.
 *
 * Throws (→ a clean 400 at the `/api/run` boundary) on a key that is not a
 * RENDERABLE catalog flag for the kind — an unknown flag, a session-global /
 * studio-managed flag, or a curated flag (which belongs to the `options` path,
 * not here). The studio UI only ever posts renderable flags; the validation
 * guards a hand-rolled curl body. studio spawns children WITHOUT a shell, so
 * each emitted token is a discrete argv element with no injection surface.
 */
export function buildCatalogArgs(
  kind: StudioTargetKind,
  values: CatalogValues | undefined
): string[] {
  if (values === undefined) return [];
  const catalog = buildFlagCatalog()[kind];
  const byFlag = new Map(
    (catalog?.flags ?? []).filter((f) => f.renderable).map((f) => [f.long, f])
  );

  const args: string[] = [];
  for (const [flag, value] of Object.entries(values)) {
    const info = byFlag.get(flag);
    if (!info) {
      throw new Error(`Unknown / non-overridable option '${flag}' for target kind '${kind}'.`);
    }
    if (info.takesValue) {
      if (typeof value !== 'string') {
        throw new Error(`Option '${flag}' must be a string value.`);
      }
      const trimmed = value.trim();
      if (trimmed !== '') args.push(flag, trimmed);
    } else {
      // Boolean (bare / negate) flag — emit the bare flag only when checked.
      if (typeof value !== 'boolean') {
        throw new Error(`Option '${flag}' must be a boolean.`);
      }
      if (value) args.push(flag);
    }
  }
  return args;
}
