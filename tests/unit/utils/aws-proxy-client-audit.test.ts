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
 * This audit walks all of `src/**` and applies THREE policies to every AWS
 * SDK client construction — static import, dynamic `await import`
 * destructure, or the member form `new mod.SQSClient(`. All three are
 * population rules over the same scan, because each of them is a shape that
 * gets re-written every time a construction site is added:
 *
 * 1. PRESENCE — the construction either spreads `buildProxyClientConfig(` in
 *    its OWN argument list, or goes through `buildStsClientConfig(` (which
 *    spreads the proxy config internally; its contract is locked by
 *    `profile-resolver.test.ts`), or carries a
 *    `// proxy-audit: ignore: <reason>` comment directly above.
 *
 * 2. PROFILE — a construction that knows a `profile` must pass it INTO
 *    `buildProxyClientConfig({ profile })`, not only alongside it. Under a
 *    proxy the fragment carries a `credentials` provider, and in the AWS SDK
 *    explicit `credentials` beat a `profile` key — so a site spelling
 *    `{ ...buildProxyClientConfig(), profile }` resolves the DEFAULT
 *    account's credentials while looking correct. That is the
 *    `--profile` half-wiring recurrence in its proxy-shaped form, and it is
 *    invisible without a proxy variable set, so no ordinary site test sees
 *    it (issue go-to-k/cdk-local#648).
 *
 * 3. ORDER — the proxy seam must be spread BEFORE any `credentials` in the
 *    same argument list. A site that resolves its own explicit credentials
 *    (`ecr-puller`'s assumed-role creds, the KVS / S3-origin / CloudFront
 *    readers' caller creds) must keep them; with the spread moved LAST the
 *    fragment's default-chain provider silently REPLACES them, again only
 *    under a proxy (issue go-to-k/cdk-local#648).
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

/** The proxy seam itself, and the STS config builder that spreads it. */
const PROXY_SEAM = 'buildProxyClientConfig(';
const STS_SEAM = 'buildStsClientConfig(';

/** A `profile` identifier — a key, or the value expression that feeds one. */
const PROFILE_TOKEN = /\bprofile\b/;

interface Construction {
  /** 1-based line of the `new` keyword. */
  readonly line: number;
  /** The trimmed source line, for the failure message. */
  readonly text: string;
  /** Balanced argument text (literal-blanked), or `null` when unbalanced. */
  readonly args: string | null;
  readonly optedOut: boolean;
}

/**
 * Every AWS SDK client construction in one file. Membership is decided on
 * the RAW source (imports live in string literals), constructions on the
 * literal-blanked copy so a comment quoting `new XxxClient(` is not a site
 * and a bracket in a string cannot unbalance the argument scan.
 */
function constructions(filePath: string): Construction[] {
  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.includes('@aws-sdk/client-')) return [];
  const code = blankLiterals(raw);
  const lines = raw.split('\n');
  const lineOf = (index: number) => raw.slice(0, index).split('\n').length;
  const found: Construction[] = [];
  for (const m of code.matchAll(/\bnew\b/g)) {
    const construction = constructionAt(code, m.index!);
    if (!construction || !CLIENT_NAME.test(construction.name)) continue;
    const line = lineOf(m.index!);
    found.push({
      line,
      text: (lines[line - 1] ?? '').trim(),
      args: argumentText(code, construction.argOpen),
      optedOut: hasOptOutMarker(lines, line, 'proxy-audit: ignore'),
    });
  }
  return found;
}

/** Policy 1: the construction threads the proxy environment at all. */
function findOffenders(filePath: string): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = [];
  for (const c of constructions(filePath)) {
    // Unbalanced: report it rather than reading on to EOF.
    if (c.args === null) {
      offenders.push({ line: c.line, text: c.text });
      continue;
    }
    if (c.args.includes(PROXY_SEAM)) continue;
    if (c.args.includes(STS_SEAM)) continue;
    if (c.optedOut) continue;
    offenders.push({ line: c.line, text: c.text });
  }
  return offenders;
}

/**
 * Split an argument list at its `buildProxyClientConfig(...)` call: the
 * call's OWN arguments, and everything else with that span blanked out. The
 * split is what makes policy 2 answerable — `profile` inside the fragment is
 * the threading, `profile` outside it is the site's own key, and a plain
 * `includes('profile')` over the whole text cannot tell them apart.
 */
function splitAtProxySeam(args: string): { fragment: string; rest: string } | null {
  const at = args.indexOf(PROXY_SEAM);
  if (at === -1) return null;
  // `argumentText` takes the index of the `(` and returns the text BETWEEN
  // the parens, so the whole call spans `open` .. `open + fragment.length + 1`.
  const open = at + PROXY_SEAM.length - 1;
  const fragment = argumentText(args, open);
  if (fragment === null) return null;
  return {
    fragment,
    rest: args.slice(0, open) + args.slice(open + fragment.length + 2),
  };
}

/** Policy 2: a site that knows a profile threads it INTO the fragment. */
function findProfileOffenders(filePath: string): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = [];
  for (const c of constructions(filePath)) {
    if (c.args === null || c.optedOut) continue;
    // `buildStsClientConfig` takes the profile as its own argument and
    // forwards it; `profile-resolver.test.ts` locks that forwarding.
    if (c.args.includes(STS_SEAM)) continue;
    const split = splitAtProxySeam(c.args);
    if (split === null) continue;
    if (!PROFILE_TOKEN.test(split.rest)) continue;
    if (PROFILE_TOKEN.test(split.fragment)) continue;
    offenders.push({ line: c.line, text: c.text });
  }
  return offenders;
}

/** Policy 3: the proxy seam is spread before any `credentials`. */
function findOrderOffenders(filePath: string): { line: number; text: string }[] {
  const offenders: { line: number; text: string }[] = [];
  for (const c of constructions(filePath)) {
    if (c.args === null || c.optedOut) continue;
    const seamIndexes = [c.args.indexOf(PROXY_SEAM), c.args.indexOf(STS_SEAM)].filter(
      (i) => i >= 0
    );
    // No seam at all is policy 1's business, not this one.
    if (seamIndexes.length === 0) continue;
    const credentialsAt = c.args.indexOf('credentials');
    if (credentialsAt === -1) continue;
    if (Math.min(...seamIndexes) < credentialsAt) continue;
    offenders.push({ line: c.line, text: c.text });
  }
  return offenders;
}

function scanAll(
  find: (filePath: string) => { line: number; text: string }[]
): { file: string; line: number; text: string }[] {
  const all: { file: string; line: number; text: string }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of collectTsFiles(root)) {
      for (const off of find(file)) {
        all.push({ file: file.slice(repoRoot.length + 1), ...off });
      }
    }
  }
  return all;
}

const render = (offenders: { file: string; line: number; text: string }[]) =>
  offenders.map((o) => `${o.file}:${o.line}  ${o.text}`);

describe('AWS SDK client proxy-config audit (issue #634)', () => {
  it('every AWS SDK client construction under src/** spreads the proxy-aware config', () => {
    expect(
      render(scanAll(findOffenders)),
      'Fix: spread `...buildProxyClientConfig({ profile? })` FIRST in the constructor config ' +
        '(import from `src/utils/aws-proxy.ts`), or route an STS site through ' +
        '`buildStsClientConfig(...)`. If the construction genuinely never reaches the network ' +
        '(or is not an AWS SDK client), add a single-line `// proxy-audit: ignore: <reason>` ' +
        'directly above it.'
    ).toEqual([]);
  });

  it('every construction that knows a profile threads it INTO buildProxyClientConfig (issue #648)', () => {
    expect(
      render(scanAll(findProfileOffenders)),
      'A construction passes a `profile` alongside the proxy fragment but not INTO it. Under a ' +
        'proxy the fragment supplies a `credentials` provider, and explicit credentials beat a ' +
        '`profile` key in the AWS SDK — so this site resolves the DEFAULT account under ' +
        '`HTTPS_PROXY` while looking correct without one. Fix: ' +
        '`...buildProxyClientConfig({ profile: <the same profile> })`.'
    ).toEqual([]);
  });

  it('spreads the proxy fragment BEFORE any credentials the site resolves itself (issue #648)', () => {
    expect(
      render(scanAll(findOrderOffenders)),
      'A construction spreads the proxy fragment AFTER its own `credentials`, so the fragment’s ' +
        'default-chain provider silently replaces them whenever a proxy variable is set (and only ' +
        'then, which is why no site test sees it). Fix: move `...buildProxyClientConfig(...)` to ' +
        'the FIRST position in the config object.'
    ).toEqual([]);
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

  // Same guard-the-guard for the two #648 policies. Each is written as the
  // BROKEN spelling next to the REPAIRED one, because a policy that flags
  // nothing and a policy that flags everything both leave the live scan
  // above green.
  it('flags a profile passed alongside the fragment rather than into it (self-check)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'proxy-audit-profile-'));
    try {
      const header =
        `import { S3Client } from '@aws-sdk/client-s3';\n` +
        `import { buildProxyClientConfig } from '../utils/aws-proxy.js';\n`;

      const halfWired = join(dir, 'half-wired.ts');
      writeFileSync(
        halfWired,
        `${header}export const c = new S3Client({\n` +
          `  ...buildProxyClientConfig(),\n` +
          `  ...(options.profile && { profile: options.profile }),\n` +
          `});\n`
      );
      expect(findProfileOffenders(halfWired)).toHaveLength(1);

      const threaded = join(dir, 'threaded.ts');
      writeFileSync(
        threaded,
        `${header}export const c = new S3Client({\n` +
          `  ...buildProxyClientConfig({ profile: options.profile }),\n` +
          `  ...(options.profile && { profile: options.profile }),\n` +
          `});\n`
      );
      expect(findProfileOffenders(threaded)).toHaveLength(0);

      // A site with no profile at all is not this policy's business — the
      // rule must not degenerate into "always pass a profile".
      const noProfile = join(dir, 'no-profile.ts');
      writeFileSync(
        noProfile,
        `${header}export const c = new S3Client({ ...buildProxyClientConfig(), region });\n`
      );
      expect(findProfileOffenders(noProfile)).toHaveLength(0);

      // `buildStsClientConfig` takes the profile itself and forwards it.
      const viaSts = join(dir, 'via-sts.ts');
      writeFileSync(
        viaSts,
        `import { STSClient } from '@aws-sdk/client-sts';\n` +
          `import { buildStsClientConfig } from '../utils/profile-resolver.js';\n` +
          `export const c = new STSClient(buildStsClientConfig({ region, profile }));\n`
      );
      expect(findProfileOffenders(viaSts)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a proxy fragment spread AFTER the site’s own credentials (self-check)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'proxy-audit-order-'));
    try {
      const header =
        `import { ECRClient } from '@aws-sdk/client-ecr';\n` +
        `import { buildProxyClientConfig } from '../utils/aws-proxy.js';\n`;

      const spreadLast = join(dir, 'spread-last.ts');
      writeFileSync(
        spreadLast,
        `${header}export const c = new ECRClient({\n` +
          `  region: parsed.region,\n` +
          `  ...(assumed ? { credentials: assumed } : {}),\n` +
          `  ...buildProxyClientConfig({ profile: options.profile }),\n` +
          `});\n`
      );
      expect(findOrderOffenders(spreadLast)).toHaveLength(1);

      const spreadFirst = join(dir, 'spread-first.ts');
      writeFileSync(
        spreadFirst,
        `${header}export const c = new ECRClient({\n` +
          `  ...buildProxyClientConfig({ profile: options.profile }),\n` +
          `  region: parsed.region,\n` +
          `  ...(assumed ? { credentials: assumed } : {}),\n` +
          `});\n`
      );
      expect(findOrderOffenders(spreadFirst)).toHaveLength(0);

      // No credentials in the argument list: nothing for the fragment to
      // clobber, so position is not this policy's business.
      const noCredentials = join(dir, 'no-credentials.ts');
      writeFileSync(
        noCredentials,
        `${header}export const c = new ECRClient({ region, ...buildProxyClientConfig() });\n`
      );
      expect(findOrderOffenders(noCredentials)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
