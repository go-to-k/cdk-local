import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock the two resolver functions makeAlbBackingPinnedResolver calls so we can
// drive its branch logic (issue #382) without a real synth. local-studio.ts
// imports ONLY `resolveAlbTarget` from local-start-alb and `resolveAlbFrontDoor`
// from elb-front-door-resolver, so the partial mocks cover its imports.
const h = vi.hoisted(() => ({ resolveAlbTarget: vi.fn(), resolveAlbFrontDoor: vi.fn() }));
vi.mock('../../../src/cli/commands/local-start-alb.js', async (importActual) => ({
  ...((await importActual()) as object),
  resolveAlbTarget: h.resolveAlbTarget,
}));
vi.mock('../../../src/local/elb-front-door-resolver.js', async (importActual) => ({
  ...((await importActual()) as object),
  resolveAlbFrontDoor: h.resolveAlbFrontDoor,
}));

import { makeAlbBackingPinnedResolver } from '../../../src/cli/commands/local-studio.js';

const stack = { stackName: 'S' };
const warn = vi.fn();
const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() } as never;

function build(pinned: Record<string, string>) {
  h.resolveAlbTarget.mockReturnValue({ stack, albLogicalId: 'Alb' });
  return makeAlbBackingPinnedResolver({
    stacks: [stack] as never,
    pinnedEcsByQualifiedId: new Map(Object.entries(pinned)),
    logger,
  });
}
const ecsFwd = (...ids: string[]) => ({
  kind: 'forward',
  targets: ids.map((id) => ({ kind: 'ecs', serviceLogicalId: id })),
});
const albEntry = { id: 'S/Alb', qualifiedId: 'S:Alb' };

describe('makeAlbBackingPinnedResolver (issue #382)', () => {
  beforeEach(() => {
    h.resolveAlbTarget.mockClear();
    h.resolveAlbFrontDoor.mockClear();
    warn.mockClear();
  });

  it('returns the pinned backing services the ALB forwards to, deduped across listeners/rules', () => {
    h.resolveAlbFrontDoor.mockReturnValue({
      warnings: [],
      listeners: [
        {
          defaultAction: { kind: 'fixed-response' },
          rules: [{ action: ecsFwd('SvcA') }, { action: ecsFwd('SvcA', 'SvcB') }],
        },
      ],
    });
    const r = build({ 'S:SvcA': 'S/SvcA', 'S:SvcB': 'S/SvcB', 'S:Unpinned': 'x' });
    const out = r(albEntry);
    // SvcA + SvcB are pinned + forwarded; SvcA is deduped; Unpinned is not forwarded.
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ id: 'S:SvcA', label: 'S/SvcA' });
    expect(out).toContainEqual({ id: 'S:SvcB', label: 'S/SvcB' });
  });

  it('drops a forwarded service that is NOT in the pinned set', () => {
    h.resolveAlbFrontDoor.mockReturnValue({
      warnings: [],
      listeners: [{ defaultAction: ecsFwd('SvcA', 'SvcLocalAsset'), rules: [] }],
    });
    // Only SvcA is pinned; SvcLocalAsset (a local-asset service) is excluded.
    expect(build({ 'S:SvcA': 'S/SvcA' })(albEntry)).toEqual([{ id: 'S:SvcA', label: 'S/SvcA' }]);
  });

  it('skips non-forward actions and non-ecs (lambda) forward targets', () => {
    h.resolveAlbFrontDoor.mockReturnValue({
      warnings: [],
      listeners: [
        {
          defaultAction: { kind: 'redirect' },
          rules: [
            { action: { kind: 'fixed-response' } },
            { action: { kind: 'forward', targets: [{ kind: 'lambda', lambdaLogicalId: 'Fn' }] } },
          ],
        },
      ],
    });
    expect(build({ 'S:SvcA': 'S/SvcA' })(albEntry)).toEqual([]);
  });

  it('short-circuits (does not resolve the ALB) when nothing is pinned', () => {
    const r = build({});
    expect(r(albEntry)).toEqual([]);
    expect(h.resolveAlbFrontDoor).not.toHaveBeenCalled();
  });

  it('WARN-logs + returns [] when the ALB cannot be resolved', () => {
    warn.mockClear();
    h.resolveAlbFrontDoor.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(build({ 'S:SvcA': 'S/SvcA' })(albEntry)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not resolve ALB'));
  });
});
