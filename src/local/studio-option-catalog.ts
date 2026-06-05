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
import type { StudioTargetKind } from './studio-events.js';
import type { Command } from 'commander';

/** One flag the underlying command accepts. */
export interface FlagInfo {
  /** The Commander flags string, e.g. `-e, --event <file>` or `--tls`. */
  flags: string;
  /** The option's help description (may be empty). */
  description: string;
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
      const flags: FlagInfo[] = [];
      for (const opt of cmd.options) {
        if (opt.hidden) continue;
        if (opt.long && CATALOG_EXCLUDED_FLAGS.has(opt.long)) continue;
        flags.push({ flags: opt.flags, description: opt.description ?? '' });
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
