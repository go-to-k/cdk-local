import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackState } from '../../../src/types/state.js';
import type { LocalStateRecord } from '../../../src/local/local-state-provider.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import {
  resolveAssumeRoleArnForLambda,
  resolveExecutionRoleArnFromState,
} from '../../../src/cli/commands/local-invoke.js';
import { resolveAssumeRoleArn } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { resolveStartApiAssumeRoleArn } from '../../../src/cli/commands/local-start-api.js';

/**
 * Issue #570, third review round — the role ARN on the SUCCESS path.
 *
 * The lane started by flattening the ARN on the four `warn` lines that report
 * an `sts:AssumeRole` FAILURE. A security pass then pointed out that the same
 * wire-derived ARN is printed by five more lines that fire when the resolution
 * SUCCEEDS, which makes them strictly more reachable:
 *
 *   - `local-invoke.ts` — from state, and from `GetFunctionConfiguration`
 *   - `local-invoke-agentcore.ts` — from state, and from `GetAgentRuntime`
 *   - `local-start-api.ts` — from state
 *
 * Where the ARN comes from is the point. Under `--from-cfn-stack` the bare
 * `--assume-role` form reads it out of a live AWS response
 * (`Configuration.Role`, `roleArn`) or out of a state record built from one,
 * and the only validation anywhere on that path is `startsWith('arn:')`. Two
 * of the five are `logger.info`, which is a DEFAULT level, and `cdkl studio`
 * mirrors every level of a serve child's stdout into a log ring it serves over
 * HTTP. So a hostile Lambda / AgentCore endpoint answering
 * `arn:aws:iam::1:role/x\nWARN: ...` forges a line there.
 *
 * This file exists because the flatten shipped UNFENCED at both of the
 * `local-invoke.ts` sites — mutation probes reverted each and all 119 tests
 * stayed green. That is the third time in this lane a `flattenToOneLine` call
 * arrived without a test, so every one of the five is driven here.
 */

/** A forged ARN: `startsWith('arn:')` passes, and the tail forges a line. */
const FORGED = 'arn:aws:iam::123456789012:role/x\nWARN: signature verified';
/** What must appear instead — every character, on one line. */
const FLAT = 'arn:aws:iam::123456789012:role/x WARN: signature verified';

function stateWithRole(logicalId: string, roleArn: string, roleProperty = 'Role'): StackState {
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
  } as unknown as StackState;
}

describe('#570 — a forged newline in a role ARN cannot forge a line on the SUCCESS path', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    for (const level of ['info', 'debug', 'warn'] as const) {
      vi.spyOn(getLogger(), level).mockImplementation((m: string) => {
        lines.push(String(m));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The one emitted line that mentions the forged tail. */
  function forgedLine(): string {
    const matches = lines.filter((l) => l.includes('signature verified'));
    expect(matches, 'no log line carried the ARN at all — the fixture missed the site').toHaveLength(
      1
    );
    return matches[0]!;
  }

  it('premise: the fixture ARN passes the only validation on the path', () => {
    // Non-vacuity for every case below. If `startsWith('arn:')` rejected this
    // value, each site would return early and every assertion would pass over
    // a line that was never emitted.
    expect(FORGED.startsWith('arn:')).toBe(true);
    expect(FORGED).toContain('\n');
    expect(FLAT).not.toContain('\n');
    // And the state helper really does hand the raw value back.
    expect(resolveExecutionRoleArnFromState(stateWithRole('Handler', FORGED), 'Handler')).toBe(
      FORGED
    );
  });

  it('local-invoke: from state', async () => {
    await resolveAssumeRoleArnForLambda(true, stateWithRole('Handler', FORGED), undefined, 'Handler');
    const line = forgedLine();
    expect(line).toContain(`from state: ${FLAT}`);
    expect(line).not.toContain('\n');
  });

  it('local-invoke: from GetFunctionConfiguration', async () => {
    // State misses (no Role property), so the live fallback fires.
    const state = stateWithRole('Handler', FORGED, 'SomethingElse');
    await resolveAssumeRoleArnForLambda(true, state, {
      resolveLambdaExecutionRoleArn: vi.fn().mockResolvedValue(FORGED),
    }, 'Handler');
    const line = forgedLine();
    expect(line).toContain(`from GetFunctionConfiguration: ${FLAT}`);
    expect(line).not.toContain('\n');
  });

  it('local-invoke-agentcore: from state', async () => {
    const loaded = stateWithRole('ChatAgent', FORGED, 'RoleArn') as unknown as LocalStateRecord;
    await resolveAssumeRoleArn(
      { assumeRole: true } as never,
      { logicalId: 'ChatAgent', resource: { Properties: {} } } as unknown as ResolvedAgentCoreRuntime,
      loaded,
      undefined
    );
    const line = forgedLine();
    expect(line).toContain(`resolved RoleArn from state: ${FLAT}`);
    expect(line).not.toContain('\n');
  });

  it('local-invoke-agentcore: from GetAgentRuntime', async () => {
    const loaded = stateWithRole(
      'ChatAgent',
      FORGED,
      'SomethingElse'
    ) as unknown as LocalStateRecord;
    await resolveAssumeRoleArn(
      { assumeRole: true } as never,
      { logicalId: 'ChatAgent', resource: { Properties: {} } } as unknown as ResolvedAgentCoreRuntime,
      loaded,
      { resolveAgentCoreRuntimeRoleArn: vi.fn().mockResolvedValue(FORGED) }
    );
    const line = forgedLine();
    expect(line).toContain(`from GetAgentRuntime: ${FLAT}`);
    expect(line).not.toContain('\n');
  });

  it('local-start-api: from state', () => {
    resolveStartApiAssumeRoleArn({
      logicalId: 'Handler',
      assumeRole: { bareAutoResolve: true } as never,
      lambdaResource: { Type: 'AWS::Lambda::Function', Properties: {} } as never,
      stateBundle: { state: stateWithRole('Handler', FORGED) } as never,
    });
    const line = forgedLine();
    expect(line).toContain(`from state: ${FLAT}`);
    expect(line).not.toContain('\n');
  });
});
