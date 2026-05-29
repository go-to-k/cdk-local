import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { zipSync, strToU8 } from 'fflate';
import { downloadAndExtractS3Bundle } from '../../../src/local/agentcore-s3-bundle.js';

/**
 * Drives the real extraction path against a real in-memory ZIP built with
 * fflate, fed through the injected `fetchObject` (no AWS / network). Only the
 * cleanup is async-awaited per test so no temp dirs leak.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c().catch(() => undefined)));
});

/** Build a ZIP byte array from a {path: contents} map. */
function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

function fetchReturning(bytes: Uint8Array): () => Promise<Uint8Array> {
  return async () => bytes;
}

describe('downloadAndExtractS3Bundle', () => {
  it('extracts every file (incl. nested dirs) to a temp dir', async () => {
    const bytes = zip({
      'app.py': 'print("hi")',
      'requirements.txt': 'bedrock-agentcore\n',
      'pkg/util.py': 'X = 1',
    });
    const bundle = await downloadAndExtractS3Bundle(
      { bucket: 'b', key: 'agent.zip' },
      { fetchObject: fetchReturning(bytes) }
    );
    cleanups.push(bundle.cleanup);

    expect(readFileSync(join(bundle.dir, 'app.py'), 'utf-8')).toBe('print("hi")');
    expect(readFileSync(join(bundle.dir, 'requirements.txt'), 'utf-8')).toBe('bedrock-agentcore\n');
    expect(readFileSync(join(bundle.dir, 'pkg', 'util.py'), 'utf-8')).toBe('X = 1');
  });

  it('passes the location to the injected fetcher', async () => {
    let seen: { bucket: string; key: string; versionId?: string } | undefined;
    const bundle = await downloadAndExtractS3Bundle(
      { bucket: 'my-bkt', key: 'k/agent.zip', versionId: 'v9' },
      {
        fetchObject: async (loc) => {
          seen = loc;
          return zip({ 'app.py': 'x' });
        },
      }
    );
    cleanups.push(bundle.cleanup);
    expect(seen).toEqual({ bucket: 'my-bkt', key: 'k/agent.zip', versionId: 'v9' });
  });

  it('cleanup() removes the temp dir', async () => {
    const bundle = await downloadAndExtractS3Bundle(
      { bucket: 'b', key: 'a.zip' },
      { fetchObject: fetchReturning(zip({ 'app.py': 'x' })) }
    );
    expect(existsSync(bundle.dir)).toBe(true);
    await bundle.cleanup();
    expect(existsSync(bundle.dir)).toBe(false);
  });

  it('rejects a zip-slip entry that escapes the target dir', async () => {
    const bytes = zip({ '../escape.txt': 'pwned', 'app.py': 'x' });
    await expect(
      downloadAndExtractS3Bundle({ bucket: 'b', key: 'a.zip' }, { fetchObject: fetchReturning(bytes) })
    ).rejects.toThrow(/escapes the target dir/);
  });

  it('throws when the bundle contains no files', async () => {
    // A zip with only a directory entry (no file content).
    const bytes = zip({ 'emptydir/': '' });
    await expect(
      downloadAndExtractS3Bundle({ bucket: 'b', key: 'a.zip' }, { fetchObject: fetchReturning(bytes) })
    ).rejects.toThrow(/contained no files/);
  });

  it('throws a clear error when the object is not a valid ZIP', async () => {
    const notZip = strToU8('this is not a zip archive');
    await expect(
      downloadAndExtractS3Bundle({ bucket: 'b', key: 'a.zip' }, { fetchObject: fetchReturning(notZip) })
    ).rejects.toThrow(/must be a ZIP archive/);
  });
});
