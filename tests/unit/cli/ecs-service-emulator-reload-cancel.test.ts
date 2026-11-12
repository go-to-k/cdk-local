import { describe, it, expect, vi } from 'vite-plus/test';
import { reloadAllServices } from '../../../src/cli/commands/ecs-service-emulator.js';

/**
 * Issue #882 — a `--watch` reload checks the shutdown signal between steps,
 * so a SIGINT / SIGTERM that lands mid-reload stops it before any further
 * Docker work (the roll of the next target / replica).
 */

type Args = Parameters<typeof reloadAllServices>[0];

function makeArgs(over: {
  abort: AbortController;
  synthesize: () => Promise<unknown>;
  targets: string[];
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  resolveBoots: ReturnType<typeof vi.fn>;
}): Args {
  return {
    // No controller: each target logs "has no live controller" and is skipped,
    // which exercises the per-target checkpoint without any Docker work.
    perTarget: over.targets.map((target) => ({
      boot: { target } as never,
      runState: {} as never,
    })),
    synthesizer: { synthesize: over.synthesize } as never,
    synthOpts: {} as never,
    strategy: { resolveBoots: over.resolveBoots } as never,
    resolvedTargets: over.targets,
    cloudMapIndexByStack: new Map(),
    options: { output: 'cdk.out' } as never,
    discovery: {} as never,
    skipPull: true,
    extraStateProviders: undefined,
    profileCredsFile: undefined,
    frontDoorByService: new Map(),
    changedPaths: ['/app/log.txt'],
    imageOverrideTags: new Map(),
    imageOverrideMap: new Map() as never,
    logger: {
      info: over.info,
      warn: over.warn,
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    signal: over.abort.signal,
  };
}

describe('reloadAllServices — shutdown cancellation (#882)', () => {
  it('a signal during the synth stops the reload before any target is resolved or rolled', async () => {
    const abort = new AbortController();
    const resolveBoots = vi.fn(() => ({ boots: [], warnings: [] }));
    const info = vi.fn();
    const args = makeArgs({
      abort,
      synthesize: async () => {
        abort.abort();
        return { stacks: [] };
      },
      targets: ['A'],
      warn: vi.fn(),
      info,
      resolveBoots,
    });
    await reloadAllServices(args);
    expect(resolveBoots).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Reload cancelled: shutting down.');
    expect(info).not.toHaveBeenCalledWith('Reload complete.');
  });

  it('a signal between targets stops the reload before the next target', async () => {
    const abort = new AbortController();
    const warn = vi.fn((msg: string) => {
      // The first target's skip line: shutdown starts right after it.
      if (msg.includes('has no live controller')) abort.abort();
    });
    const info = vi.fn();
    const args = makeArgs({
      abort,
      synthesize: async () => ({ stacks: [] }),
      targets: ['A', 'B'],
      warn,
      info,
      resolveBoots: vi.fn(() => ({
        boots: [{ target: 'A' }, { target: 'B' }],
        warnings: [],
      })),
    });
    await reloadAllServices(args);
    const skipped = warn.mock.calls.filter((c) => String(c[0]).includes('has no live controller'));
    expect(skipped).toHaveLength(1);
    expect(info).toHaveBeenCalledWith('Reload cancelled: shutting down.');
    expect(info).not.toHaveBeenCalledWith('Reload complete.');
  });

  it('without a signal the same reload walks every target and completes', async () => {
    const abort = new AbortController();
    const warn = vi.fn();
    const info = vi.fn();
    const args = makeArgs({
      abort,
      synthesize: async () => ({ stacks: [] }),
      targets: ['A', 'B'],
      warn,
      info,
      resolveBoots: vi.fn(() => ({
        boots: [{ target: 'A' }, { target: 'B' }],
        warnings: [],
      })),
    });
    await reloadAllServices(args);
    const skipped = warn.mock.calls.filter((c) => String(c[0]).includes('has no live controller'));
    expect(skipped).toHaveLength(2);
    expect(info).toHaveBeenCalledWith('Reload complete.');
  });
});
