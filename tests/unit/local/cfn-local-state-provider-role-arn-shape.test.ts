import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue #607 — the SHAPE check at the two `CfnLocalStateProvider` resolution
 * points.
 *
 * Both read a role ARN straight off a live AWS response
 * (`GetFunctionConfiguration`'s `Configuration.Role`,
 * `GetAgentRuntime`'s `roleArn`) and hand it to a caller that passes it to
 * `AssumeRoleCommand.RoleArn`. Until #607 the only validation was
 * `startsWith('arn:')`, so an arbitrarily long value beginning `arn:` was
 * accepted whole — printed AND sent.
 *
 * The sibling files `cfn-local-state-provider-exec-role.test.ts` /
 * `-agentcore-role.test.ts` cover the happy path and the SDK-error path; this
 * file covers what the check added, in both directions:
 *
 *   - an over-long / mis-shaped value is REJECTED, and
 *   - the rejection WARNS rather than being silent, because a present-but-bad
 *     field is a real misconfiguration the caller's generic "could not resolve"
 *     line cannot describe — while an ABSENT field stays silent, since there is
 *     nothing to report.
 */

const { lambdaSendMock, acSendMock } = vi.hoisted(() => ({
  lambdaSendMock: vi.fn(),
  acSendMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = lambdaSendMock;
    destroy(): void {}
  },
  GetFunctionConfigurationCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = acSendMock;
    destroy(): void {}
  },
  GetAgentRuntimeCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = vi.fn();
    destroy(): void {}
  },
  ListStackResourcesCommand: class {},
  DescribeStacksCommand: class {},
  ListExportsCommand: class {},
}));

const { CfnLocalStateProvider } = await import('../../../src/local/cfn-local-state-provider.js');

const GOOD = 'arn:aws:iam::111:role/Stack-ExecRole-AAA';
/** Passes `startsWith('arn:')`, which is the whole point. */
const OVERLONG = `arn:aws:iam::111:role/${'A'.repeat(100_000)}`;
const FORGED = 'arn:aws:iam::111:role/R\nWARN: forged line';

describe('#607 — CfnLocalStateProvider role-ARN shape check', () => {
  let warnings: string[];

  beforeEach(() => {
    lambdaSendMock.mockReset();
    acSendMock.mockReset();
    warnings = [];
    vi.spyOn(getLogger(), 'warn').mockImplementation((m: string) => {
      warnings.push(String(m));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function provider(): InstanceType<typeof CfnLocalStateProvider> {
    return new CfnLocalStateProvider({ cfnStackName: 'S', region: 'us-east-1' });
  }

  describe('resolveLambdaExecutionRoleArn (GetFunctionConfiguration Role)', () => {
    it('premise: the rejected fixtures pass the check #607 replaced', () => {
      // Non-vacuity. If these failed `startsWith('arn:')` the rejections below
      // would prove nothing about the new check.
      expect(OVERLONG.startsWith('arn:')).toBe(true);
      expect(FORGED.startsWith('arn:')).toBe(true);
    });

    it('still returns a well-formed ARN', async () => {
      lambdaSendMock.mockResolvedValueOnce({ Role: GOOD });
      expect(await provider().resolveLambdaExecutionRoleArn('Scoring')).toBe(GOOD);
      expect(warnings).toHaveLength(0);
    });

    it('rejects an over-long value that merely starts with arn:', async () => {
      lambdaSendMock.mockResolvedValueOnce({ Role: OVERLONG });
      expect(await provider().resolveLambdaExecutionRoleArn('Scoring')).toBeUndefined();
    });

    it('rejects a value carrying a forged second line', async () => {
      lambdaSendMock.mockResolvedValueOnce({ Role: FORGED });
      expect(await provider().resolveLambdaExecutionRoleArn('Scoring')).toBeUndefined();
    });

    it('WARNS on a present-but-rejected Role, so a misconfiguration is not silent', async () => {
      lambdaSendMock.mockResolvedValueOnce({ Role: 'MyRoleName' });
      await provider().resolveLambdaExecutionRoleArn('Scoring');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not a well-formed IAM role ARN');
      expect(warnings[0]).toContain('"MyRoleName"');
      expect(warnings[0]).toContain('--assume-role <arn>');
    });

    it('the warn is BOUNDED — it cannot relay the whole rejected value', async () => {
      lambdaSendMock.mockResolvedValueOnce({ Role: OVERLONG });
      await provider().resolveLambdaExecutionRoleArn('Scoring');
      expect(warnings).toHaveLength(1);
      // The point of moving the bound to the resolution point: the value is
      // 100k characters and the line stays short, while still naming the true
      // length so a clamped preview is never mistaken for the whole value.
      expect(warnings[0]!.length).toBeLessThan(400);
      expect(warnings[0]).toContain(`(${OVERLONG.length} characters)`);
    });

    it('the warn cannot carry a forged newline', async () => {
      lambdaSendMock.mockResolvedValueOnce({ Role: FORGED });
      await provider().resolveLambdaExecutionRoleArn('Scoring');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain('\n');
    });

    it('stays SILENT when the field is absent — nothing to report', async () => {
      lambdaSendMock.mockResolvedValueOnce({});
      expect(await provider().resolveLambdaExecutionRoleArn('Scoring')).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });
  });

  describe('resolveAgentCoreRuntimeRoleArn (GetAgentRuntime roleArn)', () => {
    it('still returns a well-formed ARN', async () => {
      acSendMock.mockResolvedValueOnce({ roleArn: GOOD });
      expect(await provider().resolveAgentCoreRuntimeRoleArn('agent-abc')).toBe(GOOD);
      expect(warnings).toHaveLength(0);
    });

    it('rejects an over-long value that merely starts with arn:', async () => {
      acSendMock.mockResolvedValueOnce({ roleArn: OVERLONG });
      expect(await provider().resolveAgentCoreRuntimeRoleArn('agent-abc')).toBeUndefined();
    });

    it('rejects a value carrying a forged second line', async () => {
      acSendMock.mockResolvedValueOnce({ roleArn: FORGED });
      expect(await provider().resolveAgentCoreRuntimeRoleArn('agent-abc')).toBeUndefined();
    });

    it('WARNS on a present-but-rejected roleArn', async () => {
      acSendMock.mockResolvedValueOnce({ roleArn: 'arn:aws:iam::111:user/foo' });
      await provider().resolveAgentCoreRuntimeRoleArn('agent-abc');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not a well-formed IAM role ARN');
      expect(warnings[0]).toContain('"arn:aws:iam::111:user/foo"');
    });

    it('the warn is BOUNDED and single-line', async () => {
      acSendMock.mockResolvedValueOnce({ roleArn: OVERLONG });
      await provider().resolveAgentCoreRuntimeRoleArn('agent-abc');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.length).toBeLessThan(400);
      expect(warnings[0]).not.toContain('\n');
    });

    it('stays SILENT when the field is absent', async () => {
      acSendMock.mockResolvedValueOnce({});
      expect(await provider().resolveAgentCoreRuntimeRoleArn('agent-abc')).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });
  });
});
