/**
 * SigV4 signature verification for REST v1 `AuthorizationType: 'AWS_IAM'`
 * authorizers (closes #447).
 *
 * # Scope
 *
 * cdk-local's `cdkl start-api` runs API Gateway routes locally. When a
 * route declares `AuthorizationType: 'AWS_IAM'`, AWS-deployed API Gateway
 * validates the request's SigV4 signature against the calling identity's
 * IAM permissions. We can't fully reproduce that locally — IAM policy
 * evaluation requires the deployed IAM data plane — so the local server
 * does the **signature-verification** half only:
 *
 *   1. Parse the `Authorization: AWS4-HMAC-SHA256 ...` header into the
 *      `(credential, signedHeaders, signature)` triple.
 *   2. Reconstruct the canonical request per
 *      <https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html>.
 *   3. Derive the signing key from the dev's **local** secret access key
 *      (via the standard AWS SDK credential chain) + the request's date /
 *      region / service scope.
 *   4. Compare the recomputed signature against the header's `signature`
 *      value (constant-time compare).
 *
 * # Local-vs-deployed semantics
 *
 * Verification can only succeed when the request was signed with the
 * **same** credentials the local server can read. SigV4 is an HMAC
 * (shared-secret) signature: reproducing it requires the signer's secret
 * key. For a foreign access-key-id — a federated / Cognito Identity Pool /
 * cross-account signer — cdk-local does not have that secret and AWS never
 * publishes it, so local verification is **impossible**. The deployed API
 * Gateway CAN verify the very same request because AWS holds the secret;
 * this asymmetry is a local-only limitation, not a sign the request is
 * invalid.
 *
 * When the request's `Credential=AKID/...` scope names a different
 * access-key-id than the one the dev has locally (or no local credentials
 * resolve at all), we therefore **warn-and-pass by default**: allow + a
 * one-line warn + an obviously-fake principalId
 * (`unverified-foreign-identity` / `unverified-no-creds`). Local execution
 * is overwhelmingly used to exercise app logic and ergonomics, not to
 * reproduce an authorization boundary cdk-local cannot fully emulate
 * anyway — so blocking the most common legitimate case (federated /
 * Cognito Identity Pool / cross-account signers, which are foreign by
 * construction) is the wrong default. The fake principalId keeps
 * identity-based handler authz from silently trusting a forged caller, and
 * the deployed API Gateway still does the real verification + IAM
 * evaluation.
 *
 * The opt-in **`--strict-sigv4`** flag flips this to **fail-closed**: deny
 * unverifiable requests. Use it when you want local enforcement to mirror a
 * verified-identity assumption. OAC-fronted Function URLs always
 * warn-and-pass regardless of `--strict-sigv4` (CloudFront re-signs the
 * origin request in production, so no local client signature exists to
 * verify) and their warn lines reference CloudFront OAC.
 *
 * Genuinely missing / malformed signatures (no Authorization header,
 * unparseable header, wrong algorithm, stale date) **are** rejected in both
 * modes — those would never reach the deployed API either.
 *
 * # NOT IN SCOPE
 *
 * - IAM resource / action / condition policy evaluation. The local server
 *   has no IAM data plane. Signature-verified callers reach the handler
 *   under their own identity; downstream authorization is the dev's
 *   responsibility.
 * - STS temporary credentials' session-token validation against AWS
 *   (we accept whatever session-token the dev provides locally).
 * - Multi-account / cross-account signing — we verify against the local
 *   default chain only.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { buildIdentityHash } from './authorizer-resolver.js';
import { getEmbedConfig } from './embed-config.js';
import type { CachedAuthorizerResult } from './authorizer-cache.js';

/**
 * The dev's resolved AWS credentials. Loaded lazily on first IAM-verify
 * call via the SDK default credential chain.
 */
export interface ResolvedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

/**
 * Loader for the dev's local credentials. Wrapped in a function so tests
 * can inject a stub; the production loader uses the AWS SDK default
 * credential chain (env vars → ~/.aws/config → IMDS → ...).
 */
export type CredentialsLoader = () => Promise<ResolvedCredentials>;

/**
 * Default credential loader: instantiates an `STSClient` (a direct cdk-local
 * dependency) and asks its built-in credential provider for the dev's
 * local credentials. STSClient uses the same Node default credential
 * chain (env vars → ~/.aws/config → IMDS → ...) every other AWS SDK call
 * in cdk-local uses, so this matches the deploy-time credential resolution
 * without adding a new dependency.
 */
export function defaultCredentialsLoader(): CredentialsLoader {
  let cached: Promise<ResolvedCredentials> | undefined;
  return () => {
    if (cached) return cached;
    cached = (async (): Promise<ResolvedCredentials> => {
      const { STSClient } = await import('@aws-sdk/client-sts');
      // sts-audit: ignore: the SigV4 inbound verifier resolves the host's
      // default credentials for ambient request signing. `--profile`
      // threading into this loader is a separate follow-up — the path is
      // host-side / pre-container and does not affect Lambda env injection.
      const client = new STSClient({});
      // STSClient typings (AWS SDK v3) expose `config.credentials` as a
      // memoized provider function; invoke it to resolve the dev's local
      // credentials via the default chain (env vars → ~/.aws/config →
      // IMDS → ...). The provider is cached internally by the SDK so
      // calling it multiple times is cheap.
      const creds = await client.config.credentials();
      client.destroy();
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      };
    })();
    return cached;
  };
}

/**
 * Snapshot of the inbound HTTP request needed to reconstruct the
 * canonical request. Matches the shape `runAuthorizerPass` already
 * builds for the other authorizer kinds.
 */
export interface SigV4VerifyRequest {
  /** HTTP method (uppercase). */
  method: string;
  /** Raw URL (path + optional query string). */
  rawUrl: string;
  /** Request headers as a single-value map (last value wins on duplicates). */
  headers: Record<string, string>;
  /** Body bytes (empty Buffer when GET / no body). */
  body: Buffer;
}

/**
 * Parsed Authorization header.
 *
 * Example header:
 *   `AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/execute-api/aws4_request,
 *    SignedHeaders=host;x-amz-date, Signature=abc...`
 */
interface ParsedAuthorization {
  algorithm: string;
  credentialAccessKeyId: string;
  credentialDate: string;
  credentialRegion: string;
  credentialService: string;
  credentialTerminator: string;
  signedHeaders: string[];
  signature: string;
}

/**
 * Outcome of {@link verifySigV4}. Matches the shape `runAuthorizerPass`
 * already produces for the other authorizer kinds so the http-server
 * cache + overlay paths reuse one record.
 */
export interface SigV4VerifyResult extends CachedAuthorizerResult {
  /** Hash for the per-`(authorizer, identity)` result cache. */
  identityHash: string | undefined;
}

/**
 * Verify the inbound request's `Authorization: AWS4-HMAC-SHA256 ...`
 * signature against the dev's local credentials.
 *
 * Outcomes:
 *   - **No / malformed Authorization header** → `{allow: false}`. The
 *     http-server maps this to 401 (REST v1 `missing-identity`).
 *   - **Signature mismatch** under the dev's own credentials → `{allow: false}`.
 *     The http-server maps this to 403 (REST v1 `policy-deny`).
 *   - **Different `Credential` access-key-id than the dev has** (or no
 *     local creds resolve) → unverifiable. `{allow: true}` plus a one-line
 *     warn + fake principalId by default (warn-and-pass). With `strict`
 *     (the `--strict-sigv4` flag) → `{allow: false}` (fail-closed).
 *   - **Valid signature with the dev's credentials** → `{allow: true}`.
 *     The principal id surfaced to the handler is the parsed
 *     `Credential` access-key-id.
 *   - **`oacFronted` route** → foreign / no-creds requests always pass
 *     through regardless of `strict` (CloudFront re-signs origin requests
 *     in production, so no local client signature can be verified) and the
 *     warn lines reference CloudFront OAC.
 */
export async function verifySigV4(
  req: SigV4VerifyRequest,
  loadCredentials: CredentialsLoader,
  opts: {
    warnedForeignIds?: Set<string>;
    now?: () => Date;
    /**
     * Opt-in: when true, DENY unverifiable SigV4 requests (foreign
     * access-key-id, or local-credentials-load failure) instead of the
     * default warn-and-pass. DEFAULT: false (warn-and-pass) — local
     * execution is used to exercise app logic/ergonomics, not to reproduce
     * an auth boundary cdk-local cannot fully emulate, so blocking the
     * common federated / Cognito Identity Pool / cross-account case (foreign
     * by construction) is the wrong default. The fake principalId surfaced
     * on pass-through keeps identity-based handler authz from trusting a
     * forged caller. Flipped on by the `--strict-sigv4` CLI flag. Does NOT
     * apply to {@link oacFronted} routes (those always warn-and-pass).
     */
    strict?: boolean;
    /**
     * Set by the http-server for Function URL routes fronted by a CloudFront
     * Origin Access Control (see `isFunctionUrlOacFronted`). When true the
     * route always warn-and-passes regardless of {@link strict} (CloudFront
     * re-signs origin requests in production, so no local client signature
     * can be verified), and the warn-and-pass log lines reference CloudFront
     * OAC instead of `--strict-sigv4`.
     */
    oacFronted?: boolean;
  } = {}
): Promise<SigV4VerifyResult> {
  const logger = getLogger();
  const authHeader = pickHeader(req.headers, 'authorization');
  if (!authHeader) {
    return { allow: false, identityHash: undefined };
  }

  let parsed: ParsedAuthorization;
  try {
    parsed = parseAuthorizationHeader(authHeader);
  } catch (err) {
    logger.info(
      `AWS_IAM authorizer: rejecting request — malformed Authorization header ` +
        `(${err instanceof Error ? err.message : String(err)}). Expected shape: ` +
        `'AWS4-HMAC-SHA256 Credential=<AKID>/<YYYYMMDD>/<region>/<service>/aws4_request, ` +
        `SignedHeaders=<h1>;<h2>;..., Signature=<hex>'.`
    );
    return { allow: false, identityHash: undefined };
  }

  if (parsed.algorithm !== 'AWS4-HMAC-SHA256') {
    logger.info(
      `AWS_IAM authorizer: rejecting request — unsupported Authorization algorithm ` +
        `'${redactAuthorizationSegment(parsed.algorithm)}'. Expected 'AWS4-HMAC-SHA256'.`
    );
    return { allow: false, identityHash: undefined };
  }
  if (parsed.credentialTerminator !== 'aws4_request') {
    logger.info(
      `AWS_IAM authorizer: rejecting request — invalid credential-scope terminator ` +
        `'${redactAuthorizationSegment(parsed.credentialTerminator)}'. Expected 'aws4_request' ` +
        `(the last '/' segment of the Credential= value).`
    );
    return { allow: false, identityHash: undefined };
  }

  // The `x-amz-date` (or `date`) header must match the credential scope
  // date. We use `x-amz-date` when present (AWS SDK default), fall back
  // to `date` for compatibility with curl --aws-sigv4 etc.
  const amzDate = pickHeader(req.headers, 'x-amz-date') ?? pickHeader(req.headers, 'date');
  if (!amzDate) {
    logger.info(
      'AWS_IAM authorizer: rejecting request — missing x-amz-date / date header. ' +
        "Expected ISO-8601 basic 'YYYYMMDDTHHMMSSZ' in 'x-amz-date' (AWS SDK default) " +
        "or RFC 1123 in 'date' (curl --aws-sigv4)."
    );
    return { allow: false, identityHash: undefined };
  }
  if (!validateAmzDateMatchesCredentialDate(amzDate, parsed.credentialDate)) {
    logger.info(
      `AWS_IAM authorizer: rejecting request — x-amz-date / date ` +
        `'${boundTimestampHeader(amzDate)}' does not match ` +
        `credential-scope date '${parsed.credentialDate}'. The 'YYYYMMDD' prefix of ` +
        `x-amz-date must equal the date segment of Credential=<AKID>/<YYYYMMDD>/...`
    );
    return { allow: false, identityHash: undefined };
  }

  // Optional clock-skew check: if the timestamp is more than 15 minutes
  // off the local clock, AWS rejects the request as expired. We mirror
  // that here — a missing `now` defaults to real time.
  const now = (opts.now ?? ((): Date => new Date()))();
  if (amzDateOutsideSkew(amzDate, now)) {
    logger.info(
      `AWS_IAM authorizer: rejecting request — x-amz-date / date ` +
        `'${boundTimestampHeader(amzDate)}' is outside the ` +
        `15-minute clock-skew window (local now=${now.toISOString()}). Re-sign the ` +
        `request with the current time or sync the local clock.`
    );
    return { allow: false, identityHash: undefined };
  }

  // Load the dev's local credentials. Loader is cached so we hit the
  // credential chain at most once per server lifecycle.
  let local: ResolvedCredentials;
  try {
    local = await loadCredentials();
  } catch (err) {
    // Unverifiable: no local credentials resolved, so we cannot reproduce
    // the signing key. DEFAULT: warn-and-pass — local execution is for
    // exercising app logic / ergonomics, not reproducing an auth boundary
    // cdk-local cannot fully emulate. `--strict-sigv4` flips this to
    // fail-closed. OAC-fronted routes always pass (no client signature
    // exists to verify in production).
    // Issue #564: `reason` used to be the credential CHAIN's own error text,
    // relayed verbatim into every `warn` spelling below. It is withheld now,
    // and the chain's message moved to the `debug` line just below.
    //
    // Issue #555's criterion was PROVENANCE — material cdk-local resolved
    // out of a secret or parameter store is redacted, the developer's own
    // payload is not — and on provenance alone this value stays: it is the
    // developer's own machine configuration, not something cdk-local went
    // and fetched. Provenance did not settle #555's own sigv4-verify cases
    // either, and it does not settle this one. Two further axes decide it,
    // and both point the other way:
    //
    //   LEVEL — these are `warn`, so they print on a plain `cdkl start-api`
    //   run rather than only under `--verbose`, and `cdkl studio` mirrors a
    //   serve child's output into a log ring it serves over HTTP. The
    //   population that sees a `warn` is everyone; the population that sees
    //   a `debug` line asked for it.
    //
    //   RECONSTRUCTION — what can reach this string is not a hint about a
    //   secret, it is the secret. `@aws-sdk/credential-provider-process`
    //   builds its failure as `new CredentialsProviderError(error.message)`
    //   where `error` is the rejection from `promisify(child_process.exec)`
    //   — Node's `Command failed: <command line>\n<stderr>`. A passphrase
    //   written on a `credential_process` command line is therefore already
    //   inside a credential-chain error object. That is unlike the values
    //   #555 left quoted: an access-key-id is a public identifier, and a
    //   SigV4 signature is an HMAC that is worthless without the key.
    //
    //   MEASURED — and this CORRECTS issue #564's own premise, which said
    //   the process provider's error propagates verbatim because it carries
    //   no `tryNextLink`. It carries none, and that is exactly why it does
    //   NOT propagate: `CredentialsProviderError` defaults `tryNextLink` to
    //   TRUE, so `internalCreateChain` continues past it, and the node
    //   chain's last link unconditionally throws the generic `Could not load
    //   credentials from any providers` with `tryNextLink: false`. Repro on
    //   the versions this repo resolves (@aws-sdk/credential-provider-node
    //   3.972.44, credential-provider-process 3.972.43): a profile whose
    //   `credential_process` exits non-zero, proven to have RUN by a marker
    //   file it touches, yields exactly that 45-character generic message
    //   and no command line.
    //
    //   So this is defense in depth, not a live disclosure — worth having
    //   anyway, because all that separates the command line from a
    //   default-level log line is one defaulted `tryNextLink` inside a
    //   vendored dependency that deliberately copies the exec message into
    //   the error it throws. cdk-local neither owns that line nor would
    //   notice it changing. What actually reaches `reason` today is that
    //   generic message and a handful of profile-naming chain errors, none
    //   of them secret; the cost of withholding them is zero, since
    //   `--verbose` still prints every one in full.
    //
    // Two axes of three say withhold, so the `warn` carries an
    // input-INDEPENDENT discriminator only — `err.name` plus a length, the
    // shape `ecs-secrets-resolver.ts` already uses for the parse failure it
    // must not echo. `err.name` is set by the throwing class, never from the
    // loader's input, which is the property that makes it safe.
    //
    // Deliberately NOT done: stripping the `Command failed:` first line and
    // keeping the rest. That enumerates one known-bad shape and loses the
    // race — the stderr on the second line is exactly as able to carry a
    // passphrase prompt or a token, and the next loader to grow its own
    // format would not be covered at all. Define the safe state positively
    // instead, which is what "input-independent" is.
    logger.debug(
      `AWS_IAM authorizer: the AWS credential chain's own failure message was: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    const reason = describeCredentialLoadFailure(err);
    const { sigV4StrictByDefault, sigV4OptFlag: optFlag } = getEmbedConfig();
    if (opts.strict && !opts.oacFronted) {
      logger.warn(
        sigV4StrictByDefault
          ? `AWS_IAM authorizer: could not resolve local AWS credentials (${reason}), so the ` +
              `request's SigV4 signature cannot be verified. cdk-local denies unverifiable IAM ` +
              `requests by default; pass ${optFlag} to warn-and-pass, or configure AWS ` +
              `credentials cdk-local can read.`
          : `AWS_IAM authorizer: could not resolve local AWS credentials (${reason}), so the ` +
              `request's SigV4 signature cannot be verified. ${optFlag} is set, so cdk-local ` +
              `denies unverifiable IAM requests; remove ${optFlag} to warn-and-pass (the ` +
              `default), or configure AWS credentials cdk-local can read.`
      );
      return { allow: false, identityHash: undefined };
    }
    logger.warn(
      opts.oacFronted
        ? `AWS_IAM authorizer: Function URL is fronted by CloudFront OAC (CloudFront re-signs origin requests in production), and local AWS credentials could not be resolved (${reason}). Passing through with unverified principalId 'unverified-no-creds'. Do NOT trust event.requestContext.identity.accessKey in handler code.`
        : sigV4StrictByDefault
          ? `AWS_IAM authorizer: could not resolve local AWS credentials (${reason}), so the request's SigV4 signature cannot be verified locally (SigV4 is an HMAC shared-secret signature; the deployed API Gateway verifies it against AWS's copy of the secret). ${optFlag} is set; passing through with unverified principalId 'unverified-no-creds'. Do NOT trust event.requestContext.identity.accessKey in handler code.`
          : `AWS_IAM authorizer: could not resolve local AWS credentials (${reason}), so the request's SigV4 signature cannot be verified locally (SigV4 is an HMAC shared-secret signature; the deployed API Gateway verifies it against AWS's copy of the secret). Passing through with unverified principalId 'unverified-no-creds' — cdk-local's default for unverifiable IAM requests; pass ${optFlag} to deny instead. Do NOT trust event.requestContext.identity.accessKey in handler code.`
    );
    return {
      allow: true,
      // Surface an obviously-fake principalId so handlers cannot be
      // fooled into trusting the unverified access-key-id.
      principalId: 'unverified-no-creds',
      identityHash: buildIdentityHash([parsed.signature]),
    };
  }

  // Foreign-identity request: the signer used an access key id we don't
  // have, so we can't reproduce the signing key — verification is
  // impossible. DEFAULT: warn-and-pass with a fake principalId (the common
  // legitimate case is a federated / Cognito Identity Pool / cross-account
  // signer, foreign by construction). `--strict-sigv4` flips this to
  // fail-closed: deny, since a forged `Authorization: AWS4-HMAC-SHA256
  // Credential=AKID-X/...` header could otherwise be admitted as principal
  // `AKID-X` to handler code that trusts the request identity. Use
  // case-insensitive compare on the access key id — AWS docs are silent and
  // a lowercased AKID is a trivial bypass vector otherwise.
  if (local.accessKeyId.toLowerCase() !== parsed.credentialAccessKeyId.toLowerCase()) {
    const warned = opts.warnedForeignIds;
    // The dedup key MUST be normalized to match the case-insensitive
    // AKID compare above — otherwise an attacker probing variants
    // (AKIDFOREIGN, akidforeign, AkIdFOREIGN) would trigger a fresh
    // warn line per case. Case-insensitive compare → case-insensitive
    // dedup. (PR #484 review MINOR.)
    //
    // Issue #561: the id is HASHED before it becomes a key, and the set it
    // goes into is bounded (see {@link rememberWarnedForeignId}). Nothing
    // validates `credentialAccessKeyId` before it arrives here — it is
    // whatever occupied the first '/'-separated segment of `Credential=`, so
    // a caller controls its content AND its length, up to Node's
    // `http.maxHeaderSize` (16384, read off `require('node:http')` on the
    // Node 24.15 this repo pins). Storing it raw would make an entry-count
    // cap a weak bound — cap times sixteen kilobytes — while a fixed 64-hex
    // digest makes it a real one, and it collides no more often than the raw
    // value does. Truncating the id instead would be the wrong shape: two
    // distinct long ids sharing a prefix would collapse onto one key and the
    // second signer's warning would be SUPPRESSED, which is the one outcome
    // this dedup must never produce.
    const dedupKey = createHash('sha256')
      .update(parsed.credentialAccessKeyId.toLowerCase())
      .digest('hex');
    const { sigV4StrictByDefault, sigV4OptFlag: optFlag } = getEmbedConfig();
    if (opts.strict && !opts.oacFronted) {
      if (!warned || !warned.has(dedupKey)) {
        logger.warn(
          sigV4StrictByDefault
            ? `AWS_IAM authorizer: request signed with access-key-id '${redactAuthorizationSegment(parsed.credentialAccessKeyId)}', ` +
                `which differs from the AWS credentials cdk-local resolved locally — SigV4 (HMAC / ` +
                `shared-secret) can only be verified with the signer's own credentials, never a ` +
                `federated / Cognito Identity Pool / cross-account signer's. cdk-local denies it by ` +
                `default; pass ${optFlag} to warn-and-pass, or sign the request with the same ` +
                `credentials cdk-local resolves locally.`
            : `AWS_IAM authorizer: request signed with access-key-id '${redactAuthorizationSegment(parsed.credentialAccessKeyId)}', ` +
                `which differs from the AWS credentials cdk-local resolved locally — SigV4 (HMAC / ` +
                `shared-secret) can only be verified with the signer's own credentials, never a ` +
                `federated / Cognito Identity Pool / cross-account signer's. ${optFlag} is set, so ` +
                `cdk-local denies it; remove ${optFlag} to warn-and-pass (the default), or sign the ` +
                `request with the same credentials cdk-local resolves locally.`
        );
        rememberWarnedForeignId(warned, dedupKey);
      }
      return { allow: false, identityHash: undefined };
    }
    if (!warned || !warned.has(dedupKey)) {
      logger.warn(
        opts.oacFronted
          ? `AWS_IAM authorizer: Function URL is fronted by CloudFront OAC — in production CloudFront re-signs the origin request, so the local client's signature (access-key-id '${redactAuthorizationSegment(parsed.credentialAccessKeyId)}') cannot be verified. ` +
              `Passing through with unverified principalId 'unverified-foreign-identity'. ` +
              `Do NOT trust event.requestContext.authorizer.principalId in handler code.`
          : sigV4StrictByDefault
            ? `AWS_IAM authorizer: request signed with access-key-id '${redactAuthorizationSegment(parsed.credentialAccessKeyId)}', ` +
              `a federated / Cognito Identity Pool / cross-account signer cdk-local cannot verify ` +
              `locally (SigV4 is an HMAC shared-secret signature; the deployed API Gateway verifies ` +
              `it because AWS holds the secret). ${optFlag} is set; passing through with unverified ` +
              `principalId 'unverified-foreign-identity'. Do NOT trust ` +
              `event.requestContext.authorizer.principalId in handler code.`
            : `AWS_IAM authorizer: request signed with access-key-id '${redactAuthorizationSegment(parsed.credentialAccessKeyId)}', ` +
              `a federated / Cognito Identity Pool / cross-account signer cdk-local cannot verify ` +
              `locally (SigV4 is an HMAC shared-secret signature; the deployed API Gateway verifies ` +
              `it because AWS holds the secret). Passing through with unverified principalId ` +
              `'unverified-foreign-identity' — cdk-local's default for unverifiable IAM requests; ` +
              `pass ${optFlag} to deny instead. Do NOT trust ` +
              `event.requestContext.authorizer.principalId in handler code.`
      );
      rememberWarnedForeignId(warned, dedupKey);
    }
    return {
      allow: true,
      // Surface an obviously-fake principalId so handler code cannot
      // be fooled into trusting the unverified access-key-id.
      principalId: 'unverified-foreign-identity',
      identityHash: buildIdentityHash([parsed.signature]),
    };
  }

  // Same identity — reproduce the canonical request, derive the signing
  // key, recompute the signature, compare.
  const recomputed = computeSignature(req, parsed, local.secretAccessKey, amzDate);
  if (!constantTimeEqual(recomputed, parsed.signature)) {
    // The RECOMPUTED signature is deliberately NOT printed (issue #555).
    // It is `HMAC(signing key derived from the developer's real secret
    // access key, string-to-sign)`, and every input to that string-to-sign
    // is chosen by the caller: the credential scope's region and service,
    // the date, the signed-header list and their values, the URI, the query
    // string, and the payload hash. Reaching this branch needs only an
    // access-key id equal to the local one, and an access-key id is an
    // identifier rather than a secret. So echoing the result would make
    // `cdkl start-api` a signing oracle: send a request canonically
    // identical to some AWS API call, then read a VALID signature for that
    // call, under the developer's own credentials, straight off the log.
    // This site is `info`, so no `--verbose` is needed, and `cdkl studio`
    // mirrors these lines into a log ring it serves over HTTP.
    //
    // The OFFERED signature IS printed. The caller supplied it, so echoing
    // it back to a local terminal tells them nothing they did not send, and
    // it is what makes the mismatch actionable (issue #246). The recomputed
    // hex only restated the inequality the message already names — the
    // fault itself always lies in the canonical request.
    logger.info(
      `AWS_IAM authorizer: rejecting request — Signature= mismatch (got ` +
        `'${redactSignature(parsed.signature)}'; the recomputed signature is withheld, ` +
        `because it is a valid signature for this request under your local credentials). ` +
        `The request was signed with the expected access-key-id but the HMAC does not ` +
        `verify — check the SignedHeaders list, request body, and canonical-request ` +
        `normalization on the signer side.`
    );
    return { allow: false, identityHash: undefined };
  }

  return {
    allow: true,
    principalId: parsed.credentialAccessKeyId,
    identityHash: buildIdentityHash([parsed.signature]),
  };
}

/**
 * Upper bound on how much of an `Authorization`-header segment a rejection
 * message may quote.
 *
 * 32 clears every value these messages legitimately name, with room to
 * spare: `AWS4-HMAC-SHA256` is 16 characters, the longest real algorithm
 * spelling this parser rejects (`AWS4-ECDSA-P256-SHA256-PAYLOAD`) is 30,
 * `aws4_request` is 12, a `YYYYMMDD` date is 8, and an access-key id is 20.
 * The ceiling is what fixes it at 32 rather than higher: an AWS SECRET
 * access key is 40 characters, and pasting one into `AWS_ACCESS_KEY_ID` is
 * the one way a developer's own secret reaches this header — so the bound
 * has to sit below 40 for that paste to be withheld rather than quoted.
 */
const AUTH_SEGMENT_QUOTE_MAX = 32;

/**
 * Quote one caller-supplied `Authorization`-header segment for a rejection
 * message, or withhold it when it cannot be a segment.
 *
 * Issue #555. These messages are `info` and `warn`, not `debug`, so they
 * print on a plain `cdkl start-api` run rather than only under `--verbose`
 * — a different population from a verbose-gated diagnostic, and the reason
 * the auth-header sites were the ones worth changing. What each names is a
 * POSITION in the header, and a position holds only its own short token
 * while the header's delimiters sit where the parser expects them. Drop a
 * single comma —
 * `Credential=AKID/20260101/us-east-1/execute-api/aws4_request Signature=<hex>, SignedHeaders=host, Signature=abcd`
 * — and `Credential=`'s value absorbs the parameter that should have
 * followed it, so the credential-scope split hands its LAST segment the
 * `Signature=` component and the terminator message prints it at default
 * level. (A header delimited by spaces throughout never reaches that
 * message: it yields a single parameter, so the parse throws `missing
 * SignedHeaders` first.)
 *
 * So a quote is allowed only for input that could still BE one segment: no
 * whitespace, no `=`, no longer than {@link AUTH_SEGMENT_QUOTE_MAX}. Any of
 * those failing means the parse boundary was elsewhere and the value is
 * unrelated header material of unknown extent, reported by shape instead.
 * Every genuine typo (`aws3_request`, `AWS4-HMAC-SHA512`) stays quoted in
 * full — the actionability issue #246 added these messages for — while the
 * sweep-in case degrades to a character count.
 *
 * The offered `Signature=` value has its own predicate,
 * {@link redactSignature}: a real signature is 64 characters, so this bound
 * would withhold every legitimate one.
 */
export function redactAuthorizationSegment(segment: string): string {
  if (segment.length > AUTH_SEGMENT_QUOTE_MAX || /[\s=]/.test(segment)) {
    return `<withheld: ${segment.length} characters of unparsed header material>`;
  }
  return segment;
}

/**
 * Bound on the `x-amz-date` / `date` echo. Every legal spelling is far
 * below it. Measured on Node 24: RFC 1123 `Mon, 02 Jan 2006 15:04:05 GMT`
 * is 29 characters; `new Date().toString()` runs 45 to 76 depending on the
 * zone name (55 on the machine this was written on, 76 for
 * `Australia/Eucla`) across all 418 zones `Intl.supportedValuesOf` lists;
 * and the longest spelling `Date` was observed to PARSE,
 * `Wednesday, December 31, 2025 00:00:00 GMT+0000 (Coordinated Universal
 * Time)`, is 75. So nothing actionable is ever withheld.
 */
const TIMESTAMP_HEADER_QUOTE_MAX = 200;

/**
 * Bound the `x-amz-date` / `date` echo by LENGTH ONLY.
 *
 * Issue #555 reviewed this site and deliberately did NOT route it through
 * {@link redactAuthorizationSegment}. It is not an `Authorization` segment:
 * `pickHeader` reads the whole header, so no delimiter mistake can sweep a
 * `Signature=` component into it, and what lands here is whatever the
 * CALLER put in their own timestamp header. More to the point, a SHAPE
 * bound would withhold exactly the case the message exists for — the value
 * reaching the mismatch branch is usually a perfectly valid timestamp that
 * simply disagrees with the credential scope, and the legal spellings carry
 * spaces and run long (see {@link TIMESTAMP_HEADER_QUOTE_MAX}). A
 * whitespace clause or a 32-character cap withholds all of them.
 *
 * "No shape bound" is not "no bound", though. The value is unbounded caller
 * input printed at `info`, and `cdkl studio` mirrors these lines into a log
 * ring it serves over HTTP, so a length cap costs nothing and ends the
 * flood. Do not tighten it into a shape check.
 */
export function boundTimestampHeader(value: string): string {
  if (value.length > TIMESTAMP_HEADER_QUOTE_MAX) {
    return `<withheld: ${value.length} characters, too long to be a timestamp>`;
  }
  return value;
}

/**
 * Quote the caller's OFFERED `Signature=` value, or withhold it when that
 * field swept in material which is not a signature.
 *
 * `Signature=` is the LAST parameter of the header, which makes it a sweep
 * position exactly like the credential-scope terminator: a header ending
 * `..., Signature=<hex> X-Anything=foo` parses to a `signature` of
 * `<hex> x-anything=foo`. A real SigV4 signature is lowercase hex and
 * EXACTLY 64 characters; the predicate accepts 1 to 64 rather than exactly
 * 64 only so that a short but otherwise plausible value still shows (a
 * truncated paste is worth seeing). Either way it quotes every legitimate
 * value — the one issue #246 needs the user to compare — and withholds
 * anything a mis-delimited split swept in.
 *
 * This covers the OFFERED signature only. The RECOMPUTED one is never
 * printed; the mismatch message in {@link verifySigV4} says why.
 */
export function redactSignature(signature: string): string {
  if (!/^[0-9a-f]{1,64}$/.test(signature)) {
    return `<withheld: ${signature.length} characters that are not a signature>`;
  }
  return signature;
}

/**
 * Describe a credential-chain failure for a default-level log line WITHOUT
 * relaying the chain's own message (issue #564).
 *
 * The message is withheld because of what a credential-chain error CAN
 * carry: `@aws-sdk/credential-provider-process` copies the rejection of
 * `promisify(child_process.exec)` — Node's
 * `Command failed: <command line>\n<stderr>` — into the error it throws, so
 * a passphrase on a `credential_process` command line is already inside a
 * chain error object. On the SDK versions this repo resolves today that
 * object does not actually reach the caller (the chain swallows it and ends
 * on a generic message), which makes this defense in depth rather than a
 * live disclosure. The measurement, and the full reasoning for withholding
 * at `warn` while keeping the text at `debug`, are at the call site in
 * {@link verifySigV4}.
 *
 * What is reported instead is input-INDEPENDENT: `err.name` is set by the
 * throwing class rather than derived from anything the loader read, which is
 * the property that makes quoting it safe, and is the same discriminator
 * `ecs-secrets-resolver.ts` reports for the JSON parse failure it must not
 * echo. `'unknown'` rather than a guessed class name for a non-`Error`
 * throw, so the field never names a class the throw was not.
 *
 * The LENGTH is reported, unlike in `ecs-secrets-resolver.ts`, and the
 * difference is deliberate: there the user already knows which secret it is
 * and can read the value at its source, so a character count would be
 * disclosure buying nothing. Here the user cannot see the withheld message
 * at all, and the count is what separates a one-line
 * `Could not load credentials from any providers` from a multi-hundred-
 * character `Command failed:` dump — which is what tells them whether their
 * `credential_process` even ran. It is the same choice
 * {@link redactAuthorizationSegment} makes when it withholds.
 */
export function describeCredentialLoadFailure(err: unknown): string {
  const kind = err instanceof Error ? err.name : 'unknown';
  const length = err instanceof Error ? err.message.length : String(err).length;
  return `${kind}; ${length}-character message withheld, logged at debug level under --verbose`;
}

/**
 * How many distinct foreign access-key-ids {@link verifySigV4}'s warn-dedup
 * set retains (issue #561).
 *
 * The legitimate population is tiny — a session sees one federated / Cognito
 * Identity Pool / cross-account signer, occasionally a handful — so 256
 * leaves two orders of magnitude of headroom over any real use while holding
 * the set at 256 entries of exactly 64 hex characters whatever a caller
 * sends, because {@link verifySigV4} hashes the id before it becomes a key.
 *
 * `docs/local-emulation.md` states this number to users ("the 256 most
 * recently warned ids"); change both together.
 */
const FOREIGN_ID_DEDUP_MAX = 256;

/**
 * Record that the foreign-access-key-id warning has been emitted for
 * `dedupKey`, evicting oldest-first so the set cannot grow without bound
 * (issue #561).
 *
 * # Why eviction, and not "stop warning past the cap"
 *
 * The set's only power is SUPPRESSION — an entry present means the warning
 * is skipped — so the two candidate policies differ in the DIRECTION they
 * fail. Evicting an entry can only ever cause a REPEAT warning, which is
 * precisely the un-deduped behaviour this code had before the dedup existed:
 * noisier, never quieter. Capping by refusing to warn once the set is full
 * would instead silence the (cap+1)-th distinct signer, and that signer is
 * every bit as likely to be the real federated identity the developer needs
 * told about as it is to be a prober's next value. A warning that never
 * arrives is a worse failure than a set that grows, so the bound is put
 * where it cannot suppress anything.
 *
 * `Set` iterates in insertion order, so `values().next()` is the oldest
 * entry and this is FIFO. It is a loop rather than a single `delete` so a
 * set handed in already over the cap is brought back under it.
 *
 * What this does NOT fix: a client looping over DISTINCT ids still draws one
 * warn line per probe. Distinct ids defeat the dedup whether or not the set
 * is bounded, and closing that half would need suppression — the direction
 * ruled out above. The bound here is on memory only.
 */
function rememberWarnedForeignId(warned: Set<string> | undefined, dedupKey: string): void {
  if (!warned) return;
  while (warned.size >= FOREIGN_ID_DEDUP_MAX) {
    const oldest = warned.values().next();
    if (oldest.done === true) break;
    warned.delete(oldest.value);
  }
  warned.add(dedupKey);
}

/**
 * Parse `AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...`.
 * Rejects every other shape (including legacy `AWS4-HMAC-SHA256-...`
 * variants and HTTP/1.0-style multi-line values).
 */
export function parseAuthorizationHeader(value: string): ParsedAuthorization {
  const spaceIdx = value.indexOf(' ');
  if (spaceIdx < 0) {
    throw new Error('expected algorithm followed by parameters');
  }
  const algorithm = value.slice(0, spaceIdx).trim();
  const rest = value.slice(spaceIdx + 1).trim();

  // Split by commas; each piece is `Key=Value`. Whitespace around commas
  // is permitted by the AWS spec.
  const parts = rest.split(',').map((s) => s.trim());
  const fields: Record<string, string> = {};
  for (const [i, part] of parts.entries()) {
    const eq = part.indexOf('=');
    // Report the POSITION, never the content. A part reaching here holds no
    // `=`, so quoting it says nothing about the fault the message already
    // names -- while an `Authorization: Basic <base64>` sent to an AWS_IAM
    // route arrives as exactly one such part, and quoting it would print
    // that credential at `info` (issue #555). The developer reading the
    // message is holding the header they sent; an index locates the part
    // for them without cdk-local repeating any of it.
    if (eq < 0) {
      const detail =
        part.length === 0 ? 'empty, stray comma?' : `${part.length} characters, no '='`;
      throw new Error(`malformed parameter ${i + 1} of ${parts.length} (${detail})`);
    }
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    fields[key] = val;
  }

  const credential = fields['Credential'];
  const signedHeaders = fields['SignedHeaders'];
  const signature = fields['Signature'];
  if (!credential) throw new Error('missing Credential');
  if (!signedHeaders) throw new Error('missing SignedHeaders');
  if (!signature) throw new Error('missing Signature');

  // Credential format: AKID/YYYYMMDD/region/service/aws4_request
  const credParts = credential.split('/');
  if (credParts.length !== 5) {
    // Count, not content: the whole Credential= value is the one segment
    // that can never be safely quoted. It is unbounded, it is the position
    // a hand-written (space- rather than comma-delimited) header sweeps the
    // REST of the Authorization value into -- `Signature=<hex>` included --
    // and the count is what makes the fault actionable anyway (issue #555).
    // The caller's own catch already prints the full expected shape, so
    // naming it again here would state it twice in one line.
    throw new Error(
      `malformed Credential: expected 5 slash-separated segments, got ${credParts.length}`
    );
  }
  const [accessKeyId, date, region, service, terminator] = credParts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (!/^[0-9]{8}$/.test(date)) {
    throw new Error(
      `malformed credential date '${redactAuthorizationSegment(date)}' (expected YYYYMMDD)`
    );
  }

  return {
    algorithm,
    credentialAccessKeyId: accessKeyId,
    credentialDate: date,
    credentialRegion: region,
    credentialService: service,
    credentialTerminator: terminator,
    signedHeaders: signedHeaders.split(';').map((h) => h.trim().toLowerCase()),
    signature: signature.toLowerCase(),
  };
}

/**
 * AWS SigV4 canonical-request computation. Per
 * <https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html>:
 *
 *   CanonicalRequest =
 *     HTTPRequestMethod + '\n' +
 *     CanonicalURI + '\n' +
 *     CanonicalQueryString + '\n' +
 *     CanonicalHeaders + '\n' +
 *     SignedHeaders + '\n' +
 *     HexEncode(Hash(RequestPayload))
 *
 * Then:
 *   StringToSign = "AWS4-HMAC-SHA256\n" + AmzDate + "\n" +
 *                  CredentialScope + "\n" +
 *                  HexEncode(Hash(CanonicalRequest))
 *
 *   SigningKey = HMAC(HMAC(HMAC(HMAC("AWS4"+Secret, Date), Region), Service), "aws4_request")
 *   Signature  = HexEncode(HMAC(SigningKey, StringToSign))
 */
function computeSignature(
  req: SigV4VerifyRequest,
  parsed: ParsedAuthorization,
  secretAccessKey: string,
  amzDate: string
): string {
  const { path, query } = splitRawUrl(req.rawUrl);
  const canonicalUri = canonicalizePath(path);
  const canonicalQuery = canonicalizeQueryString(query);

  // Build canonical headers from the signedHeaders list — every named
  // header MUST be present (we reject early when missing). Values are
  // trimmed of leading/trailing whitespace and internal runs of spaces
  // collapsed to a single space (per the AWS spec).
  const headerLines: string[] = [];
  for (const name of parsed.signedHeaders) {
    const raw = pickHeader(req.headers, name);
    if (raw === undefined) {
      // Missing signed header → recompute will fail and the compare
      // returns false. We still produce a sentinel string so the caller
      // gets a deterministic "no match" rather than a thrown error.
      return 'missing-signed-header';
    }
    headerLines.push(`${name}:${normalizeHeaderValue(raw)}\n`);
  }
  const canonicalHeaders = headerLines.join('');
  const signedHeadersStr = parsed.signedHeaders.join(';');

  // Payload hash: AWS SigV4 supports an UNSIGNED-PAYLOAD marker (used by
  // streaming uploads); the inbound request's `x-amz-content-sha256`
  // header carries it. Fall back to hashing the actual body.
  const xAmzContentSha = pickHeader(req.headers, 'x-amz-content-sha256');
  const payloadHash =
    xAmzContentSha &&
    (xAmzContentSha === 'UNSIGNED-PAYLOAD' || /^[0-9a-f]{64}$/i.test(xAmzContentSha))
      ? xAmzContentSha.toLowerCase()
      : sha256Hex(req.body);

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join('\n');

  const credentialScope = `${parsed.credentialDate}/${parsed.credentialRegion}/${parsed.credentialService}/${parsed.credentialTerminator}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, parsed.credentialDate);
  const kRegion = hmac(kDate, parsed.credentialRegion);
  const kService = hmac(kRegion, parsed.credentialService);
  const kSigning = hmac(kService, 'aws4_request');
  return hmac(kSigning, stringToSign).toString('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Split a raw URL into (decoded path, raw query string).
 *
 * Important: keep the path RAW for canonicalization — the canonicalizer
 * does its own URI-encoding so we do NOT decode here.
 */
function splitRawUrl(rawUrl: string): { path: string; query: string } {
  const q = rawUrl.indexOf('?');
  if (q < 0) return { path: rawUrl, query: '' };
  return { path: rawUrl.slice(0, q), query: rawUrl.slice(q + 1) };
}

/**
 * Canonicalize the request path per the AWS SigV4 spec:
 *
 *   - URI-encode each path segment (reserved chars are percent-encoded
 *     EXCEPT `-_.~` which stay literal).
 *   - Encode `/` between segments unchanged.
 *   - Empty path → `/`.
 *
 * This matches the `execute-api` service's signing rules (no double-
 * encoding).
 */
export function canonicalizePath(path: string): string {
  if (!path || path === '') return '/';
  // The request path may already be percent-encoded from the wire. The
  // AWS SDK's signer normalizes by SINGLE-encoding the decoded path —
  // we mirror that.
  const decoded = path
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
  return decoded
    .split('/')
    .map((seg) => sigV4EncodePathSegment(seg))
    .join('/');
}

/**
 * Encode a single path segment per the SigV4 unreserved-set rules:
 * `A-Za-z0-9-_.~` stay literal; everything else is percent-encoded.
 */
function sigV4EncodePathSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9\-_.~]/g, (ch) => {
    // Use encodeURIComponent and then upper-case the hex digits (AWS
    // canonical form uses upper-case hex).
    const enc = encodeURIComponent(ch);
    return enc.replace(/%[0-9a-f]{2}/g, (s) => s.toUpperCase());
  });
}

/**
 * Canonicalize the query string per SigV4: parse `key=value` pairs,
 * SORT by key (then by value on collisions), URI-encode each side
 * with upper-case hex, join with `&`.
 */
export function canonicalizeQueryString(query: string): string {
  if (!query) return '';
  const pairs: Array<[string, string]> = [];
  for (const raw of query.split('&')) {
    if (!raw) continue;
    const eq = raw.indexOf('=');
    const [k, v] = eq < 0 ? [raw, ''] : [raw.slice(0, eq), raw.slice(eq + 1)];
    let dk: string;
    let dv: string;
    try {
      dk = decodeURIComponent(k.replace(/\+/g, ' '));
    } catch {
      dk = k;
    }
    try {
      dv = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      dv = v;
    }
    pairs.push([sigV4EncodeQuery(dk), sigV4EncodeQuery(dv)]);
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function sigV4EncodeQuery(s: string): string {
  return s.replace(/[^A-Za-z0-9\-_.~]/g, (ch) => {
    const enc = encodeURIComponent(ch);
    return enc.replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase());
  });
}

/**
 * Trim leading/trailing whitespace and collapse internal runs of
 * whitespace to a single space, per the SigV4 spec.
 */
function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function pickHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Compare two hex-encoded signatures in constant time. Returns false
 * when the lengths differ (the standard short-circuit, since timing
 * leaks on length are inherent to comparing values of different sizes).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  // Buffer.from('zz', 'hex') silently returns an empty buffer; guard
  // against that by checking the expected length matches what we got.
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * AWS SigV4 expects `x-amz-date` in ISO8601 basic form `YYYYMMDDTHHMMSSZ`.
 * The credential scope encodes only the date portion. We accept both
 * `x-amz-date` and the legacy `date` header (RFC 7231) for compat.
 */
export function validateAmzDateMatchesCredentialDate(
  amzDate: string,
  credentialDate: string
): boolean {
  // ISO8601 basic: YYYYMMDDTHHMMSSZ
  const isoMatch = /^(\d{8})T\d{6}Z$/.exec(amzDate);
  if (isoMatch) {
    return isoMatch[1] === credentialDate;
  }
  // RFC 7231: Mon, 02 Jan 2006 15:04:05 GMT
  try {
    const parsed = new Date(amzDate);
    if (Number.isNaN(parsed.getTime())) return false;
    const yyyy = parsed.getUTCFullYear().toString().padStart(4, '0');
    const mm = (parsed.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = parsed.getUTCDate().toString().padStart(2, '0');
    return `${yyyy}${mm}${dd}` === credentialDate;
  } catch {
    return false;
  }
}

/**
 * Reject SigV4 timestamps more than 15 minutes off the local clock —
 * matches AWS-deployed behavior (the `RequestTimeTooSkewed` error).
 */
export function amzDateOutsideSkew(amzDate: string, now: Date): boolean {
  const iso = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  let ts: Date;
  if (iso) {
    ts = new Date(
      Date.UTC(
        Number(iso[1]),
        Number(iso[2]) - 1,
        Number(iso[3]),
        Number(iso[4]),
        Number(iso[5]),
        Number(iso[6])
      )
    );
  } else {
    ts = new Date(amzDate);
  }
  if (Number.isNaN(ts.getTime())) return true;
  const deltaMs = Math.abs(ts.getTime() - now.getTime());
  return deltaMs > 15 * 60 * 1000;
}
