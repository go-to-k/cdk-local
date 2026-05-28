import { getLogger } from './logger.js';

/**
 * Base error class for cdk-local
 */
export class CdkLocalError extends Error {
  public readonly code: string;
  public readonly cause: Error | undefined;

  constructor(message: string, code: string, cause?: Error) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = 'CdkLocalError';
    Object.setPrototypeOf(this, CdkLocalError.prototype);
  }
}

/**
 * Local-invoke `docker build` failures.
 *
 * Surfaces the stderr captured from `docker build` so the user can
 * re-run the same command directly to debug Dockerfile syntax errors
 * or missing build context. Used by `src/local/docker-image-builder.ts`
 * for container Lambdas. Kept distinct from a generic asset/build error
 * so `cdkl invoke` failures don't show up under an unrelated error class.
 */
export class LocalInvokeBuildError extends CdkLocalError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCAL_INVOKE_BUILD_ERROR', cause);
    this.name = 'LocalInvokeBuildError';
    Object.setPrototypeOf(this, LocalInvokeBuildError.prototype);
  }
}

/**
 * Signals that `cdkl start-api`'s route discovery hit an unsupported
 * shape — non-AWS_PROXY integration, ApiGwV2 service integration
 * (`IntegrationSubtype` set), WebSocket protocol, Lambda::Url with an
 * unrecognized `AuthType` (anything other than `'NONE'` / `'AWS_IAM'`),
 * or an unsupported intrinsic function in `IntegrationUri`. (Lambda::Url
 * with `InvokeMode: RESPONSE_STREAM` is a normal route dispatched via
 * the streaming protocol. Lambda::Url with `AuthType: 'AWS_IAM'`
 * is a normal route verified through the SigV4 pipeline.)
 *
 * The message names every offending route. Hard-error at discovery so
 * the server never starts in a half-working state.
 */
export class RouteDiscoveryError extends CdkLocalError {
  constructor(message: string, cause?: Error) {
    super(message, 'ROUTE_DISCOVERY_ERROR', cause);
    this.name = 'RouteDiscoveryError';
    Object.setPrototypeOf(this, RouteDiscoveryError.prototype);
  }
}

/**
 * Signals a `cdkl start-service` orchestration failure
 * (`AWS::ECS::Service` emulator). The service runner has its own
 * lifecycle (long-running replica pool, restart-on-exit), so a failure
 * inside it carries different operator semantics than a one-shot task
 * failure.
 */
export class LocalStartServiceError extends CdkLocalError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCAL_START_SERVICE_ERROR', cause);
    this.name = 'LocalStartServiceError';
    Object.setPrototypeOf(this, LocalStartServiceError.prototype);
  }
}

/**
 * Check if error is a cdk-local error
 */
export function isCdkLocalError(error: unknown): error is CdkLocalError {
  return error instanceof CdkLocalError;
}

/**
 * Format error for display
 */
export function formatError(error: unknown): string {
  if (isCdkLocalError(error)) {
    let message = `${error.name}: ${error.message}`;
    if (error.cause) {
      message += `\nCaused by: ${error.cause.message}`;
    }
    return message;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

/**
 * Global error handler
 *
 * Default exit code is 1 (general error). A {@link CdkLocalError}
 * subclass may override it by declaring a custom `exitCode` field so
 * callers can distinguish "command crashed / unauthorized / bad
 * arguments" from "command completed but some resources are still in an
 * error state, re-run to clean up".
 *
 * A {@link CdkLocalError} subclass may set `silent = true` to suppress
 * the default `logger.error` line — used when the command has already
 * printed a richer report and only needs the exit code.
 */
export function handleError(error: unknown): never {
  const logger = getLogger();
  const silent =
    error instanceof CdkLocalError && (error as CdkLocalError & { silent?: boolean }).silent;
  if (!silent) {
    logger.error(formatError(error));
  }

  if (error instanceof Error && error.stack) {
    logger.debug('Stack trace:', error.stack);
  }

  // Honor any CdkLocalError subclass that declares a custom `exitCode`
  // field. Falling back to 1 covers `CdkLocalError` subclasses with no
  // override and every non-cdk-local error.
  const customExitCode =
    error instanceof CdkLocalError
      ? (error as CdkLocalError & { exitCode?: number }).exitCode
      : undefined;
  const exitCode = typeof customExitCode === 'number' ? customExitCode : 1;
  process.exit(exitCode);
}

/**
 * Wrap async function with error handling
 *
 * Note: Uses `any[]` for args to support Commander.js action handlers
 * which can have various parameter types
 */
export function withErrorHandling<Args extends unknown[], Return extends Promise<void> | void>(
  fn: (...args: Args) => Return
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      handleError(error);
    }
  };
}

/**
 * Context passed to {@link normalizeAwsError} so the rewritten message can
 * name the bucket/operation that produced the synthetic SDK error.
 */
export interface NormalizeAwsErrorContext {
  bucket?: string;
  operation?: string;
}

/**
 * Convert AWS SDK v3's synthetic `Unknown` / `UnknownError` exception into
 * an actionable `Error` keyed off `$metadata.httpStatusCode`.
 *
 * Background — why this helper exists:
 *   AWS SDK v3 produces a synthetic `name: 'Unknown'`, `message:
 *   'UnknownError'` exception when the protocol parser hits a HEAD response
 *   with an empty body. The most common trigger is `HeadBucket` against a
 *   bucket in a different region than the client (S3 returns 301
 *   PermanentRedirect with `x-amz-bucket-region` set, but the redirect
 *   middleware doesn't recover from the empty body). Surfacing the literal
 *   string `UnknownError` to users is uninformative.
 *
 * Behavior:
 *   - Non-AWS-SDK errors (anything where `name` is not `Unknown` and
 *     `message` is not `UnknownError`) pass through unchanged.
 *   - AWS SDK Unknown errors are mapped by HTTP status:
 *     - 301 → `Bucket '<name>' is in a different region…` (auto-resolved
 *       elsewhere; if this surfaces, it's a bug worth reporting).
 *     - 403 → `Access denied to bucket '<name>'.`
 *     - 404 → `Bucket '<name>' does not exist.`
 *     - other / unknown → `S3 error during <operation> on '<bucket>' (HTTP
 *       <status>).`
 */
export function normalizeAwsError(err: unknown, context: NormalizeAwsErrorContext = {}): Error {
  if (!(err instanceof Error)) {
    return new Error(String(err));
  }

  // Detect the AWS SDK v3 "Unknown" synthetic exception. Other errors pass
  // through unchanged so we don't accidentally rewrite a legitimate AWS
  // error message.
  const isUnknown = err.name === 'Unknown' || err.message === 'UnknownError';
  if (!isUnknown) return err;

  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const status = meta?.httpStatusCode;
  const bucket = context.bucket ?? '<unknown bucket>';
  const operation = context.operation ?? 'operation';

  switch (status) {
    case 301: {
      // Try to surface the bucket's actual region from the response header
      // when the SDK exposes it. Header keys are lowercased by the SDK.
      const responseHeaders = (err as { $response?: { headers?: Record<string, string> } })
        .$response?.headers;
      const region =
        responseHeaders?.['x-amz-bucket-region'] ?? responseHeaders?.['X-Amz-Bucket-Region'];
      const where = region ? ` (in ${region})` : '';
      return new Error(
        `Bucket '${bucket}'${where} is in a different region than the client. ` +
          `cdk-local resolves this automatically; if you see this message, please report it.`
      );
    }
    case 403:
      return new Error(
        `Access denied to bucket '${bucket}'. Verify credentials and bucket policy.`
      );
    case 404:
      return new Error(`Bucket '${bucket}' does not exist.`);
    default: {
      const statusStr = status !== undefined ? `HTTP ${status}` : 'unknown HTTP status';
      return new Error(
        `S3 error during ${operation} on '${bucket}' (${statusStr}). ` +
          `See CloudTrail for details.`
      );
    }
  }
}
