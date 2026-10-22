import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ResolvedDistribution } from '../../../src/local/cloudfront-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// go-to-k/cdk-local#761 (S3): an assembly-chosen identifier renders bare when
// plain and as ONE JSON string literal when it could forge a boundary. Expected
// strings are hand-written, never computed through the display helper. The
// ready banner `(logicalId)` suffix lives in the command body (full boot with a
// server socket) and is covered only by the source line, not here.

vi.mock('../../../src/local/lambda-resolver.js', () => ({
  resolveLambdaTarget: vi.fn(() => {
    throw new Error('boom');
  }),
}));

const { bootLambdaUrlOrigins, bootLambdaEdgeFunctions, warnUnsupported, normalizeKvsFileKeys } =
  await import('../../../src/cli/commands/local-start-cloudfront.js');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function captureWarns(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' ').replace(ANSI, '').replace(/^WARN: /, ''));
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return out;
}

function dist(over: Partial<ResolvedDistribution>): ResolvedDistribution {
  return {
    logicalId: 'Dist',
    stackName: 'Stack',
    behaviors: [],
    origins: new Map(),
    customErrorResponses: [],
    ...over,
  } as ResolvedDistribution;
}

const stacks: StackInfo[] = [
  { stackName: 'Stack', displayName: 'Stack', artifactId: 'Stack', template: {}, dependencyNames: [] },
];
const bootOpts = { containerHost: '127.0.0.1', skipPull: false, envOptions: {} };

describe('start-cloudfront renders origin ids and function logical ids (#761)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('custom origin warn: plain and forging', () => {
    const warns = captureWarns();
    const mk = (originId: string) =>
      dist({
        origins: new Map([[originId, { kind: 'custom', originId, domainName: 'api.example.com' } as never]]),
      });
    warnUnsupported(mk('o1'));
    warnUnsupported(mk("o' 1"));
    expect(warns[0]).toMatch(
      /^Origin o1 is a custom \(non-S3, non-Lambda-Function-URL\) origin \(api\.example\.com\); /
    );
    expect(warns[1]).toMatch(
      /^Origin "o' 1" is a custom \(non-S3, non-Lambda-Function-URL\) origin \(api\.example\.com\); /
    );
  });

  it('unresolved S3 origin warn: plain and forging', () => {
    const warns = captureWarns();
    const mk = (originId: string) =>
      dist({ origins: new Map([[originId, { kind: 's3-unresolved', originId } as never]]) });
    warnUnsupported(mk('o1'));
    warnUnsupported(mk('o\u001b[2K1'));
    expect(warns[0]).toMatch(/^Origin o1 is an S3 origin with no resolvable local source /);
    expect(warns[1]).toMatch(/^Origin "o \[2K1" is an S3 origin with no resolvable local source /);
  });

  it('Function URL origin boot failure: plain and forging', async () => {
    const mk = (functionLogicalId: string) =>
      dist({
        origins: new Map([
          ['a', { kind: 'lambda-url', originId: 'a', functionLogicalId, functionUrlLogicalId: 'U' } as never],
        ]),
      });
    await expect(bootLambdaUrlOrigins(mk('Fn'), stacks, bootOpts)).rejects.toThrow(
      "Failed to boot the Lambda Function URL origin's backing function Fn: boom"
    );
    await expect(bootLambdaUrlOrigins(mk("F' n"), stacks, bootOpts)).rejects.toThrow(
      `Failed to boot the Lambda Function URL origin's backing function "F' n": boom`
    );
  });

  it('Lambda@Edge boot failure warn: plain and forging', async () => {
    const warns = captureWarns();
    const mk = (functionLogicalId: string) =>
      dist({
        behaviors: [{ lambdaEdge: { viewerRequest: { functionLogicalId } } } as never],
      });
    await bootLambdaEdgeFunctions(mk('Fn'), stacks, bootOpts);
    await bootLambdaEdgeFunctions(mk("F' n"), stacks, bootOpts);
    expect(warns[0]).toBe('Could not boot Lambda@Edge function Fn; its stage will be skipped: boom');
    expect(warns[1]).toBe(
      `Could not boot Lambda@Edge function "F' n"; its stage will be skipped: boom`
    );
  });

  it('--kvs-file candidates list renders the construct path', () => {
    const tpl = (cdkPath: string) =>
      ({
        Resources: {
          Kvs1: {
            Type: 'AWS::CloudFront::KeyValueStore',
            Metadata: { 'aws:cdk:path': cdkPath },
          },
        },
      }) as never;
    const msgOf = (cdkPath: string): string => {
      try {
        normalizeKvsFileKeys(new Map([['nope', 'f.json']]), tpl(cdkPath));
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('expected a throw');
    };
    expect(msgOf('Stack/Store/Resource')).toContain('Candidates: Kvs1 (Stack/Store).');
    expect(msgOf("Stack/St' ore/Resource")).toContain(`Candidates: Kvs1 ("Stack/St' ore").`);
  });
});
