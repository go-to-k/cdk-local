import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type {
  CloudFrontKvsAssociation,
  CompiledCloudFrontFunction,
} from '../../../src/local/cloudfront-function-runtime.js';
import type { ResolvedBehavior, ResolvedDistribution } from '../../../src/local/cloudfront-resolver.js';

// Mock the deployed client so the binding orchestration is tested without the
// AWS SDK; the fake source records the ARN it was built with.
const { deployedFactoryMock } = vi.hoisted(() => ({ deployedFactoryMock: vi.fn() }));
vi.mock('../../../src/local/cloudfront-kvs-client.js', () => ({
  createDeployedKvsDataSource: deployedFactoryMock,
}));

const { resolveKvsModulesForDistribution, idFromArn } = await import(
  '../../../src/local/cloudfront-kvs-binding.js'
);

function fn(
  logicalId: string,
  kvsAssociations: CloudFrontKvsAssociation[]
): CompiledCloudFrontFunction {
  return { logicalId, runtime: 'cloudfront-js-2.0', script: undefined as never, kvsAssociations };
}

function distWith(...functions: CompiledCloudFrontFunction[]): ResolvedDistribution {
  const behaviors: ResolvedBehavior[] = functions.map((f) => ({
    targetOriginId: 'O',
    viewerRequest: f as never,
  }));
  return {
    logicalId: 'Dist',
    stackName: 'Stack',
    behaviors,
    origins: new Map(),
    customErrorResponses: [],
  };
}

describe('resolveKvsModulesForDistribution', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkl-kvsbind-'));
    writeFileSync(join(dir, 'kvs.json'), JSON.stringify({ k: 'from-file' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    deployedFactoryMock.mockReset();
    deployedFactoryMock.mockImplementation((opts: { kvsArn: string }) => ({
      label: `deployed:${opts.kvsArn}`,
      getValue: () => Promise.resolve('from-deployed'),
    }));
  });

  it('a --kvs-file map wins over the deployed store', async () => {
    const f = fn('RewriteFn', [{ arnValue: { Ref: 'MyKvs' }, kvsLogicalId: 'MyKvs' }]);
    const dist = distWith(f);
    const resolveDeployedKvs = vi.fn();
    const { warnings } = await resolveKvsModulesForDistribution(dist, {
      kvsFiles: new Map([['MyKvs', join(dir, 'kvs.json')]]),
      resolveDeployedKvs,
    });
    expect(warnings).toEqual([]);
    expect(resolveDeployedKvs).not.toHaveBeenCalled();
    expect(deployedFactoryMock).not.toHaveBeenCalled();
    expect(await f.cloudfrontModule!.kvs().get('k')).toBe('from-file');
  });

  it('resolves the deployed store via the callback when no --kvs-file covers it', async () => {
    const f = fn('RewriteFn', [{ arnValue: { Ref: 'MyKvs' }, kvsLogicalId: 'MyKvs' }]);
    const resolveDeployedKvs = vi
      .fn()
      .mockResolvedValue({ arn: 'arn:aws:cloudfront::1:key-value-store/uuid', id: 'uuid' });
    const { warnings } = await resolveKvsModulesForDistribution(distWith(f), { resolveDeployedKvs });
    expect(warnings).toEqual([]);
    expect(resolveDeployedKvs).toHaveBeenCalledWith('MyKvs');
    expect(deployedFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ kvsArn: 'arn:aws:cloudfront::1:key-value-store/uuid', kvsId: 'uuid' })
    );
    expect(await f.cloudfrontModule!.kvs().get('k')).toBe('from-deployed');
  });

  it('uses a literal-ARN association directly', async () => {
    const arn = 'arn:aws:cloudfront::9:key-value-store/literal-id';
    const f = fn('RewriteFn', [{ arnValue: arn }]);
    await resolveKvsModulesForDistribution(distWith(f), { resolveDeployedKvs: vi.fn() });
    expect(deployedFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ kvsArn: arn, kvsId: 'literal-id' })
    );
  });

  it('warns + leaves the module unbound when nothing resolves', async () => {
    const f = fn('RewriteFn', [{ arnValue: { Ref: 'MyKvs' }, kvsLogicalId: 'MyKvs' }]);
    const { warnings } = await resolveKvsModulesForDistribution(distWith(f), {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/--from-cfn-stack/);
    expect(warnings[0]).toMatch(/--kvs-file MyKvs=/);
    expect(f.cloudfrontModule).toBeUndefined();
  });

  it('clears a previously-bound module when a reload loses the binding', async () => {
    const f = fn('RewriteFn', [{ arnValue: { Ref: 'MyKvs' }, kvsLogicalId: 'MyKvs' }]);
    f.cloudfrontModule = { kvs: () => ({}) as never };
    await resolveKvsModulesForDistribution(distWith(f), {});
    expect(f.cloudfrontModule).toBeUndefined();
  });

  it('builds one source per association for a multi-KVS function (id-matched)', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ k: 'from-a' }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ k: 'from-b' }));
    const f = fn('MultiFn', [
      { arnValue: { Ref: 'KvsA' }, kvsLogicalId: 'KvsA' },
      { arnValue: { Ref: 'KvsB' }, kvsLogicalId: 'KvsB' },
    ]);
    const { warnings } = await resolveKvsModulesForDistribution(distWith(f), {
      kvsFiles: new Map([
        ['KvsA', join(dir, 'a.json')],
        ['KvsB', join(dir, 'b.json')],
      ]),
    });
    expect(warnings).toEqual([]);
    // cf.kvs(<id>) selects the matching store (the file source's id is its key).
    expect(await f.cloudfrontModule!.kvs('KvsA').get('k')).toBe('from-a');
    expect(await f.cloudfrontModule!.kvs('KvsB').get('k')).toBe('from-b');
  });

  it('rebinds a function to a NEW source on a subsequent reload', async () => {
    writeFileSync(join(dir, 'v1.json'), JSON.stringify({ k: 'v1' }));
    writeFileSync(join(dir, 'v2.json'), JSON.stringify({ k: 'v2' }));
    const f = fn('ReloadFn', [{ arnValue: { Ref: 'MyKvs' }, kvsLogicalId: 'MyKvs' }]);
    const dist = distWith(f);
    await resolveKvsModulesForDistribution(dist, {
      kvsFiles: new Map([['MyKvs', join(dir, 'v1.json')]]),
    });
    expect(await f.cloudfrontModule!.kvs().get('k')).toBe('v1');
    // Simulate a --watch reload that points the same store at a new file.
    await resolveKvsModulesForDistribution(dist, {
      kvsFiles: new Map([['MyKvs', join(dir, 'v2.json')]]),
    });
    expect(await f.cloudfrontModule!.kvs().get('k')).toBe('v2');
  });

  it('resolves each unique function once even when shared across behaviors', async () => {
    const f = fn('Shared', [{ arnValue: { Ref: 'MyKvs' }, kvsLogicalId: 'MyKvs' }]);
    const dist: ResolvedDistribution = {
      logicalId: 'Dist',
      stackName: 'Stack',
      behaviors: [
        { targetOriginId: 'O', viewerRequest: f as never },
        { targetOriginId: 'O', viewerResponse: f as never },
      ],
      origins: new Map(),
      customErrorResponses: [],
    };
    const resolveDeployedKvs = vi
      .fn()
      .mockResolvedValue({ arn: 'arn:aws:cloudfront::1:key-value-store/u', id: 'u' });
    await resolveKvsModulesForDistribution(dist, { resolveDeployedKvs });
    expect(resolveDeployedKvs).toHaveBeenCalledTimes(1);
  });
});

describe('idFromArn', () => {
  it('returns the last /-segment', () => {
    expect(idFromArn('arn:aws:cloudfront::1:key-value-store/abc-123')).toBe('abc-123');
  });
  it('returns undefined when there is no segment', () => {
    expect(idFromArn('arn:aws:cloudfront::1:key-value-store/')).toBeUndefined();
    expect(idFromArn('no-slash')).toBeUndefined();
  });
});
