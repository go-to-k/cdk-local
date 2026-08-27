import { describe, it, expect } from 'vite-plus/test';
import { parseLayerVersionArn, resolveLambdaLayers } from '../../../src/local/lambda-resolver.js';
import {
  derivePartitionAndUrlSuffix,
  PARTITION_TABLE,
} from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * Issue #575. `parseLayerVersionArn` is a CLASSIFIER (an ARN string in,
 * accept / reject plus parsed fields out), so hand-picked positive cases
 * cannot fence it — a pattern widened until it accepts everything
 * satisfies every positive assertion. The fence here is DIFFERENTIAL:
 * the pre-fix implementation and the current one are run over a
 * generated input space, and every cell where they disagree must fall
 * into an enumerated intended class, judged by the VALUE the current
 * implementation returned rather than by which input produced it.
 */

interface ParsedLayerArn {
  arn: string;
  region: string;
  accountId: string;
  name: string;
  version: string;
}

/**
 * The PRE-FIX `parseLayerVersionArn`, transcribed verbatim from
 * `git show origin/main:src/local/lambda-resolver.ts` (the regex is the
 * one this branch replaces). Kept whole rather than reduced to its
 * regex so the differential compares two functions of the same shape.
 */
function parseLayerVersionArnPreFix(input: string): ParsedLayerArn | undefined {
  const m =
    /^arn:(aws|aws-cn|aws-us-gov):lambda:([a-z]{2}-(?:[a-z]+-){1,2}\d+):(\d{12}):layer:([A-Za-z0-9_-]+):(\d+)$/.exec(
      input
    );
  if (!m) return undefined;
  return {
    arn: input,
    region: m[2]!,
    accountId: m[3]!,
    name: m[4]!,
    version: m[5]!,
  };
}

// ---------------------------------------------------------------------------
// Independent oracle. Deliberately NOT the implementation's regex: it
// segments the ARN by `:` and checks each field on its own terms, so an
// implementation that widened its pattern is judged by what a layer ARN
// actually is rather than by what it chose to match.
// ---------------------------------------------------------------------------

const REGION_SHAPE = /^[a-z]{2,}(?:-[a-z]+)+-\d+$/;

/** Reasons the returned value is NOT a legitimate parse of `input`. */
function violationsForAccepted(input: string, value: ParsedLayerArn): string[] {
  const v: string[] = [];
  const parts = input.split(':');
  if (parts.length !== 8) {
    return [`accepted an ARN with ${parts.length} segments (expected 8)`];
  }
  const [arnLiteral, partition, service, region, account, layerLiteral, name, version] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (arnLiteral !== 'arn') v.push(`accepted a non-'arn' first segment '${arnLiteral}'`);
  if (service !== 'lambda') v.push(`accepted a non-'lambda' service segment '${service}'`);
  if (layerLiteral !== 'layer') v.push(`accepted a non-'layer' resource segment '${layerLiteral}'`);
  if (!/^aws(?:-[a-z]+)*$/.test(partition)) v.push(`accepted a bogus partition '${partition}'`);
  if (!REGION_SHAPE.test(region)) v.push(`accepted a non-region-shaped segment '${region}'`);
  if (!/^\d{12}$/.test(account)) v.push(`accepted a non-12-digit account '${account}'`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) v.push(`accepted an illegal layer name '${name}'`);
  if (!/^\d+$/.test(version)) v.push(`accepted a non-numeric version '${version}'`);
  if (derivePartitionAndUrlSuffix(region).partition !== partition) {
    v.push(`accepted partition '${partition}' paired with region '${region}'`);
  }
  // Field mapping: the returned segments must be the ones in the input.
  if (value.arn !== input) v.push(`arn field '${value.arn}' !== input`);
  if (value.region !== region) v.push(`region field '${value.region}' !== '${region}'`);
  if (value.accountId !== account) v.push(`accountId field '${value.accountId}' !== '${account}'`);
  if (value.name !== name) v.push(`name field '${value.name}' !== '${name}'`);
  if (value.version !== version) v.push(`version field '${value.version}' !== '${version}'`);
  return v;
}

/**
 * Reasons rejecting `input` is NOT legitimate. Only reached for inputs
 * the PRE-FIX implementation accepted, so the shape is already known
 * good; the one sanctioned reason to newly reject is that the partition
 * segment disagrees with the region's partition.
 */
function violationsForNewlyRejected(input: string): string[] {
  const parts = input.split(':');
  const partition = parts[1] ?? '';
  const region = parts[3] ?? '';
  if (derivePartitionAndUrlSuffix(region).partition === partition) {
    return [`rejected the self-consistent, well-formed ARN '${input}'`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Generated input space: 8 real partitions (plus bogus ones) x region
// shapes (real, per-partition, and malformed) x account / name / version
// variants, plus structural mutations of a canonical ARN.
// ---------------------------------------------------------------------------

const PARTITIONS = [
  'aws',
  'aws-cn',
  'aws-us-gov',
  'aws-iso',
  'aws-iso-b',
  'aws-iso-e',
  'aws-iso-f',
  'aws-eusc',
  'aws-bogus',
  'notaws',
  '',
];

const REGIONS = [
  // commercial
  'us-east-1',
  'eu-west-3',
  'ap-southeast-4',
  'ca-central-1',
  // non-commercial, one or more per partition
  'cn-north-1',
  'cn-northwest-1',
  'us-gov-west-1',
  'us-gov-east-1',
  'us-iso-east-1',
  'us-iso-west-1',
  'us-isob-east-1',
  'us-isof-south-1',
  'us-isof-east-1',
  'eu-isoe-west-1',
  'eusc-de-east-1',
  // shape probes
  'ap-southeast-new-extra-1',
  'garbage',
  'us-east',
  'useast1',
  'US-EAST-1',
  'us--east-1',
  'us-east-',
  '-us-east-1',
  'us-east-1a',
  '',
];

const ACCOUNTS = ['123456789012', '000000000000', '12345678901', '1234567890123', 'abcdefghijkl', ''];
const NAMES = ['my-layer', 'Powertools_Python', 'AWSLambdaPowertoolsPythonV2', 'bad name', 'has:colon', ''];
const VERSIONS = ['1', '42', '007', 'x', '1a', ''];

/** Structural mutations of a well-formed ARN — prefix / suffix / segment damage. */
function structuralVariants(arn: string): string[] {
  return [
    arn.toUpperCase(),
    ` ${arn}`,
    `${arn} `,
    arn.replace('arn:', 'ARN:'),
    arn.replace(':lambda:', ':lamba:'),
    arn.replace(':layer:', ':layers:'),
    `${arn}:extra`,
    arn.slice(0, -2),
    arn.replace('arn:', ''),
    `prefix${arn}`,
    arn.replace(/:/g, '/'),
  ];
}

function buildInputSpace(): string[] {
  const out: string[] = [];
  for (const partition of PARTITIONS) {
    for (const region of REGIONS) {
      for (const account of ACCOUNTS) {
        for (const name of NAMES) {
          for (const version of VERSIONS) {
            out.push(`arn:${partition}:lambda:${region}:${account}:layer:${name}:${version}`);
          }
        }
      }
    }
    out.push(
      ...structuralVariants(`arn:${partition}:lambda:us-east-1:123456789012:layer:my-layer:1`)
    );
  }
  return out;
}

/**
 * The intended sub-reasons a cell may be NEWLY ACCEPTED — the three
 * independent bounds the pre-fix regex carried. Used ONLY to tally
 * floors, never to excuse a violation (that is judged by
 * `violationsForAccepted` on the returned value alone). A cell may hit
 * more than one: `arn:aws-eusc:...:eusc-de-east-1:...` is both a
 * partition the alternation omitted AND a region shape it rejected, and
 * today no input separates them since `eusc-` is that partition's only
 * region prefix.
 */
function newlyAcceptedReasons(input: string): string[] {
  const parts = input.split(':');
  const partition = parts[1]!;
  const region = parts[3]!;
  const reasons: string[] = [];
  if (partition !== 'aws' && partition !== 'aws-cn' && partition !== 'aws-us-gov') {
    reasons.push(`partition:${partition}`);
  }
  if (!/^[a-z]{2}-/.test(region)) reasons.push('region-shape:first-token-longer-than-two');
  // Interior `<word>-` chunks: everything between the first token and
  // the numeric suffix. The pre-fix regex capped this at two.
  const regionParts = region.split('-');
  if (regionParts.length - 2 > 2) reasons.push('region-shape:extra-interior-chunks');
  return reasons;
}

describe('parseLayerVersionArn — differential fence against the pre-fix regex (issue #575)', () => {
  const inputs = buildInputSpace();

  it('every disagreement with the pre-fix implementation falls in an intended class', () => {
    const violations: string[] = [];
    const newlyAccepted: string[] = [];
    const newlyRejected: string[] = [];
    let sameAccept = 0;
    let sameReject = 0;
    const acceptedReasonTally = new Map<string, number>();
    const sameAcceptPartitions = new Set<string>();

    for (const input of inputs) {
      const before = parseLayerVersionArnPreFix(input);
      const after = parseLayerVersionArn(input);

      if (before && after) {
        sameAccept++;
        sameAcceptPartitions.add(input.split(':')[1]!);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          violations.push(
            `divergent parse for '${input}': ${JSON.stringify(before)} vs ${JSON.stringify(after)}`
          );
        }
        continue;
      }
      if (!before && !after) {
        sameReject++;
        continue;
      }
      if (after) {
        // Class 1: newly accepted. Judged by the RETURNED VALUE.
        const v = violationsForAccepted(input, after);
        if (v.length > 0) {
          violations.push(`${input}: ${v.join('; ')}`);
        } else {
          const reasons = newlyAcceptedReasons(input);
          if (reasons.length === 0) {
            violations.push(`${input}: newly accepted for no enumerated reason`);
          } else {
            newlyAccepted.push(input);
            for (const reason of reasons) {
              acceptedReasonTally.set(reason, (acceptedReasonTally.get(reason) ?? 0) + 1);
            }
          }
        }
        continue;
      }
      // Class 2: newly rejected. Judged by whether rejecting is legitimate.
      const v = violationsForNewlyRejected(input);
      if (v.length > 0) violations.push(`${input}: ${v.join('; ')}`);
      else newlyRejected.push(input);
    }

    expect(violations.slice(0, 20)).toEqual([]);

    // Floors — a pool that stops covering a class must not read as
    // "no regressions". Each intended repair has to be REACHED.
    for (const partition of ['aws-iso', 'aws-iso-b', 'aws-iso-e', 'aws-iso-f', 'aws-eusc']) {
      expect(
        acceptedReasonTally.get(`partition:${partition}`) ?? 0,
        `no newly-accepted cell for partition '${partition}'`
      ).toBeGreaterThan(0);
    }
    expect(
      acceptedReasonTally.get('region-shape:first-token-longer-than-two') ?? 0,
      "no newly-accepted cell for a region whose first token is longer than two letters (eusc-de-east-1)"
    ).toBeGreaterThan(0);
    expect(
      acceptedReasonTally.get('region-shape:extra-interior-chunks') ?? 0,
      'no newly-accepted cell for a region with more than two interior chunks'
    ).toBeGreaterThan(0);
    expect(newlyRejected.length, 'no newly-rejected cell (mismatched partition/region)').toBeGreaterThan(0);

    // The commercial + two previously-known partitions must still parse
    // exactly as before — the direction a total regression would break.
    expect(sameAccept).toBeGreaterThan(0);
    expect([...sameAcceptPartitions].sort()).toEqual(['aws', 'aws-cn', 'aws-us-gov']);
    expect(sameReject).toBeGreaterThan(0);
  });

  it('rejects the self-inconsistent pair the pre-fix regex accepted', () => {
    const mismatched = 'arn:aws-cn:lambda:us-east-1:123456789012:layer:my-layer:1';
    expect(parseLayerVersionArnPreFix(mismatched)).toBeDefined();
    expect(parseLayerVersionArn(mismatched)).toBeUndefined();
  });

  it('still rejects a non-region-shaped segment (the commercial fallback is not a hole)', () => {
    expect(
      parseLayerVersionArn('arn:aws:lambda:garbage:123456789012:layer:my-layer:1')
    ).toBeUndefined();
  });

  it('accepts a region the partition table has never heard of, as commercial', () => {
    const parsed = parseLayerVersionArn(
      'arn:aws:lambda:xy-somewhere-9:123456789012:layer:my-layer:3'
    );
    expect(parsed?.region).toBe('xy-somewhere-9');
    expect(parsed?.version).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// The caller: `resolveLambdaLayers` hard-throws on a parse miss, so the
// user-visible symptom of the pre-fix regex was `cdkl invoke` failing
// outright in five of eight partitions.
// ---------------------------------------------------------------------------

function makeStackWithLayerArn(arn: string): { stack: StackInfo; props: Record<string, unknown> } {
  const props = { Runtime: 'nodejs20.x', Handler: 'index.handler', Layers: [arn] };
  const template: CloudFormationTemplate = {
    Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: props } },
  };
  return {
    stack: {
      stackName: 'TestStack',
      displayName: 'TestStack',
      artifactId: 'TestStack',
      template,
      dependencyNames: [],
    },
    props,
  };
}

describe('resolveLambdaLayers — literal layer ARNs resolve in every partition (issue #575)', () => {
  const cases: Array<{ partition: string; region: string }> = [
    { partition: 'aws', region: 'us-east-1' },
    { partition: 'aws-cn', region: 'cn-north-1' },
    { partition: 'aws-us-gov', region: 'us-gov-west-1' },
    { partition: 'aws-iso', region: 'us-iso-east-1' },
    { partition: 'aws-iso-b', region: 'us-isob-east-1' },
    { partition: 'aws-iso-e', region: 'eu-isoe-west-1' },
    { partition: 'aws-iso-f', region: 'us-isof-south-1' },
    { partition: 'aws-eusc', region: 'eusc-de-east-1' },
  ];

  for (const { partition, region } of cases) {
    it(`resolves a ${partition} layer ARN without throwing`, () => {
      const arn = `arn:${partition}:lambda:${region}:123456789012:layer:AWSLambdaPowertoolsPythonV2:4`;
      const { stack, props } = makeStackWithLayerArn(arn);
      expect(resolveLambdaLayers(stack, 'Fn', props)).toEqual([
        {
          kind: 'arn',
          logicalId: arn,
          arn,
          region,
          accountId: '123456789012',
          name: 'AWSLambdaPowertoolsPythonV2',
          version: '4',
        },
      ]);
    });
  }

  it('still throws for a partition/region pair that cannot be reconciled', () => {
    const { stack, props } = makeStackWithLayerArn(
      'arn:aws-cn:lambda:us-east-1:123456789012:layer:my-layer:1'
    );
    expect(() => resolveLambdaLayers(stack, 'Fn', props)).toThrow(/cannot resolve locally/);
  });

  it('still throws for a literal string that is not a layer ARN at all', () => {
    const { stack, props } = makeStackWithLayerArn('not-an-arn');
    expect(() => resolveLambdaLayers(stack, 'Fn', props)).toThrow(/cannot resolve locally/);
  });
});

// ---------------------------------------------------------------------------
// The partition table itself.
// ---------------------------------------------------------------------------

describe('derivePartitionAndUrlSuffix — all eight partitions (issue #575)', () => {
  const table: Array<{ region: string; partition: string; urlSuffix: string }> = [
    { region: 'us-east-1', partition: 'aws', urlSuffix: 'amazonaws.com' },
    { region: 'eu-west-3', partition: 'aws', urlSuffix: 'amazonaws.com' },
    { region: 'cn-north-1', partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' },
    { region: 'cn-northwest-1', partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' },
    { region: 'us-gov-west-1', partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' },
    { region: 'us-gov-east-1', partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' },
    { region: 'us-iso-east-1', partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' },
    { region: 'us-iso-west-1', partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' },
    { region: 'us-isob-east-1', partition: 'aws-iso-b', urlSuffix: 'sc2s.sgov.gov' },
    { region: 'eu-isoe-west-1', partition: 'aws-iso-e', urlSuffix: 'cloud.adc-e.uk' },
    { region: 'us-isof-south-1', partition: 'aws-iso-f', urlSuffix: 'csp.hci.ic.gov' },
    { region: 'us-isof-east-1', partition: 'aws-iso-f', urlSuffix: 'csp.hci.ic.gov' },
    { region: 'eusc-de-east-1', partition: 'aws-eusc', urlSuffix: 'amazonaws.eu' },
  ];

  for (const { region, partition, urlSuffix } of table) {
    it(`maps ${region} to ${partition} / ${urlSuffix}`, () => {
      expect(derivePartitionAndUrlSuffix(region)).toEqual({ partition, urlSuffix });
    });
  }

  it('covers all eight partitions', () => {
    expect(new Set(table.map((r) => r.partition)).size).toBe(8);
  });

  it('lower-cases the region before matching', () => {
    expect(derivePartitionAndUrlSuffix('CN-NORTH-1')).toEqual({
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
    });
    expect(derivePartitionAndUrlSuffix('US-Gov-West-1')).toEqual({
      partition: 'aws-us-gov',
      urlSuffix: 'amazonaws.com',
    });
    expect(derivePartitionAndUrlSuffix('EUSC-DE-EAST-1')).toEqual({
      partition: 'aws-eusc',
      urlSuffix: 'amazonaws.eu',
    });
  });

  it('falls back to the commercial partition for an unknown region', () => {
    expect(derivePartitionAndUrlSuffix('xy-somewhere-9')).toEqual({
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
    expect(derivePartitionAndUrlSuffix('')).toEqual({
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
  });

  it('resolves each us-iso* prefix to its own partition', () => {
    // NOT an ordering test, despite how it reads: no table prefix is a
    // prefix of another (`'us-isob-east-1'.startsWith('us-iso-')` is
    // false -- index 6 is `b`, not `-`), so these three pass under ANY
    // table order. The "most-specific first" ordering in the table is
    // defensive against a FUTURE row, and the assertion that actually
    // fences it is the no-shadowing check below.
    expect(derivePartitionAndUrlSuffix('us-iso-east-1').partition).toBe('aws-iso');
    expect(derivePartitionAndUrlSuffix('us-isob-east-1').partition).toBe('aws-iso-b');
    expect(derivePartitionAndUrlSuffix('us-isof-east-1').partition).toBe('aws-iso-f');
  });

  it('has no table prefix that shadows another, so no row is order-dependent', () => {
    // Iterates the REAL `PARTITION_TABLE`, not a list re-typed here: a
    // local copy would not see a future row, which is the only thing
    // the ordering claim needs fencing against. (The first draft of
    // this test read `regionPrefix` off the region/partition/urlSuffix
    // table above, a property that does not exist there, so it compared
    // `[undefined]` against itself and passed under ANY table -- test
    // files are excluded from `tsconfig.json`, so nothing typechecked
    // the property away.)
    const prefixes = [...new Set(PARTITION_TABLE.map((r) => r.regionPrefix))];
    const shadowing = prefixes.flatMap((a) =>
      prefixes.filter((b) => b !== a && b.startsWith(a)).map((b) => `${a} shadows ${b}`)
    );
    expect(shadowing).toEqual([]);
  });
});
