import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { Command } from 'commander';

/**
 * Issue #255 — `cdkl invoke-agentcore --watch`.
 *
 * Three slices of coverage live here:
 *
 *   1. Option-surface + default — `--watch` is registered on the
 *      `addInvokeAgentCoreSpecificOptions` helper (NOT inline in
 *      `createLocalInvokeAgentCoreCommand`) and defaults to `false`.
 *      Locks the cdkd-parity contract (option helpers are the only
 *      way a host CLI inherits per-command flags).
 *   2. Source-change classifier dispatch — `runAgentCoreWatchLoop`
 *      routes a `'soft-reload'` verdict through the soft-reload
 *      callback and a `'rebuild'` verdict through the rebuild
 *      callback. The `__classifierContext` test hook returns a
 *      canned {@link ReloadAssetContext} so the classifier verdict
 *      is forced without standing up a real AssetManifestLoader.
 *   3. Soft-reload helper — `softReloadAgentContainer` reads
 *      `Config.WorkingDir`, runs `docker cp <source>/. <id>:<workdir>/`,
 *      then `docker restart <id>`. `node:child_process` is mocked at
 *      module load (ESM `node:` namespaces are non-configurable, so
 *      `vi.spyOn` does not work — `vi.mock` is the only path).
 */

// Hoisted mock — `node:child_process` is dynamically imported inside
// `softReloadAgentContainer` so we have to intercept at the module
// registry instead of spying on the namespace.
//
// `promisify(execFile)` appends the callback as the LAST argument
// regardless of the original arity, so the mock's outer shape uses
// `(...rest)` + `rest[rest.length - 1]` to grab the callback the same
// way the existing `tests/unit/local/docker-inspect-published-port.test.ts`
// mock does (the canonical pattern in this codebase).
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const cmd = rest[0] as string;
    const args = rest[1] as string[];
    // The mock returns either a string (stdout, success) or an Error
    // (promisify rejects). Mirrors the canonical pattern.
    const result = execFileMock(cmd, args);
    if (result instanceof Error) {
      cb(result, { stdout: '', stderr: '' });
    } else {
      cb(null, { stdout: (result as string) ?? '', stderr: '' });
    }
  },
}));

import {
  addInvokeAgentCoreSpecificOptions,
  createLocalInvokeAgentCoreCommand,
  runAgentCoreWatchLoop,
  softReloadAgentContainer,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import type { ResolvedAgentCoreRuntime } from '../../../src/local/agentcore-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { FileWatcher } from '../../../src/local/file-watcher.js';
import type { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import type { ReloadAssetContext } from '../../../src/local/source-change-classifier.js';

describe('invoke-agentcore --watch option surface (issue #255)', () => {
  it('exposes --watch via addInvokeAgentCoreSpecificOptions (not inline drift)', () => {
    // cdkd inherits per-command flags by calling the helper directly; an
    // inline `.addOption(--watch)` in `createLocalInvokeAgentCoreCommand`
    // would silently break that inheritance. Lock the helper as the
    // source of truth.
    const helperCmd = addInvokeAgentCoreSpecificOptions(new Command());
    const helperFlags = helperCmd.options
      .map((o) => o.long)
      .filter((l): l is string => typeof l === 'string');
    expect(helperFlags).toContain('--watch');

    const fullCmd = createLocalInvokeAgentCoreCommand();
    const fullFlags = fullCmd.options
      .map((o) => o.long)
      .filter((l): l is string => typeof l === 'string');
    expect(fullFlags).toContain('--watch');
  });

  it('--watch defaults to false', () => {
    // Locks the boolean default. A flipped default would install a
    // chokidar watcher on every invoke-agentcore invocation.
    const cmd = addInvokeAgentCoreSpecificOptions(new Command());
    const watch = cmd.options.find((o) => o.long === '--watch');
    expect(watch?.defaultValue).toBe(false);
  });
});

describe('runAgentCoreWatchLoop — classifier dispatch (soft-reload vs rebuild)', () => {
  let rebuild: ReturnType<typeof vi.fn>;
  let softReload: ReturnType<typeof vi.fn>;
  let wsInvoker: ReturnType<typeof vi.fn>;
  let waitForPing: ReturnType<typeof vi.fn>;
  let onChangeRef: ((paths: readonly string[]) => void) | undefined;
  let watcher: FileWatcher;
  let synthesizer: Synthesizer;

  beforeEach(() => {
    onChangeRef = undefined;
    rebuild = vi.fn();
    softReload = vi.fn();
    waitForPing = vi.fn().mockResolvedValue(undefined);
    watcher = { close: vi.fn().mockResolvedValue(undefined) };
    synthesizer = {
      synthesize: vi.fn().mockResolvedValue({ stacks: [] }),
    } as unknown as Synthesizer;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function baseRuntime(): ResolvedAgentCoreRuntime {
    return {
      stack: { stackName: 'App' } as ResolvedAgentCoreRuntime['stack'],
      logicalId: 'ChatAgent',
      resource: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
      containerUri: undefined,
      environmentVariables: {},
      protocol: 'HTTP',
      codeArtifact: {
        runtime: 'PYTHON_3_12',
        entryPoint: ['app.py'],
        codeAssetHash: 'OLDHASH',
      },
    };
  }

  function wireOneReloadThenEnd(): void {
    // Two WS sessions: first resolves on abort (reload fires), second
    // resolves naturally so the loop exits.
    wsInvoker = vi
      .fn()
      .mockImplementationOnce(async (_h, _p, _e, opts: { abortSignal?: AbortSignal }) => {
        process.nextTick(() => {
          onChangeRef?.(['/abs/handler.py']);
        });
        await new Promise<void>((res) => {
          opts.abortSignal?.addEventListener('abort', () => res());
        });
        return { frames: 0 };
      })
      .mockImplementationOnce(async () => ({ frames: 0 }));
  }

  it('routes a soft-reload verdict through the softReload callback (no rebuild)', async () => {
    wireOneReloadThenEnd();
    softReload.mockResolvedValue({ stacks: [] });
    const softReloadAssetCtx: ReloadAssetContext = {
      oldAssetHash: 'OLDHASH',
      newAssetHash: 'NEWHASH',
      newAssetSourceDir: '/cdk.out/asset.NEWHASH',
      dockerFile: '.cdkl-agentcore-generated-Dockerfile',
    };

    await runAgentCoreWatchLoop({
      containerHost: '127.0.0.1',
      hostPort: 9001,
      event: { hi: 1 },
      sessionId: 'sid',
      timeoutMs: 1000,
      interactive: false,
      options: { output: 'cdk.out' } as never,
      resolvedTarget: 'ChatAgent',
      resolved: baseRuntime(),
      synthesizer,
      synthOpts: {} as never,
      stacks: [],
      rebuild,
      softReload,
      __wsInvoker: wsInvoker,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      // Force the classifier into the soft-reload branch by handing it
      // an asset context where: hashes differ, no Dockerfile / dep
      // manifest / compiled-language path is touched. `handler.py` is
      // an interpreted-language source change.
      __classifierContext: async () => softReloadAssetCtx,
    });

    expect(softReload).toHaveBeenCalledTimes(1);
    expect(softReload.mock.calls[0]?.[0]).toBe('/cdk.out/asset.NEWHASH');
    expect(rebuild).not.toHaveBeenCalled();
    expect(wsInvoker).toHaveBeenCalledTimes(2);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('routes a rebuild verdict through the rebuild callback', async () => {
    // Same scaffolding, but the asset context returns `undefined` so the
    // classifier defaults to rebuild ("target image is not a CDK
    // docker-image asset").
    wireOneReloadThenEnd();
    rebuild.mockResolvedValue({ containerId: 'newId', hostPort: 9002, stacks: [] });

    await runAgentCoreWatchLoop({
      containerHost: '127.0.0.1',
      hostPort: 9001,
      event: {},
      sessionId: 'sid',
      timeoutMs: 1000,
      interactive: false,
      options: { output: 'cdk.out' } as never,
      resolvedTarget: 'ChatAgent',
      resolved: baseRuntime(),
      synthesizer,
      synthOpts: {} as never,
      stacks: [],
      rebuild,
      softReload,
      __wsInvoker: wsInvoker,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => undefined,
    });

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(softReload).not.toHaveBeenCalled();
    expect(wsInvoker).toHaveBeenCalledTimes(2);
  });

  it('wires `readStdinLines()` as the WS frame source when `interactive: true` (multi-turn REPL)', async () => {
    // The command-level dispatch sets `interactive = process.stdin.isTTY === true`
    // and threads it into the watch loop. When true, the loop attaches a
    // `frameSource` to each `wsInvoker(...)` call so each stdin line becomes
    // a follow-up WS text frame (the auto-detected REPL shape).
    wireOneReloadThenEnd();
    softReload.mockResolvedValue({ stacks: [] });
    const softReloadAssetCtx: ReloadAssetContext = {
      oldAssetHash: 'OLDHASH',
      newAssetHash: 'NEWHASH',
      newAssetSourceDir: '/cdk.out/asset.NEWHASH',
      dockerFile: '.cdkl-agentcore-generated-Dockerfile',
    };

    await runAgentCoreWatchLoop({
      containerHost: '127.0.0.1',
      hostPort: 9001,
      event: { hi: 1 },
      sessionId: 'sid',
      timeoutMs: 1000,
      interactive: true,
      options: { output: 'cdk.out' } as never,
      resolvedTarget: 'ChatAgent',
      resolved: baseRuntime(),
      synthesizer,
      synthOpts: {} as never,
      stacks: [],
      rebuild,
      softReload,
      __wsInvoker: wsInvoker,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => softReloadAssetCtx,
    });

    // Both WS invocations (initial + post-reload re-open) received a
    // frameSource on their options. The exact value is opaque — what
    // matters is that the option key was set, NOT undefined.
    expect(wsInvoker).toHaveBeenCalledTimes(2);
    const opts1 = wsInvoker.mock.calls[0]?.[3] as { frameSource?: unknown };
    const opts2 = wsInvoker.mock.calls[1]?.[3] as { frameSource?: unknown };
    expect(opts1?.frameSource).toBeDefined();
    expect(opts2?.frameSource).toBeDefined();
  });

  it('omits `frameSource` from the WS options when `interactive: false` (one-shot / non-TTY)', async () => {
    // The companion of the row above: when stdin is NOT a TTY (piped / CI),
    // the dispatch passes `interactive: false` and no frame source is
    // attached. Existing rebuild + softReload tests run with `interactive:
    // false` and incidentally cover this; the dedicated row pins the
    // negative path explicitly so a future regression that hardcodes
    // `readStdinLines()` would surface here.
    wireOneReloadThenEnd();
    rebuild.mockResolvedValue({ containerId: 'newId', hostPort: 9002, stacks: [] });

    await runAgentCoreWatchLoop({
      containerHost: '127.0.0.1',
      hostPort: 9001,
      event: {},
      sessionId: 'sid',
      timeoutMs: 1000,
      interactive: false,
      options: { output: 'cdk.out' } as never,
      resolvedTarget: 'ChatAgent',
      resolved: baseRuntime(),
      synthesizer,
      synthOpts: {} as never,
      stacks: [],
      rebuild,
      softReload,
      __wsInvoker: wsInvoker,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => undefined,
    });

    const opts1 = wsInvoker.mock.calls[0]?.[3] as { frameSource?: unknown };
    expect(opts1?.frameSource).toBeUndefined();
  });

  it('falls back to rebuild when the classifier context build throws', async () => {
    // The classifier needs `loadAgentCoreAssetContext` (synth + asset
    // manifest read) to succeed; on synth / manifest failure the watch
    // loop logs a warn and forces verdict='rebuild' (slow-but-correct
    // default). Force the failure by wiring __classifierContext to
    // throw and assert the rebuild callback fires.
    wireOneReloadThenEnd();
    rebuild.mockResolvedValue({ containerId: 'newId', hostPort: 9099, stacks: [] });

    await runAgentCoreWatchLoop({
      containerHost: '127.0.0.1',
      hostPort: 9001,
      event: {},
      sessionId: 'sid',
      timeoutMs: 1000,
      interactive: false,
      options: { output: 'cdk.out' } as never,
      resolvedTarget: 'ChatAgent',
      resolved: baseRuntime(),
      synthesizer,
      synthOpts: {} as never,
      stacks: [],
      rebuild,
      softReload,
      __wsInvoker: wsInvoker,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => {
        throw new Error('synth boom');
      },
    });

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(softReload).not.toHaveBeenCalled();
  });

  it('exits the watch loop when the rebuild callback rejects (avoids the ~30s waitForPing hang on stale currentHostPort)', async () => {
    // M1 review nit: when rebuild() rejects, the prior container is
    // already torn down so the next iteration's waitForPing on the
    // OLD `currentHostPort` would block until its default timeout.
    // The fix flips a `reloadFailed` flag that the main loop checks
    // BEFORE waitForPing, breaking out cleanly. This test exercises
    // the single-WS path: one session, watcher fires, rebuild rejects,
    // loop bails out without a second waitForPing.
    let pingCalls = 0;
    waitForPing = vi.fn().mockImplementation(async () => {
      pingCalls += 1;
    });
    // Only ONE WS session — the loop must exit after the rebuild
    // failure rather than entering a second iteration.
    wsInvoker = vi
      .fn()
      .mockImplementationOnce(async (_h, _p, _e, opts: { abortSignal?: AbortSignal }) => {
        process.nextTick(() => {
          onChangeRef?.(['/abs/handler.py']);
        });
        await new Promise<void>((res) => {
          opts.abortSignal?.addEventListener('abort', () => res());
        });
        return { frames: 0 };
      });
    rebuild.mockRejectedValue(new Error('build failed: missing Dockerfile'));

    await runAgentCoreWatchLoop({
      containerHost: '127.0.0.1',
      hostPort: 9001,
      event: {},
      sessionId: 'sid',
      timeoutMs: 1000,
      interactive: false,
      options: { output: 'cdk.out' } as never,
      resolvedTarget: 'ChatAgent',
      resolved: baseRuntime(),
      synthesizer,
      synthOpts: {} as never,
      stacks: [],
      rebuild,
      softReload,
      __wsInvoker: wsInvoker,
      __waitForPing: waitForPing,
      __watcherFactory: (onChange) => {
        onChangeRef = onChange;
        return watcher;
      },
      __classifierContext: async () => undefined,
    });

    expect(rebuild).toHaveBeenCalledTimes(1);
    // Exactly one waitForPing (the initial one before the first WS
    // session). The loop MUST NOT enter a second iteration that would
    // call waitForPing again on the stale port.
    expect(pingCalls).toBe(1);
    expect(wsInvoker).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('exits the loop on a benign agent close with no pending reload', async () => {
    // Single WS session, resolves naturally — no watcher firing.
    wsInvoker = vi.fn().mockResolvedValue({ frames: 5 });

    await runAgentCoreWatchLoop({
      containerHost: '127.0.0.1',
      hostPort: 9001,
      event: {},
      sessionId: 'sid',
      timeoutMs: 1000,
      interactive: false,
      options: { output: 'cdk.out' } as never,
      resolvedTarget: 'ChatAgent',
      resolved: baseRuntime(),
      synthesizer,
      synthOpts: {} as never,
      stacks: [],
      rebuild,
      softReload,
      __wsInvoker: wsInvoker,
      __waitForPing: waitForPing,
      __watcherFactory: () => watcher,
      __classifierContext: async () => undefined,
    });

    expect(wsInvoker).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(softReload).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalled();
  });
});

describe('softReloadAgentContainer — docker cp + docker restart wiring', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('inspects WORKDIR, then docker cp <src>/. <id>:<workdir>/, then docker restart <id>', async () => {
    execFileMock.mockImplementation((_cmd: string, argv: string[]) => {
      // `inspect` is the first call: return the container's WORKDIR.
      return argv[0] === 'inspect' ? '/srv/app\n' : '';
    });

    await softReloadAgentContainer('cidXYZ', '/cdk.out/asset.HASH');

    expect(execFileMock).toHaveBeenCalledTimes(3);
    const argvOf = (n: number): string[] =>
      (execFileMock.mock.calls[n] as [string, string[]])[1];
    expect(argvOf(0)).toEqual(['inspect', '--format', '{{.Config.WorkingDir}}', 'cidXYZ']);
    // Trailing `/.` on source forces CONTENTS to be copied (not the
    // directory itself); trailing `/` on dest forces directory
    // semantics so docker cp doesn't rename `asset.HASH` to `/srv/app`
    // when the dest looks like a file path.
    expect(argvOf(1)).toEqual(['cp', '/cdk.out/asset.HASH/.', 'cidXYZ:/srv/app/']);
    expect(argvOf(2)).toEqual(['restart', 'cidXYZ']);
  });

  it('defaults WORKDIR to `/` (single trailing slash) when docker inspect returns empty', async () => {
    execFileMock.mockImplementation((_cmd: string, argv: string[]) =>
      argv[0] === 'inspect' ? '\n' : ''
    );

    await softReloadAgentContainer('cidEmpty', '/cdk.out/asset.HASH');

    const argvOf = (n: number): string[] =>
      (execFileMock.mock.calls[n] as [string, string[]])[1];
    // `/` not `//` — the trailing-slash normalization branch.
    expect(argvOf(1)).toEqual(['cp', '/cdk.out/asset.HASH/.', 'cidEmpty:/']);
  });

  it('surfaces a docker cp failure as a typed CdkLocalError', async () => {
    execFileMock.mockImplementation((_cmd: string, argv: string[]) => {
      if (argv[0] === 'cp') return new Error('cp: permission denied');
      return '/srv/app\n';
    });

    await expect(softReloadAgentContainer('cid', '/src')).rejects.toThrow(/docker cp/);
    // inspect + cp = 2 calls; restart must NOT run after cp fails.
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('preserves docker stderr inside the wrapped CdkLocalError message (M3)', async () => {
    // execFile rejections carry an `err.stderr` property — the docker
    // CLI writes its actionable diagnostics there. Without surfacing
    // it the wrapped error only carries the generic
    // "Command failed with exit code N" line; the user has to docker
    // logs the container by hand to learn what actually failed.
    execFileMock.mockImplementation((_cmd: string, argv: string[]) => {
      if (argv[0] === 'cp') {
        const err: Error & { stderr?: string } = Object.assign(
          new Error('Command failed with exit code 1'),
          { stderr: 'Error: No such container: cid_gone\n' }
        );
        return err;
      }
      return '/srv/app\n';
    });

    await expect(softReloadAgentContainer('cid_gone', '/src')).rejects.toThrow(
      /No such container: cid_gone/
    );
  });
});
