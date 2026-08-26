/**
 * Rendering an AWS SDK failure into a log line cdk-local is willing to print
 * at DEFAULT level (issues #564, #570).
 *
 * # Why a shared module
 *
 * Issue #564 settled the policy for one site — the credential-chain failure
 * in {@link file://./sigv4-verify.ts} — and #570 found the same shape at nine
 * more, spread across four `src/cli/commands/*.ts` files. Every one of them
 * relays a third-party error's `message` into a `logger.warn`, so they share
 * one question and must not grow nine answers to it.
 *
 * # The two axes that decide it
 *
 * PROVENANCE alone says relay: a credential-chain error is about the
 * developer's own machine configuration, not something cdk-local fetched out
 * of a secret store (issue #555's criterion). Two further axes overrule it:
 *
 *   LEVEL — these are `warn`, so they print on a plain `cdkl start-api` /
 *   `cdkl invoke` run rather than only under `--verbose`, and `cdkl studio`
 *   mirrors a serve child's output into a log ring it serves over HTTP.
 *   Everybody sees a `warn`; only someone who asked sees a `debug`.
 *
 *   RECONSTRUCTION — what can reach the string is not a hint about a secret,
 *   it is the secret. `@aws-sdk/credential-provider-process` builds its
 *   failure as `new CredentialsProviderError(error.message)` where `error` is
 *   the rejection of `promisify(child_process.exec)`, i.e. Node's
 *   `Command failed: <command line>\n<stderr>`, and a passphrase written on a
 *   `credential_process` command line is an ordinary thing to have. (Verified
 *   at `@aws-sdk/credential-provider-process@3.972.{39,41,43}`
 *   `dist-cjs/index.js:56` in this repo's tree.)
 *
 * # Where these sites DIFFER from sigv4-verify's, and why the answer differs
 *
 * {@link file://./sigv4-verify.ts}'s `catch` wraps `client.config.credentials()`
 * and nothing else: credential-chain resolution, with no AWS operation
 * cdk-local asked for. Nothing actionable is lost by withholding all of it,
 * so that site withholds unconditionally and keeps the text at `debug`.
 *
 * The #570 sites wrap an SDK call cdk-local DID make — STS
 * `GetCallerIdentity` or `AssumeRole` — so two unrelated error populations
 * land in one `catch`:
 *
 *   1. the credential chain failed before the request went out, which is
 *      #564's population exactly, and
 *   2. STS answered with a modeled service exception — `ExpiredToken`,
 *      `AccessDenied`, `InvalidClientTokenId` — whose message IS the
 *      diagnosis the user needs, and which never went near
 *      `credential_process`.
 *
 * Blanket-withholding would turn the single commonest failure of these
 * commands (`ExpiredToken: The security token included in the request is
 * expired`) into a class name and a character count. So the split is by
 * population, via {@link describeAwsFailureForWarn}.
 *
 * # The safe state is defined POSITIVELY
 *
 * The discriminator is not a deny-list of bad error shapes — #564 rejected
 * that reasoning for the `Command failed:` first line, and it loses the same
 * race here. It is the SDK's own structural test for "this came off the wire
 * as a modeled service error" ({@link isAwsServiceException}). Anything that
 * does not match — a chain failure, a socket error, a bare `throw 'x'` — is
 * withheld. An unrecognised shape therefore fails toward withholding, and so
 * does a hostile endpoint that forges `x-amzn-errortype:
 * CredentialsProviderError` to dodge the branch: it lands in the withheld
 * bucket, which discloses strictly less.
 */
import { getLogger } from '../utils/logger.js';

/**
 * Longest service-exception message relayed into a `warn` line, in
 * characters.
 *
 * A modeled STS error's message is WIRE-DERIVED — the SDK reads it out of the
 * response body — so its length is not cdk-local's to assume. Real ones run
 * to roughly 150 characters (`AccessDenied: User: arn:... is not authorized to
 * perform: sts:AssumeRole on resource: arn:...`), and the policy-quoting ones
 * are the longest, so the cap is set well above that: it exists to stop an
 * unbounded body from becoming an unbounded log line, not to trim ordinary
 * AWS text, which must survive intact or the branch buys nothing.
 *
 * Truncation is announced with the true length (see
 * {@link sanitizeServiceExceptionMessage}) so a capped line is never mistaken
 * for a complete one.
 */
const SERVICE_MESSAGE_MAX = 512;

/**
 * Total stringification of a thrown value's message.
 *
 * `String(err)` is NOT total. That throw would escape the `catch` it is
 * called from and turn a warn-and-continue branch into a hard failure — a 500
 * from the SigV4 authorizer in #564's testing, and a dead `cdkl invoke` here.
 * One helper rather than an expression repeated per site, so the length
 * reported in a `warn` and the text printed at `debug` can never describe
 * different strings.
 *
 * CORRECTION to #564, measured on this repo's Node 24: `String(aSymbol)`
 * does NOT throw — it returns `'Symbol(x)'`, and it is template
 * INTERPOLATION (`` `${aSymbol}` ``) that raises
 * `TypeError: Cannot convert a Symbol value to a string`. Since both the old
 * code and this helper call `String()` explicitly, a `Symbol` throw was never
 * one of the reachable cases. The two that ARE reachable, both verified:
 * an object with a null prototype (`TypeError: Cannot convert object to
 * primitive value`, because it has no `toString`), and any value whose
 * `toString` / `Symbol.toPrimitive` throws — which a hostile or merely buggy
 * third-party error object is free to do.
 *
 * Named for what it does rather than for one caller: #564 shipped it as
 * `stringifyCredentialLoadFailure`, and #570 gave it a second population
 * (service exceptions) for which that name was simply wrong.
 */
export function stringifyThrown(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return '[unstringifiable throw]';
  }
}

/**
 * The throwing class's name, clamped to something no input can forge.
 *
 * `err.name` is NOT input-independent, which is the whole reason this is a
 * function and not an interpolation. For an AWS service exception it is
 * WIRE-DERIVED: `@aws-sdk/core` builds it from the `x-amzn-errortype` header
 * / the body's `code` / `__type` through `sanitizeErrorCode`, which splits on
 * ',' ':' and '#' and does nothing else — no length cap, no newline stripping
 * (read at `@aws-sdk/core@3.974.13` `protocols/index.js:324`). Such an
 * exception reaches these call sites, because `credential-provider-ini` calls
 * the STS `roleAssumer` unwrapped and because the #570 sites invoke STS
 * directly. So a hostile or hijacked credential endpoint
 * (`AWS_CONTAINER_CREDENTIALS_FULL_URI`, a redirected IMDS) answering
 * `x-amzn-errortype: Foo\nWARN: signature verified` could FORGE log lines
 * into the `warn` stream — and into the studio ring served over HTTP.
 *
 * A bare identifier of at most 64 characters is what every real class name is
 * and what no injected value can be; anything else degrades to `'unknown'`,
 * which also covers a non-`Error` throw, so the field never names a class the
 * throw was not.
 *
 * Note the WRONG fix: `err.name.slice(0, 64)` keeps the newline, so the
 * forgery survives truncation.
 */
export function clampErrorName(err: unknown): string {
  const rawKind = err instanceof Error ? err.name : 'unknown';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(rawKind) ? rawKind : 'unknown';
}

/**
 * Is `err` a modeled AWS service exception — i.e. did the SDK parse it out of
 * a service RESPONSE, rather than raise it while assembling the request?
 *
 * This is `ServiceException.isInstance`'s own structural test, reproduced
 * rather than imported: cdk-local loads `@aws-sdk/client-sts` lazily at every
 * one of these call sites (a dynamic `import()` inside the `try`), so taking
 * a static dependency on `@smithy/core` purely to type-test an error would
 * pull the SDK into the CLI's startup path. The structural form also keeps
 * working across the several `@smithy/core` copies pnpm resolves in this
 * tree, where an `instanceof` against one copy's class fails for an error
 * minted by another.
 *
 * The test is deliberately the SDK's and not a name list: a name list would
 * have to be extended for every new STS error code, and a missing entry would
 * fail toward DISCLOSING less, which is safe, but also toward hiding the
 * actionable message, which is the regression this split exists to avoid.
 */
export function isAwsServiceException(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { $fault?: unknown; $metadata?: unknown };
  return (
    Boolean(candidate.$metadata) && (candidate.$fault === 'client' || candidate.$fault === 'server')
  );
}

/**
 * Render a wire-derived service message safe to put on one log line.
 *
 * Two properties, and both are about the LINE rather than about secrecy — the
 * message itself is already judged safe to print by the time this is called:
 *
 *   - No control or format characters. A newline forges a whole log line into
 *     the studio ring; a bidi override (U+202E) forges how the rest of the
 *     line READS in the studio UI. Both become a space, so the text stays
 *     legible and the count of lines cdk-local emitted stays honest.
 *   - Bounded length, with the true length named when it is exceeded. The
 *     suffix names the character count of the SANITIZED message rather than
 *     of the raw one, because the sanitized string is what the truncated
 *     prefix is a prefix OF; quoting the raw length would describe a string
 *     the reader can never see.
 */
export function sanitizeServiceExceptionMessage(message: string): string {
  const flattened = message.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  if (flattened.length <= SERVICE_MESSAGE_MAX) return flattened;
  return `${flattened.slice(0, SERVICE_MESSAGE_MAX)}[... truncated; ${flattened.length}-character message]`;
}

/**
 * Describe a credential-chain failure for a default-level log line WITHOUT
 * relaying the chain's own message (issue #564).
 *
 * What is reported instead is input-INDEPENDENT: the clamped class name (see
 * {@link clampErrorName}), which is the same discriminator
 * `ecs-secrets-resolver.ts` reports for the JSON parse failure it must not
 * echo.
 *
 * The LENGTH is reported, unlike in `ecs-secrets-resolver.ts`, and the
 * difference is deliberate: there the user already knows which secret it is
 * and can read the value at its source, so a character count would be
 * disclosure buying nothing. Here the user cannot see the withheld message at
 * all, and the count is what separates a one-line
 * `Could not load credentials from any providers` (45 characters, measured
 * against `@aws-sdk/credential-provider-node@3.972.44` `dist-cjs/index.js:144`)
 * from a multi-hundred-character `Command failed:` dump — which is what tells
 * them whether their `credential_process` even ran.
 *
 * The count is a side channel, and a narrow one: against a KNOWN
 * `credential_process` template the number is `constant + len(passphrase)`, so
 * it yields the passphrase's LENGTH. That is accepted rather than overlooked.
 * It buys the one thing the user cannot otherwise see, the `Command failed:`
 * dump is not reachable on today's SDK versions anyway, and bucketing the
 * number would blur exactly the boilerplate-vs-dump distinction the field
 * exists for.
 */
export function describeCredentialLoadFailure(err: unknown): string {
  return `${clampErrorName(err)}; ${stringifyThrown(err).length}-character message withheld, logged at debug level under --verbose`;
}

/**
 * Render an AWS SDK call failure for a `logger.warn` line, and emit the
 * withheld text at `debug` when it is withheld (issue #570).
 *
 * `operation` names the call for the `debug` line — e.g.
 * `'STS GetCallerIdentity'`. It is cdk-local's own literal at every call
 * site, never anything read off an error or a response.
 *
 * # Why this emits the `debug` line itself
 *
 * Because the alternative is nine call sites each free to withhold a message
 * and forget to print it anywhere. The pairing is the invariant — "withheld
 * at `warn`" is only acceptable while "in full at `debug`" holds — so it
 * lives in one function rather than in a convention nine sites must keep. A
 * tenth site gets it for free.
 *
 * The `debug` line fires ONLY on the withheld branch. On the service-exception
 * branch the `warn` already carries the message, and repeating it verbatim one
 * level down would say nothing the reader did not just read.
 */
export function describeAwsFailureForWarn(err: unknown, operation: string): string {
  if (isAwsServiceException(err)) {
    return `${clampErrorName(err)}: ${sanitizeServiceExceptionMessage(stringifyThrown(err))}`;
  }
  getLogger().debug(`${operation}: the AWS SDK's own failure message was: ${stringifyThrown(err)}`);
  return describeCredentialLoadFailure(err);
}
