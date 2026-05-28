import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from '../local/embed-config.js';

function loadCdkJson(): { app?: string } | null {
  const filePath = resolve(process.cwd(), 'cdk.json');
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as { app?: string };
  } catch (error) {
    getLogger().warn(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
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
