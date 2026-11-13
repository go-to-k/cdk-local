// SQS queue URLs under `--aws-emulator` (go-to-k/cdk-local#947).
//
// The AWS SDK for JavaScript v3 sends an SQS request to its QueueUrl's host
// (`useQueueUrlAsEndpoint`, on by default), not to `AWS_ENDPOINT_URL[_SQS]`.
// A real-shaped queue URL (`https://sqs.<region>.amazonaws.com/<account>/<queue>`)
// would take the call out of the emulator: in mixed mode signed with the
// developer's REAL identity, under `--aws-emulator` alone with the emulator's
// key ID. The re-signing sidecar rewrites the queue URLs in the emulator's
// responses (#910); this module covers the two other ways one reaches a
// workload whose SQS calls go to the emulator:
//
//   - a queue URL that IS a value of the workload's environment
//     (`--from-state`, `--from-cfn-stack`, `--env-vars`) is rewritten to the
//     endpoint the workload's SQS calls already use, so the call stays local
//     and works (`rewriteSqsQueueUrlsInEnv`);
//   - every other one (read at runtime from SSM, Secrets Manager, a file, or
//     embedded in a larger value) fails closed: the real SQS host names
//     resolve to `127.0.0.1` inside the container (`--add-host`,
//     `awsEmulatorSqsHostBlocks`), where no SQS endpoint listens, so the
//     request is refused before any signed byte leaves the machine.
//
// A workload whose SQS is excepted to real AWS (`"real-aws"`) gets neither.

/**
 * A real SQS queue URL: an AWS SQS host (`sqs.<region>`, `<region>.queue`, the
 * legacy global `queue`; any partition suffix),
 * no port, user info, query or fragment, and a path of a 12-digit account and
 * a queue name. Group 1 is `<account>/<queue>`. The re-signing sidecar's
 * response rewrite uses this same pattern (`emulator-resign-sidecar.ts`).
 */
export const REAL_SQS_QUEUE_URL =
  /^https?:\/\/(?:sqs\.[a-z0-9-]+|[a-z0-9-]+\.queue|queue)\.amazonaws\.com(?:\.cn)?\/([0-9]{12}\/[A-Za-z0-9_-]{1,80}(?:\.fifo)?)$/;

/**
 * The AWS Regions whose SQS hosts are blocked, pinned (botocore
 * `endpoints.json`, the `aws`, `aws-cn` and `aws-us-gov` partitions). The
 * workload's own region, and the region of any queue URL in its environment,
 * are added at run time, so a Region newer than this list is covered there.
 */
export const SQS_BLOCKED_REGIONS: readonly string[] = [
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-6',
  'ap-southeast-7',
  'ca-central-1',
  'ca-west-1',
  'cn-north-1',
  'cn-northwest-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-gov-east-1',
  'us-gov-west-1',
  'us-west-1',
  'us-west-2',
];

const REGION_SHAPE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/** A real AWS service host: `*.amazonaws.com`, `*.amazonaws.com.cn`, `*.api.aws`. */
export function isRealAwsHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)amazonaws\.com(\.cn)?$/.test(h) || /(^|\.)api\.aws$/.test(h);
}

/**
 * The origin a workload's SQS calls go to, when that is NOT real AWS: its
 * `AWS_ENDPOINT_URL_SQS`, else its global `AWS_ENDPOINT_URL` (the AWS SDKs'
 * order, an empty value skipped). `undefined` when SQS goes to real AWS: no endpoint (the SDK's
 * default), a real AWS host (a `"real-aws"` exception, or a literal real
 * endpoint), or a value that is not an http(s) URL.
 */
export function sqsEmulatorOriginOf(env: Readonly<Record<string, string>>): string | undefined {
  // Truthy, as the SDKs read them: an empty `AWS_ENDPOINT_URL_SQS` falls back
  // to the global endpoint there too.
  const endpoint = env['AWS_ENDPOINT_URL_SQS'] || env['AWS_ENDPOINT_URL'];
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (isRealAwsHost(url.hostname)) return undefined;
  return url.origin;
}

/**
 * Rewrite each env value that is exactly a real SQS queue URL
 * ({@link REAL_SQS_QUEUE_URL}, surrounding whitespace ignored) to
 * `<origin>/<account>/<queue>`, in place. Returns the rewritten keys (never
 * the values). A queue URL inside a larger value is left alone.
 */
export function rewriteSqsQueueUrlsInEnv(env: Record<string, string>, origin: string): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    const m = REAL_SQS_QUEUE_URL.exec(v.trim());
    if (!m) continue;
    env[k] = `${origin}/${m[1]}`;
    keys.push(k);
  }
  return keys;
}

/**
 * Re-point each env value that is a queue URL on `fromOrigin`
 * (`<fromOrigin>/<account>/<queue>`, as {@link rewriteSqsQueueUrlsInEnv}
 * wrote it) to `toOrigin`, in place.
 */
export function repointLocalSqsQueueUrlsInEnv(
  env: Record<string, string>,
  fromOrigin: string,
  toOrigin: string
): void {
  const from = new URL(fromOrigin).origin;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || !v.startsWith(`${from}/`)) continue;
    const rest = v.slice(from.length + 1);
    if (/^[0-9]{12}\/[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/.test(rest)) env[k] = `${toOrigin}/${rest}`;
  }
}

/** The region of a real SQS host (`sqs.<r>.amazonaws.com`, `<r>.queue.amazonaws.com`). */
function regionOfSqsHost(hostname: string): string | undefined {
  const m = /^(?:sqs\.([a-z0-9-]+)|([a-z0-9-]+)\.queue)\.amazonaws\.com(?:\.cn)?$/.exec(hostname);
  const region = m?.[1] ?? m?.[2];
  return region && REGION_SHAPE.test(region) ? region : undefined;
}

/**
 * Every real SQS host name a queue URL can carry in `regions`, sorted: the
 * `sqs.<region>.<suffix>` form AWS returns today, the legacy
 * `<region>.queue.<suffix>` form, and the legacy global `queue.amazonaws.com`.
 * `amazonaws.com.cn` in the China regions.
 */
export function realSqsHostnames(regions: Iterable<string>): string[] {
  const out = new Set<string>(['queue.amazonaws.com']);
  for (const r of regions) {
    if (!REGION_SHAPE.test(r)) continue;
    const suffix = r.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    out.add(`sqs.${r}.${suffix}`);
    out.add(`${r}.queue.${suffix}`);
  }
  return [...out].sort();
}

/**
 * The regions whose SQS hosts a container blocks: {@link SQS_BLOCKED_REGIONS},
 * the env's `AWS_REGION` / `AWS_DEFAULT_REGION`, and the region of every real
 * queue URL host found in an env value (a value rewritten already is local).
 */
export function sqsBlockedRegionsFor(env: Readonly<Record<string, string>>): string[] {
  const regions = new Set<string>(SQS_BLOCKED_REGIONS);
  for (const k of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    const r = env[k]?.trim();
    if (r && REGION_SHAPE.test(r)) regions.add(r);
  }
  for (const v of Object.values(env)) {
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(/https?:\/\/([a-z0-9.-]+)\//gi)) {
      const r = regionOfSqsHost(m[1]!.toLowerCase());
      if (r) regions.add(r);
    }
  }
  return [...regions];
}
