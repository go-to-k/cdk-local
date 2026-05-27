import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../utils/logger.js';

/**
 * CDK configuration loaded from cdk.json and environment variables.
 */
export interface CdkConfig {
  app?: string;
  output?: string;
  context?: Record<string, unknown>;
}

function loadJsonConfig(filePath: string): CdkConfig | null {
  const logger = getLogger();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content) as CdkConfig;
    logger.debug(`Loaded config from ${filePath}`);
    return config;
  } catch (error) {
    logger.warn(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Load `cdk.json` from the current working directory.
 */
export function loadCdkJson(cwd?: string): CdkConfig | null {
  const dir = cwd || process.cwd();
  return loadJsonConfig(resolve(dir, 'cdk.json'));
}

/**
 * Load user-level defaults from `~/.cdk.json`.
 *
 * CDK CLI reads this as user-level defaults (lowest priority).
 * Context values from `~/.cdk.json` are merged below project `cdk.json`
 * context.
 */
export function loadUserCdkJson(): CdkConfig | null {
  return loadJsonConfig(join(homedir(), '.cdk.json'));
}

/**
 * Resolve the `--app` option from CLI, `CDKL_APP` env var, or `cdk.json`.
 *
 * Priority: CLI option > `CDKL_APP` env > `cdk.json` `app` field.
 */
export function resolveApp(cliApp?: string): string | undefined {
  if (cliApp) return cliApp;

  const envApp = process.env['CDKL_APP'];
  if (envApp) return envApp;

  const cdkJson = loadCdkJson();
  return cdkJson?.app ?? undefined;
}
