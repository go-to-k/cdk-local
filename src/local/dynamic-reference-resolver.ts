import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { buildProxyClientConfig } from '../utils/aws-proxy.js';
import { getLogger } from '../utils/logger.js';
import { describeAwsFailureForWarn } from './credential-error.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { defineOwnKey } from '../utils/own-keys.js';

/**
 * CloudFormation dynamic references (`{{resolve:secretsmanager:...}}`,
 * `{{resolve:ssm:...}}`, `{{resolve:ssm-secure:...}}`) resolved locally,
 * with the developer's own credentials, before a value is handed to a
 * container (issue #784).
 *
 * CloudFormation substitutes these tokens at deploy time, so the deployed
 * resource receives the plaintext; without this module a local container
 * received the literal token text, which is a syntactically valid string that
 * is simply not the secret. Every container-env builder (Lambda, API Gateway,
 * AgentCore, ECS) calls {@link resolveDynamicReferencesInEnv} on its final
 * template-derived env, and the cross-stack substitution path calls
 * {@link DynamicReferenceResolver.resolveString} at the `Fn::ImportValue` /
 * `Fn::GetStackOutput` boundary with the PRODUCER's region — both go through
 * the one parser and the one fetch below, so a same-stack and a cross-stack
 * reference cannot resolve differently.
 *
 * Failure is hard: a missing permission, a missing secret / parameter, or a
 * malformed reference throws {@link DynamicReferenceResolutionError} naming
 * the reference, the env var and the IAM permission the call needs. It never
 * falls back to the token.
 *
 * The resolved plaintext never reaches a log line or an error message
 * (issue #554): errors are raised before a value exists or describe the
 * value's SHAPE only, and the debug line names the env var and the service,
 * never the value.
 */

export class DynamicReferenceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DynamicReferenceResolutionError';
    Object.setPrototypeOf(this, DynamicReferenceResolutionError.prototype);
  }
}

/**
 * A fetch outcome that has not been bound to a consumer yet. The resolver's
 * cache is shared by every caller of one (reference, region), so a failure
 * is stored as this builder and rendered into a
 * {@link DynamicReferenceResolutionError} per caller. Never escapes the
 * resolver.
 */
class DeferredFailure extends Error {
  readonly build: (consumer: string, overridable: boolean) => string;
  constructor(build: (consumer: string, overridable: boolean) => string) {
    super('deferred dynamic-reference failure');
    this.build = build;
  }
  render(opts: ResolveStringOptions): DynamicReferenceResolutionError {
    return new DynamicReferenceResolutionError(
      this.build(opts.consumer, opts.overridable !== false)
    );
  }
}

function deferred(build: (consumer: string, overridable: boolean) => string): DeferredFailure {
  return new DeferredFailure(build);
}

/**
 * Any `{{resolve:...}}` occurrence. Deliberately broader than the grammar:
 * a malformed token (`{{resolve:ssm}}`, a stray `{` in the body) is detected
 * here and REJECTED by {@link parseDynamicReference}, rather than slipping
 * through to the container as text.
 */
const DYNAMIC_REFERENCE_SOURCE = String.raw`\{\{resolve:[^}]*\}\}`;
/** Stateless (non-global) form for detection: `.test` on a `/g` regex advances `lastIndex`. */
const DYNAMIC_REFERENCE_DETECT = new RegExp(DYNAMIC_REFERENCE_SOURCE);

/** A fresh global matcher per scan, so no `lastIndex` is shared between calls. */
function dynamicReferenceMatcher(): RegExp {
  return new RegExp(DYNAMIC_REFERENCE_SOURCE, 'g');
}

/**
 * The first candidate that names a real region. An environment-agnostic CDK
 * stack synthesizes its region as the literal placeholder `unknown-region`,
 * which must fall through to the next candidate (or to the SDK default chain)
 * rather than become an unreachable endpoint host.
 */
export function firstUsableRegion(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((r) => r !== undefined && r !== '' && r !== 'unknown-region');
}

/**
 * Template env keys an `--env-vars` override replaces or clears, found by
 * running the caller's own override function over sentinel values. Removing
 * them BEFORE state substitution means an override also skips a cross-stack
 * dynamic-reference lookup, as the resolver's error message promises.
 */
export function keysOverriddenBy(
  templateEnv: Record<string, unknown> | undefined,
  applyOverrides: (env: Record<string, string>) => Record<string, string>
): Set<string> {
  const out = new Set<string>();
  if (!templateEnv) return out;
  const sentinel: Record<string, string> = {};
  for (const k of Object.keys(templateEnv)) defineOwnKey(sentinel, k, `\u0000cdkl-sentinel:${k}`);
  const applied = applyOverrides(sentinel);
  for (const k of Object.keys(templateEnv)) {
    if (!Object.hasOwn(applied, k) || applied[k] !== sentinel[k]) out.add(k);
  }
  return out;
}

/** Copy of `env` without `keys` (own-key safe). */
export function withoutKeys<T>(
  env: Record<string, T>,
  keys: ReadonlySet<string>
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(env)) if (!keys.has(k)) defineOwnKey(out, k, env[k]!);
  return out;
}

/** True when `value` contains at least one `{{resolve:...}}` dynamic reference. */
export function containsDynamicReference(value: unknown): value is string {
  return typeof value === 'string' && DYNAMIC_REFERENCE_DETECT.test(value);
}

export interface SecretsManagerReference {
  service: 'secretsmanager';
  /** The full `{{resolve:...}}` token, as written. */
  raw: string;
  /** Secret name or full ARN. */
  secretId: string;
  /** Region carried by an ARN `secretId`; undefined for a name. */
  arnRegion?: string;
  /** Top-level key of the JSON SecretString to extract. */
  jsonKey?: string;
  versionStage?: string;
  versionId?: string;
}

export interface SsmReference {
  service: 'ssm' | 'ssm-secure';
  raw: string;
  /** Parameter name or ARN, without the version suffix. */
  name: string;
  /** Region carried by an ARN name; undefined for a plain name. */
  arnRegion?: string;
  /** Parameter version (`name:<version>`). */
  version?: string;
}

export type DynamicReference = SecretsManagerReference | SsmReference;

function malformed(raw: string, why: string): DynamicReferenceResolutionError {
  return new DynamicReferenceResolutionError(
    `Malformed CloudFormation dynamic reference ${displayUntrustedValue(raw)}: ${why}.`
  );
}

/**
 * Parse one `{{resolve:...}}` token per the CloudFormation grammar:
 *
 *   - `{{resolve:secretsmanager:<secret-id>:SecretString:<json-key>:<version-stage>:<version-id>}}`
 *     — every segment after `<secret-id>` optional, an empty segment meaning
 *     the default; `<secret-id>` is a name or a full ARN.
 *   - `{{resolve:ssm:<parameter-name>[:<version>]}}`
 *   - `{{resolve:ssm-secure:<parameter-name>[:<version>]}}`
 *
 * Throws {@link DynamicReferenceResolutionError} on any other shape.
 */
export function parseDynamicReference(raw: string): DynamicReference {
  const m = /^\{\{resolve:([^:{}]*):([^{}]*)\}\}$/.exec(raw);
  if (!m) throw malformed(raw, 'expected {{resolve:<service>:<reference>}}');
  const service = m[1]!;
  const body = m[2]!;
  if (service === 'secretsmanager') return parseSecretsManager(raw, body);
  if (service === 'ssm' || service === 'ssm-secure') return parseSsm(raw, service, body);
  throw malformed(
    raw,
    `unsupported service ${displayUntrustedValue(service)} (expected secretsmanager, ssm or ssm-secure)`
  );
}

function parseSecretsManager(raw: string, body: string): SecretsManagerReference {
  const parts = body.split(':');
  let secretId: string;
  let rest: string[];
  let arnRegion: string | undefined;
  if (body.startsWith('arn:')) {
    // arn:<partition>:secretsmanager:<region>:<account>:secret:<name>
    if (parts.length < 7 || parts[2] !== 'secretsmanager' || parts[5] !== 'secret' || !parts[6]) {
      throw malformed(
        raw,
        'the secret ARN is not arn:<partition>:secretsmanager:<region>:<account>:secret:<name>'
      );
    }
    secretId = parts.slice(0, 7).join(':');
    arnRegion = parts[3] || undefined;
    rest = parts.slice(7);
  } else {
    secretId = parts[0]!;
    rest = parts.slice(1);
  }
  if (secretId.length === 0) throw malformed(raw, 'the secret id is empty');
  if (rest.length > 4) {
    throw malformed(
      raw,
      'too many segments after the secret id (expected SecretString:<json-key>:<version-stage>:<version-id>)'
    );
  }
  const [secretString, jsonKey, versionStage, versionId] = rest;
  if (secretString !== undefined && secretString !== '' && secretString !== 'SecretString') {
    throw malformed(raw, 'the only supported value segment is SecretString');
  }
  if (versionStage && versionId) {
    throw malformed(raw, 'specify a version stage or a version id, not both');
  }
  return {
    service: 'secretsmanager',
    raw,
    secretId,
    ...(arnRegion !== undefined && { arnRegion }),
    ...(jsonKey && { jsonKey }),
    ...(versionStage && { versionStage }),
    ...(versionId && { versionId }),
  };
}

function parseSsm(raw: string, service: 'ssm' | 'ssm-secure', body: string): SsmReference {
  const parts = body.split(':');
  let nameParts: string[];
  let versionParts: string[];
  let arnRegion: string | undefined;
  if (body.startsWith('arn:')) {
    // arn:<partition>:ssm:<region>:<account>:parameter/<name>
    if (parts.length < 6 || parts[2] !== 'ssm' || !parts[5]?.startsWith('parameter/')) {
      throw malformed(
        raw,
        'the parameter ARN is not arn:<partition>:ssm:<region>:<account>:parameter/<name>'
      );
    }
    nameParts = parts.slice(0, 6);
    versionParts = parts.slice(6);
    arnRegion = parts[3] || undefined;
  } else {
    nameParts = parts.slice(0, 1);
    versionParts = parts.slice(1);
  }
  const name = nameParts.join(':');
  if (name.length === 0) throw malformed(raw, 'the parameter name is empty');
  if (versionParts.length > 1) throw malformed(raw, 'too many segments after the parameter name');
  const version = versionParts[0];
  if (version !== undefined && !/^[1-9]\d*$/.test(version)) {
    throw malformed(raw, 'the parameter version must be a positive integer');
  }
  return {
    service,
    raw,
    name,
    ...(arnRegion !== undefined && { arnRegion }),
    ...(version !== undefined && { version }),
  };
}

/** The IAM permissions a reference's fetch needs, for error messages. */
export function requiredPermissionsFor(ref: DynamicReference): string {
  switch (ref.service) {
    case 'secretsmanager':
      return 'secretsmanager:GetSecretValue (plus kms:Decrypt when the secret uses a customer managed KMS key)';
    case 'ssm':
      return 'ssm:GetParameter';
    case 'ssm-secure':
      return 'ssm:GetParameter and kms:Decrypt on the parameter key';
  }
}

export interface DynamicReferenceResolverOptions {
  /**
   * The CLI's `--profile`, so the fetch authenticates as the account the
   * template was deployed to. Undefined uses the default credential chain.
   */
  profile?: string;
  /**
   * Test seams: build a client for a region (`undefined` = the SDK default
   * region chain). Production leaves both unset.
   */
  secretsManagerClientFactory?: (
    region: string | undefined
  ) => Pick<SecretsManagerClient, 'send' | 'destroy'>;
  ssmClientFactory?: (region: string | undefined) => Pick<SSMClient, 'send' | 'destroy'>;
}

export interface ResolveStringOptions {
  /**
   * Region of the stack that owns the value. An ARN reference's own region
   * wins over it; undefined falls back to the SDK default chain (`AWS_REGION`
   * / the profile's region).
   */
  region?: string | undefined;
  /** Who consumes the value, e.g. `Lambda MyFn env var TOKEN`, for errors. */
  consumer: string;
  /**
   * Whether an `--env-vars` override can skip this lookup, which decides
   * whether the error suggests one. Default true; false at a cross-stack
   * boundary that runs before overrides are applied.
   */
  overridable?: boolean;
}

/**
 * Resolves dynamic references with per-region SDK clients and a per-instance
 * cache, so one container boot fetches each (reference, region) once. Call
 * {@link dispose} when done.
 */
export class DynamicReferenceResolver {
  private readonly smClients = new Map<string, Pick<SecretsManagerClient, 'send' | 'destroy'>>();
  private readonly ssmClients = new Map<string, Pick<SSMClient, 'send' | 'destroy'>>();
  private readonly cache = new Map<string, Promise<string>>();

  private readonly options: DynamicReferenceResolverOptions;

  constructor(options: DynamicReferenceResolverOptions = {}) {
    this.options = options;
  }

  /**
   * Replace every dynamic reference in `value` with its resolved plaintext.
   * A value with no reference is returned unchanged without an AWS call. The
   * replacement is a single pass over the ORIGINAL text, so a resolved value
   * that itself contains `{{resolve:` is never re-scanned.
   */
  async resolveString(value: string, opts: ResolveStringOptions): Promise<string> {
    if (!containsDynamicReference(value)) return value;
    const tokens = [...value.matchAll(dynamicReferenceMatcher())].map((m) => m[0]);
    const resolved = await Promise.all(tokens.map((t) => this.resolveToken(t, opts)));
    let i = 0;
    return value.replace(dynamicReferenceMatcher(), () => resolved[i++]!);
  }

  dispose(): void {
    for (const c of this.smClients.values()) c.destroy();
    for (const c of this.ssmClients.values()) c.destroy();
    this.smClients.clear();
    this.ssmClients.clear();
    this.cache.clear();
  }

  private resolveToken(raw: string, opts: ResolveStringOptions): Promise<string> {
    let ref: DynamicReference;
    try {
      ref = parseDynamicReference(raw);
    } catch (err) {
      if (!(err instanceof DynamicReferenceResolutionError)) throw err;
      return Promise.reject(
        new DynamicReferenceResolutionError(`${err.message.replace(/\.$/, '')} (${opts.consumer}).`)
      );
    }
    const region = firstUsableRegion(ref.arnRegion, opts.region);
    const cacheKey = `${region ?? ''}\u0000${raw}`;
    let pending = this.cache.get(cacheKey);
    if (!pending) {
      pending =
        ref.service === 'secretsmanager'
          ? this.fetchSecret(ref, region)
          : this.fetchParameter(ref, region);
      this.cache.set(cacheKey, pending);
      // A failed fetch is not cached: the error propagates to its callers,
      // and a later call (a --watch rebuild) retries.
      pending.catch(() => this.cache.delete(cacheKey));
    }
    // The cache holds the consumer-free OUTCOME; the error (and the debug
    // line) is rendered per caller, so a second consumer sharing the fetch
    // is named in its own failure rather than the first one's.
    const service = ref.service;
    return pending.then(
      (value) => {
        getLogger()
          .child('dynamic-reference')
          .debug(`Resolved ${service} dynamic reference for ${opts.consumer}`);
        return value;
      },
      (err: unknown) => {
        throw err instanceof DeferredFailure ? err.render(opts) : err;
      }
    );
  }

  private smClient(region: string | undefined): Pick<SecretsManagerClient, 'send' | 'destroy'> {
    const key = region ?? '';
    let c = this.smClients.get(key);
    if (!c) {
      c =
        this.options.secretsManagerClientFactory?.(region) ??
        new SecretsManagerClient({
          ...buildProxyClientConfig({ profile: this.options.profile }),
          ...(region && { region }),
          ...(this.options.profile && { profile: this.options.profile }),
        });
      this.smClients.set(key, c);
    }
    return c;
  }

  private ssmClient(region: string | undefined): Pick<SSMClient, 'send' | 'destroy'> {
    const key = region ?? '';
    let c = this.ssmClients.get(key);
    if (!c) {
      c =
        this.options.ssmClientFactory?.(region) ??
        new SSMClient({
          ...buildProxyClientConfig({ profile: this.options.profile }),
          ...(region && { region }),
          ...(this.options.profile && { profile: this.options.profile }),
        });
      this.ssmClients.set(key, c);
    }
    return c;
  }

  private fetchFailure(
    ref: DynamicReference,
    region: string | undefined,
    operation: string,
    err: unknown
  ): DeferredFailure {
    // Raised BEFORE any value exists, so the relayed SDK detail is about the
    // reference (AccessDenied / ResourceNotFound / ParameterNotFound), never
    // the secret. `describeAwsFailureForWarn` withholds a credential-chain
    // failure's message (issue #579), exactly as the ECS Secrets resolver does.
    const name = err instanceof Error ? err.name : '';
    let hint = '';
    if (/NotFound/.test(name)) {
      hint = ` The ${ref.service === 'secretsmanager' ? 'secret' : 'parameter'} (or the requested version) does not exist in ${region ?? 'the default region'}.`;
    } else if (/AccessDenied|NotAuthorized|UnrecognizedClient|ExpiredToken/.test(name)) {
      hint = ' The credentials cdk-local resolves with were refused.';
    }
    // Rendered ONCE: `describeAwsFailureForWarn` emits its own debug line.
    const detail = describeAwsFailureForWarn(err, operation);
    return deferred(
      (consumer, overridable) =>
        `Could not resolve CloudFormation dynamic reference ${displayUntrustedValue(ref.raw)} for ${consumer} ` +
        `(${operation} in ${region ?? 'the default region'}): ${detail}.${hint} ` +
        `Resolving it needs ${requiredPermissionsFor(ref)}. ` +
        'cdk-local does not fall back to the unresolved token' +
        (overridable ? '; override the variable with --env-vars to skip the lookup.' : '.')
    );
  }

  private async fetchSecret(
    ref: SecretsManagerReference,
    region: string | undefined
  ): Promise<string> {
    const operation = 'SecretsManager GetSecretValue';
    let secretString: string | undefined;
    try {
      const resp = await this.smClient(region).send(
        new GetSecretValueCommand({
          SecretId: ref.secretId,
          ...(ref.versionStage && { VersionStage: ref.versionStage }),
          ...(ref.versionId && { VersionId: ref.versionId }),
        })
      );
      secretString = resp.SecretString;
    } catch (err) {
      throw this.fetchFailure(ref, region, operation, err);
    }
    if (secretString === undefined) {
      throw deferred(
        (consumer) =>
          `CloudFormation dynamic reference ${displayUntrustedValue(ref.raw)} for ${consumer}: ` +
          'the secret has no SecretString (binary secrets cannot be referenced).'
      );
    }
    if (ref.jsonKey === undefined) return secretString;
    const jsonKey = ref.jsonKey;

    let parsed: unknown;
    try {
      parsed = JSON.parse(secretString);
    } catch (err) {
      // Never interpolate the parser's message: V8 quotes the parsed input,
      // which is the secret plaintext (issue #554).
      const kind = err instanceof Error ? err.name : 'unknown';
      throw deferred(
        (consumer) =>
          `CloudFormation dynamic reference ${displayUntrustedValue(ref.raw)} for ${consumer} names json-key ` +
          `${displayUntrustedValue(jsonKey)} but the secret value is not valid JSON (${kind}). ` +
          'The parser detail is withheld because it would echo the secret plaintext.'
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw deferred(
        (consumer) =>
          `CloudFormation dynamic reference ${displayUntrustedValue(ref.raw)} for ${consumer} names json-key ` +
          `${displayUntrustedValue(jsonKey)} but the secret root is not a JSON object.`
      );
    }
    if (!Object.hasOwn(parsed, jsonKey)) {
      throw deferred(
        (consumer) =>
          `CloudFormation dynamic reference ${displayUntrustedValue(ref.raw)} for ${consumer} names json-key ` +
          `${displayUntrustedValue(jsonKey)} but no such key exists in the secret JSON.`
      );
    }
    const value = (parsed as Record<string, unknown>)[jsonKey];
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  private async fetchParameter(ref: SsmReference, region: string | undefined): Promise<string> {
    const operation = 'SSM GetParameter';
    let value: string | undefined;
    let type: string | undefined;
    try {
      const resp = await this.ssmClient(region).send(
        new GetParameterCommand({
          Name: ref.version !== undefined ? `${ref.name}:${ref.version}` : ref.name,
          WithDecryption: ref.service === 'ssm-secure',
        })
      );
      value = resp.Parameter?.Value;
      type = resp.Parameter?.Type;
    } catch (err) {
      throw this.fetchFailure(ref, region, operation, err);
    }
    if (value === undefined) {
      throw deferred(
        (consumer) =>
          `CloudFormation dynamic reference ${displayUntrustedValue(ref.raw)} for ${consumer}: SSM returned no parameter value.`
      );
    }
    if (ref.service === 'ssm' && type === 'SecureString') {
      // CloudFormation rejects an `ssm` reference to a SecureString; without
      // decryption the value here would be ciphertext.
      throw deferred(
        (consumer) =>
          `CloudFormation dynamic reference ${displayUntrustedValue(ref.raw)} for ${consumer} names a SecureString parameter; ` +
          'use {{resolve:ssm-secure:...}} for SecureString parameters.'
      );
    }
    return value;
  }
}

export interface ResolveEnvDynamicReferencesOptions extends DynamicReferenceResolverOptions {
  /** Region of the stack that owns the env (see {@link ResolveStringOptions.region}). */
  region?: string | undefined;
  /** Prefix naming the consumer, e.g. `Lambda MyFn`; the env key is appended. */
  label: string;
  /**
   * Keys to leave untouched: values that are already plaintext from another
   * source (a decrypted SecureString, a deployed-function env fallback) or
   * that a `--env-vars` override replaced. Scanning a plaintext for a token
   * would put a fragment of it into an error message.
   */
  skipKeys?: ReadonlySet<string>;
  /** Reuse an existing resolver (and its cache); otherwise one is created and disposed. */
  resolver?: DynamicReferenceResolver;
}

/**
 * Keys of `finalEnv` whose value did NOT come from `templateEnv` unchanged —
 * a `--env-vars` override replaced it, or the template never declared it.
 * Those are the developer's local literals, which CloudFormation never sees,
 * so they are not resolved: an override is also how a developer skips a
 * lookup they lack permission for.
 */
export function keysNotFromTemplate(
  templateEnv: Record<string, unknown> | undefined,
  finalEnv: Record<string, string>
): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(finalEnv)) {
    const declared =
      templateEnv !== undefined && Object.hasOwn(templateEnv, k) ? templateEnv[k] : undefined;
    if (
      declared === undefined ||
      (typeof declared !== 'string' &&
        typeof declared !== 'number' &&
        typeof declared !== 'boolean') ||
      String(declared) !== v
    ) {
      out.add(k);
    }
  }
  return out;
}

/**
 * Resolve every dynamic reference in an env map. Returns a new map (own-key
 * copies) and the keys whose value changed — the caller routes those off the
 * `docker run` argv the same way it routes a decrypted SecureString.
 */
export async function resolveDynamicReferencesInEnv(
  env: Record<string, string>,
  options: ResolveEnvDynamicReferencesOptions
): Promise<{ env: Record<string, string>; resolvedKeys: string[] }> {
  const candidates = Object.keys(env).filter(
    (k) => !options.skipKeys?.has(k) && containsDynamicReference(env[k])
  );
  if (candidates.length === 0) return { env, resolvedKeys: [] };
  const resolver = options.resolver ?? new DynamicReferenceResolver(options);
  try {
    const values = await Promise.all(
      candidates.map((k) =>
        resolver.resolveString(env[k]!, {
          region: options.region,
          consumer: `${options.label} env var ${displayUntrustedValue(k)}`,
        })
      )
    );
    // Own-key copies: a variable named `__proto__` must survive (#769).
    const out: Record<string, string> = {};
    for (const k of Object.keys(env)) defineOwnKey(out, k, env[k]!);
    candidates.forEach((k, i) => defineOwnKey(out, k, values[i]!));
    return { env: out, resolvedKeys: candidates };
  } finally {
    if (!options.resolver) resolver.dispose();
  }
}
