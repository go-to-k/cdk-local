import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import { resolveStartApiAssumeRoleArn } from '../../../src/cli/commands/local-start-api.js';
import {
  applyAgentCoreCredentialEnv,
  resolveAssumeRoleArn,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import { refusedRoleArnMessage } from '../../../src/utils/role-arn.js';
import { parseAssumeRoleToken } from '../../../src/cli/options.js';
import type { LocalStateRecord } from '../../../src/local/local-state-provider.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';

/**
 * Issue #607 — the two TEMPLATE-literal resolution points.
 *
 * Both read a role ARN out of the SYNTHESIZED template rather than off the
 * wire, and both short-circuit the state lookup when they find one:
 *
 *   - `local-start-api.ts` — the Lambda's `Properties.Role`, when a CDK app
 *     renders it as an explicit ARN string instead of an intrinsic;
 *   - `local-invoke-agentcore.ts` — the runtime's `Properties.RoleArn`, the
 *     same shape one construct over.
 *
 * They are lower-trust-risk than the wire points (the template is the user's
 * own synth output), which is exactly why the check here is about the SITED
 * DIAGNOSIS: the send is bounded at the choke point in `utils/role-arn.ts`
 * either way, and a refusal there cannot say WHICH template property was
 * wrong. Rejection warns and FALLS THROUGH to the state lookup — the
 * pre-#607 control flow for a string that failed `startsWith('arn:')`.
 */

const GOOD = 'arn:aws:iam::123456789012:role/TemplateRole';
const FROM_STATE = 'arn:aws:iam::123456789012:role/StateRole';
/** Passes `startsWith('arn:')`, which is the check #607 replaced. */
const BAD = `arn:aws:iam::123456789012:role/${'A'.repeat(100_000)}`;

function stateWith(logicalId: string, roleArn: string, roleProperty: string): LocalStateRecord {
  return {
    version: 1,
    stackName: 'Stack',
    resources: {
      [logicalId]: {
        physicalId: `${logicalId}-physical`,
        resourceType: 'AWS::Lambda::Function',
        properties: { [roleProperty]: roleArn },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as LocalStateRecord;
}

describe('#607 — template-literal role-ARN resolution points', () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnings.push(String(m));
    });
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('premise: the rejected fixture passes the check #607 replaced', () => {
    expect(BAD.startsWith('arn:')).toBe(true);
  });

  describe("local-start-api: the Lambda's template Properties.Role", () => {
    function drive(roleProp: unknown, withState = false): string | undefined {
      return resolveStartApiAssumeRoleArn({
        logicalId: 'Handler',
        assumeRole: { bareAutoResolve: true } as never,
        lambdaResource: {
          Type: 'AWS::Lambda::Function',
          Properties: roleProp === undefined ? {} : { Role: roleProp },
        } as never,
        ...(withState && {
          stateBundle: { state: stateWith('Handler', FROM_STATE, 'Role') } as never,
        }),
      });
    }

    it('still returns a well-formed template Role', () => {
      expect(drive(GOOD)).toBe(GOOD);
      expect(warnings).toHaveLength(0);
    });

    it('rejects an over-long value that merely starts with arn:', () => {
      expect(drive(BAD)).toBeUndefined();
    });

    it('WARNS on a present-but-rejected template Role, naming the Lambda', () => {
      drive('MyRoleName');
      expect(warnings[0]).toContain('template Role');
      expect(warnings[0]).toContain("'Handler'");
      expect(warnings[0]).toContain('not a well-formed IAM role ARN');
      expect(warnings[0]).toContain('"MyRoleName"');
    });

    it('the warn is BOUNDED — the 100k value does not reach the line', () => {
      drive(BAD);
      expect(warnings[0]!.length).toBeLessThan(400);
      expect(warnings[0]).toContain(`(${BAD.length} characters)`);
    });

    it('FALLS THROUGH to the state lookup rather than short-circuiting', () => {
      // The pre-#607 control flow for a string that failed the check: the
      // template value is ignored, and deployed state still gets its turn.
      expect(drive(BAD, true)).toBe(FROM_STATE);
    });

    it('stays SILENT when the template Role is an intrinsic', () => {
      expect(drive({ 'Fn::GetAtt': ['ExecRole', 'Arn'] })).toBeUndefined();
      expect(warnings.filter((w) => w.includes('template Role'))).toHaveLength(0);
    });
  });

  describe("local-invoke-agentcore: the runtime's template RoleArn", () => {
    async function drive(roleArn: string | undefined, withState = false): Promise<string | undefined> {
      return resolveAssumeRoleArn(
        { assumeRole: true } as never,
        {
          logicalId: 'ChatAgent',
          resource: { Properties: {} },
          ...(roleArn !== undefined && { roleArn }),
        } as unknown as ResolvedAgentCoreRuntime,
        withState ? stateWith('ChatAgent', FROM_STATE, 'RoleArn') : undefined,
        undefined
      );
    }

    it('still returns a well-formed template RoleArn', async () => {
      expect(await drive(GOOD)).toBe(GOOD);
      expect(warnings).toHaveLength(0);
    });

    it('rejects an over-long value that merely starts with arn:', async () => {
      expect(await drive(BAD)).toBeUndefined();
    });

    it('WARNS on a present-but-rejected template RoleArn, naming the runtime', async () => {
      await drive('MyRoleName');
      expect(warnings[0]).toContain('template RoleArn');
      expect(warnings[0]).toContain("'ChatAgent'");
      expect(warnings[0]).toContain('"MyRoleName"');
    });

    it('the warn is BOUNDED', async () => {
      await drive(BAD);
      expect(warnings[0]!.length).toBeLessThan(400);
      expect(warnings[0]).toContain(`(${BAD.length} characters)`);
    });

    it('FALLS THROUGH to the state lookup rather than short-circuiting', async () => {
      expect(await drive(BAD, true)).toBe(FROM_STATE);
    });
  });
});

/**
 * Issue #607 review round 2 — the THIRD guarded send.
 *
 * `grep -rn 'new AssumeRoleCommand(' src/` finds FIVE sends, not the two in
 * `src/utils/role-arn.ts` that an earlier revision of this lane's comments
 * claimed. `local-invoke-agentcore.ts`'s `assumeAgentCoreExecutionRole` is the
 * third, and it is the one on the WIRE path: all three of its callers pass
 * `resolveAssumeRoleArn(...)`'s output.
 *
 * The hole it left was an ASYMMETRY. `cdkl start-api` wires
 * `parseAssumeRoleToken` as its `--assume-role` argParser, so a malformed
 * value is rejected at parse. `cdkl invoke-agentcore` declares no argParser at
 * all, and `resolveAssumeRoleArn` returns an explicit
 * `--assume-role <arn>` string EARLY, before every resolution point this lane
 * added — so that one spelling reached STS unchecked.
 */
describe('#607 — cdkl invoke-agentcore --assume-role <arn> is checked like start-api', () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => void warnings.push(String(m)));
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runtime = {
    logicalId: 'ChatAgent',
    resource: { Properties: {} },
  } as unknown as ResolvedAgentCoreRuntime;

  async function resolveExplicit(assumeRole: string): Promise<string | undefined> {
    return resolveAssumeRoleArn({ assumeRole } as never, runtime, undefined, undefined);
  }

  it('still returns a well-formed explicit ARN', async () => {
    await expect(resolveExplicit(GOOD)).resolves.toBe(GOOD);
  });

  it('REJECTS an over-long explicit ARN that merely starts with arn:', async () => {
    await expect(resolveExplicit(BAD)).rejects.toThrow(/Invalid --assume-role value/);
  });

  it('REJECTS a forged newline in an explicit ARN', async () => {
    await expect(resolveExplicit('arn:aws:iam::1:role/R\nWARN: forged')).rejects.toThrow(
      /Invalid --assume-role value/
    );
  });

  it('the refusal is BOUNDED and single-line — it cannot relay the value', async () => {
    const message = await resolveExplicit(BAD).then(
      () => '',
      (err: unknown) => (err as Error).message
    );
    expect(message).toContain(`(${BAD.length} characters)`);
    expect(message.length).toBeLessThan(500);
    expect(message).not.toContain('\n');
  });

  it('matches what start-api rejects at parse time — the asymmetry is closed', async () => {
    // The point of the fix: the same text, the same verdict, whichever command
    // the user typed it into.
    for (const bad of ['not-an-arn', 'arn:aws:iam::1:role/', BAD]) {
      expect(() => parseAssumeRoleToken(bad, undefined)).toThrow(/Invalid --assume-role/);
      await expect(resolveExplicit(bad)).rejects.toThrow(/Invalid --assume-role/);
    }
  });
});


/**
 * The guarded SEND itself, driven through `applyAgentCoreCredentialEnv` — the
 * one exported caller that takes an `assumeRoleArn` DIRECTLY rather than via
 * `resolveAssumeRoleArn`, so it can still hand the send a value the resolution
 * point never saw. That is exactly the population the send guard exists for.
 */
describe('#607 — assumeAgentCoreExecutionRole, the third guarded send', () => {
  const ENV_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;
  let warnings: string[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    warnings = [];
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => void warnings.push(String(m)));
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  /** The one warn this caller emits for a refused ARN. */
  function refusalLine(): string {
    const matches = warnings.filter((w) => w.includes('not well-formed'));
    expect(matches, 'the send guard emitted no line at all').toHaveLength(1);
    return matches[0]!;
  }

  it('REFUSES a malformed ARN and never mints credentials', async () => {
    const dockerEnv: Record<string, string> = {};
    await applyAgentCoreCredentialEnv(dockerEnv, { assumeRoleArn: 'not-an-arn' });
    // The refusal is caught by the caller's existing warn-and-fall-back, so
    // the command still runs on shell credentials — but nothing was assumed.
    expect(dockerEnv['AWS_SESSION_TOKEN']).toBeUndefined();
    expect(dockerEnv['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(refusalLine()).toContain('not well-formed');
  });

  it('guard-the-guard: a WELL-FORMED ARN is NOT refused by the send guard', async () => {
    // Reaches the real STS import and fails on credentials instead, which is a
    // DIFFERENT line. Without this, every refusal above would pass over a
    // helper that had simply stopped assuming anything.
    await applyAgentCoreCredentialEnv({}, { assumeRoleArn: GOOD });
    expect(warnings.filter((w) => w.includes('not well-formed'))).toHaveLength(0);
  });

  it('the refusal renders VERBATIM — it is not double-withheld', async () => {
    // The caller re-renders with `describeAwsFailureForWarn` unless the error
    // is an `AssumeRoleFailure`, and a non-service error is that policy's
    // WITHHELD branch. A `CdkLocalError` here would surface as
    // `CdkLocalError; NNN-character message withheld` instead of the reason —
    // the exact double-withhold `AssumeRoleFailure`'s JSDoc documents.
    await applyAgentCoreCredentialEnv({}, { assumeRoleArn: 'not-an-arn' });
    const line = refusalLine();
    expect(line).not.toContain('message withheld');
    expect(line).toContain('"not-an-arn" (10 characters)');
  });

  it("the guard's OWN half of the line is bounded, even for a 100k value", async () => {
    await applyAgentCoreCredentialEnv({}, { assumeRoleArn: BAD });
    const line = refusalLine();
    // What the guard contributes is `describeRejectedRoleArn`'s output: a
    // clamped preview plus the true length. The `AssumeRole(<arn>) failed:`
    // FRAMING around it is the caller's, and it interpolates the raw ARN with
    // no cap of its own — a pre-existing property of that line which this lane
    // deliberately did not change, because an integ fixture greps the studio
    // log ring for a real ARN and any re-rendering would break it. It is not
    // reachable in production: every path that reaches this caller resolves
    // through `resolveAssumeRoleArn`, which now rejects at its own points.
    const guardHalf = line.slice(line.indexOf('the role ARN is not well-formed'));
    expect(guardHalf).toContain(`(${BAD.length} characters)`);
    expect(guardHalf.length).toBeLessThan(300);
    expect(line).not.toContain('\n');
  });

  it('shares ONE refusal sentence with the two sends in utils/role-arn.ts', async () => {
    // `refusedRoleArnMessage` is exported so all three guarded sends word the
    // refusal identically. This caller prints the AssumeRoleFailure's `detail`
    // (the bare half) under its own framing, so the shared sentence is
    // asserted at its source rather than through this line.
    expect(refusedRoleArnMessage('not-an-arn')).toContain('"not-an-arn" (10 characters)');
    expect(refusedRoleArnMessage('not-an-arn')).toContain('Nothing was sent to STS');
    await applyAgentCoreCredentialEnv({}, { assumeRoleArn: 'not-an-arn' });
    expect(refusalLine()).toContain('"not-an-arn" (10 characters)');
  });
});
