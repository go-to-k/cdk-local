import { describe, it, expect } from 'vite-plus/test';
import {
  ECR_REGISTRY_HOST_FORMS,
  canonicalizeImageUriHost,
  parseEcrRegistryHost,
} from '../../../src/local/ecr-uri.js';
import { PARTITION_TABLE } from '../../../src/local/intrinsic-image.js';

const ACCT = '123456789012';
/** U+212A KELVIN SIGN: `toLowerCase` folds it onto ASCII `k`. */
const KELVIN = String.fromCodePoint(0x212a);

/**
 * One representative region per partition, with that partition's suffix
 * spelled INDEPENDENTLY of the table under test (issue #760). The commercial
 * partition is a fallback, not a table row, so it is listed here explicitly.
 */
const PARTITIONS: ReadonlyArray<{ region: string; suffix: string; scoped: boolean }> = [
  { region: 'us-east-1', suffix: 'amazonaws.com', scoped: true },
  { region: 'ap-northeast-1', suffix: 'amazonaws.com', scoped: true },
  { region: 'cn-north-1', suffix: 'amazonaws.com.cn', scoped: false },
  { region: 'us-gov-west-1', suffix: 'amazonaws.com', scoped: true },
  { region: 'us-iso-east-1', suffix: 'c2s.ic.gov', scoped: false },
  { region: 'us-isob-east-1', suffix: 'sc2s.sgov.gov', scoped: false },
  { region: 'us-isof-south-1', suffix: 'csp.hci.ic.gov', scoped: false },
  { region: 'eu-isoe-west-1', suffix: 'cloud.adc-e.uk', scoped: false },
  { region: 'eusc-de-east-1', suffix: 'amazonaws.eu', scoped: false },
];

/** The four host forms, spelled independently of `ECR_REGISTRY_HOST_FORMS`. */
const FORMS: ReadonlyArray<{ labels: string; fixed?: string }> = [
  { labels: 'dkr.ecr' },
  { labels: 'dkr.ecr-fips' },
  { labels: 'dkr-ecr', fixed: 'on.aws' },
  { labels: 'dkr-ecr-fips', fixed: 'on.aws' },
];

describe('ECR_REGISTRY_HOST_FORMS', () => {
  it('lists exactly the four host forms AWS serves', () => {
    expect(
      ECR_REGISTRY_HOST_FORMS.map((f) => [f.labels, f.fixedUrlSuffix ?? null, f.partitions ?? null])
    ).toStrictEqual(
      FORMS.map((f) => [f.labels, f.fixed ?? null, f.labels === 'dkr.ecr' ? null : ['aws', 'aws-us-gov']])
    );
  });

  it('the independent partition list covers every PARTITION_TABLE row', () => {
    for (const row of PARTITION_TABLE) {
      expect(PARTITIONS.some((p) => p.region.startsWith(row.regionPrefix))).toBe(true);
    }
  });
});

describe('parseEcrRegistryHost — every form x every partition', () => {
  const all = PARTITIONS.flatMap((p) =>
    FORMS.map((f) => ({ ...p, ...f, host: `${ACCT}.${f.labels}.${p.region}.${f.fixed ?? p.suffix}` }))
  );
  // The FIPS and dual-stack forms are served in the aws / aws-us-gov partitions
  // only (https://docs.aws.amazon.com/general/latest/gr/ecr.html).
  const cases = all.filter((c) => c.labels === 'dkr.ecr' || c.scoped);
  const offPartitionDualStack = all.filter((c) => c.labels !== 'dkr.ecr' && !c.scoped);

  it('covers both sides of the FIPS / dual-stack partition scope', () => {
    expect(cases.length).toBe(18);
    expect(offPartitionDualStack.length).toBe(18);
  });

  it.each(offPartitionDualStack)(
    'refuses $host (a form that partition does not serve)',
    ({ host }) => {
      expect(parseEcrRegistryHost(`${host}/my-repo:latest`)).toBeUndefined();
    }
  );

  it.each(cases)('accepts $host', ({ host, region, labels }) => {
    const parsed = parseEcrRegistryHost(`${host}/my-repo:latest`);
    expect(parsed).toBeDefined();
    expect(parsed!.accountId).toBe(ACCT);
    expect(parsed!.region).toBe(region);
    expect(parsed!.registryHost).toBe(host);
    expect(parsed!.form.labels).toBe(labels);
  });

  // The mispairings: a partition-suffixed form carrying `on.aws`, and a fixed-
  // suffix form carrying the partition suffix. AWS serves neither.
  const mispaired = PARTITIONS.flatMap((p) =>
    FORMS.map((f) => ({
      host: `${ACCT}.${f.labels}.${p.region}.${f.fixed ? p.suffix : 'on.aws'}`,
    }))
  );
  it.each(mispaired)('refuses the form/suffix mispairing $host', ({ host }) => {
    expect(parseEcrRegistryHost(`${host}/my-repo:latest`)).toBeUndefined();
  });

  // A region paired with ANOTHER partition's suffix.
  const crossPartition = PARTITIONS.flatMap((p) =>
    PARTITIONS.filter((q) => q.suffix !== p.suffix).map((q) => ({
      host: `${ACCT}.dkr.ecr.${p.region}.${q.suffix}`,
    }))
  );
  it.each(crossPartition)('refuses the cross-partition suffix $host', ({ host }) => {
    expect(parseEcrRegistryHost(`${host}/my-repo:latest`)).toBeUndefined();
  });
});

describe('parseEcrRegistryHost — negative controls', () => {
  const LONG_S = String.fromCodePoint(0x17f);
  it.each([
    // Look-alike suffixes: the captured suffix must EQUAL the expected one.
    ['a non-AWS suffix', `${ACCT}.dkr.ecr.us-east-1.example.com/r:t`],
    ['a suffix-prefixed look-alike', `${ACCT}.dkr.ecr.us-east-1.amazonaws.com.evil.example/r:t`],
    ['a dual-stack look-alike', `${ACCT}.dkr-ecr.us-east-1.on.aws.evil.example/r:t`],
    ['a suffix with a label prepended', `${ACCT}.dkr-ecr.us-east-1.evil.on.aws/r:t`],
    ['an ISO look-alike carrying the commercial suffix', `${ACCT}.dkr.ecr.us-iso-east-1.amazonaws.com/r:t`],
    ['a trailing dot', `${ACCT}.dkr.ecr.us-east-1.amazonaws.com./r:t`],
    // No port, no userinfo, anchored.
    ['a port', `${ACCT}.dkr.ecr.us-east-1.amazonaws.com:5000/r:t`],
    ['userinfo after the host', `${ACCT}.dkr.ecr.us-east-1.amazonaws.com@evil.example/r:t`],
    ['userinfo before the host', `user@${ACCT}.dkr.ecr.us-east-1.amazonaws.com/r:t`],
    ['a scheme', `https://${ACCT}.dkr.ecr.us-east-1.amazonaws.com/r:t`],
    ['a leading label', `x.${ACCT}.dkr.ecr.us-east-1.amazonaws.com/r:t`],
    ['an 11-digit account', `12345678901.dkr.ecr.us-east-1.amazonaws.com/r:t`],
    ['a 13-digit account', `1234567890123.dkr.ecr.us-east-1.amazonaws.com/r:t`],
    ['no path', `${ACCT}.dkr.ecr.us-east-1.amazonaws.com`],
    ['an unescaped-dot label look-alike', `${ACCT}.dkrxecr.us-east-1.amazonaws.com/r:t`],
    ['an unknown label run', `${ACCT}.dkr.ecr-dualstack.us-east-1.amazonaws.com/r:t`],
    // Non-ASCII that a full Unicode fold would map onto ASCII.
    ['a Kelvin sign in the region', `${ACCT}.dkr.ecr-fips.us-${KELVIN}east-1.amazonaws.com/r:t`],
    ['a Kelvin sign in the ISO-E suffix', `${ACCT}.dkr.ecr.eu-isoe-west-1.cloud.adc-e.u${KELVIN}/r:t`],
    ['a Kelvin sign in the labels', `${ACCT}.d${KELVIN}r.ecr.us-east-1.amazonaws.com/r:t`],
    ['a long s in the FIPS labels', `${ACCT}.dkr-ecr-fip${LONG_S}.us-east-1.on.aws/r:t`],
    ['a leading space in the region', `${ACCT}.dkr.ecr. us-east-1.amazonaws.com/r:t`],
    ['an underscore region', `${ACCT}.dkr.ecr.us_east_1.amazonaws.com/r:t`],
    // Not ECR at all.
    ['public ECR', 'public.ecr.aws/nginx/nginx:alpine'],
    ['Docker Hub', 'nginx:latest'],
  ])('refuses %s', (_label, uri) => {
    expect(parseEcrRegistryHost(uri)).toBeUndefined();
  });

  it.each(['s3', 'lambda-url', 's3-external-1', 'fips-us-east-1', 'us-east', 'zz-east-1', 'east-1', 'us-east-1a', 'dkr-us-gov-west-1', 'eusc-east-1'])(
    'refuses the non-region label %s in the region position (every form)',
    (label) => {
      for (const host of [
        `${ACCT}.dkr.ecr.${label}.amazonaws.com`,
        `${ACCT}.dkr.ecr-fips.${label}.amazonaws.com`,
        `${ACCT}.dkr-ecr.${label}.on.aws`,
        `${ACCT}.dkr-ecr-fips.${label}.on.aws`,
      ]) {
        expect(parseEcrRegistryHost(`${host}/r:t`)).toBeUndefined();
      }
    }
  );

  it.each([
    ['us-east-1', 'amazonaws.com'],
    ['us-gov-west-1', 'amazonaws.com'],
    ['us-iso-east-1', 'c2s.ic.gov'],
    ['us-isob-east-1', 'sc2s.sgov.gov'],
    ['us-isof-south-1', 'csp.hci.ic.gov'],
    ['eu-isoe-west-1', 'cloud.adc-e.uk'],
    ['eusc-de-east-1', 'amazonaws.eu'],
    ['cn-north-1', 'amazonaws.com.cn'],
    ['ap-southeast-7', 'amazonaws.com'],
    ['mx-central-1', 'amazonaws.com'],
    ['il-central-1', 'amazonaws.com'],
    ['US-GOV-WEST-1', 'amazonaws.com'],
    ['US-ISO-EAST-1', 'c2s.ic.gov'],
    ['US-ISOB-EAST-1', 'sc2s.sgov.gov'],
    ['US-ISOF-SOUTH-1', 'csp.hci.ic.gov'],
    ['EU-ISOE-WEST-1', 'cloud.adc-e.uk'],
    ['EUSC-DE-EAST-1', 'amazonaws.eu'],
    ['CN-NORTH-1', 'amazonaws.com.cn'],
    ['AP-SOUTHEAST-7', 'amazonaws.com'],
    ['MX-CENTRAL-1', 'amazonaws.com'],
    ['IL-CENTRAL-1', 'amazonaws.com'],
  ])('accepts the region shape %s on the plain form', (region, suffix) => {
    expect(parseEcrRegistryHost(`${ACCT}.dkr.ecr.${region}.${suffix}/r:t`)).toBeDefined();
  });

  it('folds an upper-cased ASCII host to the canonical spelling', () => {
    const parsed = parseEcrRegistryHost(`${ACCT}.DKR-ECR-FIPS.US-EAST-1.ON.AWS/my-repo:latest`);
    expect(parsed).toMatchObject({
      accountId: ACCT,
      region: 'us-east-1',
      registryHost: `${ACCT}.dkr-ecr-fips.us-east-1.on.aws`,
    });
  });
});

describe('canonicalizeImageUriHost', () => {
  it('folds only the ASCII letters of the registry host, never the path or tag', () => {
    expect(canonicalizeImageUriHost(`${ACCT}.DKR.ECR.US-EAST-1.AMAZONAWS.COM/My/Repo:TAG`)).toBe(
      `${ACCT}.dkr.ecr.us-east-1.amazonaws.com/My/Repo:TAG`
    );
  });

  it('leaves a non-ASCII code point as written (no Unicode fold)', () => {
    const uri = `${ACCT}.dkr.ecr.us-${KELVIN}east-1.amazonaws.com/r:t`;
    expect(canonicalizeImageUriHost(uri)).toBe(uri);
  });

  it('leaves a Docker Hub path segment alone', () => {
    expect(canonicalizeImageUriHost('MyOrg/MyRepo:tag')).toBe('MyOrg/MyRepo:tag');
  });
});
