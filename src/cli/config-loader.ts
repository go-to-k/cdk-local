import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from '../local/embed-config.js';

interface CdkJson {
  app?: string;
  watch?: { include?: string | string[]; exclude?: string | string[] };
}

function loadCdkJson(): CdkJson | null {
  const filePath = resolve(process.cwd(), 'cdk.json');
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as CdkJson;
  } catch (error) {
    getLogger().warn(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function normalizeGlobList(value: string | string[] | undefined): string[] {
  const arr = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return arr.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Resolve the `--app` option from CLI, `CDKL_APP` env var, or `cdk.json`.
 *
 * Priority: CLI option > `CDKL_APP` env > `cdk.json` `app` field > undefined.
 *
 * `@aws-cdk/toolkit-lib`'s `Toolkit.fromCdkApp(...)` requires the CDK app
 * command as a positional argument and does NOT auto-resolve `cdk.json`'s
 * `app` field, so cdk-local resolves it here before handing the command to
 * the toolkit. `~/.cdk.json` context is intentionally NOT read here —
 * `CdkAppMultiContext` inside `assembly-reader.ts` already merges it.
 */
export function resolveApp(cliApp?: string): string | undefined {
  if (cliApp) return cliApp;

  const envApp = process.env[`${getEmbedConfig().envPrefix}_APP`];
  if (envApp) return envApp;

  return loadCdkJson()?.app ?? undefined;
}

/** Resolved `cdk.json` `watch` block (include / exclude glob lists). */
export interface CdkWatchConfig {
  /** Globs of source paths whose changes trigger a `--watch` reload. */
  include: string[];
  /** Globs of source paths that never trigger a reload. */
  exclude: string[];
}

/**
 * Resolve the `cdk.json` `watch` block, mirroring `cdk watch`'s
 * include / exclude semantics for `cdkl start-api --watch` source-tree
 * watching.
 *
 * Defaults when the keys are absent: `include` -> `['**']` (watch the
 * whole app directory), `exclude` -> `[]`. Unlike `cdk watch`, a missing
 * `watch` block is NOT an error — `--watch` still works against the
 * defaults. The caller layers in mandatory excludes (the synth output
 * directory, `node_modules`, `.git`) so re-synth writes never re-trigger
 * a reload and large noise directories are pruned.
 */
export function resolveWatchConfig(): CdkWatchConfig {
  const watch = loadCdkJson()?.watch;
  const include = normalizeGlobList(watch?.include);
  return {
    // An empty / all-invalid `include` (e.g. `[]` or `""`) would make the
    // watcher match nothing and silently never reload — fall back to `**`.
    include: include.length > 0 ? include : ['**'],
    exclude: normalizeGlobList(watch?.exclude),
  };
}
