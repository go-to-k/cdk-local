import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackState } from '../../../src/types/state.js';
import type { LocalStateRecord } from '../../../src/local/local-state-provider.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import {
  resolveAssumeRoleArnForLambda,
  resolveExecutionRoleArnFromState,
  suggestAssumeRoleFromState,
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
 * A fourth round then found a SIXTH, more reachable than any of them:
 * `suggestAssumeRoleFromState`'s `Hint:` line, whose caller is guarded on
 * `options.assumeRole === undefined`, so it fires on a plain
 * `cdkl invoke --from-cfn-stack <fn>` with no role flag at all. The first
 * enumeration had walked the assume-role RESOLVERS rather than the readers of
 * `resolveExecutionRoleArnFromState`.
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
 * stayed green. That was the third time in this lane a `flattenToOneLine` call
 * arrived without a test, so all SIX are driven here, each by the exported
 * function that owns it.
 *
 * UPDATED by issue #607, which closed the other half. `startsWith('arn:')` is
 * no longer "the only validation anywhere on that path": the STATE resolution
 * points (`resolveExecutionRoleArnFromState`, and cdk-local's own
 * `CfnLocalStateProvider`) now shape- and length-check the value with
 * `isIamRoleArn`, so a forged ARN is REJECTED before it can reach any of those
 * lines — which also bounds what is SENT as `AssumeRoleCommand.RoleArn`, the
 * half a flatten at the log line could never cover. The four state-derived
 * cases below therefore assert the STRONGER property that superseded the
 * flatten there: nothing forged is printed at all.
 *
 * ALL SIX now assert rejection, including the two that reach a log line
 * through a `LocalStateProvider` the caller supplied. An earlier revision of
 * this file left those two driving the flatten, on the grounds that a host
 * CLI's own provider implementation is not covered by the check inside
 * cdk-local's `CfnLocalStateProvider` — which was true, and was an argument
 * for checking the provider RETURN, not for leaving it unchecked so that a
 * test could keep asserting something. Both call sites now check what they are
 * handed, and the send itself is bounded at the choke point in
 * `src/utils/role-arn.ts` regardless of how the value got there.
 *
 * All SIX carry a WELL-FORMED-ARN guard-the-guard, because a test asserting
 * that nothing was logged passes just as happily over a call site that stopped
 * emitting for some entirely unrelated reason. Two of them did not, in an
 * earlier revision that claimed here that all of them did: the agentcore- and
 * start-api-from-state cases asserted only `forgedNeverResolved()`, which is
 * vacuous over zero lines — strictly weaker than the `forgedLine()` they
 * replaced, which failed loudly when its site went dead.
 */

/** A forged ARN: `startsWith('arn:')` passes, and the tail forges a line. */
const FORGED = 'arn:aws:iam::123456789012:role/x\nWARN: signature verified';
/**
 * A well-formed role ARN (issue #607). Guards the guard: it proves a case that
 * now asserts REJECTION is watching the shape check rather than a site that
 * stopped emitting for some unrelated reason.
 */
const CLEAN = 'arn:aws:iam::123456789012:role/CleanRole';

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

  /**
   * The #607 property at a state site: the forged ARN is never RESOLVED.
   *
   * Not "the tail never appears" — the rejection warn deliberately shows the
   * value it refused, so a real misconfiguration is diagnosable, and it shows
   * it flattened and clamped. So the assertion is the two things that actually
   * matter: no emitted line carries a raw newline (the forgery never lands),
   * and any line mentioning the tail is the rejection warn rather than a line
   * presenting it as the function's execution role.
   */
  function forgedNeverResolved(): void {
    for (const line of lines) {
      expect(line, 'a log line carried a raw newline').not.toContain('\n');
    }
    for (const line of lines.filter((l) => l.includes('signature verified'))) {
      expect(
        line,
        'the forged tail appeared on a line that is not the #607 rejection warn'
      ).toContain('not a well-formed IAM role ARN');
    }
  }

  it('premise: the fixture ARN would pass the check #607 replaced', () => {
    // Non-vacuity in both directions. `startsWith('arn:')` accepted this value
    // — that is what made every line below reachable — and the shape check that
    // replaced it does not, which is what the four state cases now assert.
    expect(FORGED.startsWith('arn:')).toBe(true);
    expect(FORGED).toContain('\n');
    // And the state helper now refuses to hand it back at all.
    expect(
      resolveExecutionRoleArnFromState(stateWithRole('Handler', FORGED), 'Handler')
    ).toBeUndefined();
    // Guard the guard: the same helper still resolves a WELL-FORMED ARN, so a
    // rejection below is the shape check firing rather than the fixture being
    // wrong in some other way.
    expect(resolveExecutionRoleArnFromState(stateWithRole('Handler', CLEAN), 'Handler')).toBe(
      CLEAN
    );
  });

  it('local-invoke: from state — #607 rejects it before any line is emitted', async () => {
    const arn = await resolveAssumeRoleArnForLambda(
      true,
      stateWithRole('Handler', FORGED),
      undefined,
      'Handler'
    );
    expect(arn).toBeUndefined();
    forgedNeverResolved();
  });

  it('local-invoke: from GetFunctionConfiguration — #607 rejects the provider return', async () => {
    // State misses (no Role property), so the live fallback fires. The
    // provider here is a MOCK standing in for a host CLI's own
    // `LocalStateProvider`: cdk-local's `CfnLocalStateProvider` checks at the
    // source, a host's does not, so `resolveAssumeRoleArnForLambda` checks
    // what it is handed rather than trusting the interface.
    const state = stateWithRole('Handler', FORGED, 'SomethingElse');
    const arn = await resolveAssumeRoleArnForLambda(
      true,
      state,
      { resolveLambdaExecutionRoleArn: vi.fn().mockResolvedValue(FORGED) },
      'Handler'
    );
    expect(arn).toBeUndefined();
    forgedNeverResolved();
    // Guard the guard: a well-formed provider return still resolves and still
    // logs, so the rejection above is the check firing rather than the
    // fallback having quietly stopped working.
    const clean = await resolveAssumeRoleArnForLambda(
      true,
      stateWithRole('Handler', CLEAN, 'SomethingElse'),
      { resolveLambdaExecutionRoleArn: vi.fn().mockResolvedValue(CLEAN) },
      'Handler'
    );
    expect(clean).toBe(CLEAN);
    expect(lines.some((l) => l.includes(`from GetFunctionConfiguration: ${CLEAN}`))).toBe(true);
  });

  it('local-invoke-agentcore: from state — #607 rejects it before any line is emitted', async () => {
    const loaded = stateWithRole('ChatAgent', FORGED, 'RoleArn') as unknown as LocalStateRecord;
    const arn = await resolveAssumeRoleArn(
      { assumeRole: true } as never,
      { logicalId: 'ChatAgent', resource: { Properties: {} } } as unknown as ResolvedAgentCoreRuntime,
      loaded,
      undefined
    );
    expect(arn).toBeUndefined();
    forgedNeverResolved();
    // Guard the guard. Without it `forgedNeverResolved()` passes vacuously
    // over zero emitted lines, which is what a DEAD lookup also produces — and
    // the pre-#607 `forgedLine()` this replaced failed loudly in that case, so
    // omitting it would make the rewrite strictly weaker than what it replaced.
    const clean = await resolveAssumeRoleArn(
      { assumeRole: true } as never,
      { logicalId: 'ChatAgent', resource: { Properties: {} } } as unknown as ResolvedAgentCoreRuntime,
      stateWithRole('ChatAgent', CLEAN, 'RoleArn') as unknown as LocalStateRecord,
      undefined
    );
    expect(clean).toBe(CLEAN);
    expect(lines.some((l) => l.includes(`resolved RoleArn from state: ${CLEAN}`))).toBe(true);
  });

  it('local-invoke-agentcore: from GetAgentRuntime — #607 rejects the provider return', async () => {
    const loaded = stateWithRole(
      'ChatAgent',
      FORGED,
      'SomethingElse'
    ) as unknown as LocalStateRecord;
    const arn = await resolveAssumeRoleArn(
      { assumeRole: true } as never,
      { logicalId: 'ChatAgent', resource: { Properties: {} } } as unknown as ResolvedAgentCoreRuntime,
      loaded,
      { resolveAgentCoreRuntimeRoleArn: vi.fn().mockResolvedValue(FORGED) }
    );
    expect(arn).toBeUndefined();
    forgedNeverResolved();
    // Guard the guard, as above.
    const clean = await resolveAssumeRoleArn(
      { assumeRole: true } as never,
      { logicalId: 'ChatAgent', resource: { Properties: {} } } as unknown as ResolvedAgentCoreRuntime,
      stateWithRole('ChatAgent', CLEAN, 'SomethingElse') as unknown as LocalStateRecord,
      { resolveAgentCoreRuntimeRoleArn: vi.fn().mockResolvedValue(CLEAN) }
    );
    expect(clean).toBe(CLEAN);
    expect(lines.some((l) => l.includes(`from GetAgentRuntime: ${CLEAN}`))).toBe(true);
  });

  it('local-invoke: the no-flag `Hint:` line — #607 rejects it, so it never fires', () => {
    // Was the most reachable of the six: it fires with NO `--assume-role`, on a
    // plain `cdkl invoke --from-cfn-stack`. It reads the same state helper, so
    // the shape check now stops it at the source.
    suggestAssumeRoleFromState(stateWithRole('Handler', FORGED), 'Handler');
    forgedNeverResolved();
    // Guard the guard: the line DOES fire, flattened, for a well-formed ARN, so
    // the assertion above is the shape check rather than a dead call site.
    suggestAssumeRoleFromState(stateWithRole('Handler', CLEAN), 'Handler');
    expect(lines.some((l) => l.includes(`uses execution role ${CLEAN}`))).toBe(true);
  });

  it('local-start-api: from state — #607 rejects it before any line is emitted', () => {
    const arn = resolveStartApiAssumeRoleArn({
      logicalId: 'Handler',
      assumeRole: { bareAutoResolve: true } as never,
      lambdaResource: { Type: 'AWS::Lambda::Function', Properties: {} } as never,
      stateBundle: { state: stateWithRole('Handler', FORGED) } as never,
    });
    expect(arn).toBeUndefined();
    forgedNeverResolved();
    // Guard the guard, for the same reason as the agentcore sibling above.
    const clean = resolveStartApiAssumeRoleArn({
      logicalId: 'Handler',
      assumeRole: { bareAutoResolve: true } as never,
      lambdaResource: { Type: 'AWS::Lambda::Function', Properties: {} } as never,
      stateBundle: { state: stateWithRole('Handler', CLEAN) } as never,
    });
    expect(clean).toBe(CLEAN);
    expect(lines.some((l) => l.includes(`from state: ${CLEAN}`))).toBe(true);
  });
});
