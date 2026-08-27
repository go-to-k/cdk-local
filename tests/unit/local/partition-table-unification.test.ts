import { describe, it, expect } from 'vite-plus/test';
import {
  PARTITION_TABLE,
  derivePartitionAndUrlSuffix,
  derivePseudoParametersFromRegion,
} from '../../../src/local/intrinsic-image.js';
import * as ecsTaskResolver from '../../../src/local/ecs-task-resolver.js';

/**
 * Issue #575 / go-to-k/cdkd#1821. cdk-local carried TWO independent
 * region -> partition tables: the one behind `derivePartitionAndUrlSuffix`
 * (completed to all eight partitions earlier on this branch) and a second
 * if/else chain inside `derivePseudoParametersFromRegion`, which knew four
 * and matched case-sensitively. The second one feeds `${AWS::Partition}` /
 * `${AWS::URLSuffix}` substitution and the `Fn::Join` ECR `Code.ImageUri`
 * reconstruction, so in `us-isof-` / `eu-isoe-` / `eusc-` regions it
 * synthesized `<acct>.dkr.ecr.<region>.amazonaws.com` — a host that does
 * not exist — and substituted `aws` into every ARN the resolver built.
 * Quiet, because the value is structurally valid.
 *
 * The fix is ONE table. The fence that makes a future divergence
 * IMPOSSIBLE rather than merely unlikely is the agreement suite below,
 * and it is driven off the exported `PARTITION_TABLE` — a list re-typed
 * here could not see a future row, which is exactly the vacuity that bit
 * commit 73765f7 on this branch.
 */

/** Uppercase a region the way a user typing `--region CN-NORTH-1` would. */
const shout = (region: string): string => region.toUpperCase();

describe('one partition authority (issue #575, go-to-k/cdkd#1821)', () => {
  it('ecs-task-resolver re-exports the SAME symbols, not a second copy', () => {
    // Identity, not deep equality: a re-introduced private table would be
    // deep-equal on the day it is written and drift later, which is the
    // whole history of this bug. `toBe` fails the day the copy appears.
    expect(ecsTaskResolver.PARTITION_TABLE).toBe(PARTITION_TABLE);
    expect(ecsTaskResolver.derivePartitionAndUrlSuffix).toBe(derivePartitionAndUrlSuffix);
  });

  it('both entry points agree for every row of the REAL table', () => {
    // Probe regions are GENERATED from the table, so a future row is
    // covered the moment it is added -- no test edit required.
    const probes = [
      ...PARTITION_TABLE.flatMap((row) => [`${row.regionPrefix}east-1`, `${row.regionPrefix}west-2`]),
      // Commercial fallback: not a table row, so it has to be listed.
      'us-east-1',
      'eu-west-2',
      'ap-northeast-1',
      'xy-somewhere-9',
    ];
    const disagreements = probes
      .map((region) => ({
        region,
        viaTable: derivePartitionAndUrlSuffix(region),
        viaPseudo: derivePseudoParametersFromRegion(region),
      }))
      .filter(
        ({ viaTable, viaPseudo }) =>
          viaPseudo?.partition !== viaTable.partition || viaPseudo?.urlSuffix !== viaTable.urlSuffix
      );
    expect(disagreements).toEqual([]);
    // Guard the guard: a filter over an empty probe list is vacuously green.
    expect(probes.length).toBe(PARTITION_TABLE.length * 2 + 4);
  });

  it('both entry points agree for every row when the region is UPPER-CASE', () => {
    const disagreements = PARTITION_TABLE.map((row) => shout(`${row.regionPrefix}east-1`))
      .map((region) => ({
        region,
        viaTable: derivePartitionAndUrlSuffix(region),
        viaPseudo: derivePseudoParametersFromRegion(region),
      }))
      .filter(
        ({ viaTable, viaPseudo }) =>
          viaPseudo?.partition !== viaTable.partition || viaPseudo?.urlSuffix !== viaTable.urlSuffix
      );
    expect(disagreements).toEqual([]);
  });
});

describe('derivePseudoParametersFromRegion — all eight partitions', () => {
  const canonical: Array<{ region: string; partition: string; urlSuffix: string }> = [
    { region: 'us-east-1', partition: 'aws', urlSuffix: 'amazonaws.com' },
    { region: 'ap-northeast-1', partition: 'aws', urlSuffix: 'amazonaws.com' },
    { region: 'cn-north-1', partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' },
    { region: 'us-gov-west-1', partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' },
    { region: 'us-iso-east-1', partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' },
    { region: 'us-isob-east-1', partition: 'aws-iso-b', urlSuffix: 'sc2s.sgov.gov' },
    { region: 'us-isof-south-1', partition: 'aws-iso-f', urlSuffix: 'csp.hci.ic.gov' },
    { region: 'eu-isoe-west-1', partition: 'aws-iso-e', urlSuffix: 'cloud.adc-e.uk' },
    { region: 'eusc-de-east-1', partition: 'aws-eusc', urlSuffix: 'amazonaws.eu' },
  ];

  for (const { region, partition, urlSuffix } of canonical) {
    it(`resolves ${region} to ${partition} / ${urlSuffix}`, () => {
      expect(derivePseudoParametersFromRegion(region)).toEqual({ region, partition, urlSuffix });
    });
  }

  it('covers all eight partitions', () => {
    expect(new Set(canonical.map((r) => r.partition)).size).toBe(8);
  });

  it('exercises every row of the REAL table, so a future row forces a case here', () => {
    // The canonical list above is hand-written on purpose (a generated
    // region would assert the implementation against itself), so this
    // pairs it with the real table: a row nothing here covers is named.
    const uncovered = PARTITION_TABLE.filter(
      (row) => !canonical.some((c) => c.region.startsWith(row.regionPrefix))
    ).map((row) => row.regionPrefix);
    expect(uncovered).toEqual([]);
  });

  it('falls back to the commercial partition for an unknown region', () => {
    expect(derivePseudoParametersFromRegion('xy-somewhere-9')).toEqual({
      region: 'xy-somewhere-9',
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
  });

  it('returns undefined for undefined / empty region', () => {
    expect(derivePseudoParametersFromRegion(undefined)).toBeUndefined();
    expect(derivePseudoParametersFromRegion('')).toBeUndefined();
  });

  it('passes accountId through when supplied, and omits the field otherwise', () => {
    expect(derivePseudoParametersFromRegion('eusc-de-east-1', '123456789012')).toEqual({
      accountId: '123456789012',
      region: 'eusc-de-east-1',
      partition: 'aws-eusc',
      urlSuffix: 'amazonaws.eu',
    });
    expect(derivePseudoParametersFromRegion('eusc-de-east-1')).not.toHaveProperty('accountId');
  });
});

describe('derivePseudoParametersFromRegion — case asymmetry is deliberate', () => {
  /**
   * Matching is case-INSENSITIVE (delegation lower-cases), the returned
   * `region` is VERBATIM. Both halves are pinned, because the tempting
   * "tidy-up" is to lower-case the returned value too -- and that would
   * change what `${AWS::Region}` substitutes into templates, a separate
   * behaviour change tracked in go-to-k/cdkd#1831.
   */
  it('resolves the right partition from an upper-case region', () => {
    expect(derivePseudoParametersFromRegion('CN-NORTH-1')).toEqual({
      region: 'CN-NORTH-1',
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
    });
  });

  it('returns the region byte-identical to the input for every row of the REAL table', () => {
    const mangled = PARTITION_TABLE.map((row) => shout(`${row.regionPrefix}east-1`))
      .map((region) => ({ region, returned: derivePseudoParametersFromRegion(region)?.region }))
      .filter(({ region, returned }) => returned !== region);
    expect(mangled).toEqual([]);
  });

  it('a mixed-case region keeps its casing while still resolving non-commercially', () => {
    expect(derivePseudoParametersFromRegion('Us-IsoF-South-1')).toEqual({
      region: 'Us-IsoF-South-1',
      partition: 'aws-iso-f',
      urlSuffix: 'csp.hci.ic.gov',
    });
  });
});
