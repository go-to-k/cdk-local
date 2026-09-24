import { derivePartitionAndUrlSuffix } from './intrinsic-image.js';

/**
 * ECR private-registry host recognition, shared by the pull path
 * (`ecr-puller.ts`) and the ECS image classifier (`ecs-task-resolver.ts`).
 *
 * Both used to carry their own copy of a plain-form, commercial-only pattern
 * (`<acct>.dkr.ecr.<region>.amazonaws.com(.cn)?`), so a FIPS, dual-stack or ISO
 * registry host was classified as a PUBLIC image: an anonymous `docker pull`,
 * no `docker login`, and a `no basic auth credentials` failure (issue #760).
 * One definition keeps the two classifiers from drifting apart again.
 *
 * This module has no AWS SDK import on purpose: `ecs-task-resolver.ts`
 * documents itself as SDK-free, and it imports this file.
 */

/** One HOST FORM AWS serves an ECR private registry under. */
export interface EcrRegistryHostForm {
  /** The literal labels between the account id and the region, e.g. `dkr.ecr`. */
  readonly labels: string;
  /**
   * The fixed URL suffix this form is served under, or `undefined` when the
   * form carries the suffix of the region's own partition.
   */
  readonly fixedUrlSuffix?: string;
  /**
   * The partitions this form is served in, or `undefined` for every partition.
   * A region outside them is refused: the host would be one AWS does not serve,
   * and for a fixed suffix it would send that partition's token into another
   * partition's DNS.
   */
  readonly partitions?: readonly string[];
}

/**
 * Every ECR private-registry host form, read off the AWS-published `ecr`
 * endpoint list (https://docs.aws.amazon.com/general/latest/gr/ecr.html):
 *
 * - `<acct>.dkr.ecr.<region>.<partition suffix>` — the plain IPv4 endpoint.
 * - `<acct>.dkr.ecr-fips.<region>.<partition suffix>` — FIPS IPv4.
 * - `<acct>.dkr-ecr.<region>.on.aws` — dual-stack (IPv4 + IPv6).
 * - `<acct>.dkr-ecr-fips.<region>.on.aws` — dual-stack FIPS.
 *
 * Every form except the plain one is scoped to the `aws` and `aws-us-gov`
 * partitions, the only ones that endpoint list shows it in: both FIPS forms are
 * listed for `us-east-1` / `us-east-2` / `us-west-1` / `us-west-2` /
 * `us-gov-east-1` / `us-gov-west-1` only, and `on.aws` is the dual-stack DNS of
 * those two partitions (the others serve dual-stack under their own suffixes,
 * which are not listed here). A FIPS or dual-stack host in any other partition
 * is therefore not recognized and is pulled as a public image, as before issue
 * #760. The scope is by PARTITION, not by region: a commercial region AWS adds
 * later is accepted, and a login to an unserved region's FIPS host only fails,
 * because the suffix is still AWS-owned.
 */
const FIPS_AND_DUAL_STACK_PARTITIONS = ['aws', 'aws-us-gov'] as const;
export const ECR_REGISTRY_HOST_FORMS: readonly EcrRegistryHostForm[] = [
  { labels: 'dkr.ecr' },
  { labels: 'dkr.ecr-fips', partitions: FIPS_AND_DUAL_STACK_PARTITIONS },
  {
    labels: 'dkr-ecr',
    fixedUrlSuffix: 'on.aws',
    partitions: FIPS_AND_DUAL_STACK_PARTITIONS,
  },
  {
    labels: 'dkr-ecr-fips',
    fixedUrlSuffix: 'on.aws',
    partitions: FIPS_AND_DUAL_STACK_PARTITIONS,
  },
];

const ECR_HOST_FORM_BY_LABELS = new Map(ECR_REGISTRY_HOST_FORMS.map((f) => [f.labels, f]));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<acct>.<labels>.<region>.<suffix>/` — ANCHORED at the start, so nothing
 * (userinfo, a scheme, another host) can precede the account id, and ending at
 * the first `/`, so the captured suffix is the rest of the host.
 *
 * The labels alternation is built from {@link ECR_REGISTRY_HOST_FORMS},
 * ESCAPED (an unescaped `dkr.ecr` would match `dkrxecr`) and longest first, so
 * `dkr.ecr-fips` is tried before its own `dkr.ecr` prefix. The `i` flag makes
 * the labels case-insensitive, as DNS is; it is non-unicode, so it does NOT
 * treat U+212A (Kelvin sign) as `k`, and `\d` is ASCII-only.
 */
const ECR_URI_HOST_REGEX = new RegExp(
  `^(\\d{12})\\.(${[...ECR_REGISTRY_HOST_FORMS]
    .sort((a, b) => b.labels.length - a.labels.length)
    .map((f) => escapeRegExp(f.labels))
    .join('|')})\\.([^./]+)\\.([^/]+)/`,
  'i'
);

/**
 * A region segment is ASCII alphanumerics plus `-`. Tested on the RAW capture,
 * BEFORE any case fold: `String.prototype.toLowerCase` folds U+212A onto an
 * ASCII `k`, so testing a folded value would admit `us-eKst-1` (Kelvin sign) as
 * the region `us-ekst-1` — a region the host does not name, which then seeds
 * the ECR client and the login endpoint. Today {@link REGION_SHAPE} also
 * refuses that input, because the fold is ASCII-only and the shape is ASCII
 * only, so this guard is DEFENSE IN DEPTH: it keeps the region safe if the fold
 * is ever widened to full Unicode folding.
 */
const CANONICAL_REGION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The SHAPE of an AWS region id, tested on the FOLDED region after the charset
 * guard above. One alternative per partition, transcribed from the
 * `regionRegex` of each partition in the AWS SDK / botocore `partitions.json`
 * (`\w+` written as `[a-z0-9]+`):
 *
 * - aws: `(us|eu|ap|sa|ca|me|af|il|mx)-X-N`
 * - aws-cn: `cn-X-N`; aws-us-gov: `us-gov-X-N`
 * - aws-iso / -b / -e / -f: `us-iso-X-N`, `us-isob-X-N`, `eu-isoe-X-N`,
 *   `us-isof-X-N`
 * - aws-eusc: `eusc-<cc>-X-N` — broader than upstream's `eusc-(de)-`, matching
 *   `PARTITION_TABLE`'s `eusc-` prefix so a future country is not refused here
 *   while the partition lookup accepts it.
 *
 * It refuses a label that is not a region — `s3`, `lambda-url`,
 * `s3-external-1`, `fips-us-east-1` — so `<acct>.dkr.ecr.s3.amazonaws.com` or
 * `<acct>.dkr-ecr.lambda-url.on.aws` never becomes a login target. Those hosts
 * are AWS-owned, but they are not registries, and only TLS would stop a token
 * sent there (an `insecure-registries` daemon setting turns that off).
 */
const REGION_SHAPE =
  /^(?:(?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z0-9]+-[0-9]+|cn-[a-z0-9]+-[0-9]+|us-gov-[a-z0-9]+-[0-9]+|us-iso-[a-z0-9]+-[0-9]+|us-isob-[a-z0-9]+-[0-9]+|eu-isoe-[a-z0-9]+-[0-9]+|us-isof-[a-z0-9]+-[0-9]+|eusc-[a-z]+-[a-z0-9]+-[0-9]+)$/;

/**
 * A URL suffix is a dotted name of ASCII alphanumerics and `-`, tested on the
 * raw capture like the region. Today it is DEFENSE IN DEPTH, not the load-
 * bearing check: the fold below is ASCII-only, so `cloud.adc-e.uK` (Kelvin
 * sign) never becomes the `aws-iso-e` suffix, and the exact-suffix comparison
 * already refuses a port (`:`), userinfo (`@`) or any look-alike. It keeps
 * the suffix safe if that fold is ever widened to full Unicode folding.
 */
const CANONICAL_URL_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Lower-case ONLY `A`-`Z`. DNS case-insensitivity is ASCII-only, and a full
 * `toLowerCase` would fold U+212A onto `k` and hand the charset guards above an
 * already-ASCII string, defeating them.
 */
function foldAsciiUpperCase(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** Docker's rule for "component 1 is a registry host, not a repository segment". */
function isRegistryHostComponent(component: string): boolean {
  return component.includes('.') || component.includes(':') || component === 'localhost';
}

/**
 * Lower-case the REGISTRY HOST of an image reference (ASCII letters only) and
 * leave the repository path and tag byte-identical.
 *
 * Docker's credential store is keyed on the hostname VERBATIM, so a login to
 * one spelling and a pull from another sends no credentials; every
 * docker-facing use of an ECR reference goes through this one spelling. The
 * path is not folded: docker requires it lower-case already, and rewriting it
 * would name a different image. A first component that is not a registry host
 * (`MyOrg/MyRepo:tag` is a Docker Hub path) is left alone for the same reason.
 */
export function canonicalizeImageUriHost(imageUri: string): string {
  const slash = imageUri.indexOf('/');
  if (slash < 0) return imageUri;
  const host = imageUri.slice(0, slash);
  if (!isRegistryHostComponent(host)) return imageUri;
  return foldAsciiUpperCase(host) + imageUri.slice(slash);
}

/** The ECR registry an image reference names. */
export interface EcrRegistryHost {
  accountId: string;
  /** Lower-case region id — seeds the ECR client. */
  region: string;
  /**
   * The canonical (ASCII-lower-cased) registry host the reference names — the
   * host `docker pull` targets, and so the host `docker login` must target.
   */
  registryHost: string;
  /** The matched form from {@link ECR_REGISTRY_HOST_FORMS}. */
  form: EcrRegistryHostForm;
}

/**
 * The ECR registry an image reference names, or `undefined` when its host is
 * not one of {@link ECR_REGISTRY_HOST_FORMS} with the suffix that form carries
 * for the region it names.
 *
 * The suffix check is what keeps a `docker login` from being pointed at a host
 * cdk-local does not own: `<acct>.dkr.ecr.<region>.example.com`, a look-alike
 * `amazonaws.com.evil.example`, a port or userinfo after the suffix, and a
 * form/suffix mispairing (`dkr-ecr` + `amazonaws.com`, `dkr.ecr` + `on.aws`,
 * an ISO region + `amazonaws.com`) are all refused.
 */
export function parseEcrRegistryHost(imageUri: string): EcrRegistryHost | undefined {
  const m = ECR_URI_HOST_REGEX.exec(imageUri);
  if (!m) return undefined;
  const [, accountId, rawLabels, rawRegion, rawSuffix] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Both guarded on the RAW capture, before any fold (see the regexes' docs).
  if (!CANONICAL_REGION_SEGMENT.test(rawRegion)) return undefined;
  if (!CANONICAL_URL_SUFFIX.test(rawSuffix)) return undefined;
  const form = ECR_HOST_FORM_BY_LABELS.get(foldAsciiUpperCase(rawLabels));
  // Unreachable while the alternation is built from this table, escaped. Not
  // dead: with the escaping removed, `dkrxecr` matches the alternation and this
  // lookup is what refuses it. Fail-closed rather than asserted.
  if (!form) return undefined;
  const region = foldAsciiUpperCase(rawRegion);
  if (!REGION_SHAPE.test(region)) return undefined;
  const suffix = foldAsciiUpperCase(rawSuffix);
  const partition = derivePartitionAndUrlSuffix(region);
  if (form.partitions && !form.partitions.includes(partition.partition)) return undefined;
  const expectedSuffix = form.fixedUrlSuffix ?? partition.urlSuffix;
  if (suffix !== expectedSuffix) return undefined;
  return {
    accountId,
    region,
    registryHost: `${accountId}.${form.labels}.${region}.${suffix}`,
    form,
  };
}
