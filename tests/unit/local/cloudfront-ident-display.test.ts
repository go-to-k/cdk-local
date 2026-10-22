import { describe, expect, it, vi } from 'vite-plus/test';
import type {
  CloudFrontKvsAssociation,
  CompiledCloudFrontFunction,
} from '../../../src/local/cloudfront-function-runtime.js';
import type { ResolvedDistribution } from '../../../src/local/cloudfront-resolver.js';
import { compileCloudFrontFunction } from '../../../src/local/cloudfront-function-runtime.js';
import { createUnboundCloudFrontModule } from '../../../src/local/cloudfront-kvs.js';
import { resolveKvsModulesForDistribution } from '../../../src/local/cloudfront-kvs-binding.js';
import { resolveCloudFrontDistribution } from '../../../src/local/cloudfront-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const FORGED = 'a\' b';
const FORGED_RENDERED = '"a\' b"';
const CTRL = 'x\u001b[2Kforged';
const CTRL_RENDERED = '"x [2Kforged"';

function distWith(logicalId: string, kvs: CloudFrontKvsAssociation[]): ResolvedDistribution {
  const f = {
    logicalId,
    runtime: 'cloudfront-js-2.0',
    script: undefined as never,
    kvsAssociations: kvs,
  } as CompiledCloudFrontFunction;
  return {
    logicalId: 'Dist',
    stackName: 'Stack',
    behaviors: [{ targetOriginId: 'O', viewerRequest: f as never }],
    origins: new Map(),
    customErrorResponses: [],
  } as ResolvedDistribution;
}

describe('cloudfront identifier rendering (#761)', () => {
  it('kvs-binding warning: plain ids bare, forging ids as JSON literals', async () => {
    const run = async (fnId: string, ref: string) =>
      (
        await resolveKvsModulesForDistribution(
          distWith(fnId, [{ arnValue: { Ref: ref }, kvsLogicalId: ref }]),
          { kvsFiles: new Map(), resolveDeployedKvs: vi.fn().mockResolvedValue(undefined) }
        )
      ).warnings[0]!;
    expect(await run('Fn', 'Store')).toContain('CloudFront Function Fn reads KeyValueStore Store, but');
    expect(await run(FORGED, CTRL)).toContain(
      `CloudFront Function ${FORGED_RENDERED} reads KeyValueStore ${CTRL_RENDERED}, but`
    );
  });

  it('compile errors name the function: bare vs JSON literal', () => {
    const bad = (id: string): string => {
      try {
        compileCloudFrontFunction(id, 'var x = ;', 'cloudfront-js-2.0');
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    expect(bad('Fn')).toContain('CloudFront Function Fn failed to compile');
    expect(bad(FORGED)).toContain(`CloudFront Function ${FORGED_RENDERED} failed to compile`);
  });

  it('unbound kvs module error', async () => {
    await expect(createUnboundCloudFrontModule('Fn').kvs().get('k')).rejects.toThrow(
      'CloudFront Function Fn reads from a KeyValueStore'
    );
    await expect(createUnboundCloudFrontModule(CTRL).kvs().get('k')).rejects.toThrow(
      `CloudFront Function ${CTRL_RENDERED} reads from a KeyValueStore`
    );
  });

  it('resolver: not-a-distribution error', () => {
    const stack = (name: string): StackInfo =>
      ({ stackName: name, template: { Resources: { R: { Type: 'AWS::S3::Bucket' } } } }) as never;
    expect(() => resolveCloudFrontDistribution({ stack: stack('web'), logicalId: 'R' })).toThrow(
      /^Resource R in stack web is not an/
    );
    expect(() =>
      resolveCloudFrontDistribution({ stack: stack(FORGED), logicalId: 'R' })
    ).toThrow(`Resource R in stack ${FORGED_RENDERED} is not an`);
  });
});
