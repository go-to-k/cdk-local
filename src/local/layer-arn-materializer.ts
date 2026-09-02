import { createWriteStream, rmSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildProxyClientConfig, proxyAwareFetch } from '../utils/aws-proxy.js';
import { getLogger } from '../utils/logger.js';
import type { ResolvedArnLambdaLayer } from './lambda-resolver.js';
import { getEmbedConfig } from './embed-config.js';
import {
  describeAwsFailureForWarn,
  flattenToOneLine,
  sanitizeServiceExceptionMessage,
} from './credential-error.js';
import { isIamRoleArn, refusedRoleArnMessage } from '../utils/role-arn.js';

/**
 * Materialize a literal-ARN Lambda Layer to a host tmpdir so it can be
 * bind-mounted at `/opt` alongside same-stack layers (issue #448).
 *
 * Steps:
 *
 *   1. Optional `sts:AssumeRole` against `roleArn` (the CLI's
 *      `--layer-role-arn <arn>` flag). When the dev's default
 *      credentials cannot read the layer (cross-account case) the role
 *      typically belongs to a trust-policy-permitted role in the layer's
 *      account.
 *   2. `lambda:GetLayerVersion` against the layer's region (parsed from
 *      the ARN by `parseLayerVersionArn` — NOT the dev's profile
 *      region) to recover the presigned S3 URL in `Content.Location`.
 *   3. Download the ZIP from the presigned URL via `proxyAwareFetch(...)`
 *      (no AWS credentials needed on the GET — the presign carries them;
 *      the proxy-aware form is what keeps step 3 reachable on a machine
 *      whose only egress is a forward proxy, issue #647).
 *   4. Unzip into a fresh tmpdir under `os.tmpdir()` using `node:zlib`
 *      + the documented ZIP-file format. AWS layer ZIPs use the
 *      DEFLATE compression method.
 *
 * Returns the absolute path to the unzipped directory; the caller
 * `cpSync`-merges it into the `/opt` host tmpdir alongside any
 * same-stack `kind: 'asset'` layers and records the path in the
 * tracking set for cleanup.
 *
 * Failures surface as `LayerMaterializationError` with the layer ARN
 * in the message so the user sees which layer broke (vs which
 * Lambda's `Properties.Layers` array hit which AWS error).
 *
 * **Network IO is gated by the `lambdaClientFactory` / `stsClientFactory`
 * options** to keep unit tests deterministic — production callers omit
 * both and the function builds the real SDK clients on the fly via
 * dynamic `import()` to keep the cold-start path small.
 */
export interface MaterializeLayerOptions {
  /**
   * Optional role to assume before calling `GetLayerVersion`. When
   * unset the dev's default credentials (whatever the SDK default
   * chain resolves) are used. Threading a per-CLI-invocation flag is
   * the canonical cross-account escape hatch — see `--layer-role-arn`
   * on `cdkl invoke` / `cdkl start-api`.
   */
  roleArn?: string;
  /**
   * Test seam: override the Lambda client (the production call goes
   * through `@aws-sdk/client-lambda`'s `LambdaClient.send(new
   * GetLayerVersionCommand(...))`).
   */
  lambdaClientFactory?: (region: string, credentials?: AwsCredentials) => LambdaSendClient;
  /**
   * Test seam: override the STS client (production goes through
   * `@aws-sdk/client-sts`'s `STSClient.send(new AssumeRoleCommand(...))`).
   */
  stsClientFactory?: (region: string) => StsSendClient;
  /**
   * Test seam: override the presigned-URL ZIP fetch. The production
   * call goes through `proxyAwareFetch()` (`src/utils/aws-proxy.ts`), which
   * is `globalThis.fetch` with no proxy variable set. Returns a
   * `Uint8Array` (the ZIP body) so the test can inject a fixture-built ZIP.
   */
  fetchZip?: (presignedUrl: string) => Promise<Uint8Array>;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Minimal slice of `LambdaClient` cdk-local needs. Surfaced as an interface
 * so unit tests can mock without pulling the real SDK module.
 */
export interface LambdaSendClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<{ Content?: { Location?: string } }>;
  destroy?: () => void;
}

export interface StsSendClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<{
    Credentials?: {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
    };
  }>;
  destroy?: () => void;
}

export class LayerMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerMaterializationError';
    Object.setPrototypeOf(this, LayerMaterializationError.prototype);
  }
}

/**
 * cdk-local's OWN rejection raised INSIDE a guarded region, still needing the
 * call site's framing (issue #579, review round 2).
 *
 * Two classes are needed, not one, because the guarded regions contain BOTH
 * kinds of cdk-local throw and they want opposite handling:
 *
 *   - ALREADY FRAMED — the ARN-shape guard raises
 *     `Layer <arn>: not a layer-version ARN ...`, which names the layer and the
 *     problem and fires before any AWS call. Re-raising it INTACT is right;
 *     wrapping it would double the `Layer <arn>:` prefix and, worse, prepend
 *     `GetLayerVersion failed` to a failure where no call was ever made.
 *   - UNFRAMED — `AssumeRole returned no Credentials` and
 *     `GetLayerVersion response did not include Content.Location` are bare
 *     sentences that mean nothing without the site's `Layer <arn>: <call>
 *     failed: ... <remedy>` envelope.
 *
 * A first pass at #579 made both `LayerMaterializationError` and re-raised
 * both, which silently DROPPED the envelope (and the `looksLikeAccessDenied`
 * hint) from the second group. The existing tests only substring-match the
 * inner sentence, so nothing went red. Hence a distinct type rather than a
 * shared one: the catch keeps the message verbatim — it is cdk-local's own
 * text, never anything off the wire, so the credential-error policy has
 * nothing to decide about it — and still applies the framing.
 */
class UnframedLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnframedLayerError';
    Object.setPrototypeOf(this, UnframedLayerError.prototype);
  }
}

/**
 * The detail half of a layer failure message: cdk-local's own text kept
 * verbatim, anything else rendered by the shared credential-error policy.
 */
function layerFailureDetail(err: unknown, operation: string): string {
  return err instanceof UnframedLayerError
    ? err.message
    : describeAwsFailureForWarn(err, operation);
}

export async function materializeLayerFromArn(
  layer: ResolvedArnLambdaLayer,
  options: MaterializeLayerOptions = {}
): Promise<string> {
  const logger = getLogger();

  let credentials: AwsCredentials | undefined;
  if (options.roleArn) {
    try {
      credentials = await assumeRoleForLayer(options.roleArn, layer.region, options);
      logger.debug(`Layer ${layer.arn}: assumed role ${options.roleArn} for GetLayerVersion`);
    } catch (err) {
      // An ALREADY-FRAMED cdk-local throw passes through untouched; see
      // {@link UnframedLayerError} for why the two cases are separate types.
      if (err instanceof LayerMaterializationError) throw err;
      // Issue #579. LEVEL: this THROWS rather than logging, but the text lands
      // on the user through the top-level error handler, which is
      // default-level output by construction. RECONSTRUCTION:
      // `assumeRoleForLayer` wraps `sts.send(AssumeRoleCommand)` — the same
      // two-population `catch` issue #570 split at nine sites in
      // `src/cli/commands/**`; this one sits outside that scope, which is the
      // only reason it was not covered there.
      throw new LayerMaterializationError(
        `Layer ${layer.arn}: STS AssumeRole(${flattenToOneLine(options.roleArn)}) failed: ${layerFailureDetail(
          err,
          'STS AssumeRole (--layer-role-arn)'
        )}. ` + 'Check the role trust policy permits your principal and sts:AssumeRole is allowed.'
      );
    }
  }

  let presignedUrl: string;
  try {
    presignedUrl = await fetchLayerContentUrl(layer, credentials, options);
  } catch (err) {
    // The ARN-shape guard frames itself (and fires before any call), so it
    // passes through; the missing-`Content.Location` guard does not, and is
    // kept verbatim inside this site's envelope by `layerFailureDetail`.
    if (err instanceof LayerMaterializationError) throw err;
    const hint = looksLikeAccessDenied(err)
      ? ' GetLayerVersion access denied; check the credentials / role can read the layer ' +
        '(grant lambda:GetLayerVersion on the layer ARN, or pass --layer-role-arn <arn> ' +
        'to assume a role in the layer account).'
      : '';
    // Issue #579 — same two-axis call as the AssumeRole site above;
    // `fetchLayerContentUrl` is a `lambda:GetLayerVersion` call. `hint` is
    // cdk-local's own literal and is derived from `looksLikeAccessDenied`,
    // which reads the error rather than printing it, so it stays as is.
    throw new LayerMaterializationError(
      `Layer ${layer.arn}: GetLayerVersion failed in region ${layer.region}: ${layerFailureDetail(
        err,
        'Lambda GetLayerVersion'
      )}.${hint}`
    );
  }

  let zipBytes: Uint8Array;
  try {
    zipBytes = await downloadPresignedZip(presignedUrl, options);
  } catch (err) {
    // `sanitizeServiceExceptionMessage`, not bare `errMsg`: since issue #647
    // this `catch` also sees whatever `proxyAwareFetch` raises — `node:net` /
    // OpenSSL / proxy-agent text, none of it credential-bearing but none of it
    // one bounded line either. Nothing to WITHHOLD, everything to FLATTEN.
    throw new LayerMaterializationError(
      `Layer ${layer.arn}: failed to download layer ZIP from the presigned URL: ${sanitizeServiceExceptionMessage(
        errMsg(err)
      )}.`
    );
  }

  const dir = await mkdtemp(
    join(
      tmpdir(),
      `${getEmbedConfig().resourceNamePrefix}-arn-layer-${layer.name}-${layer.version}-`
    )
  );
  try {
    await unzipBufferToDirectory(zipBytes, dir);
  } catch (err) {
    // Clean up the partially-extracted tmpdir before re-throwing — the
    // caller never receives `dir` on this path so its tracking sets in
    // local-invoke (ImagePlan.layerArnTmpDirs) / local-start-api
    // (layerTmpDirs Set) never learn about it, and the OS never
    // reclaims it until reboot. Best-effort: a second failure would
    // mask the original unzip error.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw new LayerMaterializationError(
      `Layer ${layer.arn}: failed to unzip layer contents into '${dir}': ${errMsg(err)}.`
    );
  }
  return dir;
}

async function fetchLayerContentUrl(
  layer: ResolvedArnLambdaLayer,
  credentials: AwsCredentials | undefined,
  options: MaterializeLayerOptions
): Promise<string> {
  const factory = options.lambdaClientFactory ?? (await defaultLambdaClientFactory());
  const client = factory(layer.region, credentials);
  try {
    // Layer ARN form used as LayerName lets the SDK resolve cross-
    // account references without a separate account-id flag. AWS docs:
    // "When provided the layer-version's ARN as LayerName, the
    // VersionNumber must still be set."
    //
    // Derived from the ORIGINAL ARN by dropping its `:<version>` tail
    // rather than re-interpolated from the parsed fields, because
    // re-interpolation has to name a partition and hardcoding `aws`
    // sends a partition-mismatched ARN to a non-commercial endpoint
    // (issue #575). `parseLayerVersionArn` only accepts an ARN whose
    // partition agrees with its region, so the prefix here is already
    // the right one for `layer.region`.
    //
    // Guarded because `materializeLayerFromArn` is re-exported from
    // `src/internal.ts`, so a host CLI can hand in a
    // `ResolvedArnLambdaLayer` it built itself, whose `arn` never went
    // through `parseLayerVersionArn`. The old re-interpolation was
    // structurally immune to that; stripping a tail is not.
    //
    // The guard asserts what is actually being stripped -- a NUMERIC
    // version segment -- rather than merely that some colon exists. A
    // bare `lastIndexOf` admits both failure shapes: a colon-free string
    // returns -1 and `slice(0, -1)` drops the last character, AND a
    // version-less `...:layer:MyLayer` strips the NAME instead, leaving
    // `...:layer` paired with a `Number(undefined)` version. Both turn a
    // caller's mistake into a confusing API error instead of a clear
    // local one, which is the whole point of the check.
    const versionSuffix = /^(.*):(\d+)$/.exec(layer.arn);
    if (!versionSuffix) {
      throw new LayerMaterializationError(
        `Layer ${layer.arn}: not a layer-version ARN (no ':<version>' suffix to strip). ` +
          `Expected arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>.`
      );
    }
    const versionLessArn = versionSuffix[1]!;
    const command = await buildGetLayerVersionCommand(versionLessArn, Number(layer.version));
    const response = await client.send(command);
    const url = response?.Content?.Location;
    if (!url || typeof url !== 'string') {
      throw new UnframedLayerError(
        'GetLayerVersion response did not include Content.Location (presigned ZIP URL)'
      );
    }
    return url;
  } finally {
    client.destroy?.();
  }
}

async function assumeRoleForLayer(
  roleArn: string,
  region: string,
  options: MaterializeLayerOptions
): Promise<AwsCredentials> {
  // GUARDED SEND (issue #607) — one of the two ARGV-SOURCED sends, the last of
  // the five `new AssumeRoleCommand(` sites in `src/` to be guarded. This one
  // is `--layer-role-arn`; its twin is in the other file.
  //
  // The reason is CONSISTENCY and the LENGTH BOUND, explicitly NOT the threat
  // model. #607 is about a role ARN arriving off the WIRE — a hostile
  // `GetFunctionConfiguration` / `GetAgentRuntime` response or a compromised
  // CloudFormation state read — and that path does not reach here: this
  // function's ARN comes only from `--layer-role-arn` on the user's own command
  // line. A comment implying otherwise would be the next false invariant, and
  // this lane already had to retract one ("one of the two places in the
  // process where a role ARN is handed to STS" — there are five).
  //
  // What guarding buys is that all five sends answer "is this a role ARN?" the
  // same way, and that an unbounded value cannot be sent or printed even when
  // the user is the one who typed it. `--layer-role-arn` / `--ecr-role-arn`
  // are declared as plain `new Option('<flag> <arn>', …)` with NO `argParser`
  // — `local-start-api.ts` holds the repo's only `parseAssumeRoleToken`
  // wiring — so nothing validated them before this.
  //
  // Throws the ALREADY-FRAMED `LayerMaterializationError`, not
  // `UnframedLayerError`: the caller re-throws a framed error untouched, while
  // an unframed one is wrapped in `STS AssumeRole(${flattenToOneLine(roleArn)})
  // failed: …` — which interpolates the raw ARN with no cap, so framing the
  // refusal there would put the very value being refused for its LENGTH onto
  // the line. Self-framing keeps the whole message bounded.
  if (!isIamRoleArn(roleArn)) {
    throw new LayerMaterializationError(refusedRoleArnMessage(roleArn));
  }

  const factory = options.stsClientFactory ?? (await defaultStsClientFactory());
  const client = factory(region);
  try {
    const command = await buildAssumeRoleCommand(roleArn);
    const response = await client.send(command);
    const creds = response?.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey) {
      throw new UnframedLayerError('AssumeRole returned no Credentials');
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      ...(creds.SessionToken !== undefined && { sessionToken: creds.SessionToken }),
    };
  } finally {
    client.destroy?.();
  }
}

async function defaultLambdaClientFactory(): Promise<
  (region: string, credentials?: AwsCredentials) => LambdaSendClient
> {
  const { LambdaClient } = await import('@aws-sdk/client-lambda');
  return (region, credentials) =>
    new LambdaClient({
      ...buildProxyClientConfig(),
      region,
      ...(credentials && {
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          ...(credentials.sessionToken !== undefined && {
            sessionToken: credentials.sessionToken,
          }),
        },
      }),
    });
}

async function defaultStsClientFactory(): Promise<(region: string) => StsSendClient> {
  const { STSClient } = await import('@aws-sdk/client-sts');
  // sts-audit: ignore: this is a region-only factory whose call chain
  // does not yet receive `--profile` (issue #448's --layer-role-arn flow
  // assumes default-credential-chain access to the layer's account);
  // when --profile threading is extended to layer materialization, this
  // becomes a `buildStsClientConfig({ region, profile })` call.
  return (region) => new STSClient({ ...buildProxyClientConfig(), region });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildGetLayerVersionCommand(layerArn: string, versionNumber: number): Promise<any> {
  const { GetLayerVersionCommand } = await import('@aws-sdk/client-lambda');
  return new GetLayerVersionCommand({ LayerName: layerArn, VersionNumber: versionNumber });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildAssumeRoleCommand(roleArn: string): Promise<any> {
  const { AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  return new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `${getEmbedConfig().resourceNamePrefix}-layer-${Date.now()}`,
    DurationSeconds: 3600,
  });
}

async function downloadPresignedZip(
  presignedUrl: string,
  options: MaterializeLayerOptions
): Promise<Uint8Array> {
  if (options.fetchZip) return options.fetchZip(presignedUrl);
  // `proxyAwareFetch`, not the global `fetch`: step 2's `GetLayerVersion`
  // goes through the proxy-aware SDK client above, so behind proxy-only
  // egress it SUCCEEDS and this download — the very next step — used to fail
  // direct against the presigned S3 host (issue #647).
  const response = await proxyAwareFetch(presignedUrl);
  if (!response.ok) {
    throw new Error(
      // Issue #579 review round 2 — `statusText` is the HTTP REASON PHRASE, i.e.
      // a string the presigned host chose, and it lands on a default-level
      // line. The HTTP parser forbids CR/LF there, so the forged-LINE half was
      // already closed by the protocol; `\x1b` (an ANSI escape) and U+2028 (a
      // forced break in the studio UI's `<pre>`) are NOT forbidden, and
      // `flattenToOneLine` covers all four categories rather than just the two
      // the parser happens to stop.
      `HTTP ${response.status} ${flattenToOneLine(response.statusText)} from layer Content.Location URL`
    );
  }
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Minimal ZIP unzipper that handles the subset of the ZIP format Lambda
 * layer ZIPs ever use (DEFLATE compression method 8, STORE method 0).
 * Avoids bringing in a heavyweight dep for a 50-line task.
 *
 * Path-traversal guard: every entry's relative path is `normalize()`d
 * and rejected if the resulting absolute path escapes `destDir` (the
 * "Zip Slip" CVE class). Symlinks inside the ZIP are also rejected for
 * the same reason — they could point at arbitrary host paths.
 */
async function unzipBufferToDirectory(zipBytes: Uint8Array, destDir: string): Promise<void> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  // Find the End of Central Directory record (signature 0x06054b50) by
  // scanning the last ~64KB of the buffer backwards.
  const eocdSig = 0x06054b50;
  const maxComment = 0xffff;
  const minScan = Math.max(0, zipBytes.byteLength - maxComment - 22);
  let eocdOffset = -1;
  for (let i = zipBytes.byteLength - 22; i >= minScan; i--) {
    if (view.getUint32(i, true) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Not a ZIP file (no End of Central Directory record found)');
  }
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const destAbsolute = resolve(destDir);
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let parsed = 0;
  while (cursor < cdEnd && parsed < totalEntries) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`Corrupt ZIP: missing Central Directory header at offset ${cursor}`);
    }
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraFieldLength = view.getUint16(cursor + 30, true);
    const fileCommentLength = view.getUint16(cursor + 32, true);
    const externalAttrs = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const fileName = new TextDecoder('utf-8').decode(
      zipBytes.subarray(cursor + 46, cursor + 46 + fileNameLength)
    );
    cursor += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    parsed++;

    // Reject anything that escapes destDir (Zip Slip).
    const normalized = normalize(fileName);
    const targetPath = resolve(destAbsolute, normalized);
    if (!targetPath.startsWith(destAbsolute + (destAbsolute.endsWith('/') ? '' : '/'))) {
      throw new Error(
        `Refusing to extract entry '${fileName}' — path escapes the destination directory`
      );
    }
    // Symlink entries on Unix encode 0xA in the high byte of external
    // attributes (Unix `mode & S_IFMT >> 16` => 0xA000). Rejected
    // because they could redirect to arbitrary host paths.
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new Error(`Refusing to extract symlink entry '${fileName}' from layer ZIP (security)`);
    }

    if (fileName.endsWith('/')) {
      await mkdir(targetPath, { recursive: true });
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });

    // Read the Local File Header to locate the actual data payload.
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Corrupt ZIP: missing Local File Header for '${fileName}'`);
    }
    const lfhFileNameLength = view.getUint16(localHeaderOffset + 26, true);
    const lfhExtraFieldLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + lfhFileNameLength + lfhExtraFieldLength;
    const compressedData = zipBytes.subarray(dataOffset, dataOffset + compressedSize);

    let payload: Uint8Array;
    if (compressionMethod === 0) {
      payload = compressedData;
    } else if (compressionMethod === 8) {
      payload = await inflateRaw(compressedData);
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for entry '${fileName}' (only STORE and DEFLATE supported)`
      );
    }
    if (payload.length !== uncompressedSize && compressionMethod !== 0) {
      throw new Error(
        `ZIP entry '${fileName}': inflate produced ${payload.length} bytes, expected ${uncompressedSize}`
      );
    }
    // Stream the payload through fs.createWriteStream so we never hold
    // a 100MB+ layer ZIP entirely in memory after the network read.
    await pipeline(Readable.from(payload), createWriteStream(targetPath));
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const { inflateRaw: inflate } = await import('node:zlib');
  return new Promise((resolveP, rejectP) => {
    inflate(data, (err, out) => {
      if (err) rejectP(err);
      else resolveP(out);
    });
  });
}

/**
 * Message of a thrown value, for the two throws that are NOT AWS SDK relays.
 *
 * Issue #579 deliberately left these two on `errMsg`: the presigned-URL
 * download is a plain HTTPS fetch (the URL already carries its authorization,
 * so no credential chain is resolved and no modeled service exception is
 * parsed) and the unzip is a purely LOCAL operation. Neither `catch` can see a
 * `credential_process` command line, so there is nothing for the
 * credential-error policy to DECIDE about them. The two AWS calls in this
 * module — STS `AssumeRole` and `lambda:GetLayerVersion` — go through
 * `describeAwsFailureForWarn` instead.
 *
 * CORRECTED in review round 2: an earlier revision of this note claimed these
 * catches see nothing wire-derived at all, which was stronger than the code.
 * The download `catch` DOES see wire-derived text — `downloadPresignedZip`
 * raises `HTTP <status> <statusText> ...`, and the reason phrase is whatever
 * the presigned host sent. Nothing there needs WITHHOLDING (no credential
 * chain, no secret), but it does need FLATTENING.
 *
 * CORRECTED AGAIN in issue #647: that flattening used to be applied at the
 * `HTTP <status>` throw alone, which was sufficient only while `fetch` was the
 * transport and its every failure was the fixed string `fetch failed`. The
 * download now goes through `proxyAwareFetch`, so the same `catch` also sees
 * `node:net` / OpenSSL / proxy-agent messages of arbitrary shape and length.
 * The download SITE therefore applies `sanitizeServiceExceptionMessage` to
 * whatever `errMsg` returns; `errMsg` itself stays bare because its other
 * caller is the unzip `catch`, whose input is a local `fflate` error.
 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function looksLikeAccessDenied(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as { name?: string }).name ?? '';
  const code = (err as { Code?: string }).Code ?? '';
  const message = err.message ?? '';
  return (
    name === 'AccessDeniedException' ||
    code === 'AccessDeniedException' ||
    /access denied/i.test(message) ||
    /not authorized/i.test(message)
  );
}
