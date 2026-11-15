import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { zipSync, strToU8 } from 'fflate';
import { downloadAndExtractS3Bundle } from '../../../src/local/agentcore-s3-bundle.js';
import { getLogger } from '../../../src/utils/logger.js';

// The DEFAULT fetcher's S3 client, for the relayed-failure tests below. The
// other tests inject `fetchObject` and never construct it.
const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn<() => Promise<unknown>>() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3Send;
    destroy(): void {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

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

describe('downloadAndExtractS3Bundle redactBucket (go-to-k/cdkd#6339)', () => {
  const BUCKET = 'bucket-from-a-producer-stack';

  async function run(bytes: Uint8Array, redactBucket: boolean | undefined) {
    const { getLogger } = await import('../../../src/utils/logger.js');
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    let error = '';
    let logged = '';
    try {
      const bundle = await downloadAndExtractS3Bundle(
        { bucket: BUCKET, key: 'agent.zip' },
        { fetchObject: fetchReturning(bytes), ...(redactBucket !== undefined && { redactBucket }) }
      );
      cleanups.push(bundle.cleanup);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      logged = info.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      info.mockRestore();
    }
    return { logged, error };
  }

  it.each([
    ['an unzip failure', strToU8('not a zip')],
    ['an empty bundle', zip({})],
  ])('names the bucket in neither the log nor the error on %s when set', async (_label, bytes) => {
    const { logged, error } = await run(bytes, true);
    expect(error).not.toBe('');
    expect(logged).toContain('s3://<cross-stack value withheld>/agent.zip');
    expect(error).toContain('s3://<cross-stack value withheld>/agent.zip');
    expect(`${logged}\n${error}`).not.toContain(BUCKET);
  });

  it('prints the bucket as before when unset', async () => {
    const { logged, error } = await run(strToU8('not a zip'), undefined);
    expect(logged).toContain(`s3://${BUCKET}/agent.zip`);
    expect(error).toContain(`s3://${BUCKET}/agent.zip`);
  });
});

describe('downloadAndExtractS3Bundle redactBucket on a relayed S3 failure (#984)', () => {
  const BUCKET = 'bucket-from-a-producer-stack';

  /** A modeled S3 exception, shaped as the SDK's `ServiceException` is. */
  function serviceException(name: string, message: string): Error {
    return Object.assign(new Error(message), {
      name,
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
  }

  function accessDenied(bucket: string): Error {
    return serviceException(
      'AccessDenied',
      `User: arn:aws:iam::123456789012:user/dev is not authorized to perform: s3:GetObject on resource: ` +
        `"arn:aws:s3:::${bucket}/agent.zip" because no identity-based policy allows the s3:GetObject action`
    );
  }

  function dnsFailure(host: string): Error {
    return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }

  async function run(failure: unknown, redactBucket: boolean | undefined, bucket = BUCKET) {
    s3Send.mockReset();
    s3Send.mockRejectedValue(failure);
    const debug = vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    let error = '';
    try {
      await downloadAndExtractS3Bundle(
        { bucket, key: 'agent.zip' },
        { region: 'us-east-1', ...(redactBucket !== undefined && { redactBucket }) }
      );
    } catch (err) {
      error = (err as Error).message;
    }
    const debugged = debug.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    debug.mockRestore();
    info.mockRestore();
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(error).toMatch(/^S3 GetObject for s3:\/\/.*\/agent\.zip failed: /);
    return { error, debugged };
  }

  it('withholds the bucket an AccessDenied names when set', async () => {
    const { error } = await run(accessDenied(BUCKET), true);
    expect(error).toContain('AccessDenied: User: arn:aws:iam::123456789012:user/dev');
    expect(error).toContain('"arn:aws:s3:::<cross-stack value withheld>/agent.zip"');
    expect(error).not.toContain(BUCKET);
  });

  it('relays the AccessDenied bucket as before when unset', async () => {
    const { error } = await run(accessDenied(BUCKET), undefined);
    expect(error).toContain(`"arn:aws:s3:::${BUCKET}/agent.zip"`);
  });

  it('withholds a bucket the 512-character cap would cut in two', async () => {
    // The bucket straddles the cap, so a replacement made after the cut would
    // find no whole occurrence and leave its prefix on the line.
    const failure = serviceException('AccessDenied', `${'x'.repeat(500)}${BUCKET} and more`);
    const { error } = await run(failure, true);
    expect(error).toContain(`${'x'.repeat(500)}<cross-stack`);
    expect(error).not.toContain(BUCKET.slice(0, 12));
  });

  it('withholds the bucket a DNS failure names on the debug line when set', async () => {
    const { error, debugged } = await run(dnsFailure(`${BUCKET}.s3.us-east-1.amazonaws.com`), true);
    expect(debugged).toContain(
      'getaddrinfo ENOTFOUND <cross-stack value withheld>.s3.us-east-1.amazonaws.com'
    );
    expect(`${error}\n${debugged}`).not.toContain(BUCKET);
  });

  it('logs the DNS failure host as before when unset', async () => {
    const { debugged } = await run(dnsFailure(`${BUCKET}.s3.us-east-1.amazonaws.com`), undefined);
    expect(debugged).toContain(`getaddrinfo ENOTFOUND ${BUCKET}.s3.us-east-1.amazonaws.com`);
  });

  it('withholds a case-folded and a percent-encoded spelling of the bucket', async () => {
    const bucket = 'My Bucket';
    const failure = dnsFailure(`my bucket.s3.amazonaws.com and /My%20Bucket/agent.zip`);
    const { debugged } = await run(failure, true, bucket);
    expect(debugged).toContain(
      '<cross-stack value withheld>.s3.amazonaws.com and /<cross-stack value withheld>/agent.zip'
    );
    expect(debugged.toLowerCase()).not.toContain('my bucket');
    expect(debugged).not.toContain('My%20Bucket');
  });

  it('replaces nothing for an empty bucket', async () => {
    const { error } = await run(accessDenied(''), true, '');
    const relayed = error.slice(error.indexOf(' failed: '));
    expect(relayed).toContain('"arn:aws:s3:::/agent.zip"');
    expect(relayed).not.toContain('withheld');
  });
});
