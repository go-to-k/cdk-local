import { readFileSync } from 'node:fs';

/**
 * CloudFront KeyValueStore support for `cdkl start-cloudfront`'s CloudFront
 * Functions (the `import cf from 'cloudfront'; cf.kvs().get(...)` runtime API).
 *
 * A CloudFront Function backed by a KeyValueStore is the user's own application
 * compute, run locally in the `node:vm` sandbox the same way every other
 * CloudFront Function is — but its `cf.kvs().get(key)` reads need a backing
 * store. KVS is a managed service cdk-local does NOT emulate; instead a
 * `cf.kvs()` read is served from one of two bindings the command layer resolves:
 *
 *   - the deployed store (`--from-cfn-stack`) via the real
 *     `cloudfront-keyvaluestore` data-plane `GetKey` API (see
 *     `cloudfront-kvs-client.ts`) — application compute local, managed service
 *     real AWS, exactly like a Lambda reaching real DynamoDB; or
 *   - a local JSON map (`--kvs-file <id>=<file.json>`), so KVS-driven routing
 *     logic is testable with no AWS deploy.
 *
 * This module owns the binding-agnostic pieces: the {@link KvsDataSource}
 * abstraction both bindings implement, the local-file data source, and the
 * `cf` module shim (`cf.kvs(id?)` -> a handle with the `get` / `exists`
 * methods) injected into the sandbox. The deployed data source lives in
 * `cloudfront-kvs-client.ts` so the AWS SDK boundary is isolated + mockable.
 *
 * Out of scope: `cf.kvs().meta()` / `cf.kvs().count()` (rare in routing
 * functions, and the deployed forms need extra control-plane calls) surface a
 * clear "not reproduced locally" error rather than a wrong value. KVS writes
 * are not a Function runtime API (a Function can only read), so only reads are
 * reproduced.
 */

/**
 * A backing store for a CloudFront Function's `cf.kvs()` reads. Both the
 * deployed (`GetKey`) and local-file bindings implement this so the `cf` shim
 * is binding-agnostic.
 */
export interface KvsDataSource {
  /** Human-readable label surfaced in errors (e.g. `deployed:<arn>` / `file:<path>`). */
  readonly label: string;
  /**
   * The KeyValueStore Id (the ARN's last segment) this source represents, when
   * known — used to match a `cf.kvs(<id>)` call that names a specific store.
   * Absent for a local-file source keyed only by its `--kvs-file` id.
   */
  readonly kvsId?: string;
  /** Return the value for `key`, or `undefined` when the key is absent. */
  getValue(key: string): Promise<string | undefined>;
}

/** A handle returned by `cf.kvs(id?)` — the subset of the runtime API cdk-local reproduces. */
export interface CloudFrontKvsHandle {
  /**
   * `get(key, { format })` — resolve the key's value. Rejects when the key is
   * absent (matching the deployed runtime, which rejects rather than returning
   * `undefined`). `format: 'json'` parses the value as JSON; the default
   * returns the raw string.
   */
  get(key: string, options?: { format?: 'string' | 'json' }): Promise<unknown>;
  /** `exists(key)` — true when the key is present. */
  exists(key: string): Promise<boolean>;
  /** Not reproduced locally — throws a clear error. */
  meta(): Promise<never>;
  /** Not reproduced locally — throws a clear error. */
  count(): Promise<never>;
}

/** The `cf` module bound into the sandbox (`import cf from 'cloudfront'`). */
export interface CloudFrontModule {
  /**
   * `cf.kvs(id?)` — select the associated KeyValueStore. With no argument it
   * returns the function's single association (the common case); with an id it
   * matches the store by id, falling back to the sole source when only one is
   * associated.
   */
  kvs(kvsId?: string): CloudFrontKvsHandle;
}

/** Build a `cf` module backed by the resolved data sources for one function. */
export function createCloudFrontModule(sources: readonly KvsDataSource[]): CloudFrontModule {
  return {
    kvs(kvsId?: string): CloudFrontKvsHandle {
      return makeHandle(pickSource(sources, kvsId));
    },
  };
}

/**
 * The `cf` module bound when a function calls `cf.kvs()` but no KeyValueStore
 * binding was resolved (no `--from-cfn-stack`, no covering `--kvs-file`). The
 * handle is returned successfully so a top-level `cf.kvs()` call does not throw
 * at module-eval; the actionable error surfaces when the function actually
 * reads a key.
 */
export function createUnboundCloudFrontModule(functionLogicalId: string): CloudFrontModule {
  const fail = (): Promise<never> =>
    Promise.reject(
      new Error(
        `CloudFront Function '${functionLogicalId}' reads from a KeyValueStore (cf.kvs()), but no ` +
          'KeyValueStore binding is available locally. Pass --from-cfn-stack to read the deployed ' +
          'store, or --kvs-file <id>=<file.json> to back it with a local JSON map.'
      )
    );
  const handle: CloudFrontKvsHandle = {
    get: () => fail(),
    exists: () => fail(),
    meta: () => fail(),
    count: () => fail(),
  };
  return { kvs: () => handle };
}

function pickSource(sources: readonly KvsDataSource[], kvsId: string | undefined): KvsDataSource {
  if (sources.length === 0) {
    throw new Error('cf.kvs(): no KeyValueStore is associated with this function.');
  }
  if (kvsId === undefined) return sources[0]!;
  const byId = sources.find((s) => s.kvsId === kvsId);
  if (byId) return byId;
  // Lenient single-association fallback: a function with one associated store
  // that names it by a hardcoded id still resolves to that sole source.
  if (sources.length === 1) return sources[0]!;
  throw new Error(
    `cf.kvs('${kvsId}'): no associated KeyValueStore matches this id locally ` +
      `(associated: ${sources.map((s) => s.kvsId ?? s.label).join(', ')}).`
  );
}

function makeHandle(source: KvsDataSource): CloudFrontKvsHandle {
  return {
    async get(key: string, options?: { format?: 'string' | 'json' }): Promise<unknown> {
      const value = await source.getValue(key);
      if (value === undefined) {
        throw new Error(`cf.kvs().get('${key}'): key not found in ${source.label}.`);
      }
      if (options?.format === 'json') {
        try {
          return JSON.parse(value) as unknown;
        } catch (err) {
          throw new Error(
            `cf.kvs().get('${key}', { format: 'json' }): value is not valid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      return value;
    },
    async exists(key: string): Promise<boolean> {
      return (await source.getValue(key)) !== undefined;
    },
    meta(): Promise<never> {
      return Promise.reject(
        new Error(
          'cf.kvs().meta() is not reproduced locally by cdkl start-cloudfront (only get / exists are supported).'
        )
      );
    },
    count(): Promise<never> {
      return Promise.reject(
        new Error(
          'cf.kvs().count() is not reproduced locally by cdkl start-cloudfront (only get / exists are supported).'
        )
      );
    },
  };
}

/**
 * Build a {@link KvsDataSource} from a local JSON file (the `--kvs-file
 * <id>=<file.json>` escape hatch). The file is a flat `{ "key": "value" }`
 * object; non-string values are JSON-stringified (KVS values are always
 * strings). Read once at construction (boot time); a `--watch` reload rebuilds
 * it.
 */
export function createLocalFileKvsDataSource(args: {
  id: string;
  filePath: string;
}): KvsDataSource {
  let raw: string;
  try {
    raw = readFileSync(args.filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `--kvs-file '${args.id}=${args.filePath}': could not read the file: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--kvs-file '${args.id}=${args.filePath}': not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `--kvs-file '${args.id}=${args.filePath}': expected a JSON object of key -> value entries.`
    );
  }
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return {
    label: `file:${args.filePath}`,
    kvsId: args.id,
    getValue: (key: string): Promise<string | undefined> => Promise.resolve(map.get(key)),
  };
}
