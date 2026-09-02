import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  blankLiterals,
  collectTsFiles,
  hasOptOutMarker,
} from '../../helpers/client-construction-scan.js';

/**
 * Issue go-to-k/cdk-local#647: the sibling audit
 * (`aws-proxy-client-audit.test.ts`) fences every AWS SDK client
 * construction, and every one of them was already threaded — yet the layer
 * ZIP download and the Cognito JWKS / OIDC discovery reads still went
 * DIRECT behind a forward proxy, because they are not SDK calls at all.
 * The global `fetch` (undici) reads no proxy environment variable, so a
 * bare `fetch(...)` is the second place proxy support gets silently
 * dropped.
 *
 * This audit walks all of `src/**` and asserts every use of the GLOBAL
 * fetch — a bare `fetch(` call or a `globalThis.fetch` reference — either
 * goes through `proxyAwareFetch` instead, or carries a
 * `// proxy-audit: ignore: <reason>` comment directly above it. Same marker
 * as the client audit: a site is either proxy-aware or it says in one line
 * why it must not be.
 *
 * It FAILS CLOSED — a new global-fetch site is an offender until someone
 * decides which it is. That is the point: the three sites this issue found
 * were all written before anyone had the proxy in mind, and nothing asked
 * the question.
 *
 * BOUNDS, stated rather than left to be rediscovered:
 *
 *   - A `typeof globalThis.fetch` / `typeof fetch` TYPE position is not a
 *     call and is skipped. `src/local/rest-v1-integrations.ts` declares its
 *     injection seam that way.
 *   - An ALIASED binding is not in the population: `options.fetchImpl ??
 *     fetch` binds the global without calling it, and the later
 *     `fetchImpl(url)` names a local. The three sites written that way
 *     (`agentcore-a2a-client`, `agentcore-mcp-client`,
 *     `studio-request-relay`) all target a loopback container or a
 *     loopback serve, which is exactly what must NOT be proxied — so the
 *     gap costs nothing today. A remote-host caller written that way would
 *     escape this audit; the client audit carries the same alias bound.
 *     The same bound covers every other INDIRECTION on the global, and the
 *     other GLOBAL OBJECTS that alias it: `global.fetch(url)`,
 *     `self.fetch(url)`, `globalThis['fetch']`,
 *     `const { fetch } = globalThis`, `globalThis?.fetch`, `(0, fetch)(url)`.
 *     They are enumerated here
 *     rather than patterned for, because chasing spellings is how a fence
 *     ends up with four patterns and a fifth hole — the honest statement is
 *     that this scans the two spellings anyone actually writes and names
 *     the rest as out of population.
 *   - It fences `fetch` only, NOT a direct `node:http(s).request` egress.
 *     Derived rather than assumed —
 *     `grep -rn "from 'node:http\(s\)\?'" src/` returns servers plus two
 *     outbound sites: `proxyAwareFetch` here, and `studio-proxy`, whose
 *     upstream is bounded to LOOPBACK by `normalizeLocalUpstream`
 *     (go-to-k/cdk-local#578). `ecs-service-runner`'s raw `node:net`
 *     `createConnection` is a loopback TCP probe. So no remote-host raw
 *     request exists today, and the population is complete in practice
 *     rather than by construction.
 *   - `src/local/studio-ui.ts`'s browser JS lives inside a template
 *     literal, so `blankLiterals` removes it before the scan. Its `fetch`
 *     calls run in the browser against studio's own origin and are not
 *     Node egress at all.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const SCAN_ROOTS = [join(repoRoot, 'src')];

/** A bare `fetch(` that is not a property access (`source.fetch(`). */
const BARE_FETCH_CALL = /(?<![.\w$])fetch\s*\(/g;
/** Any `globalThis.fetch` use — call or reference. */
const GLOBAL_THIS_FETCH = /globalThis\s*\.\s*fetch\b/g;
/** `typeof` immediately before the match makes it a type position. */
const TYPEOF_BEFORE = /\btypeof\s+$/;

function findOffenders(filePath: string): { line: number; text: string }[] {
  const raw = readFileSync(filePath, 'utf-8');
  // Comments and string / template literals are blanked so a comment
  // quoting `fetch(` is not a site, and so the embedded browser JS in
  // studio-ui.ts is not scanned as Node code.
  const code = blankLiterals(raw);
  const lines = raw.split('\n');
  const lineOf = (index: number): number => raw.slice(0, index).split('\n').length;
  const offenders: { line: number; text: string }[] = [];
  const seen = new Set<number>();
  for (const pattern of [BARE_FETCH_CALL, GLOBAL_THIS_FETCH]) {
    pattern.lastIndex = 0;
    for (const m of code.matchAll(pattern)) {
      const index = m.index!;
      if (TYPEOF_BEFORE.test(code.slice(Math.max(0, index - 16), index))) continue;
      const lineNo = lineOf(index);
      if (seen.has(lineNo)) continue;
      if (hasOptOutMarker(lines, lineNo, 'proxy-audit: ignore')) continue;
      seen.add(lineNo);
      offenders.push({ line: lineNo, text: (lines[lineNo - 1] ?? '').trim() });
    }
  }
  return offenders.sort((a, b) => a.line - b.line);
}

describe('global-fetch proxy audit (issue #647)', () => {
  it('every global-fetch use under src/** is proxy-aware or reasoned away', () => {
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
        `Found ${allOffenders.length} use(s) of the global fetch that do not thread the proxy environment:\n${msg}\n\n` +
          'Fix: call `proxyAwareFetch(url)` from `src/utils/aws-proxy.ts` instead — it IS ' +
          '`globalThis.fetch` when no proxy variable is set, and routes through the same ' +
          '`NO_PROXY`-aware agent the AWS SDK clients use when one is. If the target is a ' +
          'loopback container / serve, or the emulated data path rather than cdk-local\'s own ' +
          'egress, add a single-line `// proxy-audit: ignore: <reason>` directly above it.'
      );
    }
  });

  // The audit is only evidence if it can go red: the pre-#647 spelling of
  // each real site must be reported and the repaired spelling must not.
  it('flags the pre-fix spellings and passes the repaired ones (self-check)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'proxy-fetch-audit-'));
    try {
      // layer-arn-materializer's pre-fix download, verbatim from origin/main.
      const bare = join(dir, 'bare.ts');
      writeFileSync(bare, `const response = await fetch(presignedUrl);\n`);
      expect(findOffenders(bare)).toHaveLength(1);

      // cognito-jwt's pre-fix JWKS default, verbatim from origin/main.
      const viaGlobalThis = join(dir, 'global-this.ts');
      writeFileSync(
        viaGlobalThis,
        `const fetchImpl = opts.fetchImpl ?? (async (url) => globalThis.fetch(url));\n`
      );
      expect(findOffenders(viaGlobalThis)).toHaveLength(1);

      // A `globalThis.fetch` REFERENCE (no call parens) is a site too — that
      // is the shape `rest-v1-integrations.ts` uses.
      const reference = join(dir, 'reference.ts');
      writeFileSync(reference, `const impl = deps.fetch ?? globalThis.fetch;\n`);
      expect(findOffenders(reference)).toHaveLength(1);

      const repaired = join(dir, 'repaired.ts');
      writeFileSync(
        repaired,
        `import { proxyAwareFetch } from '../utils/aws-proxy.js';\n` +
          `const response = await proxyAwareFetch(presignedUrl);\n`
      );
      expect(findOffenders(repaired)).toHaveLength(0);

      const optedOut = join(dir, 'opted-out.ts');
      writeFileSync(
        optedOut,
        `// proxy-audit: ignore: loopback container, must never be proxied\n` +
          `const response = await fetch(containerUrl);\n`
      );
      expect(findOffenders(optedOut)).toHaveLength(0);

      // Not sites: a property access, a type position, a comment quoting the
      // call, and a local binding merely NAMED fetch.
      const notSites = join(dir, 'not-sites.ts');
      writeFileSync(
        notSites,
        `const result = await source.fetch(key);\n` +
          `type Impl = typeof globalThis.fetch;\n` +
          `type Impl2 = typeof fetch;\n` +
          `// a comment mentioning fetch(url) is prose, not a call\n` +
          `const fetch: S3ObjectFetcher = async (key) => undefined;\n`
      );
      expect(findOffenders(notSites)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
