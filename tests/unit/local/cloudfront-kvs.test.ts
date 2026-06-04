import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createCloudFrontModule,
  createLocalFileKvsDataSource,
  createUnboundCloudFrontModule,
  type KvsDataSource,
} from '../../../src/local/cloudfront-kvs.js';

/** A trivial in-memory data source for shim tests. */
function fakeSource(map: Record<string, string>, kvsId?: string): KvsDataSource {
  return {
    label: `fake:${kvsId ?? 'x'}`,
    ...(kvsId !== undefined && { kvsId }),
    getValue: (key) => Promise.resolve(map[key]),
  };
}

describe('createCloudFrontModule', () => {
  it('get() returns the value for a present key', async () => {
    const cf = createCloudFrontModule([fakeSource({ greeting: 'hello' })]);
    expect(await cf.kvs().get('greeting')).toBe('hello');
  });

  it('get({ format: json }) parses the value', async () => {
    const cf = createCloudFrontModule([fakeSource({ cfg: '{"a":1}' })]);
    expect(await cf.kvs().get('cfg', { format: 'json' })).toEqual({ a: 1 });
  });

  it('get() rejects when the key is absent', async () => {
    const cf = createCloudFrontModule([fakeSource({})]);
    await expect(cf.kvs().get('missing')).rejects.toThrow(/key not found/);
  });

  it('get({ format: json }) rejects on invalid JSON', async () => {
    const cf = createCloudFrontModule([fakeSource({ k: 'not json' })]);
    await expect(cf.kvs().get('k', { format: 'json' })).rejects.toThrow(/not valid JSON/);
  });

  it('exists() reflects presence', async () => {
    const cf = createCloudFrontModule([fakeSource({ k: 'v' })]);
    expect(await cf.kvs().exists('k')).toBe(true);
    expect(await cf.kvs().exists('nope')).toBe(false);
  });

  it('meta() / count() reject as not reproduced locally', async () => {
    const cf = createCloudFrontModule([fakeSource({})]);
    await expect(cf.kvs().meta()).rejects.toThrow(/not reproduced locally/);
    await expect(cf.kvs().count()).rejects.toThrow(/not reproduced locally/);
  });

  it('kvs(id) selects the matching source by id', async () => {
    const cf = createCloudFrontModule([
      fakeSource({ k: 'a' }, 'store-a'),
      fakeSource({ k: 'b' }, 'store-b'),
    ]);
    expect(await cf.kvs('store-b').get('k')).toBe('b');
  });

  it('kvs(id) falls back to the sole source when only one is associated', async () => {
    const cf = createCloudFrontModule([fakeSource({ k: 'only' }, 'store-a')]);
    // A hardcoded id that does not match still resolves to the single store.
    expect(await cf.kvs('some-other-id').get('k')).toBe('only');
  });

  it('kvs(id) throws when multiple stores are associated and none matches', async () => {
    const cf = createCloudFrontModule([
      fakeSource({}, 'store-a'),
      fakeSource({}, 'store-b'),
    ]);
    expect(() => cf.kvs('store-c')).toThrow(/no associated KeyValueStore matches/);
  });

  it('kvs() throws when no store is associated', () => {
    const cf = createCloudFrontModule([]);
    expect(() => cf.kvs()).toThrow(/no KeyValueStore is associated/);
  });
});

describe('createUnboundCloudFrontModule', () => {
  it('returns a handle whose reads fail with actionable guidance', async () => {
    const cf = createUnboundCloudFrontModule('RewriteFn');
    // kvs() itself succeeds (so a top-level cf.kvs() does not crash at eval).
    const handle = cf.kvs();
    await expect(handle.get('k')).rejects.toThrow(/--from-cfn-stack/);
    await expect(handle.get('k')).rejects.toThrow(/--kvs-file/);
    await expect(handle.exists('k')).rejects.toThrow(/RewriteFn/);
  });
});

describe('createLocalFileKvsDataSource', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkl-kvs-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it('looks up keys from a flat JSON map', async () => {
    const src = createLocalFileKvsDataSource({
      id: 'MyKvs',
      filePath: write('ok.json', JSON.stringify({ a: '1', b: '2' })),
    });
    expect(src.kvsId).toBe('MyKvs');
    expect(await src.getValue('a')).toBe('1');
    expect(await src.getValue('missing')).toBeUndefined();
  });

  it('JSON-stringifies non-string values (KVS values are strings)', async () => {
    const src = createLocalFileKvsDataSource({
      id: 'K',
      filePath: write('mixed.json', JSON.stringify({ obj: { x: 1 }, n: 5 })),
    });
    expect(await src.getValue('obj')).toBe('{"x":1}');
    expect(await src.getValue('n')).toBe('5');
  });

  it('throws on a missing file', () => {
    expect(() =>
      createLocalFileKvsDataSource({ id: 'K', filePath: join(dir, 'nope.json') })
    ).toThrow(/could not read the file/);
  });

  it('throws on invalid JSON', () => {
    expect(() =>
      createLocalFileKvsDataSource({ id: 'K', filePath: write('bad.json', '{ not json') })
    ).toThrow(/not valid JSON/);
  });

  it('throws when the JSON is not an object', () => {
    expect(() =>
      createLocalFileKvsDataSource({ id: 'K', filePath: write('arr.json', '[1,2]') })
    ).toThrow(/expected a JSON object/);
  });
});
