import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

/**
 * Issue #882 — source fences for how every `--watch` runner wires the reload
 * queue and the shutdown. The queue and the signal policy have behavioral
 * rows (`reload-queue.test.ts`, `shutdown-signal.test.ts`); these pin each
 * runner's USE of them, which only a live Docker run exercises otherwise:
 * reloads go through `createReloadQueue`, the shutdown runs `stopWatchReloads`
 * BEFORE removing anything, the reload checks its signal before starting a
 * container, and repeated signals go through `createShutdownSignalHandler`.
 */

const CMD = join(__dirname, '../../../src/cli/commands');
const read = (f: string): string => readFileSync(join(CMD, f), 'utf-8');

/** `first` occurs, then `second` occurs after it, both after `from`. */
function expectOrder(src: string, from: string, first: string, second: string): void {
  const start = src.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
  const a = src.indexOf(first, start);
  const b = src.indexOf(second, start);
  expect(a, `not found after anchor: ${first}`).toBeGreaterThanOrEqual(0);
  expect(b, `not found after anchor: ${second}`).toBeGreaterThanOrEqual(0);
  expect(a, `${first} must come before ${second}`).toBeLessThan(b);
}

describe('--watch shutdown wiring (#882)', () => {
  it('no runner chains reloads by hand any more', () => {
    for (const f of readdirSync(CMD).filter((n) => n.endsWith('.ts'))) {
      expect(read(f), f).not.toMatch(/reloadChain\s*=\s*reloadChain\.then|reloadChain\.then\(/);
    }
  });

  it('ECS emulator (start-service / start-alb)', () => {
    const src = read('ecs-service-emulator.ts');
    expect(src).toMatch(
      /run:\s*\(changedPaths,\s*signal\)\s*=>\s*reloadAllServices\(\{[^}]*?\bsignal,[^}]*?\}\)/
    );
    expectOrder(src, 'const cleanup = singleFlight(', 'await stopWatchReloads(', 'perTarget.map(');
    expectOrder(src, 'async function rollOneTarget(', 'if (signal?.aborted) return;', 'await rollServiceReplica(');
    expect(src).toMatch(/await rollOneTarget\(\{[\s\S]*?\.\.\.\(signal && \{ signal \}\)/);
    expect(src).toContain('createShutdownSignalHandler(');
    expect(src).toContain("process.on('SIGTERM', sigtermHandler)");
  });

  it('start-api', () => {
    const src = read('local-start-api.ts');
    expect(src).toContain('createReloadQueue(');
    expectOrder(src, 'const runCleanup = singleFlight(', 'await stopWatchReloads(', 'await server.close()');
    expectOrder(src, 'async function reloadAllServers(', 'if (signal?.aborted)', 'buildPool(');
    expect(src).toContain('createShutdownSignalHandler(');
  });

  it('start-agentcore', () => {
    const src = read('local-start-agentcore.ts');
    expect(src).toContain('createReloadQueue(');
    expectOrder(src, 'const teardown = async', 'await stopWatchReloads(', 'await server.close()');
    expectOrder(src, 'const newImage = await resolveAgentCoreImage(', 'if (tornDown || shuttingDown) return;', 'runDetached(');
    expect(src).toContain('createShutdownSignalHandler(');
  });

  it('invoke-agentcore', () => {
    const src = read('local-invoke-agentcore.ts');
    expect(src).toContain('createReloadQueue(');
    expect(src).toMatch(/registerStop:\s*\(stop\)\s*=>\s*\{\s*stopWatch = stop;/);
    expectOrder(src, 'const cleanup = singleFlight(', 'if (stopWatch) await stopWatch();', 'removeContainer(containerId)');
    expectOrder(src, 'rebuild: async (signal) =>', 'if (signal?.aborted)', 'containerId = await runDetached(');
    expect(src).toContain("process.on('SIGTERM', sigtermHandler)");
    expect(src).toContain('createShutdownSignalHandler(');
  });

  it('start-cloudfront', () => {
    const src = read('local-start-cloudfront.ts');
    expect(src).toContain('createReloadQueue(');
    expect(src).toMatch(/const reloaded = await synthAndResolve\(\);\s*if \(signal\.aborted\) return;/);
    expectOrder(src, 'const teardown = async', 'await stopWatchReloads(', 'await server.close()');
    expect(src).toContain('createShutdownSignalHandler(');
  });

  it('a non-signal exit keeps the signal handlers until its cleanup has finished', () => {
    // Removing them first let a ^C during that cleanup hit Node's default
    // SIGINT handler, which kills the process mid-teardown.
    for (const f of ['ecs-service-emulator.ts', 'local-invoke-agentcore.ts', 'local-run-task.ts']) {
      const src = read(f);
      // The command's own `finally`: the one that removes the signal handlers.
      const fin = src.lastIndexOf('} finally {', src.indexOf("process.off('SIGINT', sigintHandler)"));
      const tail = src.slice(fin);
      const cleanupAt = tail.search(/await cleanup\(\);/);
      const offAt = tail.indexOf("process.off('SIGINT'");
      expect(cleanupAt, `${f}: finally awaits cleanup`).toBeGreaterThanOrEqual(0);
      expect(offAt, `${f}: finally removes the SIGINT handler`).toBeGreaterThanOrEqual(0);
      expect(cleanupAt, `${f}: handlers removed before the cleanup finished`).toBeLessThan(offAt);
      expect(tail.indexOf("process.off('SIGTERM'"), f).toBeGreaterThan(cleanupAt);
    }
  });

  it('run-task (no --watch, same second-signal policy)', () => {
    const src = read('local-run-task.ts');
    expect(src).toContain('createShutdownSignalHandler(');
    expect(src).toContain("process.on('SIGTERM', sigtermHandler)");
  });
});
