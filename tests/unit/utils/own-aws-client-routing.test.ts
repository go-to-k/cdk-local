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
 * go-to-k/cdk-local#898: in AWS Emulator mixed mode every own AWS SDK client
 * picks its side by its endpoint service id (`buildProxyClientConfig({
 * service })` / `workloadClientConfig({ service })`). A construction that does
 * not pass one stays on real AWS, so a new client that forgets it silently
 * reads real AWS for a service the developer routed to the emulator.
 *
 * Every construction in `src/**` (the population of the sibling
 * `aws-proxy-client-audit.test.ts`) must therefore either
 *
 * - pass `service: '<ID>'` where `<ID>` is the `AWS_ENDPOINT_URL_<ID>` suffix
 *   the SDK derives from that client's own `serviceId` (checked against the
 *   installed SDK below), or
 * - be listed in {@link REAL_ONLY} with the reason it must stay on real AWS
 *   in mixed mode — and then pass no `service` at all.
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
 * Constructions that stay on real AWS in mixed mode, keyed
 * `<src-relative path>#<Client>` (`*#<Client>` for every site of a class),
 * each with its reason.
 */
const REAL_ONLY: Readonly<Record<string, string>> = {
  '*#STSClient':
    'identity: --role-arn / task-role assumes and the account lookup establish the REAL identity mixed mode keeps',
  'src/local/ecr-puller.ts#ECRClient':
    'the registry token must match the registry host `docker pull` reads, which the image URI names (real ECR)',
  'src/local/agentcore-s3-bundle.ts#S3Client':
    "a fromS3 code bundle is the deployed unit's own artifact, in the real deploy's bucket",
  'src/local/layer-arn-materializer.ts#LambdaClient':
    'a literal layer ARN is code shipped by the real deploy (often a public layer), not data the workload reads',
  'src/local/cfn-local-state-provider.ts#CloudFormationClient':
    "--from-cfn-stack's real side; createMixedModeStateProvider resolves names per service over it",
  'src/local/cfn-local-state-provider.ts#LambdaClient':
    "--from-cfn-stack's real side (deployed-function env fallback, execution role)",
  'src/local/cfn-local-state-provider.ts#BedrockAgentCoreControlClient':
    "--from-cfn-stack's real side (deployed AgentCore runtime role)",
  // `start-cloudfront` resolves its origins and stores with
  // `createLocalStateProvider(..., { realAwsOnly: true })`: real names, so real clients.
  'src/local/cloudfront-s3-origin.ts#S3Client':
    'start-cloudfront serves S3 origins under their real names (realAwsOnly state)',
  'src/local/cloudfront-distribution-config.ts#CloudFrontClient':
    "start-cloudfront reads the real distribution's origin bucket name",
  'src/local/cloudfront-kvs-client.ts#CloudFrontClient':
    'start-cloudfront looks a KeyValueStore up by its real name',
  'src/local/cloudfront-kvs-client.ts#CloudFrontKeyValueStoreClient':
    'start-cloudfront reads the real KeyValueStore its real-name lookup found',
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
      const args = raw.slice(c.argOpen + 1, c.argOpen + 1 + blanked!.length);
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

describe('own AWS clients pick their side per service in mixed mode (#898)', () => {
  const all = sites();
  const realOnly = (s: Site): string | undefined => REAL_ONLY[s.key] ?? REAL_ONLY[`*#${s.cls}`];

  it('finds the population (a scan that matches nothing proves nothing)', () => {
    expect(all.length).toBeGreaterThan(30);
    expect(all.some((s) => s.cls === 'SecretsManagerClient')).toBe(true);
    expect(all.some((s) => s.file === 'src/local/httpv2-service-integration.ts')).toBe(true);
  });

  it('every construction passes its SDK service id, or is listed as real-only with a reason', async () => {
    const offenders: string[] = [];
    for (const s of all) {
      if (!(s.cls in CLIENT_PACKAGES)) {
        offenders.push(
          `${s.file}:${s.line} ${s.cls}: unknown client — add it to CLIENT_PACKAGES and route it`
        );
        continue;
      }
      if (realOnly(s)) {
        if (s.services.length > 0) {
          offenders.push(`${s.file}:${s.line} ${s.cls}: listed real-only but passes service`);
        }
        continue;
      }
      const expected = await sdkServiceId(s.cls);
      if (s.services.length !== 1 || s.services[0] !== expected) {
        offenders.push(
          `${s.file}:${s.line} ${s.cls}: pass \`service: '${expected}'\` to its client-config seam ` +
            `(found ${JSON.stringify(s.services)}), or list it in REAL_ONLY with a reason`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every REAL_ONLY entry still names a construction (no stale exemptions)', () => {
    const stale = Object.keys(REAL_ONLY).filter((k) =>
      k.startsWith('*#')
        ? !all.some((s) => s.cls === k.slice(2))
        : !all.some((s) => s.key === k)
    );
    expect(stale).toEqual([]);
  });
});
