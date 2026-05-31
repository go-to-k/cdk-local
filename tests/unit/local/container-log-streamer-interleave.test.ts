import { describe, it, expect } from 'vite-plus/test';
import { writePrefixedLines } from '../../../src/local/container-log-streamer.js';

/**
 * Issue #227 review fix (Test G4) — multi-replica concurrent line
 * interleave. Each replica's streamer prefixes its OWN per-replica
 * line shape (`[svc=... r=0 ...]` vs `[svc=... r=1 ...]`). When two
 * streamers emit chunks concurrently, `writePrefixedLines` must
 * preserve each line's prefix — no cross-contamination, no shared
 * mutable buffer between replicas. Exercises the exported
 * `writePrefixedLines` accumulator directly to keep the test scope
 * narrow: a service-runner-level concurrent-emit assertion would
 * require two real docker logs streams which is out of scope for a
 * unit test. The accumulator is the only shared logic between
 * replicas, so testing it for cross-replica isolation is sufficient.
 *
 * Lives in its OWN file so the file-level `vi.mock(container-log-
 * streamer)` in `ecs-service-runner-stream-logs.test.ts` does not
 * shadow the real `writePrefixedLines` export. (Per-file mock scopes
 * — each test file is its own module graph in vitest.)
 */
describe('writePrefixedLines per-replica isolation', () => {
  it('two concurrent prefix streams keep each line under its OWN prefix (no cross-contamination)', () => {
    const writes: string[] = [];
    const out = {
      write: (chunk: string): boolean => {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    // Simulate r0 + r1 emitting interleaved chunks (the docker daemon
    // delivers `data` events from independent streamers concurrently).
    // Each replica's `data` handler maintains its OWN buffer (closure
    // local in `attachContainerLogStreamer`) — there is no shared
    // state, so the order below must be exactly the order out.
    let r0Buf = '';
    let r1Buf = '';
    const r0Prefix = '[svc=Demo r=0 c=app] ';
    const r1Prefix = '[svc=Demo r=1 c=app] ';

    // Chunk 1 from r0 (partial line — must NOT emit yet)
    r0Buf = writePrefixedLines(r0Prefix, r0Buf + 'r0-part-', out);
    expect(writes).toHaveLength(0);

    // Chunk 1 from r1 (partial line — must NOT emit yet)
    r1Buf = writePrefixedLines(r1Prefix, r1Buf + 'r1-line-A\nr1-part-', out);
    // Only the COMPLETE r1 line emits; r1's partial tail stays
    // buffered SEPARATELY from r0's partial.
    expect(writes).toEqual(['[svc=Demo r=1 c=app] r1-line-A\n']);
    expect(r0Buf).toBe('r0-part-');
    expect(r1Buf).toBe('r1-part-');

    // Chunk 2 from r0 (completes r0's partial)
    r0Buf = writePrefixedLines(r0Prefix, r0Buf + 'one\n', out);
    expect(writes[writes.length - 1]).toBe('[svc=Demo r=0 c=app] r0-part-one\n');
    expect(r0Buf).toBe('');

    // Chunk 2 from r1 (completes r1's partial)
    r1Buf = writePrefixedLines(r1Prefix, r1Buf + 'B\n', out);
    expect(writes[writes.length - 1]).toBe('[svc=Demo r=1 c=app] r1-part-B\n');
    expect(r1Buf).toBe('');

    // Final order: each line emitted with its OWN prefix, never the
    // other replica's. Cross-contamination would surface as e.g.
    // `[r=0 ...] r1-part-B` or vice versa.
    expect(writes).toEqual([
      '[svc=Demo r=1 c=app] r1-line-A\n',
      '[svc=Demo r=0 c=app] r0-part-one\n',
      '[svc=Demo r=1 c=app] r1-part-B\n',
    ]);
  });
});
