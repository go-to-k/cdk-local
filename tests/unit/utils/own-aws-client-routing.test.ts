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
import { normalizeAwsEndpointServiceId } from '../../../src/utils/aws-proxy.js';

/**
 * go-to-k/cdk-local#898, inverted in #908: in AWS Emulator mixed mode every
 * own AWS SDK client picks its side by its endpoint service id
 * (`buildProxyClientConfig({ service })` / `workloadClientConfig({ service })`):
 * the emulator unless a `"real-aws"` exception names that service. A
 * construction that passes no service stays on real AWS in mixed mode, so
 * each one must be listed with its reason.
 *
 * Every construction in `src/**` (the population of the sibling
 * `aws-proxy-client-audit.test.ts`) must therefore either
 *
 * - pass `service: '<ID>'` where `<ID>` is the `AWS_ENDPOINT_URL_<ID>` suffix
 *   the SDK derives from that client's own `serviceId` (checked against the
 *   installed SDK below), or
 * - be listed in {@link NOT_PER_SERVICE} with the reason it does not route per
 *   service — and then pass no `service` at all.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const CLIENT_NAME = /^[A-Z][A-Za-z0-9_$]*Client$/;

/** The SDK package of every client class cdk-local constructs. */
const CLIENT_PACKAGES: Readonly<Record<string, string>> = {
  BedrockAgentCoreControlClient: '@aws-sdk/client-bedrock-agentcore-control',
  CloudFormationClient: '@aws-sdk/client-cloudformation',
  CloudFrontClient: '@aws-sdk/client-cloudfront',
  CloudFrontKeyValueStoreClient: '@aws-sdk/client-cloudfront-keyvaluestore',
  ECRClient: '@aws-sdk/client-ecr',
  EventBridgeClient: '@aws-sdk/client-eventbridge',
  KinesisClient: '@aws-sdk/client-kinesis',
  LambdaClient: '@aws-sdk/client-lambda',
  S3Client: '@aws-sdk/client-s3',
  SecretsManagerClient: '@aws-sdk/client-secrets-manager',
  SFNClient: '@aws-sdk/client-sfn',
  SNSClient: '@aws-sdk/client-sns',
  SQSClient: '@aws-sdk/client-sqs',
  SSMClient: '@aws-sdk/client-ssm',
  STSClient: '@aws-sdk/client-sts',
};

/**
 * Constructions that do not route per service in mixed mode, keyed
 * `<src-relative path>#<Client>` (`*#<Client>` for every site of a class),
 * each with its reason.
 */
const NOT_PER_SERVICE: Readonly<Record<string, string>> = {
  '*#STSClient':
    'identity: --role-arn / --assume-role / --ecr-role-arn assumes establish the REAL identity a mixed-mode ' +
    'workload holds (real AWS); the ${AWS::AccountId} lookup routes STS itself (accountLookupStsClientConfig)',
  'src/local/cfn-local-state-provider.ts#CloudFormationClient':
    "--from-cfn-stack's real side; createMixedModeStateProvider builds the emulator side with an endpointOverride",
  'src/local/cfn-local-state-provider.ts#LambdaClient':
    "--from-cfn-stack's real side (deployed-function env fallback, execution role)",
  'src/local/cfn-local-state-provider.ts#BedrockAgentCoreControlClient':
    "--from-cfn-stack's real side (deployed AgentCore runtime role)",
};

const SERVICE_ARG = /\bservice:\s*'([^']*)'/g;

interface Site {
  key: string;
  file: string;
  cls: string;
  line: number;
  services: string[];
}

function sites(): Site[] {
  const out: Site[] = [];
  for (const file of collectTsFiles(join(repoRoot, 'src'))) {
    const raw = readFileSync(file, 'utf-8');
    if (!raw.includes('@aws-sdk/client-')) continue;
    const code = blankLiterals(raw);
    const rel = relative(repoRoot, file).split('\\').join('/');
    for (const m of code.matchAll(/\bnew\b/g)) {
      const c = constructionAt(code, m.index!);
      if (!c || !CLIENT_NAME.test(c.name)) continue;
      const blanked = argumentText(code, c.argOpen);
      expect(blanked, `${rel}: unbalanced construction of ${c.name}`).not.toBeNull();
      // Same span on the raw source: the literal (the service id) is readable there.
      // Comments stripped, so a commented-out `service: '...'` routes nothing.
      const args = raw
        .slice(c.argOpen + 1, c.argOpen + 1 + blanked!.length)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      out.push({
        key: `${rel}#${c.name}`,
        file: rel,
        cls: c.name,
        line: raw.slice(0, m.index!).split('\n').length,
        services: [...args.matchAll(SERVICE_ARG)].map((s) => s[1]!),
      });
    }
  }
  return out;
}

async function sdkServiceId(cls: string): Promise<string> {
  const mod = (await import(CLIENT_PACKAGES[cls]!)) as Record<
    string,
    new (cfg: object) => { config: { serviceId: string }; destroy(): void }
  >;
  const client = new mod[cls]!({ region: 'us-east-1' });
  try {
    return normalizeAwsEndpointServiceId(client.config.serviceId);
  } finally {
    client.destroy();
  }
}

describe('own AWS clients pick their side per service in mixed mode (#898, #908)', () => {
  const all = sites();
  const notPerService = (s: Site): string | undefined => NOT_PER_SERVICE[s.key] ?? NOT_PER_SERVICE[`*#${s.cls}`];

  it('finds the population (a scan that matches nothing proves nothing)', () => {
    expect(all.length).toBeGreaterThan(30);
    expect(all.some((s) => s.cls === 'SecretsManagerClient')).toBe(true);
    expect(all.some((s) => s.file === 'src/local/httpv2-service-integration.ts')).toBe(true);
  });

  it('every construction passes its SDK service id, or is listed with a reason', async () => {
    const offenders: string[] = [];
    for (const s of all) {
      if (!(s.cls in CLIENT_PACKAGES)) {
        offenders.push(
          `${s.file}:${s.line} ${s.cls}: unknown client — add it to CLIENT_PACKAGES and route it`
        );
        continue;
      }
      if (notPerService(s)) {
        if (s.services.length > 0) {
          offenders.push(`${s.file}:${s.line} ${s.cls}: listed in NOT_PER_SERVICE but passes service`);
        }
        continue;
      }
      const expected = await sdkServiceId(s.cls);
      if (s.services.length !== 1 || s.services[0] !== expected) {
        offenders.push(
          `${s.file}:${s.line} ${s.cls}: pass \`service: '${expected}'\` to its client-config seam ` +
            `(found ${JSON.stringify(s.services)}), or list it in NOT_PER_SERVICE with a reason`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every NOT_PER_SERVICE entry still names a construction (no stale exemptions)', () => {
    const stale = Object.keys(NOT_PER_SERVICE).filter((k) =>
      k.startsWith('*#')
        ? !all.some((s) => s.cls === k.slice(2))
        : !all.some((s) => s.key === k)
    );
    expect(stale).toEqual([]);
  });
});
