import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  argumentText,
  blankLiterals,
  collectTsFiles,
  constructionAt,
  hasOptOutMarker,
} from '../../helpers/client-construction-scan.js';

/**
 * Issue go-to-k/cdk-local#634: the AWS SDK v3 does not read `HTTPS_PROXY` /
 * `NO_PROXY` on its own — a proxy reaches a client only through the
 * `requestHandler` its CONSTRUCTION SITE supplies. That makes every
 * `new XxxClient(...)` a place where proxy support can be silently dropped,
 * the same relapse shape as the `--profile` half-wiring the sibling audit
 * (`tests/unit/cli/sts-client-profile-audit.test.ts`) fences for STS.
 *
 * This audit walks all of `src/**` and asserts every AWS SDK client
 * construction — static import, dynamic `await import` destructure, or the
 * member form `new mod.SQSClient(` — either:
 *
 *   - spreads `buildProxyClientConfig(` in the construction's OWN argument
 *     list, OR
 *   - goes through `buildStsClientConfig(` (which spreads the proxy config
 *     internally; its contract is locked by `profile-resolver.test.ts`), OR
 *   - carries a `// proxy-audit: ignore: <reason>` comment directly above —
 *     explicit, reasoned opt-out.
 *
 * POPULATION is derived from the defect, not from a site list: a
 * construction is in scope when its class name ends in `Client` AND the
 * file references an `@aws-sdk/client-*` module anywhere. That
 * over-approximates on purpose (a non-SDK `FooClient` in such a file gets
 * flagged and needs one opt-out line) — the failure direction of a MISSED
 * site is an invisible half-wire, which is the expensive one.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const SCAN_ROOTS = [join(repoRoot, 'src')];

const CLIENT_NAME = /^[A-Z][A-Za-z0-9_$]*Client$/;

function findOffenders(filePath: string): { line: number; text: string }[] {
  const raw = readFileSync(filePath, 'utf-8');
  // Membership is decided on the RAW source (imports live in string
  // literals), constructions on the literal-blanked copy so a comment
  // quoting `new XxxClient(` is not a site and a bracket in a string cannot
  // unbalance the argument scan.
  if (!raw.includes('@aws-sdk/client-')) return [];
  const code = blankLiterals(raw);
  const lines = raw.split('\n');
  const lineOf = (index: number) => raw.slice(0, index).split('\n').length;
  const offenders: { line: number; text: string }[] = [];
  for (const m of code.matchAll(/\bnew\b/g)) {
    const construction = constructionAt(code, m.index!);
    if (!construction || !CLIENT_NAME.test(construction.name)) continue;
    const lineNo = lineOf(m.index!);
    const trimmed = (lines[lineNo - 1] ?? '').trim();
    const args = argumentText(code, construction.argOpen);
    // Unbalanced: report it rather than reading on to EOF.
    if (args === null) {
      offenders.push({ line: lineNo, text: trimmed });
      continue;
    }
    if (args.includes('buildProxyClientConfig(')) continue;
    if (args.includes('buildStsClientConfig(')) continue;
    if (hasOptOutMarker(lines, lineNo, 'proxy-audit: ignore')) continue;
    offenders.push({ line: lineNo, text: trimmed });
  }
  return offenders;
}

describe('AWS SDK client proxy-config audit (issue #634)', () => {
  it('every AWS SDK client construction under src/** spreads the proxy-aware config', () => {
    const allOffenders: { file: string; line: number; text: string }[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectTsFiles(root)) {
        for (const off of findOffenders(file)) {
          allOffenders.push({ file: file.slice(repoRoot.length + 1), ...off });
        }
      }
    }
    if (allOffenders.length > 0) {
      const msg = allOffenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
      throw new Error(
        `Found ${allOffenders.length} AWS SDK client construction(s) that do not thread the proxy environment:\n${msg}\n\n` +
          'Fix: spread `...buildProxyClientConfig({ profile? })` FIRST in the constructor config ' +
          '(import from `src/utils/aws-proxy.ts`), or route an STS site through ' +
          '`buildStsClientConfig(...)`. If the construction genuinely never reaches the network ' +
          '(or is not an AWS SDK client), add a single-line `// proxy-audit: ignore: <reason>` ' +
          'directly above it.'
      );
    }
  });

  // The audit is only evidence if it can go red: the pre-#634 spelling of a
  // real site (ecs-secrets-resolver, verbatim from origin/main) must be
  // reported, and the repaired spelling must not. A scanner that scans
  // nothing reports nothing — this pins that the population rule actually
  // reaches a bare construction.
  it('flags the pre-fix spelling and passes the repaired one (self-check)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'proxy-audit-'));
    try {
      const broken = join(dir, 'broken.ts');
      writeFileSync(
        broken,
        `import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';\n` +
          `export const c = new SecretsManagerClient({\n` +
          `  ...(region && { region }),\n` +
          `});\n`
      );
      expect(findOffenders(broken)).toHaveLength(1);

      const memberForm = join(dir, 'member.ts');
      writeFileSync(
        memberForm,
        `const mod = await import('@aws-sdk/client-sqs');\n` +
          `export const c = new mod.SQSClient({ region: 'us-east-1' });\n`
      );
      expect(findOffenders(memberForm)).toHaveLength(1);

      const fixed = join(dir, 'fixed.ts');
      writeFileSync(
        fixed,
        `import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';\n` +
          `import { buildProxyClientConfig } from '../utils/aws-proxy.js';\n` +
          `export const c = new SecretsManagerClient({\n` +
          `  ...buildProxyClientConfig(),\n` +
          `});\n`
      );
      expect(findOffenders(fixed)).toHaveLength(0);

      const optedOut = join(dir, 'opted-out.ts');
      writeFileSync(
        optedOut,
        `import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';\n` +
          `// proxy-audit: ignore: constructed only to read config defaults, never sends\n` +
          `export const c = new SecretsManagerClient({});\n`
      );
      expect(findOffenders(optedOut)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
