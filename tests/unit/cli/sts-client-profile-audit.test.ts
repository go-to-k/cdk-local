import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Issue #245: `--profile` has been only half-wired twice (credentials vs
 * region; subprocess env vs SDK config). This audit walks `src/cli/**`
 * + `src/local/**` and asserts every `new STSClient({...})` construction
 * either:
 *
 *   - goes through the shared `buildStsClientConfig` helper (whose
 *     contract is locked by `profile-resolver.test.ts` — it always
 *     emits `{ profile }` when `--profile` is plumbed), OR
 *   - is the canonical `new STSClient({ profile })` shape inside the
 *     shared resolver itself, OR
 *   - is explicitly opt-out (an `// sts-audit: ignore` line directly
 *     above the construction names the reason — e.g. host-side
 *     resolvers that don't accept a profile yet).
 *
 * The historical foot-gun this test prevents is the inline
 * `new STSClient({ ...(region && { region }) })` shape that silently
 * dropped `--profile`. Every cdk-local STS site has been migrated to
 * `buildStsClientConfig({ region, profile })`; the audit fails the
 * moment a new construction is added in the old shape.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');

// `src/utils/` is included alongside `src/cli/` + `src/local/` because
// `src/utils/role-arn.ts` was previously outside the audit scope despite
// hosting `applyRoleArnIfSet`'s STSClient call, which is invoked by
// every command. The PR-review caught the relapse vector and widened
// the scope so the next half-wire trips a test failure here.
const SCAN_ROOTS = [
  join(repoRoot, 'src', 'cli'),
  join(repoRoot, 'src', 'local'),
  join(repoRoot, 'src', 'utils'),
];

/** Recursively collect every `*.ts` file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const s = statSync(abs);
    if (s.isDirectory()) {
      out.push(...collectTsFiles(abs));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Read a file and report every `new STSClient(...)` construction that does
 * NOT use the shared `buildStsClientConfig` helper. The audit's allow-list
 * is intentionally narrow:
 *
 *   - `new STSClient({ profile })` — the canonical shape used INSIDE the
 *     shared `resolveProfileCredentials` helper itself.
 *   - `new STSClient(buildStsClientConfig(...))` — every other site.
 *   - `new STSClient({})` or `new STSClient({ region })` directly preceded
 *     by a `// sts-audit: ignore` line — explicit opt-out (host-side
 *     resolvers that don't accept a profile yet).
 */
function findOffenders(filePath: string): { line: number; text: string }[] {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const offenders: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes('new STSClient(')) continue;
    // Skip JSDoc / comment lines that mention the literal pattern in
    // backticks for documentation purposes (e.g. the historical-pattern
    // call-out inside `buildStsClientConfig`'s own docstring). A real
    // construction site is never inside a comment block.
    const trimmedStart = line.trim();
    if (
      trimmedStart.startsWith('*') ||
      trimmedStart.startsWith('//') ||
      trimmedStart.startsWith('/*')
    )
      continue;
    // The construction may span multiple lines — read the next few too
    // so multi-line `new STSClient(\n  buildStsClientConfig(...))` is
    // recognized as a wrapped helper call, not a bare construction.
    const lookahead = lines.slice(i, Math.min(i + 4, lines.length)).join(' ');
    if (lookahead.includes('buildStsClientConfig(')) continue;
    // Canonical resolver shape inside profile-resolver.ts.
    if (/new STSClient\(\{\s*profile\s*\}\)/.test(lookahead)) continue;
    // Explicit opt-out marker anywhere in the immediately-preceding
    // comment block (up to 6 lines back of contiguous `//` lines).
    let optOut = false;
    for (let k = i - 1; k >= 0 && k >= i - 6; k--) {
      const prev = (lines[k] ?? '').trim();
      if (prev.length === 0) break;
      if (!prev.startsWith('//')) break;
      if (prev.includes('sts-audit: ignore')) {
        optOut = true;
        break;
      }
    }
    if (optOut) continue;
    offenders.push({ line: i + 1, text: line.trim() });
  }
  return offenders;
}

describe('STSClient `--profile` audit (issue #245)', () => {
  it('every `new STSClient(...)` under src/cli/** + src/local/** routes through the shared profile helper', () => {
    const allOffenders: { file: string; line: number; text: string }[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectTsFiles(root)) {
        for (const off of findOffenders(file)) {
          allOffenders.push({ file: file.slice(repoRoot.length + 1), ...off });
        }
      }
    }
    if (allOffenders.length > 0) {
      const msg = allOffenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join('\n');
      throw new Error(
        `Found ${allOffenders.length} STSClient construction(s) that do not thread --profile via buildStsClientConfig:\n${msg}\n\n` +
          'Fix: replace `new STSClient({ ...(region && { region }) })` with ' +
          '`new STSClient(buildStsClientConfig({ region, profile }))` (import from `src/utils/profile-resolver.ts`). ' +
          'If the call site genuinely has no profile to plumb, add a single-line `// sts-audit: ignore: <reason>` directly above the construction.'
      );
    }
  });
});
