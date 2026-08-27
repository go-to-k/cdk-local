// Side-effect import: the `cloudfront-keyvaluestore` data-plane API is signed
// with SigV4A (asymmetric, multi-region), and the AWS SDK does NOT bundle a
// SigV4A signer by default — importing this package registers the pure-JS
// implementation into the shared signer container, without which every GetKey
// fails with "Neither CRT nor JS SigV4a implementation is available".
import '@aws-sdk/signature-v4a';
import { CloudFrontClient, paginateListKeyValueStores } from '@aws-sdk/client-cloudfront';
import {
  CloudFrontKeyValueStoreClient,
  GetKeyCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { getLogger } from '../utils/logger.js';
import {
  describeAwsFailureForWarn,
  flattenToOneLine,
  stringifyThrown,
} from './credential-error.js';
import type { KvsDataSource } from './cloudfront-kvs.js';

/**
 * Static AWS credentials for the deployed `GetKey` client. A structural subset
 * of the SDK's `AwsCredentialIdentity` (accepted by the client `credentials`
 * option) so cdk-local does not depend on `@aws-sdk/types`. Matches the
 * `ResolvedProfileCredentials` shape the command layer threads in.
 */
export interface KvsClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * The deployed-store {@link KvsDataSource} for `cdkl start-cloudfront`'s
 * CloudFront Functions under `--from-cfn-stack` (issue follow-up to #363): a
 * `cf.kvs().get(key)` read is served by the real `cloudfront-keyvaluestore`
 * data-plane `GetKey` API against the deployed KeyValueStore's ARN. The SDK
 * client handles the API's SigV4A signing, so cdk-local does not hand-sign.
 *
 * This isolates the AWS SDK boundary from the binding-agnostic `cf` shim in
 * `cloudfront-kvs.ts` so unit tests can mock `GetKeyCommand` here and the shim
 * can be tested over a plain fake source. Consumed by the `start-cloudfront`
 * command's KVS-binding resolution; a host CLI wiring KVS reads can build the
 * same source via the `cdk-local/internal` re-export.
 *
 * KVS is a global CloudFront service whose data-plane endpoint is resolved by
 * the SDK; the client region defaults to `us-east-1` (where CloudFront's global
 * resources live) and can be overridden. Reads require the caller's credentials
 * to carry `cloudfront-keyvaluestore:GetKey`.
 */
export interface CreateDeployedKvsDataSourceOptions {
  /** The deployed KeyValueStore ARN (the `KvsARN` GetKey parameter). */
  kvsArn: string;
  /** The store Id (ARN last segment), for matching a `cf.kvs(<id>)` call. */
  kvsId?: string;
  /** Client region (defaults to `us-east-1` — CloudFront's global region). */
  region?: string;
  /** Explicit credentials; when absent the SDK's default credential chain is used. */
  credentials?: KvsClientCredentials;
}

/**
 * Build a {@link KvsDataSource} backed by the deployed store's `GetKey` API.
 * A missing key resolves to `undefined` (the `ResourceNotFoundException` is
 * caught) so the `cf` shim can surface a clean "key not found" — any other
 * error (access denied, throttling) propagates so the user sees the real cause.
 */
export function createDeployedKvsDataSource(
  options: CreateDeployedKvsDataSourceOptions
): KvsDataSource {
  const client = new CloudFrontKeyValueStoreClient({
    region: options.region ?? 'us-east-1',
    ...(options.credentials !== undefined && { credentials: options.credentials }),
  });
  return {
    label: `deployed:${options.kvsArn}`,
    ...(options.kvsId !== undefined && { kvsId: options.kvsId }),
    async getValue(key: string): Promise<string | undefined> {
      try {
        const out = await client.send(new GetKeyCommand({ KvsARN: options.kvsArn, Key: key }));
        return out.Value;
      } catch (err) {
        if (isKeyNotFound(err)) return undefined;
        // Issue #579. LEVEL: this throw propagates out of the function sandbox
        // to `cloudfront-server.ts`'s top-level handler, which relays its
        // `message` into a DEFAULT-level `Request handling failed:` warn (and
        // answers a fixed 500) -- so it IS a default-level line, one level up.
        // RECONSTRUCTION: the `catch` wraps `client.send(GetKeyCommand)`, which
        // resolves the credential chain before the request, so it sees both a
        // `CredentialsProviderError` and a modeled
        // `cloudfront-keyvaluestore` exception whose message is the diagnosis.
        throw new Error(
          // `kvsArn` is WIRE-DERIVED: `resolveDeployedKvsArnByName` copies
          // `item.ARN` out of a `ListKeyValueStores` response with no
          // validation, and this throw is relayed into a DEFAULT-level warn by
          // `cloudfront-server.ts`. Same class as the `PhysicalResourceId`
          // flatten (issue #579 review round 3).
          `cf.kvs().get('${key}') against ${flattenToOneLine(options.kvsArn)} failed: ${describeAwsFailureForWarn(
            err,
            'CloudFront KeyValueStore GetKey'
          )}`
        );
      }
    },
  };
}

/**
 * Resolve a deployed KeyValueStore's ARN (+ Id) from its NAME via the
 * CloudFront control-plane `ListKeyValueStores` API. Needed because
 * `--from-cfn-stack` reads the store's physical id from `ListStackResources`,
 * and for `AWS::CloudFront::KeyValueStore` that physical id is the store NAME
 * (the `Ref` value) — NOT the ARN. The data-plane `GetKey` needs the ARN (which
 * embeds the store's UUID Id), so we look the name up against the account's
 * stores. CloudFront is global, so the client defaults to `us-east-1`. Returns
 * `undefined` on any miss (no match, access denied) so the caller falls back to
 * the unbound-KVS warning.
 */
export async function resolveDeployedKvsArnByName(
  name: string,
  options: { region?: string; credentials?: KvsClientCredentials } = {}
): Promise<{ arn: string; id?: string } | undefined> {
  const client = new CloudFrontClient({
    region: options.region ?? 'us-east-1',
    ...(options.credentials !== undefined && { credentials: options.credentials }),
  });
  try {
    for await (const page of paginateListKeyValueStores({ client }, {})) {
      for (const item of page.KeyValueStoreList?.Items ?? []) {
        if (item.Name === name && item.ARN) {
          return { arn: item.ARN, ...(item.Id !== undefined && { id: item.Id }) };
        }
      }
    }
  } catch (err) {
    // Issue #579. LEVEL: `debug`, so only a reader who asked with `--verbose`
    // sees it -- the message is KEPT rather than withheld, exactly as
    // `sigv4-verify` keeps its own text at `debug`. It is still FLATTENED,
    // because the `debug` stream is the same stdout `cdkl studio` mirrors into
    // an HTTP-served ring, so a `\n` would forge a line there as surely as at
    // `warn`. RECONSTRUCTION does not arise: nothing is withheld, so there is
    // no population to split.
    getLogger().debug(
      `ListKeyValueStores lookup for '${name}' failed: ${flattenToOneLine(stringifyThrown(err))}`
    );
  }
  return undefined;
}

/** True when a GetKey error means the key (or store) was not found, not a real failure. */
function isKeyNotFound(err: unknown): boolean {
  if (err instanceof ResourceNotFoundException) return true;
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (name === 'ResourceNotFoundException') return true;
    const status = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
    if (status === 404) return true;
  }
  return false;
}
