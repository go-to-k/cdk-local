import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { LocalStateProvider, LocalStateRecord } from '../../../src/local/local-state-provider.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue #570 — the CALL SITES. Nine `logger.warn` lines across five
 * `src/cli/commands/*.ts` files relayed an AWS SDK error's `message`
 * verbatim; each now routes through `describeAwsFailureForWarn`.
 *
 * Every site is driven SEPARATELY, on purpose. Issue #564 found that
 * replacing five interpolations at once and probing the symbol reported RED
 * while two of the five were unfenced: a whole-symbol probe answers "is ANY
 * of this fenced", not "is EACH". So each row below reaches exactly one
 * `catch` and asserts against that site's own literal.
 *
 * The helper's own behaviour is fenced in
 * `tests/unit/local/credential-error.test.ts`; this file asserts only that
 * each site routes through it.
 */

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

// `resolveAgentCoreCodeImageFromS3` continues into an S3 GetObject after the
// warn under test. Stub it so the test stays hermetic (no network) and fast:
// without this, each of that site's four cases spends ~550 ms in the SDK's
// retry loop against a bucket that does not exist.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(): never {
      throw new Error('s3 stubbed out for the #570 relay-site test');
    }
    destroy(): void {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = sendMock;
    destroy(): void {}
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { resolvePseudoParametersForInvoke, resolveLambdaContainerEnv } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { buildEcsImageResolutionContext: buildRunTaskContext } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const { buildEcsImageResolutionContext: buildStartServiceContext } = await import(
  '../../../src/cli/commands/local-start-service.js'
);
const { resolvePseudoParametersForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const {
  applyAgentCoreCredentialEnv,
  buildAgentCoreImageContext,
  resolveAgentCoreCodeImageFromS3,
  resolveHostCredentialsForSigV4,
} = await import('../../../src/cli/commands/local-invoke-agentcore.js');

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

/**
 * The worst string a credential-chain error can carry, reused from #564's
 * fixture: `@aws-sdk/credential-provider-process` copies the rejection of
 * `promisify(child_process.exec)` — `Command failed: <command line>\n<stderr>`
 * — into the error it throws, and both lines can hold a passphrase.
 */
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

function expiredTokenError(): Error {
  const e = new Error(SERVICE_MESSAGE);
  // The name the SDK actually sets: `@aws-sdk/client-sts` models this one, at
  // `dist-cjs/models/errors.js:6`. (`AccessDenied`, used below, is NOT modeled
  // and arrives as the wire code verbatim -- both shapes are exercised.)
  Object.defineProperty(e, 'name', { value: 'ExpiredTokenException' });
  Object.assign(e, {
    $fault: 'client',
    $metadata: { httpStatusCode: 403, requestId: 'req-1' },
  });
  return e;
}

/** A service exception whose wire-derived message carries a forged log line. */
function forgedServiceError(): Error {
  const e = new Error('denied\nWARN: signature verified');
  Object.defineProperty(e, 'name', { value: 'AccessDenied' });
  Object.assign(e, {
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
  return e;
}

const ROLE_ARN = 'arn:aws:iam::123456789012:role/relay-test';

function ecsStack(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Parameters: {
        SsmDbHost: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
      },
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              { Name: 'app', Environment: [{ Name: 'DB_HOST', Value: { Ref: 'SsmDbHost' } }] },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

function ecsStateProvider(): LocalStateProvider {
  return {
    label: '--from-cfn-stack',
    load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
    buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
    resolveTemplateSsmParameters: vi
      .fn()
      .mockResolvedValue({ values: { SsmDbHost: 'db.internal' }, secureStringLogicalIds: [] }),
    dispose: vi.fn(),
  } as unknown as LocalStateProvider;
}

function agentRuntime(): ResolvedAgentCoreRuntime {
  return {
    stack: { stackName: 'App', region: 'us-east-1' } as ResolvedAgentCoreRuntime['stack'],
    logicalId: 'ChatAgent',
    resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
    containerUri: 'repo:tag',
    environmentVariables: {},
    protocol: 'HTTP',
  } as unknown as ResolvedAgentCoreRuntime;
}

function agentStack(): StackInfo {
  return { stackName: 'App', region: 'us-east-1', template: { Resources: {} } } as unknown as StackInfo;
}

function agentStateProvider(): LocalStateProvider {
  return {
    label: '--from-cfn-stack',
    load: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as LocalStateProvider;
}

function assumeRoleLambda(): ResolvedLambda {
  return {
    kind: 'zip',
    stack: {
      stackName: 'Stack',
      displayName: 'Stack',
      artifactId: 'Stack',
      template: { Resources: {} },
      dependencyNames: [],
      region: 'us-east-1',
    },
    logicalId: 'Handler',
    resource: {
      Type: 'AWS::Lambda::Function',
      Properties: { Environment: { Variables: { GREETING: 'hello' } } },
      Metadata: { 'aws:cdk:path': 'Stack/Handler/Resource' },
    },
    memoryMb: 256,
    timeoutSec: 7,
    layers: [],
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    codePath: '/tmp/code',
  } as unknown as ResolvedLambda;
}

/** Swallow whatever the site does AFTER the warn (S3 download, creds throw). */
async function tolerate(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // The warn under test is emitted before the failure; the failure itself
    // belongs to a code path this test deliberately does not stub.
  }
}

// --------------------------------------------------------------------------
// The nine sites
// --------------------------------------------------------------------------

interface Site {
  /** `<file>:<enclosing function>` — the identity of the occurrence. */
  name: string;
  /**
   * A literal unique to THIS site's warn text, proving the fixture reached
   * the intended `catch` and not some other warn the same call emits.
   *
   * TWO pairs share a byte-identical spelling, not one: `local-run-task` /
   * `ecs-service-emulator` (the `${AWS::AccountId}` line) and
   * `local-invoke` / `local-invoke-agentcore` (the bare `--assume-role: STS
   * AssumeRole(<arn>) failed: ` line). For those four rows the discriminator
   * is the MODULE the row drives, not the string — which is why every row
   * calls exactly one command module and no row is ever consolidated with
   * another on the strength of its literal.
   */
  reached: string;
  /** Whether the site interpolates the role ARN, which must keep printing. */
  quotesRoleArn: boolean;
  drive: () => Promise<void>;
}

const sites: Site[] = [
  {
    name: 'local-invoke.ts / resolvePseudoParametersForInvoke',
    reached:
      'Resolver needs ${AWS::AccountId} but STS GetCallerIdentity failed: ',
    quotesRoleArn: false,
    drive: async () => {
      await tolerate(() => resolvePseudoParametersForInvoke('us-east-1', {}));
    },
  },
  {
    name: 'local-invoke.ts / resolveLambdaContainerEnv (--assume-role)',
    reached: `--assume-role: STS AssumeRole(${ROLE_ARN}) failed: `,
    quotesRoleArn: true,
    drive: async () => {
      await tolerate(() =>
        resolveLambdaContainerEnv(assumeRoleLambda(), { assumeRole: ROLE_ARN }, undefined)
      );
    },
  },
  {
    name: 'local-run-task.ts / buildEcsImageResolutionContext',
    reached:
      'Resolver needs ${AWS::AccountId} but STS GetCallerIdentity failed: ',
    quotesRoleArn: false,
    drive: async () => {
      await tolerate(() => buildRunTaskContext(ecsStack(), ecsStateProvider(), {} as never));
    },
  },
  {
    name: 'ecs-service-emulator.ts / buildEcsImageResolutionContext',
    reached:
      'Resolver needs ${AWS::AccountId} but STS GetCallerIdentity failed: ',
    quotesRoleArn: false,
    drive: async () => {
      await tolerate(() =>
        buildStartServiceContext(
          'MyStack:WebService',
          [ecsStack()],
          {} as never,
          ecsStateProvider()
        )
      );
    },
  },
  {
    name: 'local-start-api.ts / resolvePseudoParametersForStartApi',
    reached:
      '--from-state: resolver needs ${AWS::AccountId} but STS GetCallerIdentity failed: ',
    quotesRoleArn: false,
    drive: async () => {
      await tolerate(() => resolvePseudoParametersForStartApi('us-east-1', {} as never));
    },
  },
  {
    name: 'local-invoke-agentcore.ts / resolveHostCredentialsForSigV4',
    reached: `--assume-role: STS AssumeRole(${ROLE_ARN}) failed for --sigv4 signing: `,
    quotesRoleArn: true,
    drive: async () => {
      await tolerate(() =>
        resolveHostCredentialsForSigV4(
          { assumeRole: ROLE_ARN } as never,
          agentRuntime(),
          undefined,
          'us-east-1',
          undefined
        )
      );
    },
  },
  {
    name: 'local-invoke-agentcore.ts / resolveAgentCoreCodeImageFromS3',
    reached: `--assume-role: STS AssumeRole(${ROLE_ARN}) failed for the fromS3 bundle download: `,
    quotesRoleArn: true,
    drive: async () => {
      await tolerate(() =>
        resolveAgentCoreCodeImageFromS3(
          agentRuntime(),
          { runtime: 'python3.12', entryPoint: ['app.py'] } as never,
          { bucket: 'bkt', key: 'bundle.zip' } as never,
          { assumeRole: ROLE_ARN } as never,
          'x86_64',
          undefined,
          undefined
        )
      );
    },
  },
  {
    name: 'local-invoke-agentcore.ts / buildAgentCoreImageContext',
    reached: '--from-cfn-stack: STS GetCallerIdentity failed: ',
    quotesRoleArn: false,
    drive: async () => {
      await tolerate(() =>
        buildAgentCoreImageContext(agentStack(), agentStateProvider(), {} as never)
      );
    },
  },
  {
    name: 'local-invoke-agentcore.ts / applyAgentCoreCredentialEnv',
    reached: `--assume-role: STS AssumeRole(${ROLE_ARN}) failed: `,
    quotesRoleArn: true,
    drive: async () => {
      await tolerate(() => applyAgentCoreCredentialEnv({}, { assumeRoleArn: ROLE_ARN }));
    },
  },
];

describe('#570 — no AWS SDK error message reaches a warn unfiltered', () => {
  let warnLines: string[];
  let debugLines: string[];

  beforeEach(() => {
    warnLines = [];
    debugLines = [];
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnLines.push(String(m));
    });
    vi.spyOn(getLogger(), 'debug').mockImplementation((m: string) => {
      debugLines.push(String(m));
    });
    // Not under test, and one site logs progress before it fails.
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    sendMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The one warn line this site's fixture produced. */
  function siteWarn(site: Site): string {
    const matches = warnLines.filter((l) => l.includes(site.reached));
    expect(
      matches,
      `no warn line at ${site.name} contained its own literal — the fixture did not reach the site`
    ).toHaveLength(1);
    return matches[0]!;
  }

  it('covers every relay site the sweep found, with no row silently dropped', () => {
    // A table driven off the source could not notice a site being DELETED
    // from it, so the count is asserted against a literal. Six sites are
    // from issue #570's body; three more (`resolveLambdaContainerEnv`,
    // `resolveHostCredentialsForSigV4`, `resolveAgentCoreCodeImageFromS3`)
    // are the same class and were found while working it.
    expect(sites).toHaveLength(9);
    expect(new Set(sites.map((s) => s.name)).size).toBe(9);
    expect(sites.filter((s) => s.quotesRoleArn)).toHaveLength(4);

    // The role ARN is fenced by `reached` itself, not by a separate case: for
    // the four quoting sites the ARN is INSIDE the literal that `siteWarn`
    // requires to appear in a real warn line, so every one of this row's other
    // cases already fails if the ARN stops printing. A dedicated
    // `expect(line).toContain(ROLE_ARN)` could not fail after `siteWarn`
    // returned, which is why there is no such case.
    //
    // What this asserts is the remaining half: that `quotesRoleArn` agrees
    // with the literal, so the flag cannot drift into describing a site it no
    // longer describes.
    for (const s of sites) {
      expect(s.reached.includes(ROLE_ARN), `${s.name}: quotesRoleArn disagrees with reached`).toBe(
        s.quotesRoleArn
      );
    }
  });

  describe.each(sites)('$name', (site) => {
    it('withholds a credential-chain message from the warn and prints it at debug', async () => {
      sendMock.mockRejectedValue(chainError());
      await site.drive();

      const line = siteWarn(site);
      // The literal shape, not a substring of it: `toContain(WITHHELD)`
      // would still pass if the raw message were appended alongside, so the
      // absence assertions below carry the other half.
      expect(line).toContain(`${site.reached}${WITHHELD}`);
      expect(line).not.toContain(PASSPHRASE);
      expect(line).not.toContain('Command failed');
      expect(line).not.toContain('\n');

      // Withheld at `warn` is only acceptable while in full at `debug`.
      expect(debugLines.join('\n')).toContain(PASSPHRASE);
    });

    it('keeps a modeled STS service exception message, which is the diagnosis', async () => {
      sendMock.mockRejectedValue(expiredTokenError());
      await site.drive();

      expect(siteWarn(site)).toContain(
        `${site.reached}ExpiredTokenException: ${SERVICE_MESSAGE}`
      );
    });

    it('flattens a forged newline inside a kept service message', async () => {
      sendMock.mockRejectedValue(forgedServiceError());
      await site.drive();

      const line = siteWarn(site);
      expect(line).toContain(`${site.reached}AccessDenied: denied WARN: signature verified`);
      expect(line).not.toContain('\n');
    });

    it('withholds an unstringifiable throw rather than crashing the site', async () => {
      // Reaches `stringifyThrown`'s `[unstringifiable throw]` fallback through
      // a real call site, not just through the helper: `String()` on a
      // null-prototype object raises TypeError, and that throw escaping the
      // `catch` would turn warn-and-continue into a hard failure.
      sendMock.mockRejectedValue(Object.create(null));
      await site.drive();
      expect(siteWarn(site)).toContain(
        `${site.reached}unknown; 23-character message withheld`
      );
    });
  });
});
