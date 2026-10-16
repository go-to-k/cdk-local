import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  argumentText,
  blankLiterals,
  collectTsFiles,
  constructionAt,
} from '../../helpers/client-construction-scan.js';

/**
 * Site fence for go-to-k/cdk-local#783. Under `workloadIdentity: 'caller'` a
 * client that serves a WORKLOAD input (a secret, a parameter, a bucket read, a
 * task definition lookup, ...) must resolve the CALLER's credentials, not the
 * `--role-arn` role the process assumed. That only holds when the client's
 * construction spreads `workloadClientConfig(` / `workloadStsClientConfig(`
 * (`src/utils/workload-identity.ts`), so a new client site that copies the
 * older `buildProxyClientConfig(` spelling would silently resolve the workload
 * input as the role.
 *
 * Every AWS SDK client construction under `src/` therefore either spreads the
 * workload helper or is listed in ALLOWLIST with the class that justifies the
 * role / profile identity. A new site: spread the workload helper, or add it
 * here with its class. The population rule (class name ends in `Client` in a
 * file that references `@aws-sdk/client-*`) and the parsing helpers are the
 * ones `aws-proxy-client-audit.test.ts` uses. The allowlist may only SHRINK:
 * an entry with a count above what the file holds is stale and fails.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const SRC = join(repoRoot, 'src');

const CLIENT_NAME = /^[A-Z][A-Za-z0-9_$]*Client$/;
const WORKLOAD_SEAMS = ['workloadClientConfig(', 'workloadStsClientConfig('] as const;
/**
 * The `${AWS::AccountId}` / placeholder-account lookups spread this instead:
 * the account follows where the stack was read (the caller under
 * `--from-cfn-stack`, else the `--role-arn` role). It is its own passing class, counted
 * exactly per file (see EXPECTED_DEPLOY_ACCOUNT_SITES).
 */
const DEPLOY_ACCOUNT_SEAM = 'accountLookupStsClientConfig(';
const EXPECTED_DEPLOY_ACCOUNT_SITES: Record<string, number> = {
  'src/cli/commands/ecs-service-emulator.ts': 2,
  'src/cli/commands/local-run-task.ts': 2,
  'src/cli/commands/local-invoke.ts': 1,
  'src/cli/commands/local-invoke-agentcore.ts': 1,
  'src/cli/commands/local-start-api.ts': 1,
};
const WORKLOAD_FLOOR = 24;

type SiteClass = 'role' | 'profile-resolution' | 'first-assume-hop';

const ALLOWLIST: Record<string, { class: SiteClass; count: number; reason: string }> = {
  'src/utils/profile-resolver.ts': {
    class: 'profile-resolution',
    count: 1,
    reason: "resolves the caller's named profile by construction",
  },
  'src/utils/profile-region.ts': {
    class: 'profile-resolution',
    count: 1,
    reason: "resolves the caller's named profile by construction",
  },
  'src/utils/role-arn.ts': {
    class: 'first-assume-hop',
    count: 1,
    reason: "applyRoleArnIfSet's own AssumeRole is the hop that creates the role",
  },
  'src/local/ecr-puller.ts': {
    class: 'role',
    count: 2,
    reason: 'GetCallerIdentity for the pull and the ECR client run as the role',
  },
  'src/local/agentcore-s3-bundle.ts': {
    class: 'role',
    count: 1,
    reason: "the fromS3 code bundle is the unit's own artifact, read as the role",
  },
};

interface Site {
  readonly file: string;
  readonly line: number;
  readonly workload: boolean;
  readonly deployAccount: boolean;
}

function sitesIn(abs: string): Site[] {
  const raw = readFileSync(abs, 'utf-8');
  if (!raw.includes('@aws-sdk/client-')) return [];
  const code = blankLiterals(raw);
  const file = relative(repoRoot, abs).split('\\').join('/');
  const sites: Site[] = [];
  for (const m of code.matchAll(/\bnew\b/g)) {
    const c = constructionAt(code, m.index!);
    if (!c || !CLIENT_NAME.test(c.name)) continue;
    const args = argumentText(code, c.argOpen);
    sites.push({
      file,
      line: code.slice(0, m.index!).split('\n').length,
      workload: args !== null && WORKLOAD_SEAMS.some((s) => args.includes(s)),
      deployAccount: args !== null && args.includes(DEPLOY_ACCOUNT_SEAM),
    });
  }
  return sites;
}

const allSites = collectTsFiles(SRC).flatMap(sitesIn);
const deployAccountSites = allSites.filter((s) => s.deployAccount);
const nonWorkload = allSites.filter((s) => !s.workload && !s.deployAccount);

describe('workload identity site fence (#783)', () => {
  it('finds the construction sites (parser floor)', () => {
    expect(allSites.length).toBeGreaterThanOrEqual(25);
    expect(allSites.filter((s) => s.workload).length).toBeGreaterThanOrEqual(WORKLOAD_FLOOR);
  });

  it('exactly the account-id lookups use accountLookupStsClientConfig', () => {
    const counts: Record<string, number> = {};
    for (const s of deployAccountSites) counts[s.file] = (counts[s.file] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_DEPLOY_ACCOUNT_SITES);
  });

  it('every non-workload site is allowlisted, and the allowlist is exact', () => {
    const problems: string[] = [];
    const byFile = new Map<string, Site[]>();
    for (const s of nonWorkload) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    for (const [file, sites] of byFile) {
      const entry = ALLOWLIST[file];
      const where = sites.map((s) => `${s.file}:${s.line}`).join(', ');
      if (!entry) {
        problems.push(
          `${where}: client does not spread workloadClientConfig( / workloadStsClientConfig( / accountLookupStsClientConfig( and is not allowlisted`
        );
      } else if (sites.length > entry.count) {
        problems.push(
          `${file}: ${sites.length} non-workload sites exceed the allowlisted ${entry.count} (${where})`
        );
      } else if (sites.length < entry.count) {
        problems.push(
          `${file}: allowlist says ${entry.count} but only ${sites.length} remain; lower the count`
        );
      }
    }
    for (const file of Object.keys(ALLOWLIST)) {
      if (!byFile.has(file)) {
        problems.push(`${file}: allowlist entry is dead (no non-workload client site); remove it`);
      }
    }
    expect(problems).toEqual([]);
  });
});
