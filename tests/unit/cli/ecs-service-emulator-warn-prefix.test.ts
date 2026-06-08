import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

/**
 * Regression for the doubled `WARN:   WARN:` log prefix.
 *
 * The compact-mode logger (`src/utils/logger.ts`) prefixes warn lines with
 * `WARN: ` (and error lines with `ERROR: `) so the severity survives a
 * colourless pipe (the studio child / `NO_COLOR`). A message string that ALSO
 * begins with a literal `WARN:` therefore double-prefixes to
 * `WARN:   WARN: ...`. Two listener warnings in `ecs-service-emulator.ts` (the
 * privileged-port remap + the degraded-HTTPS notice) carried a stale `  WARN:`
 * from before the logger added the prefix — surfaced in the `cdkl studio`
 * ALB-serve LOGS panel as `WARN:   WARN: listener port 443 ...`.
 *
 * Source-grep (the front-door boot path can't be exercised end-to-end without
 * Docker + an EACCES privileged bind): no logged message in this file may
 * start with a literal `WARN:` / `ERROR:` — the logger owns that prefix.
 */
const SOURCE = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../src/cli/commands/ecs-service-emulator.ts'
  ),
  'utf-8'
);

describe('ecs-service-emulator listener WARN prefix', () => {
  it('embeds no literal WARN:/ERROR: prefix in a logged message (the logger adds it)', () => {
    // A backtick template literal that opens with (optional spaces then)
    // `WARN:` / `ERROR:` is the double-prefix shape.
    expect(/`\s*(WARN|ERROR):/.test(SOURCE)).toBe(false);
  });

  it('still emits the privileged-port + degraded-HTTPS listener warnings', () => {
    expect(SOURCE).toContain('is privileged (< 1024) and cannot be');
    expect(SOURCE).toContain('is HTTPS in the cloud but serving HTTP');
  });
});
