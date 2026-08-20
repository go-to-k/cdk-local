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

// The scope is the WHOLE of `src/**`, not a list of directories. It was
// `src/cli` + `src/local` until `src/utils/role-arn.ts` — which hosts
// `applyRoleArnIfSet`'s STSClient call, invoked by every command — turned out
// to be outside it, and a hand-kept root list re-opens exactly that relapse
// vector one directory over: a probe on 2026-08-20 planted the defect in
// `src/assets/docker-build.ts` and the audit stayed green
// (go-to-k/cdk-local#537). A directory holding no STS client today costs one
// cheap read; a directory missing from the list costs the audit.
const SCAN_ROOTS = [join(repoRoot, 'src')];

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
 * Every local binding in `source` that names the STS client class, so a
 * construction is recognised through an ALIASED import as well as the plain
 * one. Probed on 2026-08-20 (go-to-k/cdk-local#537): the audit matched the
 * literal string `new STSClient(` only, while this codebase already builds the
 * client through `const { STSClient } = await import('@aws-sdk/client-sts')` at
 * five sites — renaming that destructured binding was one keystroke away from
 * an invisible half-wire.
 */
function stsBindings(source: string): string[] {
  const names = new Set<string>();
  const isStsModule = (spec: string) => spec.includes('@aws-sdk/client-sts');
  // `import { STSClient as STS } from '@aws-sdk/client-sts'`
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!isStsModule(m[2]!)) continue;
    for (const clause of m[1]!.split(',')) {
      const [imported, local] = clause.split(/\s+as\s+/).map((x) => x.trim());
      if (imported === 'STSClient') names.add(local || imported);
    }
  }
  // `const { STSClient: STS } = await import('@aws-sdk/client-sts')` and the
  // `require` spelling.
  for (const m of source.matchAll(
    /\{([^}]*)\}\s*=\s*(?:await\s+import|require)\(\s*['"]([^'"]+)['"]/g
  )) {
    if (!isStsModule(m[2]!)) continue;
    for (const clause of m[1]!.split(',')) {
      const [imported, local] = clause.split(':').map((x) => x.trim());
      if (imported === 'STSClient') names.add(local || imported);
    }
  }
  // `const Client = mod.STSClient`
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*\.STSClient\b/g)) {
    names.add(m[1]!);
  }
  if (names.size === 0) names.add('STSClient');
  names.add('STSClient');
  return [...names];
}

/** The balanced `(...)` argument text starting at `open` (an index of `(`). */
function argumentText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

/**
 * Report every STS client construction that does NOT thread `--profile`.
 * Accepted:
 *
 *   - `new STSClient(buildStsClientConfig(...))` — every ordinary site. The
 *     helper call must appear in the construction's OWN argument list; the
 *     first version looked in a fixed four-line window, which a later,
 *     unrelated call could satisfy.
 *   - `new STSClient({ profile })` — the canonical shape inside the shared
 *     resolver itself.
 *   - a construction whose immediately preceding comment line carries
 *     `sts-audit: ignore` — explicit, reasoned opt-out.
 */
function findOffenders(filePath: string): { line: number; text: string }[] {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const lineOf = (index: number) => raw.slice(0, index).split('\n').length;
  const offenders: { line: number; text: string }[] = [];
  const bindings = stsBindings(raw);
  const pattern = new RegExp(`new\\s+(${bindings.join('|')})\\s*\\(`, 'g');
  for (const m of raw.matchAll(pattern)) {
    const at = m.index!;
    const lineNo = lineOf(at);
    const line = lines[lineNo - 1] ?? '';
    // A construction is never inside a comment; a docstring may quote one.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    const args = argumentText(raw, at + m[0].length - 1);
    if (args.includes('buildStsClientConfig(')) continue;
    if (/^\s*\{\s*profile\s*\}\s*$/.test(args)) continue;
    // Opt-out marker on the contiguous comment block directly above.
    let optOut = false;
    for (let k = lineNo - 2; k >= 0 && k >= lineNo - 7; k--) {
      const prev = (lines[k] ?? '').trim();
      if (prev.length === 0) break;
      if (!prev.startsWith('//')) break;
      if (prev.includes('sts-audit: ignore')) {
        optOut = true;
        break;
      }
    }
    if (optOut) continue;
    offenders.push({ line: lineNo, text: trimmed });
  }
  return offenders;
}

describe('STSClient `--profile` audit (issue #245)', () => {
  it('every STS client construction under src/** routes through the shared profile helper', () => {
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
