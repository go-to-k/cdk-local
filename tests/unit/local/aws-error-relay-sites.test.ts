import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import type { CrossStackResolver } from '../../../src/local/state-resolver.js';

/**
 * Issue #579 — the CALL SITES outside `src/cli/commands/**`.
 *
 * Issue #570 settled the policy (`src/local/credential-error.ts`) and applied
 * it to nine STS relays in the command layer, with a per-occurrence probe
 * harness at `tests/unit/cli/sts-error-relay-sites.test.ts`. This file is that
 * harness's sibling for the rest of the codebase: every remaining `catch` that
 * relayed an AWS SDK error's `message` into a line a user sees at DEFAULT
 * level.
 *
 * Every site is driven SEPARATELY, on purpose — the same reason the #570
 * harness gives: a whole-symbol probe answers "is ANY of this fenced", not "is
 * EACH". Each row below reaches exactly one `catch` and asserts against that
 * site's own literal, so reverting one site turns exactly its rows red.
 *
 * TWO sites in issue #579's scope are NOT rows here, because their fixtures
 * belong elsewhere and duplicating them would make this file the definition of
 * a different module's mocks:
 *
 *   - `local-studio.ts` / `prepareEcsImageContexts` — covered by the `#579`
 *     block in `tests/unit/cli/local-studio-pin-classifier.test.ts`, which
 *     already owns that command's mock graph.
 *   - `ecs-service-runner.ts` / `printExitedContainerLogs` — covered by
 *     `tests/unit/local/ecs-service-runner-exit-logs.test.ts`. It is the one
 *     site whose RECONSTRUCTION axis does not arise: the text is the
 *     container's own stdout, not an SDK failure, so nothing is withheld and
 *     the fix is the LEVEL half alone (one prefixed warn per line).
 *
 * A THIRD site is deliberately not a ROW but IS covered in this file, at the
 * bottom: `cloudfront-kvs-client.ts`'s `ListKeyValueStores` relay. It cannot be
 * a row because the table's five cases all assert WITHHOLDING, and that site
 * withholds nothing — it is a `debug` line, so the message is KEPT and only
 * flattened. Listing it as a row with four inapplicable cases would say less
 * than a block that states what it actually guarantees.
 *
 * The helper's own behaviour is fenced in
 * `tests/unit/local/credential-error.test.ts`; this file asserts only that
 * each site routes through it.
 *
 * # READ THIS BEFORE ADDING A SITE
 *
 * Two rules, both paid for rather than reasoned out in advance. Issue #579 ran
 * four review rounds and a mutation probe after each; the probe found
 * unfenced changes in THREE of them, every time in the same two shapes.
 *
 * 1. A `flattenToOneLine` call is NEVER covered incidentally. Nothing
 *    exercises it unless a case deliberately feeds it a character to flatten,
 *    so a flatten added without its own case is invisible to the entire suite
 *    and free for the next editor to delete. Rounds 1, 2 and 3 each shipped
 *    flattens that a revert left fully green — the role ARN, the
 *    `PhysicalResourceId`, the request-derived S3 key, the KVS ARN, four more.
 *
 * 2. A newly-added `catch` is invisible to every case that does not make the
 *    call FAIL. The same applies to a re-raise guard: if no case throws
 *    cdk-local's own error INSIDE the guarded region, dropping the guard stays
 *    green while the policy silently withholds text this repo wrote itself.
 *
 * Neither shape reads as missing in a diff review, which is why the mutation
 * probe is the check and the reading is not. After adding a site, REVERT it and
 * confirm its rows go red. A probe that comes back green is a finding.
 */

// --------------------------------------------------------------------------
// SDK mocks — one `send` per package so a row can never be satisfied by
// another row's rejection.
// --------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  ssmSend: vi.fn(),
  cfnSend: vi.fn(),
  lambdaSend: vi.fn(),
  agentCoreSend: vi.fn(),
  secretsSend: vi.fn(),
  s3Send: vi.fn(),
  kvsSend: vi.fn(),
  stsSend: vi.fn(),
  ecrSend: vi.fn(),
  sqsSend: vi.fn(),
  /** `resolveDeployedKvsArnByName` paginates rather than `send`s. */
  kvsListPages: vi.fn(),
}));

function clientClass(send: ReturnType<typeof vi.fn>) {
  return class {
    send = send;
    destroy(): void {}
  };
}
class AnyCommand {
  constructor(public input?: unknown) {}
}

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: clientClass(mocks.ssmSend),
  GetParametersCommand: AnyCommand,
  GetParameterCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: clientClass(mocks.cfnSend),
  ListStackResourcesCommand: AnyCommand,
  DescribeStacksCommand: AnyCommand,
  ListExportsCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: clientClass(mocks.lambdaSend),
  GetFunctionConfigurationCommand: AnyCommand,
  GetLayerVersionCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: clientClass(mocks.agentCoreSend),
  GetAgentRuntimeCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: clientClass(mocks.secretsSend),
  GetSecretValueCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: clientClass(mocks.s3Send),
  GetObjectCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-cloudfront-keyvaluestore', () => ({
  CloudFrontKeyValueStoreClient: clientClass(mocks.kvsSend),
  GetKeyCommand: AnyCommand,
  // The real class, so `err instanceof ResourceNotFoundException` in
  // `isKeyNotFound` stays a meaningful test rather than always false.
  ResourceNotFoundException: class extends Error {},
}));
vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: clientClass(vi.fn()),
  // The lookup iterates rather than `send`s, so the seam is the paginator: it
  // defers to `kvsListPages`, which a test can make throw.
  paginateListKeyValueStores: (): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      yield (await mocks.kvsListPages()) as unknown;
    },
  }),
}));
vi.mock('@aws-sdk/signature-v4a', () => ({}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: clientClass(mocks.stsSend),
  AssumeRoleCommand: AnyCommand,
  GetCallerIdentityCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: clientClass(mocks.ecrSend),
  GetAuthorizationTokenCommand: AnyCommand,
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: clientClass(mocks.sqsSend),
  SendMessageCommand: AnyCommand,
}));

const { resolveSsmParameters } = await import('../../../src/local/ssm-parameter-resolver.js');
const { SSMClient } = await import('@aws-sdk/client-ssm');
const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');
const { substituteAgainstStateAsync } = await import('../../../src/local/state-resolver.js');
const { createS3OriginReader } = await import('../../../src/local/cloudfront-s3-origin.js');
const { createDeployedKvsDataSource, resolveDeployedKvsArnByName } = await import(
  '../../../src/local/cloudfront-kvs-client.js'
);
const { materializeLayerFromArn } = await import('../../../src/local/layer-arn-materializer.js');
const { pullEcrImage, __resetStsCachesForTesting } = await import(
  '../../../src/local/ecr-puller.js'
);
const { resolvePlaceholderAccountForTest } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const { resolvePlaceholderAccountForTest: emulatorResolvePlaceholderAccount } = await import(
  '../../../src/cli/commands/ecs-service-emulator.js'
);
const { resolveEcsSecrets } = await import('../../../src/local/ecs-secrets-resolver.js');
const { downloadAndExtractS3Bundle } = await import('../../../src/local/agentcore-s3-bundle.js');
const { dispatchServiceIntegration, _resetClientCacheForTest } = await import(
  '../../../src/local/httpv2-service-integration.js'
);

// --------------------------------------------------------------------------
// Fixtures — the same two populations #570 fenced, restated so this file is
// readable on its own.
// --------------------------------------------------------------------------

const PASSPHRASE = 'hunter2-do-not-log';
const CHAIN_MESSAGE =
  `Command failed: /opt/bin/get-creds --vault-passphrase ${PASSPHRASE}\n` +
  `  vault: unlocked with passphrase ${PASSPHRASE}`;
/** Measured in `credential-error.test.ts`, restated so the expected line is literal. */
const CHAIN_MESSAGE_LENGTH = 125;
const WITHHELD = `CredentialsProviderError; ${CHAIN_MESSAGE_LENGTH}-character message withheld, logged at debug level under --verbose`;

class CredentialsProviderError extends Error {
  override name = 'CredentialsProviderError';
}
function chainError(): Error {
  return new CredentialsProviderError(CHAIN_MESSAGE);
}

/** The service message that must KEEP printing: it is the diagnosis. */
const SERVICE_MESSAGE = 'The security token included in the request is expired';

/**
 * A MODELED service exception. `$fault` + `$metadata` are set by the SDK from
 * the HTTP RESPONSE, never from anything the body names, which is why they are
 * the discriminator: a hostile endpoint can change `err.name` but cannot move a
 * `credential_process` command line onto this branch.
 */
function serviceError(message: string, name = 'ExpiredTokenException'): Error {
  const e = new Error(message);
  Object.defineProperty(e, 'name', { value: name });
  // 400 rather than 403 on purpose: `cloudfront-s3-origin`'s `classifyS3Error`
  // routes a 403 (and the name `AccessDenied`) into its `denied` branch, which
  // carries NO message at all -- so a 403 fixture would make that row assert
  // against a line the site never renders. The status is incidental to what
  // these rows fence; the branch it lands in is not.
  return Object.assign(e, { $fault: 'client', $metadata: { httpStatusCode: 400 } });
}
function expiredTokenError(): Error {
  return serviceError(SERVICE_MESSAGE);
}
/**
 * A service exception whose wire-derived message carries a forged log line.
 *
 * Named `ThrottlingException` rather than the `AccessDenied` the #570 harness
 * uses, for the same reason the status is 400: `classifyS3Error` special-cases
 * that NAME into its message-less `denied` branch. What this fixture fences is
 * the MESSAGE's newline; the forged-NAME half has its own case below.
 */
function forgedServiceError(): Error {
  return serviceError('denied\nWARN: signature verified', 'ThrottlingException');
}

let warnLines: string[] = [];
let debugLines: string[] = [];

/** The one warn line whose text contains `needle`. */
function warnContaining(needle: string): string {
  const matches = warnLines.filter((l) => l.includes(needle));
  expect(matches, `no warn line contained '${needle}' — the fixture did not reach the site`)
    .toHaveLength(1);
  return matches[0]!;
}

/** Run `fn` and return the message of whatever it throws. */
async function thrownMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the site to throw, but it resolved');
}

// --------------------------------------------------------------------------
// Site drivers
// --------------------------------------------------------------------------

const LAYER = {
  arn: 'arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:3',
  name: 'MyLayer',
  version: '3',
  region: 'us-east-1',
} as unknown as Parameters<typeof materializeLayerFromArn>[0];

/** `resolveSsmParameters(client, refs, label)` — the SSM client is the mock. */
function ssmClient(): Parameters<typeof resolveSsmParameters>[0] {
  return new SSMClient({}) as Parameters<typeof resolveSsmParameters>[0];
}
const SSM_REFS = [
  { logicalId: 'DbHost', ssmName: '/app/db-host', isList: false },
] as unknown as Parameters<typeof resolveSsmParameters>[1];

function importValueResolver(reject: () => Error): CrossStackResolver {
  return {
    resolveImport: async () => {
      throw reject();
    },
    resolveGetStackOutput: async () => {
      throw reject();
    },
  } as unknown as CrossStackResolver;
}

/**
 * What a site actually put in front of the reader.
 *
 * `text` is the rendered relay. `code` is set only where the site splits the
 * class name into its own field instead of prefixing it into the text — which
 * is the httpv2 body and nothing else, since a log line has one field and a
 * JSON body has two.
 */
interface Relayed {
  text: string;
  code?: string;
}

interface Site {
  /** `<file>` / `<enclosing function>` — the identity of the occurrence. */
  name: string;
  /**
   * The `operation` literal the site passes to `describeAwsFailureForWarn`,
   * which is what its `debug` line is prefixed with. Asserted because a
   * copy-pasted wrong label is otherwise undetectable: the user-visible line
   * reads correctly and only the `debug` line names the wrong call.
   */
  operation: string;
  /** A literal unique to THIS site's text, proving the fixture reached it. */
  reached: string;
  /**
   * Does the KEPT-branch rendering carry the class name as a `<name>: ` prefix?
   *
   * True at every log-line site, because `describeAwsFailureForWarn` has one
   * field to put both halves in. False at the httpv2 site alone, whose JSON
   * body carries the name in `code`, so its `message` is the bare sanitized
   * text — the asymmetry is real and is asserted rather than smoothed over,
   * since smoothing it over is how a row stops testing its own site.
   */
  namePrefix: boolean;
  /** Run the site with `err` as the SDK rejection; return what it rendered. */
  drive: (err: unknown) => Promise<Relayed>;
}

const sites: Site[] = [
  {
    name: 'ssm-parameter-resolver.ts / resolveSsmParameters',
    operation: 'SSM GetParameters',
    reached: 'SSM GetParameters(/app/db-host) failed: ',
    namePrefix: true,
    drive: async (err) => {
      mocks.ssmSend.mockRejectedValue(err);
      await resolveSsmParameters(ssmClient(), SSM_REFS, '--from-cfn-stack');
      return { text: warnContaining('SSM GetParameters(/app/db-host) failed: ') };
    },
  },
  {
    name: 'cfn-local-state-provider.ts / resolveDeployedFunctionEnv',
    operation: 'Lambda GetFunctionConfiguration',
    reached: 'GetFunctionConfiguration(fn-physical-id) failed: ',
    namePrefix: true,
    drive: async (err) => {
      mocks.lambdaSend.mockRejectedValue(err);
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      await p.resolveDeployedFunctionEnv('fn-physical-id');
      p.dispose();
      return { text: warnContaining('GetFunctionConfiguration(fn-physical-id) failed: ') };
    },
  },
  {
    name: 'cfn-local-state-provider.ts / resolveLambdaExecutionRoleArn',
    operation: 'Lambda GetFunctionConfiguration (--assume-role auto-resolve)',
    reached: 'GetFunctionConfiguration(fn-role-id) for --assume-role auto-resolve failed: ',
    namePrefix: true,
    drive: async (err) => {
      mocks.lambdaSend.mockRejectedValue(err);
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      await p.resolveLambdaExecutionRoleArn('fn-role-id');
      p.dispose();
      return { text: warnContaining('GetFunctionConfiguration(fn-role-id) for --assume-role') };
    },
  },
  {
    name: 'cfn-local-state-provider.ts / resolveAgentCoreRuntimeRoleArn',
    operation: 'bedrock-agentcore-control GetAgentRuntime (--assume-role auto-resolve)',
    reached: 'GetAgentRuntime(agent-id) for --assume-role auto-resolve failed: ',
    namePrefix: true,
    drive: async (err) => {
      mocks.agentCoreSend.mockRejectedValue(err);
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      await p.resolveAgentCoreRuntimeRoleArn('agent-id');
      p.dispose();
      return { text: warnContaining('GetAgentRuntime(agent-id) for --assume-role') };
    },
  },
  {
    name: 'cfn-local-state-provider.ts / load (ListStackResources)',
    operation: 'CloudFormation ListStackResources',
    reached: 'ListStackResources(S) failed: ',
    namePrefix: true,
    drive: async (err) => {
      mocks.cfnSend.mockRejectedValue(err);
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      await p.load('S', undefined);
      p.dispose();
      return { text: warnContaining('ListStackResources(S) failed: ') };
    },
  },
  {
    name: 'cfn-local-state-provider.ts / load (DescribeStacks)',
    operation: 'CloudFormation DescribeStacks',
    reached: 'DescribeStacks(S) failed: ',
    namePrefix: true,
    drive: async (err) => {
      // ListStackResources must SUCCEED so the fixture reaches the second call.
      mocks.cfnSend.mockResolvedValueOnce({ StackResourceSummaries: [] }).mockRejectedValue(err);
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      await p.load('S', undefined);
      p.dispose();
      return { text: warnContaining('DescribeStacks(S) failed: ') };
    },
  },
  {
    name: 'cfn-local-state-provider.ts / buildCrossStackResolver (ListExports)',
    operation: 'CloudFormation ListExports',
    reached: 'ListExports (us-east-1) failed: ',
    namePrefix: true,
    drive: async (err) => {
      mocks.cfnSend.mockRejectedValue(err);
      const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
      const resolver = await p.buildCrossStackResolver();
      await resolver?.resolveImport('SomeExport');
      p.dispose();
      return { text: warnContaining('ListExports (us-east-1) failed: ') };
    },
  },
  {
    name: 'state-resolver.ts / Fn::ImportValue',
    operation: 'CrossStackResolver.resolveImport (Fn::ImportValue)',
    reached: "Fn::ImportValue 'X': lookup failed: ",
    namePrefix: true,
    drive: async (err) => {
      const r = await substituteAgainstStateAsync(
        { 'Fn::ImportValue': 'X' },
        { resources: {}, crossStackResolver: importValueResolver(() => err as Error) }
      );
      expect(r.kind).toBe('unresolved');
      return { text: r.kind === 'unresolved' ? r.reason : '' };
    },
  },
  {
    name: 'state-resolver.ts / Fn::GetStackOutput',
    operation: 'CrossStackResolver.resolveGetStackOutput (Fn::GetStackOutput)',
    reached: "Fn::GetStackOutput 'Other.Out' (us-east-1): lookup failed: ",
    namePrefix: true,
    drive: async (err) => {
      const r = await substituteAgainstStateAsync(
        {
          'Fn::GetStackOutput': {
            StackName: 'Other',
            OutputName: 'Out',
            Region: 'us-east-1',
          },
        },
        { resources: {}, crossStackResolver: importValueResolver(() => err as Error) }
      );
      expect(r.kind).toBe('unresolved');
      return { text: r.kind === 'unresolved' ? r.reason : '' };
    },
  },
  {
    name: 'cloudfront-s3-origin.ts / classifyS3Error (via the reader warn)',
    operation: 'S3 GetObject',
    reached: "S3 read of 'index.html' from bucket 'cdn-bucket' failed: ",
    namePrefix: true,
    drive: async (err) => {
      mocks.s3Send.mockRejectedValue(err);
      const reader = createS3OriginReader('cdn-bucket');
      await reader({ uri: '/index.html' });
      await reader.close();
      return { text: warnContaining("S3 read of 'index.html' from bucket 'cdn-bucket' failed: ") };
    },
  },
  {
    name: 'cloudfront-kvs-client.ts / createDeployedKvsDataSource.getValue',
    operation: 'CloudFront KeyValueStore GetKey',
    reached: "cf.kvs().get('theme') against arn:aws:cloudfront::1:key-value-store/s failed: ",
    namePrefix: true,
    drive: async (err) => {
      mocks.kvsSend.mockRejectedValue(err);
      const src = createDeployedKvsDataSource({
        kvsArn: 'arn:aws:cloudfront::1:key-value-store/s',
      });
      return { text: await thrownMessage(() => src.getValue('theme')) };
    },
  },
  {
    name: 'layer-arn-materializer.ts / assumeRoleForLayer',
    operation: 'STS AssumeRole (--layer-role-arn)',
    reached: `Layer ${LAYER.arn}: STS AssumeRole(arn:aws:iam::1:role/L) failed: `,
    namePrefix: true,
    drive: async (err) => ({
      text: await thrownMessage(() =>
        materializeLayerFromArn(LAYER, {
          roleArn: 'arn:aws:iam::1:role/L',
          stsClientFactory: () => ({
            send: async () => {
              throw err;
            },
          }),
        })
      ),
    }),
  },
  {
    name: 'layer-arn-materializer.ts / fetchLayerContentUrl',
    operation: 'Lambda GetLayerVersion',
    reached: `Layer ${LAYER.arn}: GetLayerVersion failed in region us-east-1: `,
    namePrefix: true,
    drive: async (err) => ({
      text: await thrownMessage(() =>
        materializeLayerFromArn(LAYER, {
          lambdaClientFactory: () => ({
            send: async () => {
              throw err;
            },
          }),
        })
      ),
    }),
  },
  {
    name: 'ecr-puller.ts / assumeRoleForEcr',
    operation: 'STS AssumeRole (ECR pull)',
    reached: 'Failed to assume role arn:aws:iam::1:role/E for ECR pull: ',
    namePrefix: true,
    drive: async (err) => {
      __resetStsCachesForTesting();
      // GetCallerIdentity must SUCCEED so the fixture reaches the AssumeRole.
      mocks.stsSend.mockResolvedValueOnce({ Account: '999988887777' }).mockRejectedValue(err);
      return {
        text: await thrownMessage(() =>
          pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
            region: 'us-east-1',
            ecrRoleArn: 'arn:aws:iam::1:role/E',
          })
        ),
      };
    },
  },
  {
    name: 'ecs-secrets-resolver.ts / resolveSecretsManager',
    operation: 'SecretsManager GetSecretValue',
    reached:
      "Failed to resolve Secrets Manager secret for container 'api' / env 'DB_PASSWORD' (arn:aws:secretsmanager:us-east-1:1:secret:db): ",
    namePrefix: true,
    drive: async (err) => {
      mocks.secretsSend.mockRejectedValue(err);
      const text = await thrownMessage(() =>
        resolveEcsSecrets(
          [
            {
              containerName: 'api',
              name: 'DB_PASSWORD',
              valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:db',
            },
          ],
          { region: 'us-east-1' }
        )
      );
      return { text };
    },
  },
  {
    name: 'ecs-secrets-resolver.ts / resolveSsm',
    operation: 'SSM GetParameter (ECS secret)',
    reached:
      "Failed to resolve SSM parameter for container 'api' / env 'API_KEY' (/app/api-key): ",
    namePrefix: true,
    drive: async (err) => {
      mocks.ssmSend.mockRejectedValue(err);
      const text = await thrownMessage(() =>
        resolveEcsSecrets(
          [
            {
              containerName: 'api',
              name: 'API_KEY',
              valueFrom: 'arn:aws:ssm:us-east-1:1:parameter/app/api-key',
            },
          ],
          { region: 'us-east-1' }
        )
      );
      return { text };
    },
  },
  {
    name: 'httpv2-service-integration.ts / translateSdkError',
    operation: 'SQS-SendMessage service integration',
    /**
     * Empty, and that is the honest value rather than a gap.
     *
     * Every other row's relay is embedded in a sentence the site wrote, so a
     * literal from that sentence proves the fixture reached the intended
     * `catch`. This site's relay is a JSON body FIELD, so there is no framing
     * around it — `message` IS the rendering. Reaching the site is proved
     * instead by `JSON.parse` succeeding on the body plus the fact that only
     * `sqsSend` was made to reject.
     *
     * `drive` returns the PARSED `message`, not the raw body. Asserting
     * `not.toContain('\n')` against the raw body would be vacuous, since
     * `JSON.stringify` escapes a newline to the two characters `\` `n` and the
     * check would pass on text that renders as two lines wherever the body is
     * displayed.
     */
    reached: '',
    // The body carries the class name in `code`, so `message` is the bare
    // sanitized text. This is the only `false` in the table.
    namePrefix: false,
    drive: async (err) => {
      _resetClientCacheForTest();
      mocks.sqsSend.mockRejectedValue(err);
      const res = await dispatchServiceIntegration(
        'SQS-SendMessage',
        { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q', MessageBody: 'hi' },
        'us-east-1'
      );
      const parsed = JSON.parse(res.body ?? '') as { message: string; code: string };
      return { text: parsed.message, code: parsed.code };
    },
  },
];

describe('#579 — no AWS SDK error message reaches a default-level line unfiltered', () => {
  beforeEach(() => {
    warnLines = [];
    debugLines = [];
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'debug').mockImplementation((m: string) => {
      debugLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('covers every relay site the sweep found, with no row silently dropped', () => {
    // A table driven off the source could not notice a site being DELETED from
    // it, so the count is asserted against a literal, and the `operation`
    // labels are asserted UNIQUE: each names a distinct AWS call, so a
    // copy-pasted label is a real defect rather than a stylistic one. (The
    // #570 harness deliberately allows shared `reached` literals across rows;
    // here no two sites share text, so both keys are unique.)
    expect(sites).toHaveLength(17);
    expect(new Set(sites.map((s) => s.name)).size).toBe(17);
    expect(new Set(sites.map((s) => s.operation)).size).toBe(17);
    expect(new Set(sites.map((s) => s.reached)).size).toBe(17);
    // Exactly one site splits the class name into its own field. If a second
    // one ever does, the shared cases below need to say which — a silent
    // second `false` would mean a row stopped asserting the name at all.
    expect(sites.filter((s) => !s.namePrefix).map((s) => s.name)).toEqual([
      'httpv2-service-integration.ts / translateSdkError',
    ]);
  });

  describe.each(sites)('$name', (site) => {
    it('withholds a credential-chain message and prints it at debug', async () => {
      const { text } = await site.drive(chainError());

      expect(text).toContain(`${site.reached}${WITHHELD}`);
      expect(text).not.toContain(PASSPHRASE);
      expect(text).not.toContain('Command failed');
      expect(text).not.toContain('\n');

      // Withheld is only acceptable while the text is in full at `debug`, and
      // that line must name THIS call — a copy-pasted `operation` label is
      // invisible in the user-visible line.
      const debug = debugLines.filter((l) => l.includes(PASSPHRASE));
      expect(debug).toHaveLength(1);
      expect(debug[0]!).toContain(`${site.operation}: the AWS SDK's own failure message was:`);
      // Flattened: the debug stream is the same stdout studio mirrors into an
      // HTTP-served ring, so the two-line chain message must arrive as one.
      expect(debug[0]!).not.toContain('\n');
    });

    it('keeps a modeled service exception message, which is the diagnosis', async () => {
      const { text, code } = await site.drive(expiredTokenError());
      const named = site.namePrefix ? 'ExpiredTokenException: ' : '';
      expect(text).toContain(`${site.reached}${named}${SERVICE_MESSAGE}`);
      // Where the name lives in its own field, assert it there instead — the
      // name must survive SOMEWHERE, or the reader cannot tell what failed.
      if (!site.namePrefix) expect(code).toBe('ExpiredTokenException');
    });

    it('flattens a forged newline inside a kept service message', async () => {
      const { text } = await site.drive(forgedServiceError());
      const named = site.namePrefix ? 'ThrottlingException: ' : '';
      expect(text).toContain(`${site.reached}${named}denied WARN: signature verified`);
      expect(text).not.toContain('\n');
    });

    it('clamps a forged wire-derived err.name', async () => {
      // `err.name` is built from `x-amzn-errortype` with no length cap and no
      // newline stripping, so it is the OTHER half of the forging surface —
      // and the half these sites interpolated raw before #579.
      const { text, code } = await site.drive(
        serviceError('denied', 'Foo\nWARN: signature verified')
      );
      expect(text).toContain(`${site.reached}${site.namePrefix ? 'unknown: ' : ''}denied`);
      expect(text).not.toContain('signature verified');
      if (!site.namePrefix) expect(code).toBe('unknown');
    });

    it('withholds an unstringifiable throw rather than crashing the site', async () => {
      // Reaches `stringifyThrown`'s `[unstringifiable throw]` fallback through
      // a real call site: `String()` on a null-prototype object raises
      // TypeError, and that throw escaping the `catch` would turn a
      // warn-and-continue (or a clean error) into an unhandled failure.
      const { text } = await site.drive(Object.create(null));
      expect(text).toContain(`${site.reached}unknown; 23-character message withheld`);
    });
  });
});

/**
 * Issue #579 — the SECOND wire-derived value on those same lines, and it is
 * not the error half.
 *
 * `cfn-local-state-provider.ts` interpolates a resource's PHYSICAL ID into
 * three warn templates. That id is copied out of `ListStackResources`'
 * `PhysicalResourceId` with no validation at all, so it is exactly as
 * endpoint-controlled as an error message — and it fires on a path where the
 * SAME endpoint decides whether the follow-up call fails. A hijacked
 * CloudFormation endpoint answering
 * `PhysicalResourceId: "fn\nWARN: forged"` and then failing the
 * `GetFunctionConfiguration` it also serves puts an attacker-chosen entry in
 * the studio ring by the same mechanism the `Hint:` line the #570 lane closed.
 *
 * This block exists because a mutation probe that reverted the flatten left
 * every case in the table above GREEN — the same way #570's role-ARN flatten shipped
 * unfenced.
 */
describe('#579 — a forged newline in a physical id cannot forge a line either', () => {
  const FORGED_ID = 'fn-physical-id\nWARN: signature verified';

  beforeEach(() => {
    warnLines = [];
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const idSites: { name: string; drive: () => Promise<void> }[] = [
    {
      name: 'resolveDeployedFunctionEnv',
      drive: async () => {
        mocks.lambdaSend.mockRejectedValue(new Error('boom'));
        const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
        await p.resolveDeployedFunctionEnv(FORGED_ID);
        p.dispose();
      },
    },
    {
      name: 'resolveLambdaExecutionRoleArn',
      drive: async () => {
        mocks.lambdaSend.mockRejectedValue(new Error('boom'));
        const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
        await p.resolveLambdaExecutionRoleArn(FORGED_ID);
        p.dispose();
      },
    },
    {
      name: 'resolveAgentCoreRuntimeRoleArn',
      drive: async () => {
        mocks.agentCoreSend.mockRejectedValue(new Error('boom'));
        const p = new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
        await p.resolveAgentCoreRuntimeRoleArn(FORGED_ID);
        p.dispose();
      },
    },
  ];

  it('covers all three physical-id-quoting sites', () => {
    expect(idSites).toHaveLength(3);
  });

  describe.each(idSites)('$name', (site) => {
    it('flattens the id, keeping every character on one line', async () => {
      await site.drive();

      const matches = warnLines.filter((l) => l.includes('WARN: signature verified'));
      expect(matches, 'the forged id never reached a warn line at all').toHaveLength(1);
      const line = matches[0]!;
      // Every character survives -- only the break became a space, so the id is
      // still recognisable to whoever has to debug it.
      expect(line).toContain('fn-physical-id WARN: signature verified');
      expect(line).not.toContain('\n');
    });
  });
});

/**
 * Issue #579 — the httpv2 site is the only one whose output crosses a PROCESS
 * boundary: it is a served HTTP response body, not a log line. So it carries a
 * second obligation the log sites do not have, and this block is that
 * obligation stated as cases rather than as prose: sanitizing the WIRE-derived
 * half must not touch cdk-local's OWN text, and must not reshape the body.
 *
 * `requireParams`' 400 is the one that would have regressed. Before #579 it
 * threw an anonymous `Error` carrying a `statusCode`, which fell through the
 * SDK branch — so the credential-error policy, applied to that branch, would
 * have withheld a message cdk-local wrote itself and turned an actionable 400
 * into a class name and a character count.
 */
describe('#579 — the httpv2 body sanitizes wire text only, and keeps its shape', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays requireParams' 400 byte-identically, with the code field kept", async () => {
    _resetClientCacheForTest();
    const res = await dispatchServiceIntegration(
      'SQS-SendMessage',
      // `MessageBody` missing => the cdk-local-authored 400.
      { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q' },
      'us-east-1'
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? '')).toEqual({
      message: 'missing required RequestParameter(s): MessageBody',
      code: 'ServiceIntegrationRequestError',
    });
    // It never reached the SDK, so nothing was withheld on the way.
    expect(mocks.sqsSend).not.toHaveBeenCalled();
  });

  it('relays the no-region 400 byte-identically (raised before the guarded try)', async () => {
    _resetClientCacheForTest();
    const res = await dispatchServiceIntegration('SQS-SendMessage', { Region: '  ' }, '  ');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? '')).toEqual({
      message:
        "No AWS region configured. Set --region, AWS_REGION, or pass a 'Region' RequestParameter.",
    });
  });

  it('keeps the SDK branch status code, which is what the integ fixture asserts', async () => {
    // `tests/integration/local-start-api/verify.sh` accepts ANY status other
    // than 501 on POST /sqs and only greps the body for the deferred-501
    // marker. #579 changed `message` / `code` and NOTHING about `statusCode`,
    // and this pins that so the fixture cannot be broken from here.
    _resetClientCacheForTest();
    mocks.sqsSend.mockRejectedValue(serviceError('The queue does not exist.', 'QueueDoesNotExist'));
    const res = await dispatchServiceIntegration(
      'SQS-SendMessage',
      { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q', MessageBody: 'hi' },
      'us-east-1'
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('Not Implemented');
    // `message` is the BARE sanitized text: this body carries the class name
    // in `code`, so prefixing it into `message` too would both duplicate it and
    // change what a client parsing `message` reads (review round 2).
    expect(JSON.parse(res.body ?? '')).toEqual({
      message: 'The queue does not exist.',
      code: 'QueueDoesNotExist',
    });
  });

  it('defaults to 500 for a transport failure and withholds its message', async () => {
    // The shape the integ fixture actually produces: it POSTs to
    // `https://sqs.invalid.example/q`, so the SDK fails to RESOLVE the host.
    // That is a plain `Error` with no `$fault`, i.e. the withheld branch — and
    // the status is unchanged at 500, which is what keeps the fixture green.
    _resetClientCacheForTest();
    const dns = new Error('getaddrinfo ENOTFOUND sqs.invalid.example');
    Object.assign(dns, { code: 'ENOTFOUND' });
    mocks.sqsSend.mockRejectedValue(dns);
    const res = await dispatchServiceIntegration(
      'SQS-SendMessage',
      { QueueUrl: 'https://sqs.invalid.example/q', MessageBody: 'hi' },
      'us-east-1'
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('Not Implemented');
    expect(res.body).not.toContain('sqs.invalid.example');
    // `clampErrorCode` keeps a bare identifier, so the reader still learns it
    // was a DNS failure rather than a misconfiguration.
    expect(JSON.parse(res.body ?? '')).toEqual({
      message:
        'Error ENOTFOUND; 41-character message withheld, logged at debug level under --verbose',
      code: 'Error',
    });
  });
});

/**
 * Issue #579 review round 2 — three changes that had NO covering assertion.
 *
 * Each was found the same way the PhysicalResourceId flatten was: revert it,
 * and the whole suite stays green. A change nothing asserts is a change the
 * next editor may undo for free, which is the failure mode this file exists to
 * prevent, so a probe that comes back all-green is a finding rather than a
 * pass.
 */
describe('#579 — the three changes that shipped unfenced in round 1', () => {
  beforeEach(() => {
    debugLines = [];
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(getLogger(), 'debug').mockImplementation((m: string) => {
      debugLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cloudfront-kvs-client.ts / resolveDeployedKvsArnByName (the debug relay)', () => {
    /**
     * NOT a `sites` row, and the header says why: this line is `debug`, so the
     * message is KEPT rather than withheld and four of the table's five cases
     * would not apply. What it must still do is FLATTEN — the `debug` stream is
     * the same stdout `cdkl studio` mirrors into an HTTP-served ring — and
     * survive an unstringifiable throw, because the whole point of the `catch`
     * is that a lookup miss falls back to the unbound-KVS path.
     */
    async function driveLookup(err: unknown): Promise<{ arn: string } | undefined> {
      mocks.kvsListPages.mockImplementation(() => {
        throw err;
      });
      return resolveDeployedKvsArnByName('store-name');
    }

    it('keeps the message (it is debug) but flattens it onto one line', async () => {
      await driveLookup(new Error('AccessDenied\nServer listening on http://attacker.example/'));
      const line = debugLines.find((l) => l.includes("ListKeyValueStores lookup for 'store-name'"));
      expect(line, 'the fixture did not reach the debug relay').toBeDefined();
      // Kept in full — nothing is withheld at `debug`.
      expect(line).toContain('Server listening on http://attacker.example/');
      // But flattened: one emitted line, so it cannot forge a second one in
      // the studio ring under `--verbose`.
      expect(line).not.toContain('\n');
      expect(line).toContain('AccessDenied Server listening on');
    });

    it('survives an unstringifiable throw instead of escaping the catch', async () => {
      // The pre-#579 spelling was `String(err)`, which THROWS on a
      // null-prototype object ("Cannot convert object to primitive value").
      // That throw would escape this best-effort `catch` and turn a
      // fall-back-to-unbound-KVS into a hard failure.
      await expect(driveLookup(Object.create(null))).resolves.toBeUndefined();
      const line = debugLines.find((l) => l.includes("ListKeyValueStores lookup for 'store-name'"));
      expect(line).toContain('[unstringifiable throw]');
    });

    it('resolves undefined so the caller still falls back to the unbound path', async () => {
      await expect(driveLookup(new Error('boom'))).resolves.toBeUndefined();
    });
  });

  describe('httpv2-service-integration.ts / the NON-OBJECT throw branch', () => {
    it('withholds a bare string throw from the served response body', async () => {
      // `throw 'x'` skips the object branch entirely and lands on
      // `errorResponse(500, ...)`, which used to interpolate `String(err)`.
      // This is a RESPONSE BODY, so the text leaves the process.
      _resetClientCacheForTest();
      mocks.sqsSend.mockRejectedValue(`nope\nWARN: forged ${PASSPHRASE}`);
      const res = await dispatchServiceIntegration(
        'SQS-SendMessage',
        { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q', MessageBody: 'hi' },
        'us-east-1'
      );
      expect(res.statusCode).toBe(500);
      const parsed = JSON.parse(res.body ?? '') as { message: string };
      expect(parsed.message).toContain('Unexpected error invoking SQS-SendMessage: ');
      expect(parsed.message).not.toContain(PASSPHRASE);
      expect(parsed.message).not.toContain('WARN: forged');
      // A bare string names no class, so the clamp reports `unknown` rather
      // than inventing one.
      expect(parsed.message).toContain('unknown; ');
      expect(parsed.message).toContain('message withheld');
    });
  });

  describe('layer-arn-materializer.ts / AssumeRole returned no Credentials', () => {
    it("keeps cdk-local's own text AND the site's framing", async () => {
      // Its twin (`GetLayerVersion response did not include Content.Location`)
      // was fenced in round 1; this one was not. Both regressed the same way:
      // round 1 re-raised them BARE, dropping the `Layer <arn>: <call> failed:
      // ... <remedy>` envelope. The existing tests substring-match the inner
      // sentence, so nothing went red.
      const message = await thrownMessage(() =>
        materializeLayerFromArn(LAYER, {
          roleArn: 'arn:aws:iam::1:role/L',
          // A response with no `Credentials` — cdk-local's own guard fires.
          stsClientFactory: () => ({ send: async () => ({}) }),
        })
      );
      expect(message).toBe(
        `Layer ${LAYER.arn}: STS AssumeRole(arn:aws:iam::1:role/L) failed: ` +
          'AssumeRole returned no Credentials. ' +
          'Check the role trust policy permits your principal and sts:AssumeRole is allowed.'
      );
    });

    it("keeps the Content.Location guard's framing too (its fenced twin)", async () => {
      const message = await thrownMessage(() =>
        materializeLayerFromArn(LAYER, {
          lambdaClientFactory: () => ({ send: async () => ({ Content: {} }) }),
        })
      );
      expect(message).toBe(
        `Layer ${LAYER.arn}: GetLayerVersion failed in region us-east-1: ` +
          'GetLayerVersion response did not include Content.Location (presigned ZIP URL).'
      );
    });

    it('still passes an ALREADY-FRAMED throw through untouched', async () => {
      // The ARN-shape guard frames itself and fires before any AWS call, so
      // wrapping it would double the `Layer <arn>:` prefix and prepend
      // `GetLayerVersion failed` to a failure where no call was made.
      const message = await thrownMessage(() =>
        materializeLayerFromArn(
          { ...LAYER, arn: 'arn:aws:lambda:us-east-1:111122223333:layer:MyLayer' },
          { lambdaClientFactory: () => ({ send: async () => ({}) }) }
        )
      );
      // Pinned as an EXACT string, because this is an observable behaviour
      // change and the PR body quotes it. On `main` the same input rendered
      // DOUBLE-framed — `Layer <arn>: GetLayerVersion failed in region <r>:
      // Layer <arn>: not a layer-version ARN ... .` with a doubled full stop —
      // because the guard's own framed message was wrapped again by the site.
      expect(message).toBe(
        'Layer arn:aws:lambda:us-east-1:111122223333:layer:MyLayer: ' +
          "not a layer-version ARN (no ':<version>' suffix to strip). " +
          'Expected arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>.'
      );
      expect(message).not.toContain('GetLayerVersion failed in region');
    });
  });
});

/**
 * Issue #579 review round 2 — the SECOND unfenced sweep.
 *
 * Round 2 fixed a blocker, two flatten sites and four nits, and a probe run
 * over the whole round found SIX of them green when reverted: the same result
 * the PhysicalResourceId flatten gave in round 1, from the same cause. A
 * flatten is invisible to every assertion that does not deliberately feed it a
 * character to flatten, and a new `catch` is invisible to every assertion that
 * does not deliberately make the call fail. Neither shows up in a diff review
 * as missing, which is why the probe is the check and not the reading.
 */
describe('#579 round 2 — the fixes that a probe found unfenced', () => {
  beforeEach(() => {
    warnLines = [];
    debugLines = [];
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'debug').mockImplementation((m: string) => {
      debugLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('BLOCKER — agentcore-s3-bundle.ts / defaultFetchObject', () => {
    /**
     * The site the sweep first mis-triaged. Its `try` wrapped `client.send` in
     * a `finally` with NO `catch`, so the raw SDK error propagated to
     * `withErrorHandling` -> `formatError`, which prints
     * `${error.name}: ${error.message}` unflattened and unclamped at DEFAULT
     * level. Being outside the unzip `catch` made it UNCOVERED, not out of
     * scope.
     */
    it('withholds a credential-chain failure instead of letting it reach formatError', async () => {
      mocks.s3Send.mockRejectedValue(chainError());
      const message = await thrownMessage(() =>
        downloadAndExtractS3Bundle({ bucket: 'bkt', key: 'bundle.zip' })
      );
      expect(message).toContain('S3 GetObject for s3://bkt/bundle.zip failed: ');
      expect(message).toContain(WITHHELD);
      expect(message).not.toContain(PASSPHRASE);
      expect(message).not.toContain('Command failed');
      expect(message).not.toContain('\n');
      // And the withheld text is recoverable, naming this call.
      const debug = debugLines.filter((l) => l.includes(PASSPHRASE));
      expect(debug).toHaveLength(1);
      expect(debug[0]!).toContain(
        "S3 GetObject (fromS3 bundle): the AWS SDK's own failure message was:"
      );
    });

    it('keeps a modeled S3 exception message and clamps its forged name', async () => {
      mocks.s3Send.mockRejectedValue(serviceError('The key does not exist.', 'NoSuchKey'));
      expect(
        await thrownMessage(() => downloadAndExtractS3Bundle({ bucket: 'bkt', key: 'k.zip' }))
      ).toContain('failed: NoSuchKey: The key does not exist.');

      mocks.s3Send.mockRejectedValue(serviceError('denied', 'Foo\nWARN: signature verified'));
      const forged = await thrownMessage(() =>
        downloadAndExtractS3Bundle({ bucket: 'bkt', key: 'k.zip' })
      );
      expect(forged).toContain('failed: unknown: denied');
      expect(forged).not.toContain('signature verified');
    });

    it("re-raises cdk-local's own empty-body throw intact", async () => {
      // It fires INSIDE the same `try`, so without the re-raise guard the
      // policy would withhold a message cdk-local wrote itself.
      mocks.s3Send.mockResolvedValue({});
      expect(
        await thrownMessage(() => downloadAndExtractS3Bundle({ bucket: 'bkt', key: 'k.zip' }))
      ).toBe('S3 GetObject for s3://bkt/k.zip returned an empty body.');
    });
  });

  describe('BLOCKER — cloudfront-s3-origin.ts / the REQUEST-derived key', () => {
    // The most reachable forged-line vector in the sweep: `uriToKey` runs
    // `decodeURIComponentSafe` over the request URI, so this needs no
    // credentials, no hostile AWS endpoint and no `--verbose` — just an HTTP
    // client that can reach the served port.
    const FORGED_URI = '/%0AWARN:%20signature%20verified';

    it('flattens the key on the read-failure warn', async () => {
      mocks.s3Send.mockRejectedValue(serviceError('boom', 'InternalError'));
      const reader = createS3OriginReader('cdn-bucket');
      await reader({ uri: FORGED_URI });
      await reader.close();
      const line = warnContaining('signature verified');
      expect(line).toContain("S3 read of ' WARN: signature verified'");
      expect(line).not.toContain('\n');
    });

    it('flattens the key on the access-denied warn', async () => {
      mocks.s3Send.mockRejectedValue(serviceError('nope', 'AccessDenied'));
      const reader = createS3OriginReader('cdn-bucket');
      await reader({ uri: FORGED_URI });
      await reader.close();
      const line = warnContaining('signature verified');
      expect(line).toContain("S3 denied reading ' WARN: signature verified'");
      expect(line).not.toContain('\n');
    });

    it('flattens the custom-error page key too', async () => {
      // The primary key must MISS (404) so the reader falls through to the
      // `CustomErrorResponses` candidate, and that read must then be DENIED so
      // the warn under test fires (a plain miss on the error page is silent).
      mocks.s3Send
        .mockRejectedValueOnce(serviceError('gone', 'NoSuchKey'))
        .mockRejectedValue(serviceError('nope', 'AccessDenied'));
      const reader = createS3OriginReader('cdn-bucket');
      await reader({
        uri: '/ok.html',
        customErrorResponses: [
          {
            errorCode: 404,
            responseCode: 200,
            responsePagePath: '/spa\nWARN: signature verified',
          },
        ] as unknown as Parameters<typeof reader>[0]['customErrorResponses'],
      });
      await reader.close();
      const line = warnContaining("custom-error page 'spa WARN: signature verified'");
      expect(line).not.toContain('\n');
    });
  });

  describe('NIT — the wire-derived values on default-level lines', () => {
    const FORGED_ARN = 'arn:aws:iam::1:role/x\nWARN: signature verified';

    /** A well-formed ARN, for the guard-the-guards below. */
    const CLEAN_ARN = 'arn:aws:iam::999988887777:role/CleanRole';

    /**
     * REWRITTEN by issue #607, like the sibling cases in
     * `tests/unit/cli/sts-error-relay-sites.test.ts`.
     *
     * These two used to assert the FLATTEN: a forged newline reached the
     * thrown message and the flatten was what kept it on one line. #607
     * guards both sends — `--ecr-role-arn` and `--layer-role-arn` — so the
     * forged value is now REFUSED before either line is built, which is
     * strictly stronger. The flatten stays as belt-and-braces at the sites
     * a well-formed ARN still reaches.
     *
     * NOTE the reason those two sends are guarded is CONSISTENCY and the
     * LENGTH BOUND, not #607's threat model: both take their ARN only from
     * the user's own argv, never from a wire response.
     */
    it('ecr-puller.ts REFUSES a forged role ARN before any line is built', async () => {
      __resetStsCachesForTesting();
      mocks.stsSend
        .mockResolvedValueOnce({ Account: '999988887777' })
        .mockRejectedValue(new Error('boom'));
      const message = await thrownMessage(() =>
        pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
          region: 'us-east-1',
          ecrRoleArn: FORGED_ARN,
        })
      );
      expect(message).toContain('AssumeRole refused');
      expect(message).toContain('Nothing was sent to STS');
      expect(message).not.toContain('\n');
    });

    it('ecr-puller.ts guard-the-guard: a WELL-FORMED ARN still reaches the flattened line', async () => {
      __resetStsCachesForTesting();
      mocks.stsSend
        .mockResolvedValueOnce({ Account: '999988887777' })
        .mockRejectedValue(new Error('boom'));
      const message = await thrownMessage(() =>
        pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
          region: 'us-east-1',
          ecrRoleArn: CLEAN_ARN,
        })
      );
      expect(message).toContain(`assume role ${CLEAN_ARN}`);
      expect(message).not.toContain('AssumeRole refused');
    });

    it('layer-arn-materializer.ts REFUSES a forged role ARN before any line is built', async () => {
      const message = await thrownMessage(() =>
        materializeLayerFromArn(LAYER, {
          roleArn: FORGED_ARN,
          stsClientFactory: () => ({
            send: async () => {
              throw new Error('boom');
            },
          }),
        })
      );
      expect(message).toContain('AssumeRole refused');
      expect(message).not.toContain('\n');
      // Self-framed: the caller's own wrapper interpolates the raw ARN with no
      // length cap, so the refusal must not travel through it.
      expect(message).not.toContain('STS AssumeRole(');
    });

    it('layer-arn-materializer.ts guard-the-guard: a WELL-FORMED ARN still reaches the flattened line', async () => {
      const message = await thrownMessage(() =>
        materializeLayerFromArn(LAYER, {
          roleArn: CLEAN_ARN,
          stsClientFactory: () => ({
            send: async () => {
              throw new Error('boom');
            },
          }),
        })
      );
      expect(message).toContain(`STS AssumeRole(${CLEAN_ARN})`);
      expect(message).not.toContain('AssumeRole refused');
    });

    it("layer-arn-materializer.ts flattens the presigned host's HTTP reason phrase", async () => {
      // `statusText` is chosen by the presigned host. The HTTP parser forbids
      // CR/LF there, so the fixture uses U+2028 and an ANSI escape — the two
      // the protocol does NOT stop, and which still break a line in the studio
      // UI's `<pre>` and in a terminal respectively.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden\u2028WARN: signature verified\u001b[0m',
      })) as unknown as typeof globalThis.fetch;
      try {
        const message = await thrownMessage(() =>
          materializeLayerFromArn(LAYER, {
            lambdaClientFactory: () => ({
              send: async () => ({ Content: { Location: 'https://presigned.example/zip' } }),
            }),
          })
        );
        expect(message).toContain('HTTP 403 Forbidden WARN: signature verified');
        expect(message).not.toContain('\u2028');
        expect(message).not.toContain('\u001b');
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('httpv2 range-guards $metadata.httpStatusCode before it becomes res.statusCode', async () => {
      // `decorateServiceException` copies parsed response-body keys onto the
      // exception, so a non-integer here is reachable — and it would raise
      // `ERR_HTTP_INVALID_STATUS_CODE` on a real `http.ServerResponse`, taking
      // the request handler down instead of answering.
      _resetClientCacheForTest();
      const weird = new Error('boom');
      Object.assign(weird, { $fault: 'client', $metadata: { httpStatusCode: '500\nWARN: x' } });
      const res = await dispatchServiceIntegration(
        'SQS-SendMessage',
        { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q', MessageBody: 'hi' },
        'us-east-1'
      );
      expect(typeof res.statusCode).toBe('number');
      expect(Number.isInteger(res.statusCode)).toBe(true);
      mocks.sqsSend.mockRejectedValue(weird);
      const res2 = await dispatchServiceIntegration(
        'SQS-SendMessage',
        { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q', MessageBody: 'hi' },
        'us-east-1'
      );
      expect(res2.statusCode).toBe(500);
    });
  });
});

/**
 * Issue #579 review round 3 — the sites the DERIVED population found.
 *
 * Rounds 1 and 2 swept the list issue #579 enumerated. That list was an INPUT,
 * not the population: the population is "every AWS SDK `.send(...)` whose
 * failure can reach a default-level line", and deriving it (brace-matched
 * `try` regions across `src/**`, then a caller check on every unguarded hit)
 * turned up three more instances of the SAME `try { send } finally { destroy }`
 * shape whose mis-triage `agentcore-s3-bundle.ts` documents at length —
 * including the `GetCallerIdentity` call issue #570 had already guarded at five
 * OTHER sites.
 *
 * The lesson is in the method, not the count: an enumerated list cannot tell
 * you what it left out, and a shape this uniform is derivable.
 */
describe('#579 round 3 — the catch-less sends the derived population found', () => {
  beforeEach(() => {
    debugLines = [];
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(getLogger(), 'debug').mockImplementation((m: string) => {
      debugLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ecr-puller.ts / pullEcrImage (STS GetCallerIdentity)', () => {
    // The most reachable of the three: no `--assume-role`, no `--ecr-role-arn`,
    // just a deployed-image pull on the default credential chain.
    it('withholds a credential-chain failure and names the call at debug', async () => {
      __resetStsCachesForTesting();
      mocks.stsSend.mockRejectedValue(chainError());
      const message = await thrownMessage(() =>
        pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
          region: 'us-east-1',
        })
      );
      expect(message).toContain('STS GetCallerIdentity failed while preparing the ECR pull: ');
      expect(message).toContain(WITHHELD);
      expect(message).not.toContain(PASSPHRASE);
      expect(message).not.toContain('\n');
      const debug = debugLines.filter((l) => l.includes(PASSPHRASE));
      expect(debug).toHaveLength(1);
      expect(debug[0]!).toContain(
        "STS GetCallerIdentity (ECR pull): the AWS SDK's own failure message was:"
      );
    });

    it('keeps a modeled STS exception and clamps a forged name', async () => {
      __resetStsCachesForTesting();
      mocks.stsSend.mockRejectedValue(expiredTokenError());
      expect(
        await thrownMessage(() =>
          pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
            region: 'us-east-1',
          })
        )
      ).toContain(`ExpiredTokenException: ${SERVICE_MESSAGE}`);

      __resetStsCachesForTesting();
      mocks.stsSend.mockRejectedValue(serviceError('denied', 'Foo\nWARN: signature verified'));
      const forged = await thrownMessage(() =>
        pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
          region: 'us-east-1',
        })
      );
      expect(forged).toContain('unknown: denied');
      expect(forged).not.toContain('signature verified');
    });

    it("re-raises cdk-local's own no-Account throw intact", async () => {
      __resetStsCachesForTesting();
      mocks.stsSend.mockResolvedValue({});
      expect(
        await thrownMessage(() =>
          pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
            region: 'us-east-1',
          })
        )
      ).toBe('STS GetCallerIdentity returned no Account. Verify your AWS credentials.');
    });
  });

  describe('ecr-puller.ts / ecrLogin (ECR GetAuthorizationToken)', () => {
    it('withholds a credential-chain failure from the login step', async () => {
      __resetStsCachesForTesting();
      // GetCallerIdentity succeeds so the fixture reaches the ECR client.
      mocks.stsSend.mockResolvedValue({ Account: '111122223333' });
      mocks.ecrSend.mockRejectedValue(chainError());
      const message = await thrownMessage(() =>
        pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
          region: 'us-east-1',
        })
      );
      expect(message).toContain(
        'ECR GetAuthorizationToken failed (account=111122223333, region=us-east-1): '
      );
      expect(message).toContain(WITHHELD);
      expect(message).not.toContain(PASSPHRASE);
      expect(message).not.toContain('\n');
    });

    it('keeps a modeled ECR exception message', async () => {
      __resetStsCachesForTesting();
      mocks.stsSend.mockResolvedValue({ Account: '111122223333' });
      mocks.ecrSend.mockRejectedValue(serviceError('not authorized', 'AccessDeniedException'));
      expect(
        await thrownMessage(() =>
          pullEcrImage('111122223333.dkr.ecr.us-east-1.amazonaws.com/repo:tag', {
            region: 'us-east-1',
          })
        )
      ).toContain('AccessDeniedException: not authorized');
    });
  });

  describe('ecs-service-emulator.ts / resolvePlaceholderAccount (STS GetCallerIdentity)', () => {
    // The sixth and last site of the derived population, and the exact twin of
    // `local-run-task.ts`'s below. Deferred ONE round only because PR #610 held
    // this file; it lands in the same PR rather than as a follow-up.
    const PLACEHOLDER_ARN = 'arn:aws:iam::${AWS::AccountId}:role/TaskRole';

    it('withholds a credential-chain failure and names the call at debug', async () => {
      mocks.stsSend.mockRejectedValue(chainError());
      const message = await thrownMessage(() =>
        emulatorResolvePlaceholderAccount(PLACEHOLDER_ARN, 'us-east-1', undefined)
      );
      expect(message).toContain('STS GetCallerIdentity failed while resolving placeholder ARN');
      expect(message).toContain(WITHHELD);
      expect(message).not.toContain(PASSPHRASE);
      expect(message).not.toContain('\n');
      const debug = debugLines.filter((l) => l.includes(PASSPHRASE));
      expect(debug).toHaveLength(1);
      expect(debug[0]!).toContain(
        "STS GetCallerIdentity (task-role placeholder): the AWS SDK's own failure message was:"
      );
    });

    it('keeps a modeled STS exception message', async () => {
      mocks.stsSend.mockRejectedValue(expiredTokenError());
      expect(
        await thrownMessage(() =>
          emulatorResolvePlaceholderAccount(PLACEHOLDER_ARN, 'us-east-1', undefined)
        )
      ).toContain(`ExpiredTokenException: ${SERVICE_MESSAGE}`);
    });

    it("re-raises cdk-local's own no-Account throw intact", async () => {
      mocks.stsSend.mockResolvedValue({});
      const message = await thrownMessage(() =>
        emulatorResolvePlaceholderAccount(PLACEHOLDER_ARN, 'us-east-1', undefined)
      );
      expect(message).toContain('GetCallerIdentity returned no Account');
      // The relay's framing must NOT be layered on top of it.
      expect(message).not.toContain('STS GetCallerIdentity failed while resolving');
    });

    it('carries the same remedy its run-task twin does', async () => {
      // Called "the exact twin" of `local-run-task.ts`'s site, and it dropped
      // the remedy that BOTH the twin and this function's own in-`try` throw
      // carry — so a user hitting the relay path got no way forward while the
      // adjacent path told them exactly what to do.
      mocks.stsSend.mockRejectedValue(new Error('boom'));
      expect(
        await thrownMessage(() =>
          emulatorResolvePlaceholderAccount(PLACEHOLDER_ARN, 'us-east-1', undefined)
        )
      ).toContain('Pass the ARN explicitly: --assume-task-role <arn>');
    });

    it('flattens a forged newline in the placeholder ARN', async () => {
      mocks.stsSend.mockRejectedValue(new Error('boom'));
      const message = await thrownMessage(() =>
        emulatorResolvePlaceholderAccount(
          'arn:aws:iam::${AWS::AccountId}:role/x\nWARN: signature verified',
          'us-east-1',
          undefined
        )
      );
      expect(message).toContain('role/x WARN: signature verified');
      expect(message).not.toContain('\n');
    });
  });

  describe('local-run-task.ts / resolvePlaceholderAccount (STS GetCallerIdentity)', () => {
    const PLACEHOLDER_ARN = 'arn:aws:iam::${AWS::AccountId}:role/TaskRole';

    it('withholds a credential-chain failure and names the call at debug', async () => {
      mocks.stsSend.mockRejectedValue(chainError());
      const message = await thrownMessage(() =>
        resolvePlaceholderAccountForTest(PLACEHOLDER_ARN, 'us-east-1', undefined)
      );
      expect(message).toContain('STS GetCallerIdentity failed while resolving placeholder ARN');
      expect(message).toContain(WITHHELD);
      expect(message).not.toContain(PASSPHRASE);
      expect(message).not.toContain('\n');
      // The remedy still reaches the user — withholding the SDK's text must not
      // take cdk-local's own guidance with it.
      expect(message).toContain('Pass the ARN explicitly: --assume-task-role <arn>');
      const debug = debugLines.filter((l) => l.includes(PASSPHRASE));
      expect(debug).toHaveLength(1);
      expect(debug[0]!).toContain(
        "STS GetCallerIdentity (task-role placeholder): the AWS SDK's own failure message was:"
      );
    });

    it('keeps a modeled STS exception message', async () => {
      mocks.stsSend.mockRejectedValue(expiredTokenError());
      expect(
        await thrownMessage(() =>
          resolvePlaceholderAccountForTest(PLACEHOLDER_ARN, 'us-east-1', undefined)
        )
      ).toContain(`ExpiredTokenException: ${SERVICE_MESSAGE}`);
    });

    it("re-raises cdk-local's own no-Account throw intact", async () => {
      mocks.stsSend.mockResolvedValue({});
      expect(
        await thrownMessage(() =>
          resolvePlaceholderAccountForTest(PLACEHOLDER_ARN, 'us-east-1', undefined)
        )
      ).toContain('GetCallerIdentity returned no Account');
    });

    it('passes a placeholder-free ARN through without any AWS call', async () => {
      await expect(
        resolvePlaceholderAccountForTest('arn:aws:iam::1:role/Plain', 'us-east-1', undefined)
      ).resolves.toBe('arn:aws:iam::1:role/Plain');
      expect(mocks.stsSend).not.toHaveBeenCalled();
    });
  });
});

/**
 * Issue #579 review round 3 — the flatten/shape fixes, fenced.
 *
 * Third round, third all-green probe on the round's own flattens. The pattern
 * is now established well enough to state as a rule: a `flattenToOneLine` call
 * is invisible to every assertion that does not deliberately feed it a
 * character to flatten, so it is never covered incidentally and must be fenced
 * by a case built for it.
 */
describe('#579 round 3 — the wire-derived values on lines this round touched', () => {
  const FORGED = 'x\nWARN: signature verified';

  beforeEach(() => {
    warnLines = [];
    debugLines = [];
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'debug').mockImplementation((m: string) => {
      debugLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'info').mockImplementation((m: string) => {
      warnLines.push(String(m));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cloudfront-kvs-client.ts flattens the wire-derived kvsArn', async () => {
    // `resolveDeployedKvsArnByName` copies `item.ARN` out of a
    // `ListKeyValueStores` response unvalidated, and this throw is relayed into
    // a DEFAULT-level warn by `cloudfront-server.ts`.
    mocks.kvsSend.mockRejectedValue(new Error('boom'));
    const src = createDeployedKvsDataSource({ kvsArn: `arn:aws:cloudfront::1:kvs/${FORGED}` });
    const message = await thrownMessage(() => src.getValue('k'));
    expect(message).toContain('arn:aws:cloudfront::1:kvs/x WARN: signature verified');
    expect(message).not.toContain('\n');
  });

  it('agentcore-s3-bundle.ts flattens the bucket / key / versionId it prints', async () => {
    // Under `--from-cfn-stack` these come from template intrinsics resolved
    // against DEPLOYED state, and `formatRef` now feeds a default-level ERROR
    // line as well as the `info` progress line it always fed.
    mocks.s3Send.mockRejectedValue(new Error('boom'));
    const message = await thrownMessage(() =>
      downloadAndExtractS3Bundle({ bucket: `bkt${FORGED}`, key: 'k.zip', versionId: `v${FORGED}` })
    );
    expect(message).toContain('bktx WARN: signature verified');
    expect(message).toContain('versionId=vx WARN: signature verified');
    expect(message).not.toContain('\n');
    // The `info` progress line runs through the same helper, and it fires on
    // the SUCCESS path too — strictly more reachable than the failure.
    expect(warnLines.some((l) => l.includes('bktx WARN: signature verified'))).toBe(true);
    expect(warnLines.every((l) => !l.includes('\n'))).toBe(true);
  });

  it('state-resolver.ts flattens the Fn::ImportValue export name', async () => {
    const r = await substituteAgainstStateAsync(
      { 'Fn::ImportValue': FORGED },
      {
        resources: {},
        crossStackResolver: importValueResolver(() => new Error('boom')),
      }
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain("Fn::ImportValue 'x WARN: signature verified'");
      expect(r.reason).not.toContain('\n');
    }
  });

  it('state-resolver.ts flattens the Fn::GetStackOutput stack / output / region', async () => {
    const r = await substituteAgainstStateAsync(
      {
        'Fn::GetStackOutput': { StackName: `S${FORGED}`, OutputName: 'Out', Region: 'us-east-1' },
      },
      { resources: {}, crossStackResolver: importValueResolver(() => new Error('boom')) }
    );
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.reason).toContain("Fn::GetStackOutput 'Sx WARN: signature verified.Out'");
      expect(r.reason).not.toContain('\n');
    }
  });

  it('ssm-parameter-resolver.ts flattens the joined parameter names', async () => {
    mocks.ssmSend.mockRejectedValue(new Error('boom'));
    await resolveSsmParameters(
      ssmClient(),
      [{ logicalId: 'P', ssmName: `/app/${FORGED}`, isList: false }] as unknown as Parameters<
        typeof resolveSsmParameters
      >[1],
      '--from-cfn-stack'
    );
    const line = warnContaining('SSM GetParameters(');
    expect(line).toContain('/app/x WARN: signature verified');
    expect(line).not.toContain('\n');
  });

  it('httpv2 keeps the message of a service-exception-SHAPED plain object', async () => {
    // `stringifyThrown` / `clampErrorName` key on `instanceof Error`, so before
    // this round a non-`Error` carrying `$fault` rendered as the literal
    // `[object Object]` — claiming to keep the diagnosis while printing a
    // placeholder. `code` stays `unknown` deliberately: a shape that is not an
    // `Error` names no class.
    _resetClientCacheForTest();
    mocks.sqsSend.mockRejectedValue({
      message: 'Rate exceeded\nWARN: signature verified',
      name: 'ThrottlingException',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });
    const res = await dispatchServiceIntegration(
      'SQS-SendMessage',
      { QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q', MessageBody: 'hi' },
      'us-east-1'
    );
    const parsed = JSON.parse(res.body ?? '') as { message: string; code: string };
    expect(parsed.message).toBe('Rate exceeded WARN: signature verified');
    expect(parsed.message).not.toContain('[object Object]');
    expect(parsed.code).toBe('unknown');
    expect(res.statusCode).toBe(400);
  });
});

