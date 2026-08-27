/**
 * Rendering an AWS SDK failure into a log line cdk-local is willing to print
 * at DEFAULT level (issues #564, #570).
 *
 * # Why a shared module
 *
 * Issue #564 settled the policy for one site — the credential-chain failure
 * in {@link file://./sigv4-verify.ts} — and #570 found the same shape at nine
 * more, spread across five `src/cli/commands/*.ts` files. Every one of them
 * relays a third-party error's `message` into a `logger.warn`, so they share
 * one question and must not grow nine answers to it.
 *
 * SCOPE, stated so a later sweep finds a decision rather than an oversight:
 * this module governs those nine plus sigv4-verify's one, and its
 * {@link flattenToOneLine} additionally covers every other wire-derived value
 * printed on those lines (the role ARN, on the failure AND success paths).
 *
 * Issue #579 extended it to the AWS SDK error relays elsewhere under
 * `src/local/**` (plus `local-studio.ts`'s image-context warn), so the policy
 * is no longer scoped to `src/cli/commands/**`:
 * `cfn-local-state-provider.ts` (`formatAwsErrorForWarn`, six callers),
 * `ssm-parameter-resolver.ts` (whose `formatSsmError` was DELETED rather than
 * fixed — it was a second spelling of the same forging vector),
 * `state-resolver.ts`, `cloudfront-kvs-client.ts`, `cloudfront-s3-origin.ts`,
 * `layer-arn-materializer.ts`, `ecr-puller.ts`, `ecs-secrets-resolver.ts` and
 * `httpv2-service-integration.ts`. Each was decided on the SAME two axes below
 * rather than rewritten mechanically, and a `catch` around a purely LOCAL
 * operation was left alone: `agentcore-s3-bundle.ts`'s unzip and
 * `layer-arn-materializer.ts`'s presigned-URL download / unzip see no
 * credential chain and no service response, so there is nothing here for them.
 *
 * The test is what a `catch` CAN SEE, and applying it by LOCATION instead is
 * how the sweep first got `agentcore-s3-bundle.ts` wrong. Its `try` does wrap
 * `unzipSync` and nothing else — but that made the S3 `GetObject` above it
 * UNCOVERED, not out of scope: it had no `catch` at all, so the raw SDK error
 * propagated to `withErrorHandling` -> `formatError`, which prints
 * `${error.name}: ${error.message}` unflattened and unclamped at DEFAULT
 * level, and the default credential chain is what a run without
 * `--assume-role` uses. "Outside that `catch`" is not "outside the sweep";
 * ask which populations reach the site, and if the answer is "nothing catches
 * it here", follow it to the frame that does.
 *
 * #579 also widened what LEVEL means, and the widening is the useful part:
 * `httpv2-service-integration.ts`'s relay is not a log line at all, it is a
 * served HTTP RESPONSE BODY — the widest reader in the sweep, since it needs
 * neither `--verbose` nor access to the terminal, and the studio capture proxy
 * records it onto the timeline besides. The axis is about READERS, not about
 * logs.
 *
 * TWO CALLING CONVENTIONS this imposes, both found by #579 rather than
 * anticipated here:
 *
 *   1. Render each failure ONCE. {@link describeAwsFailureForWarn} EMITS the
 *      `debug` line, so calling it twice for one error prints that line twice
 *      (`cfn-local-state-provider.ts`'s `load` did, having rendered the same
 *      failure for its warn and for `lastLoadError`).
 *   2. Re-raise cdk-local's OWN throws ABOVE the relay, with an identifiable
 *      class. The discriminator is positive, so a `catch` that also catches
 *      the caller's own `throw new Error('...')` withholds text cdk-local
 *      wrote itself — which is the diagnostic loss this file's
 *      {@link describeCredentialLoadFailure} note calls "a real diagnostic
 *      loss, accepted". #579 stopped accepting it where it was cheap not to:
 *      `layer-arn-materializer.ts`'s ARN-shape and missing-`Content.Location`
 *      guards became `LayerMaterializationError`s and are re-raised, and
 *      `httpv2-service-integration.ts`'s missing-RequestParameter 400 became a
 *      `ServiceIntegrationRequestError` so an actionable 400 body did not
 *      degrade into a class name and a character count.
 *
 * TWO CATCH-ALL relays remain outside it, and both are UNCOVERED. An earlier
 * revision of this note gave them opposite verdicts in adjacent paragraphs —
 * clearing one and rejecting the other on the same evidence — which was simply
 * wrong about the first, so both now read the same way:
 *
 *   - `cloudfront-server.ts:129`'s `Request handling failed: ${err.message}`.
 *     It is what makes `cloudfront-kvs-client.ts`'s throw a DEFAULT-level
 *     line, and for THAT sub-path the text arrives pre-sanitized — but it is a
 *     catch-all over the whole request pipeline, so an origin fetch, an
 *     edge-function invoke or an SDK error raised anywhere below it still
 *     reaches the line RAW.
 *   - `ecs-service-emulator.ts`'s `logger.error` at three sites (`:909`,
 *     `:1508`, `:1599`). One of them does carry
 *     `ecs-secrets-resolver.ts`'s `EcsSecretsResolutionError`, which this
 *     module sanitized on the way in — and reasoning from that to "the relay
 *     is safe" is the SAME generalisation the bullet above rejects. All three
 *     are catch-alls over a whole reload or replica roll, relaying
 *     `err instanceof Error ? err.message : String(err)`, and what they
 *     usually carry is docker CLI stderr, which is multi-line.
 *
 * So: one sub-path arriving pre-sanitized never clears a catch-all. Both need
 * the same per-occurrence call as everything else in this list. Neither is
 * done here — `cloudfront-server.ts` is out of this change's scope, and the
 * emulator's three are a different population (docker output, not SDK errors)
 * that wants the flattening half rather than the withholding half.
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
 *   2. STS answered with a modeled service exception — `ExpiredTokenException`,
 *      `AccessDenied` — whose message IS the diagnosis the user needs, and
 *      which never went near `credential_process`. (Spelled as the SDK
 *      spells them: `@aws-sdk/client-sts` models `ExpiredTokenException`
 *      (`dist-cjs/models/errors.js:6`), while `AccessDenied` is unmodeled and
 *      arrives as the wire code verbatim — which is exactly why the name is
 *      clamped rather than trusted.)
 *
 * Blanket-withholding would turn the single commonest failure of these
 * commands (`ExpiredTokenException: The security token included in the
 * request is expired`) into a class name and a character count. So the split
 * is by population, via {@link describeAwsFailureForWarn}.
 *
 * # The safe state is defined POSITIVELY
 *
 * The discriminator is not a deny-list of bad error shapes — #564 rejected
 * that reasoning for the `Command failed:` first line, and it loses the same
 * race here. It is the SDK's own structural test for "this came off the wire
 * as a modeled service error" ({@link isAwsServiceException}). Anything that
 * does not match — a chain failure, a socket error, a bare `throw 'x'` — is
 * withheld. An unrecognised shape therefore fails toward withholding.
 *
 * A hostile endpoint cannot steer the discriminator into disclosing MORE.
 * `$fault` / `$metadata` are set by the SDK from the HTTP response, not from
 * anything the body names, so forging `x-amzn-errortype:
 * CredentialsProviderError` only changes `err.name` — the response is still a
 * service response, so the error stays on the KEPT branch and its message is
 * still the sanitized, capped one the endpoint could have sent under any
 * other name. What the endpoint cannot do is move a `credential_process`
 * command line onto that branch: that text originates locally, inside a
 * `CredentialsProviderError` that never acquires `$fault`.
 *
 * # What this does NOT close
 *
 * A single-LINE forged string still reaches readers other than a human. It no
 * longer redirects the studio capture proxy: issue #578 anchored every
 * `cdkl studio` ready pattern to the start of the line, made the serve manager
 * skip a line carrying cdk-local's own `WARN: ` / `ERROR: ` decoration
 * outright, and bounded the resolved upstream to loopback — so a message
 * containing `Server listening on http://...` is neither read as a banner nor
 * usable as a destination. What remains is the reader this sanitizer was
 * always aimed at: a HUMAN scanning the log, for whom a forged-looking line is
 * still misleading text, which is why the flattening + capping stay.
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
  // The READ is guarded, not just the value. `err` is a third-party object and
  // `name` can be an accessor that throws (or a Proxy trap that does), and such
  // a throw would escape the `catch` this is called from -- the same hazard
  // {@link stringifyThrown} exists to close, arriving through a different
  // property.
  let rawKind: unknown;
  try {
    rawKind = err instanceof Error ? err.name : 'unknown';
  } catch {
    return 'unknown';
  }
  return typeof rawKind === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawKind)
    ? rawKind
    : 'unknown';
}

/**
 * The thrown value's `code`, when it is a bare identifier, else `undefined`.
 *
 * This exists because withholding by class name alone is not discriminating
 * enough for the population that actually reaches the withheld branch most
 * often. `Region is missing`, `getaddrinfo ENOTFOUND sts.<region>.amazonaws.com`
 * and `connect ETIMEDOUT 169.254.169.254:80` all arrive as a plain `Error`, so
 * all three render as `Error; N-character message withheld` and the reader
 * cannot tell a misconfiguration from an unreachable endpoint.
 *
 * Node sets `code` on its system errors (`ENOTFOUND`, `ETIMEDOUT`,
 * `ECONNREFUSED`) and there it is a fixed enum chosen by the runtime. It is
 * NOT input-independent in general, though, and the earlier draft of this note
 * claimed it was: `@smithy/core`'s `decorateServiceException`
 * (`dist-cjs/submodules/client/index.js:795-802`) copies every key of the
 * PARSED RESPONSE BODY onto the exception, so an unmodeled error from a
 * hostile endpoint can carry a `code` of its choosing. The clamp is therefore
 * load-bearing rather than belt-and-braces, exactly as it is for
 * {@link clampErrorName}: what survives is at most 64 characters matching
 * `[A-Za-z0-9_.-]`, which cannot forge a line, and which is the same residue
 * the class name already accepts.
 *
 * `undefined` rather than `'unknown'` when there is none, so the caller can
 * omit the field entirely instead of printing a placeholder that says less
 * than nothing.
 */
export function clampErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  let raw: unknown;
  try {
    raw = (err as { code?: unknown }).code;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
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
  try {
    return (
      Boolean(candidate.$metadata) &&
      (candidate.$fault === 'client' || candidate.$fault === 'server')
    );
  } catch {
    // A throwing accessor means the shape cannot be established, and an
    // unestablished shape is the withheld bucket -- the same direction every
    // other unknown takes.
    return false;
  }
}

/**
 * Replace every character that could make one emitted line render as more than
 * one line, or render in an order it was not written in, with a space.
 *
 * Four Unicode categories, each measured rather than assumed (see the fixture
 * in `tests/unit/local/credential-error.test.ts`):
 *
 *   - `Cc` — the C0/C1 controls, which is `\n` / `\r` (a forged extra line in
 *     the studio ring) and `\x1b` (an ANSI escape in a terminal). U+0085 NEL
 *     lives here too.
 *   - `Cf` — the format characters, which is U+202E RIGHT-TO-LEFT OVERRIDE and
 *     friends: they forge how the REST of the line reads. The cost is that a
 *     ZWJ inside an emoji or an Indic cluster is replaced too; an AWS error
 *     message is ASCII, so that is a trade with no observed downside.
 *   - `Zl` / `Zp` — U+2028 and U+2029. Neither is in `Cc` or `Cf`, and both are
 *     forced line breaks in the studio UI's `<pre>`, so leaving them out would
 *     have left the forged-line case open in HTML while closing it in a
 *     terminal.
 *   - `Cs` — a LONE surrogate, which is not a character at all and breaks JSON
 *     encoding of the log event. With the `u` flag a well-formed pair is one
 *     code point and does NOT match, so emoji survive.
 *
 * Used by both branches of {@link describeAwsFailureForWarn} — the kept
 * message, and the `debug` line carrying the withheld one, because the `debug`
 * stream is the SAME studio ring under `--verbose`, so a text unsafe to put on
 * a line at `warn` is unsafe at `debug` — and, since issue #570's review
 * rounds, by every OTHER wire-derived value that lands on one of these lines:
 * `sigv4-verify`'s own `debug` line, and the role ARN at the four warn sites
 * plus the five `info` / `debug` sites that print an ARN resolved from a live
 * `GetFunctionConfiguration` / `GetAgentRuntime` response. The last group is
 * the more reachable one — it fires on SUCCESS.
 */
export function flattenToOneLine(message: string): string {
  return message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, ' ');
}

/**
 * Render a wire-derived service message safe to put on one log line.
 *
 * Two properties, and both are about the LINE rather than about secrecy — the
 * message itself is already judged safe to print by the time this is called:
 *
 *   - No line breaks and no rendering-direction control, via
 *     {@link flattenToOneLine}.
 *   - Bounded length, with the true length named when it is exceeded. The
 *     suffix names the character count of the SANITIZED message rather than
 *     of the raw one, because the sanitized string is what the truncated
 *     prefix is a prefix OF; quoting the raw length would describe a string
 *     the reader can never see.
 *
 * The cut is made on CODE POINTS rather than UTF-16 units, so a truncation
 * landing inside an astral character cannot emit half of a surrogate pair. The
 * count in the suffix is the code-point count for the same reason: the prefix
 * and the number must describe the same string.
 */
export function sanitizeServiceExceptionMessage(message: string): string {
  // Code points are exactly the unit wanted here. `no-misused-spread`'s concern
  // is that spreading a string splits grapheme CLUSTERS (a ZWJ emoji sequence, a
  // combining mark), and that is accepted: the input is an AWS error message,
  // and the property being bought is that the cut cannot land inside a surrogate
  // PAIR and emit half of one. `Intl.Segmenter` would preserve clusters and is
  // what the rule suggests, but it makes the cap locale-dependent, which a
  // log-line bound must not be.
  // oxlint-disable-next-line typescript/no-misused-spread
  const points = [...flattenToOneLine(message)];
  if (points.length <= SERVICE_MESSAGE_MAX) return points.join('');
  return `${points.slice(0, SERVICE_MESSAGE_MAX).join('')}[... truncated; ${points.length}-character message]`;
}

/**
 * Describe a credential-chain failure for a default-level log line WITHOUT
 * relaying the chain's own message (issue #564).
 *
 * What is reported instead is input-INDEPENDENT: the clamped class name (see
 * {@link clampErrorName}), which is the same discriminator
 * `ecs-secrets-resolver.ts` reports for the JSON parse failure it must not
 * echo, plus the clamped {@link clampErrorCode} when the throw carries one.
 *
 * Withholding is NOT free, and the cost lands on cdk-local's own text as well
 * as on the SDK's. The worked example used to be `role-arn.ts`'s
 * `AssumeRole(<arn>) returned no usable credentials.`: a plain `Error` with no
 * `$fault`, so it was withheld like any other, and the note recorded that as a
 * real diagnostic loss accepted because the alternative — an allow-list of
 * messages that may print — is the deny-list this design rejects, wearing the
 * other sign. It also named the right fix: make cdk-local's own throws
 * IDENTIFIABLE rather than guess at their text.
 *
 * Issue #579 did that, for exactly this example. `role-arn.ts` now throws
 * `AssumeRoleFailure`, carrying a `detail` its relaying callers print verbatim
 * — and the same pattern closed the identical loss in
 * `layer-arn-materializer.ts`, `httpv2-service-integration.ts`,
 * `ecr-puller.ts`, `local-run-task.ts` and `ecs-service-emulator.ts`. The
 * general point stands and is what a new site should apply: the policy cannot
 * tell cdk-local's own sentence from a hostile endpoint's, so a `catch` that
 * can see both must make its own throws recognisable BEFORE the relay.
 *
 * The remaining ARN-length question — an ARN is structured, so the bound
 * belongs at the three resolution points rather than at the log line — is
 * tracked separately at
 * https://github.com/go-to-k/cdk-local/issues/607.
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
  const code = clampErrorCode(err);
  const kind = code === undefined ? clampErrorName(err) : `${clampErrorName(err)} ${code}`;
  return `${kind}; ${stringifyThrown(err).length}-character message withheld, logged at debug level under --verbose`;
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
 *
 * It is FLATTENED (not capped). Flattened because the `debug` stream is not a
 * private channel: it is the same stdout `cdkl studio` mirrors into the log
 * ring it serves over HTTP, so a `\n` in the withheld text would forge a line
 * there exactly as it would at `warn`. Not capped, because being able to read
 * the whole withheld message is the entire reason the line exists — the
 * `warn`'s character count is what tells the reader how much they are about to
 * see. Note that this puts the full text into that ring for a
 * `--verbose` studio run; see `docs/troubleshooting.md`.
 *
 * ORDERING: the `debug` line is emitted when THIS function runs, which is
 * before the `warn` at every site — inline in the `warn`'s template at eight of
 * them, and a couple of statements earlier at the one that hoists the result
 * into a `const reason`. Either way it prints immediately ABOVE the `warn` that
 * refers to it under `--verbose`. Left as is: restructuring every call site to
 * log afterwards would buy an ordering nobody reads top-down anyway.
 */
export function describeAwsFailureForWarn(err: unknown, operation: string): string {
  if (isAwsServiceException(err)) {
    return `${clampErrorName(err)}: ${sanitizeServiceExceptionMessage(stringifyThrown(err))}`;
  }
  getLogger().debug(
    `${operation}: the AWS SDK's own failure message was: ${flattenToOneLine(stringifyThrown(err))}`
  );
  return describeCredentialLoadFailure(err);
}
