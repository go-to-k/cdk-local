/**
 * Per-subtype dispatcher for HTTP API v2 service integrations
 * (`IntegrationType: AWS_PROXY` + `IntegrationSubtype: <Service>-<Action>`).
 *
 * Full AWS-documented subtype list (NOT exhaustive — see AWS docs at
 *   https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-aws-services-reference.html
 * for the complete reference, which also covers Lambda-Invoke, the
 * DynamoDB-* family, SNS-Publish, AppConfig-StartConfigurationSession,
 * SQS-SendMessageBatch / Kinesis-PutRecords, etc.).
 *
 * Subtypes cdk-local currently bundles SDK clients for:
 *   - EventBridge-PutEvents
 *   - SQS-SendMessage / SQS-ReceiveMessage / SQS-DeleteMessage / SQS-PurgeQueue
 *   - Kinesis-PutRecord
 *   - StepFunctions-StartExecution / StartSyncExecution / StopExecution
 *   - AppConfig-GetConfiguration (recognized but returns 501 — the
 *     `@aws-sdk/client-appconfig` package is not yet bundled)
 *
 * Unrecognized subtypes (including AWS-documented entries cdk-local does not
 * yet implement, and outright typos) fall back to the deferred-501 path
 * in `route-discovery.ts`, surfacing a clean HTTP 501 at request time
 * rather than aborting boot.
 *
 * Each subtype maps to ONE AWS SDK call. The `RequestParameters` map
 * carries the SDK input (already resolved to strings by
 * `parameter-mapping.ts`); per-subtype adapters convert it to the
 * shape the SDK's typed `*Command` constructor expects.
 *
 * `Region` is special-cased: AWS docs list it as an optional parameter
 * on every subtype to override the SDK client's default region. When
 * resolved to a non-empty string, the per-subtype adapter passes it
 * to the SDK client constructor.
 *
 * Authentication: SDK calls run under the dev's local AWS credential
 * chain (same chain as `cdkl invoke --assume-role` v1) — no
 * separate `--service-integration-role` flag in this PR. The dev's
 * permissions therefore control what the local route can reach,
 * matching the safe-by-default precedent set by sigv4-verify.ts.
 *
 * Response shape: each adapter returns
 *   `{ statusCode, body, headers }`
 * which the HTTP server passes through verbatim. SDK errors surface as
 * HTTP 4xx (client errors — e.g. NonExistentQueue, ValidationException)
 * or HTTP 5xx (service errors). The default content-type is
 * `application/json`; per-subtype overlays are applied via the
 * `IntegrationResponseParameters` overlay applied separately by the
 * server.
 */

import type * as EventBridgeNs from '@aws-sdk/client-eventbridge';
import type * as KinesisNs from '@aws-sdk/client-kinesis';
import type * as SfnNs from '@aws-sdk/client-sfn';
import type * as SqsNs from '@aws-sdk/client-sqs';
import { stringifyValue } from '../utils/stringify.js';
import { getLogger } from '../utils/logger.js';
import { getEmbedConfig } from './embed-config.js';
import {
  clampErrorName,
  describeAwsFailureForWarn,
  isAwsServiceException,
  sanitizeServiceExceptionMessage,
  stringifyThrown,
} from './credential-error.js';

const logger = getLogger();

/**
 * Resolved service-integration call descriptor — emitted by the route
 * discovery layer, consumed by the dispatcher.
 */
export interface ServiceIntegrationSpec {
  /** Canonical subtype, e.g. `'SQS-SendMessage'`. */
  subtype: SupportedSubtype;
  /** The raw `RequestParameters` map from the CFn template. */
  requestParameters: Readonly<Record<string, unknown>>;
  /** Optional per-status-code `ResponseParameters` from the CFn template. */
  responseParameters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * SDK-call outcome before response-parameter overlay.
 */
export interface ServiceIntegrationResult {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

export type SupportedSubtype =
  | 'EventBridge-PutEvents'
  | 'SQS-SendMessage'
  | 'SQS-ReceiveMessage'
  | 'SQS-DeleteMessage'
  | 'SQS-PurgeQueue'
  | 'Kinesis-PutRecord'
  | 'StepFunctions-StartExecution'
  | 'StepFunctions-StartSyncExecution'
  | 'StepFunctions-StopExecution'
  | 'AppConfig-GetConfiguration';

/**
 * Full list of subtypes cdk-local recognizes as supported. Mirrors AWS docs.
 */
export const SUPPORTED_SUBTYPES: readonly SupportedSubtype[] = [
  'EventBridge-PutEvents',
  'SQS-SendMessage',
  'SQS-ReceiveMessage',
  'SQS-DeleteMessage',
  'SQS-PurgeQueue',
  'Kinesis-PutRecord',
  'StepFunctions-StartExecution',
  'StepFunctions-StartSyncExecution',
  'StepFunctions-StopExecution',
  'AppConfig-GetConfiguration',
];

/**
 * Type guard: is the string an AWS-recognized service-integration subtype?
 *
 * Used by route discovery to classify routes — recognized subtypes go
 * through dispatch, anything else (typo, future-AWS-subtype-not-yet-supported)
 * falls back to deferred-501.
 */
export function isSupportedSubtype(value: unknown): value is SupportedSubtype {
  return typeof value === 'string' && (SUPPORTED_SUBTYPES as readonly string[]).includes(value);
}

/**
 * Lazy-loaded SDK clients keyed by `<service>:<region>`. SDK packages
 * are heavyweight (~5-10 MB each); per-process per-region caching
 * avoids re-instantiating the AWS Signer + middleware stack on every
 * request.
 */
const clientCache = new Map<string, unknown>();

async function getClient(service: string, region: string): Promise<unknown> {
  const key = `${service}:${region}`;
  const cached = clientCache.get(key);
  if (cached) return cached;
  let client: unknown;
  switch (service) {
    case 'sqs': {
      const mod = await import('@aws-sdk/client-sqs');
      client = new mod.SQSClient({ region });
      break;
    }
    case 'sns': {
      const mod = await import('@aws-sdk/client-sns');
      client = new mod.SNSClient({ region });
      break;
    }
    case 'eventbridge': {
      const mod = await import('@aws-sdk/client-eventbridge');
      client = new mod.EventBridgeClient({ region });
      break;
    }
    case 'kinesis': {
      const mod = await import('@aws-sdk/client-kinesis');
      client = new mod.KinesisClient({ region });
      break;
    }
    case 'sfn': {
      const mod = await import('@aws-sdk/client-sfn');
      client = new mod.SFNClient({ region });
      break;
    }
    case 'ssm': {
      const mod = await import('@aws-sdk/client-ssm');
      client = new mod.SSMClient({ region });
      break;
    }
    default:
      throw new Error(`unknown service '${service}'`);
  }
  clientCache.set(key, client);
  return client;
}

/**
 * Internal test hook — drop all cached SDK clients so unit tests can
 * reset module-scoped state between cases. NOT exported via the public
 * `index.ts`; used only by `tests/unit/local/httpv2-service-integration.test.ts`.
 */
export function _resetClientCacheForTest(): void {
  clientCache.clear();
}

/**
 * Dispatch a service integration: build the SDK input from the
 * pre-resolved parameter map, invoke the SDK, translate the response
 * to HTTP shape.
 *
 * `defaultRegion` is the cdk-local process's default AWS region (from
 * `AWS_REGION` / profile / `--region`). When the resolved parameter
 * map includes a non-empty `Region`, that value overrides the default
 * for this single call — matches AWS API Gateway behavior.
 *
 * Returns a `ServiceIntegrationResult` for the HTTP server to write
 * to the client. SDK-level errors are caught and translated to
 * HTTP 4xx / 5xx — never thrown.
 */
export async function dispatchServiceIntegration(
  subtype: SupportedSubtype,
  resolvedParameters: Readonly<Record<string, string>>,
  defaultRegion: string
): Promise<ServiceIntegrationResult> {
  // Extract the optional Region parameter — it's documented on every
  // subtype as the SDK client region override.
  const region = (resolvedParameters['Region'] || defaultRegion).trim();
  if (!region) {
    return errorResponse(
      400,
      "No AWS region configured. Set --region, AWS_REGION, or pass a 'Region' RequestParameter."
    );
  }

  try {
    switch (subtype) {
      case 'EventBridge-PutEvents':
        return await dispatchEventBridgePutEvents(resolvedParameters, region);
      case 'SQS-SendMessage':
        return await dispatchSqsSendMessage(resolvedParameters, region);
      case 'SQS-ReceiveMessage':
        return await dispatchSqsReceiveMessage(resolvedParameters, region);
      case 'SQS-DeleteMessage':
        return await dispatchSqsDeleteMessage(resolvedParameters, region);
      case 'SQS-PurgeQueue':
        return await dispatchSqsPurgeQueue(resolvedParameters, region);
      case 'Kinesis-PutRecord':
        return await dispatchKinesisPutRecord(resolvedParameters, region);
      case 'StepFunctions-StartExecution':
        return await dispatchSfnStartExecution(resolvedParameters, region);
      case 'StepFunctions-StartSyncExecution':
        return await dispatchSfnStartSyncExecution(resolvedParameters, region);
      case 'StepFunctions-StopExecution':
        return await dispatchSfnStopExecution(resolvedParameters, region);
      case 'AppConfig-GetConfiguration':
        return await dispatchAppConfigGetConfiguration(resolvedParameters, region);
    }
  } catch (err) {
    return translateSdkError(subtype, err);
  }
}

// ---------------------------------------------------------------------
// Per-subtype adapters
// ---------------------------------------------------------------------

async function dispatchEventBridgePutEvents(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['Detail', 'DetailType', 'Source']);
  const mod = await import('@aws-sdk/client-eventbridge');
  const client = (await getClient('eventbridge', region)) as EventBridgeNs.EventBridgeClient;
  const entry: Record<string, unknown> = {
    Detail: params['Detail'],
    DetailType: params['DetailType'],
    Source: params['Source'],
  };
  if (params['Time']) entry['Time'] = new Date(params['Time']);
  if (params['EventBusName']) entry['EventBusName'] = params['EventBusName'];
  if (params['Resources']) entry['Resources'] = splitCsv(params['Resources']);
  if (params['TraceHeader']) entry['TraceHeader'] = params['TraceHeader'];
  const response = await client.send(
    new mod.PutEventsCommand({ Entries: [entry as EventBridgeNs.PutEventsRequestEntry] })
  );
  return okJson(response);
}

async function dispatchSqsSendMessage(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['QueueUrl', 'MessageBody']);
  const mod = await import('@aws-sdk/client-sqs');
  const client = (await getClient('sqs', region)) as SqsNs.SQSClient;
  const input: Record<string, unknown> = {
    QueueUrl: params['QueueUrl'],
    MessageBody: params['MessageBody'],
  };
  if (params['DelaySeconds']) input['DelaySeconds'] = Number(params['DelaySeconds']);
  if (params['MessageDeduplicationId'])
    input['MessageDeduplicationId'] = params['MessageDeduplicationId'];
  if (params['MessageGroupId']) input['MessageGroupId'] = params['MessageGroupId'];
  if (params['MessageAttributes']) {
    input['MessageAttributes'] = parseJsonOrEmpty(params['MessageAttributes']);
  }
  if (params['MessageSystemAttributes']) {
    input['MessageSystemAttributes'] = parseJsonOrEmpty(params['MessageSystemAttributes']);
  }
  const response = await client.send(
    new mod.SendMessageCommand(input as unknown as SqsNs.SendMessageCommandInput)
  );
  return okJson(response);
}

async function dispatchSqsReceiveMessage(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['QueueUrl']);
  const mod = await import('@aws-sdk/client-sqs');
  const client = (await getClient('sqs', region)) as SqsNs.SQSClient;
  const input: Record<string, unknown> = { QueueUrl: params['QueueUrl'] };
  if (params['AttributeNames']) input['AttributeNames'] = splitCsv(params['AttributeNames']);
  if (params['MaxNumberOfMessages'])
    input['MaxNumberOfMessages'] = Number(params['MaxNumberOfMessages']);
  if (params['MessageAttributeNames'])
    input['MessageAttributeNames'] = splitCsv(params['MessageAttributeNames']);
  if (params['ReceiveRequestAttemptId'])
    input['ReceiveRequestAttemptId'] = params['ReceiveRequestAttemptId'];
  if (params['VisibilityTimeout']) input['VisibilityTimeout'] = Number(params['VisibilityTimeout']);
  if (params['WaitTimeSeconds']) input['WaitTimeSeconds'] = Number(params['WaitTimeSeconds']);
  const response = await client.send(
    new mod.ReceiveMessageCommand(input as unknown as SqsNs.ReceiveMessageCommandInput)
  );
  return okJson(response);
}

async function dispatchSqsDeleteMessage(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['QueueUrl', 'ReceiptHandle']);
  const mod = await import('@aws-sdk/client-sqs');
  const client = (await getClient('sqs', region)) as SqsNs.SQSClient;
  const response = await client.send(
    new mod.DeleteMessageCommand({
      QueueUrl: params['QueueUrl'],
      ReceiptHandle: params['ReceiptHandle'],
    })
  );
  return okJson(response);
}

async function dispatchSqsPurgeQueue(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['QueueUrl']);
  const mod = await import('@aws-sdk/client-sqs');
  const client = (await getClient('sqs', region)) as SqsNs.SQSClient;
  const response = await client.send(new mod.PurgeQueueCommand({ QueueUrl: params['QueueUrl'] }));
  return okJson(response);
}

async function dispatchKinesisPutRecord(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['StreamName', 'Data', 'PartitionKey']);
  const mod = await import('@aws-sdk/client-kinesis');
  const client = (await getClient('kinesis', region)) as KinesisNs.KinesisClient;
  // Data is documented as base64 in the AWS PutRecord API; HTTP API
  // v2 service integrations pass it through as-is (a string already),
  // and the SDK accepts Uint8Array. Best-effort: if the resolved value
  // is already base64-shaped (no whitespace + only base64 alphabet),
  // decode it; otherwise treat the raw string as UTF-8 bytes.
  const dataBytes = decodeBase64OrUtf8(params['Data'] ?? '');
  const input: Record<string, unknown> = {
    StreamName: params['StreamName'],
    Data: dataBytes,
    PartitionKey: params['PartitionKey'],
  };
  if (params['SequenceNumberForOrdering'])
    input['SequenceNumberForOrdering'] = params['SequenceNumberForOrdering'];
  if (params['ExplicitHashKey']) input['ExplicitHashKey'] = params['ExplicitHashKey'];
  const response = await client.send(
    new mod.PutRecordCommand(input as unknown as KinesisNs.PutRecordInput)
  );
  return okJson(response);
}

async function dispatchSfnStartExecution(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['StateMachineArn']);
  const mod = await import('@aws-sdk/client-sfn');
  const client = (await getClient('sfn', region)) as SfnNs.SFNClient;
  const input: Record<string, unknown> = { stateMachineArn: params['StateMachineArn'] };
  if (params['Name']) input['name'] = params['Name'];
  if (params['Input']) input['input'] = params['Input'];
  const response = await client.send(
    new mod.StartExecutionCommand(input as unknown as SfnNs.StartExecutionInput)
  );
  return okJson(response);
}

async function dispatchSfnStartSyncExecution(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['StateMachineArn']);
  const mod = await import('@aws-sdk/client-sfn');
  const client = (await getClient('sfn', region)) as SfnNs.SFNClient;
  const input: Record<string, unknown> = { stateMachineArn: params['StateMachineArn'] };
  if (params['Name']) input['name'] = params['Name'];
  if (params['Input']) input['input'] = params['Input'];
  if (params['TraceHeader']) input['traceHeader'] = params['TraceHeader'];
  const response = await client.send(
    new mod.StartSyncExecutionCommand(input as unknown as SfnNs.StartSyncExecutionInput)
  );
  return okJson(response);
}

async function dispatchSfnStopExecution(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  requireParams(params, ['ExecutionArn']);
  const mod = await import('@aws-sdk/client-sfn');
  const client = (await getClient('sfn', region)) as SfnNs.SFNClient;
  const input: Record<string, unknown> = { executionArn: params['ExecutionArn'] };
  if (params['Cause']) input['cause'] = params['Cause'];
  if (params['Error']) input['error'] = params['Error'];
  const response = await client.send(
    new mod.StopExecutionCommand(input as unknown as SfnNs.StopExecutionInput)
  );
  return okJson(response);
}

async function dispatchAppConfigGetConfiguration(
  params: Record<string, string>,
  region: string
): Promise<ServiceIntegrationResult> {
  // The AWS docs map AppConfig-GetConfiguration to the LEGACY
  // appconfig:GetConfiguration call (deprecated by AWS in favor of
  // GetLatestConfiguration via AppConfigData). The legacy operation
  // lives in `@aws-sdk/client-appconfig`, not appconfigdata. We do
  // NOT carry that client in package.json today (not used elsewhere
  // in cdk-local) — surface a clear "package not present" error rather
  // than depending on it for a single subtype. Adding the dep is a
  // follow-up if real usage emerges.
  void params;
  void region;
  return errorResponse(
    501,
    `AppConfig-GetConfiguration is recognized but ${getEmbedConfig().productName} does not yet bundle @aws-sdk/client-appconfig. Use the deployed API for this subtype, or open an issue if you need local emulation.`
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * A REQUEST-shape rejection raised by cdk-local itself, before any AWS call.
 *
 * Issue #579 — it needs its own class so {@link translateSdkError} can tell it
 * apart from a relayed SDK failure. Its message is cdk-local's own literal and
 * names the missing parameter, so it is the diagnosis and must reach the
 * client verbatim; the credential-error policy withholds every non-service
 * exception, which would otherwise have turned this 400 into a class name and
 * a character count. `credential-error.ts` names exactly this remedy: make
 * cdk-local's own throws identifiable rather than guess at their text.
 *
 * The ONE remaining cdk-local-authored throw inside the guarded `try` is
 * `getClient`'s `unknown service '<x>'`, and it is left withheld deliberately:
 * its `switch` is exhaustive over the dispatched subtypes, so the arm is dead
 * code guarding against a future subtype added without a client case. If it
 * ever does fire, the developer who added that subtype reads the full text on
 * the `debug` line the helper emits.
 */
class ServiceIntegrationRequestError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ServiceIntegrationRequestError';
    Object.setPrototypeOf(this, ServiceIntegrationRequestError.prototype);
  }
}

function requireParams(params: Record<string, string>, required: readonly string[]): void {
  const missing = required.filter((k) => !params[k] || params[k].trim() === '');
  if (missing.length > 0) {
    throw new ServiceIntegrationRequestError(
      `missing required RequestParameter(s): ${missing.join(', ')}`
    );
  }
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseJsonOrEmpty(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function decodeBase64OrUtf8(value: string): Uint8Array {
  const trimmed = value.trim();
  // RFC 4648 base64 alphabet check (no whitespace, padding allowed).
  if (/^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length % 4 === 0 && trimmed.length > 0) {
    try {
      return Buffer.from(trimmed, 'base64');
    } catch {
      /* fall through */
    }
  }
  return Buffer.from(value, 'utf8');
}

function okJson(response: unknown): ServiceIntegrationResult {
  // The SDK response includes a `$metadata` envelope we strip for
  // user-facing responses — matches AWS API Gateway's behavior, which
  // surfaces only the operation-specific fields.
  const stripped = stripSdkMetadata(response);
  return {
    statusCode: 200,
    body: JSON.stringify(stripped),
    headers: { 'content-type': 'application/json' },
  };
}

function stripSdkMetadata(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj;
  const { $metadata: _meta, ...rest } = obj as Record<string, unknown>;
  return rest;
}

function errorResponse(statusCode: number, message: string): ServiceIntegrationResult {
  return {
    statusCode,
    body: JSON.stringify({ message }),
    headers: { 'content-type': 'application/json' },
  };
}

/**
 * Translate an AWS SDK error to an HTTP response. AWS SDK v3 surfaces
 * errors as instances carrying `$metadata.httpStatusCode` + `name`;
 * we honor the status code when present, default to 500.
 *
 * Issue #579 routed the two relayed fields through the credential-error
 * policy. LEVEL: this one is NOT a log line — it is a RESPONSE BODY served on
 * the local API port, which makes it the widest reader of the set: the studio
 * capture proxy records a served response body onto the timeline, so the text
 * reaches the same browser the log ring does, and any HTTP client reaches it
 * without `--verbose`. RECONSTRUCTION: the `catch` wraps the per-subtype
 * dispatch, i.e. one `client.send(...)`, so a `CredentialsProviderError`
 * carrying a `credential_process` command line would have been JSON-encoded
 * into that body verbatim. A modeled service exception's message is what a
 * real API Gateway service integration surfaces and is the diagnosis, so it
 * keeps printing; `code` is `err.name`, wire-derived, and is clamped.
 */
/** A value usable as an HTTP status line without raising `ERR_HTTP_INVALID_STATUS_CODE`. */
function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value < 600;
}

function translateSdkError(subtype: SupportedSubtype, err: unknown): ServiceIntegrationResult {
  if (err instanceof ServiceIntegrationRequestError) {
    // The RESPONSE SHAPE is preserved, not just the message. Before #579 this
    // throw fell through the SDK branch below and produced `{ message, code }`,
    // so returning the bare `{ message }` `errorResponse` builds would have
    // dropped a field from a served body — a silent contract change riding
    // along with a security fix. `code` carries the class name (it used to be
    // the string `Error`, this throw having been an anonymous `Error`), which
    // is cdk-local's own literal rather than anything off the wire.
    return {
      statusCode: err.statusCode,
      body: JSON.stringify({ message: err.message, code: err.name }),
      headers: { 'content-type': 'application/json' },
    };
  }
  if (err && typeof err === 'object') {
    const e = err as {
      name?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
      statusCode?: number;
    };
    // Both candidates are RANGE-GUARDED. `e.statusCode` always was; issue #579
    // review round 2 caught that `$metadata.httpStatusCode` was not, and this
    // value becomes `res.statusCode` on a real `http.ServerResponse`, where a
    // non-integer raises `ERR_HTTP_INVALID_STATUS_CODE` and takes the server's
    // request handler down instead of answering. `$metadata` is a plain object
    // that `decorateServiceException` copies parsed response-body keys onto, so
    // "the SDK sets it" is not the same as "it is an integer".
    const status = isHttpStatus(e.statusCode)
      ? e.statusCode
      : isHttpStatus(e.$metadata?.httpStatusCode)
        ? e.$metadata.httpStatusCode
        : 500;
    const body = {
      // The KEPT branch uses `sanitizeServiceExceptionMessage` rather than the
      // whole of `describeAwsFailureForWarn`, and the difference is this
      // site's alone: a log line has one field, so the helper concatenates
      // `<name>: <message>` into it, but this body already carries the name in
      // `code`. Prefixing it into `message` as well would both duplicate it and
      // change what a client parsing `message` reads (`Rate exceeded` becoming
      // `ThrottlingException: Rate exceeded`). The WITHHELD branch still goes
      // through the helper, so the `debug` line pairing is preserved.
      // On the KEPT branch, read `e.message` when it is a string rather than
      // going through `stringifyThrown`, which keys on `instanceof Error` and
      // would render a service-exception-SHAPED plain object as the literal
      // `[object Object]` — claiming to have kept the diagnosis while printing
      // a placeholder. Safe on this branch specifically: the message is already
      // judged printable here, and the sanitizer still flattens and caps it, so
      // reading the field is exactly as bounded as reading `err.message` off an
      // `Error`. (Every SDK-modeled exception DOES extend `Error`, so this is
      // belt-and-braces for a hand-rolled or proxied throw rather than
      // something `@aws-sdk/*` produces. Issue #579 review round 3.)
      message: isAwsServiceException(err)
        ? sanitizeServiceExceptionMessage(
            typeof e.message === 'string' ? e.message : stringifyThrown(err)
          )
        : describeAwsFailureForWarn(err, `${subtype} service integration`),
      // `code` is NOT widened the same way, and that asymmetry is deliberate:
      // `clampErrorName` degrades a non-`Error` to `unknown` on purpose, "so
      // the field never names a class the throw was not". A shape that is not
      // an `Error` has no class, and `unknown` is the honest answer; the
      // message half above carries the diagnosis regardless.
      code: clampErrorName(err),
    };
    logger.debug(`[${subtype}] SDK error (${status}): ${stringifyValue(body)}`);
    return {
      statusCode: status,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    };
  }
  // A non-object throw (`throw 'x'`) never carries a credential chain's message
  // -- `CredentialsProviderError` is an `Error` -- but it is still relayed into
  // a response body, so it goes through the same helper rather than `String()`.
  return errorResponse(
    500,
    `Unexpected error invoking ${subtype}: ${describeAwsFailureForWarn(
      err,
      `${subtype} service integration`
    )}`
  );
}

// ---------------------------------------------------------------------
// ResponseParameters overlay
// ---------------------------------------------------------------------

/**
 * Apply HTTP API v2 `ResponseParameters` mapping (per AWS docs:
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-parameter-mapping.html#http-api-mapping-supported-values).
 *
 * Keys are `<op>:header.<name>` or `overwrite:statuscode`. Values can
 * carry `$response.header.<name>`, `$context.<X>`, `$stageVariables.<X>`,
 * or be a static literal. JSONPath against `$response.body.X` is NOT
 * supported (would require SDK response parsing into the same shape
 * every subtype produces; deferred). Reserved headers (per AWS docs)
 * are rejected at this layer with a single-line debug log.
 *
 * Status-code lookup is by the SDK-returned `statusCode`. When the
 * exact code has no entry, the wildcard `'default'` entry is applied
 * if present (matches AWS deployed behavior).
 */
export function applyResponseParameters(
  base: ServiceIntegrationResult,
  responseParameters: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
  responseCtx: ResponseParameterContext
): ServiceIntegrationResult {
  if (!responseParameters) return base;
  const overlay =
    responseParameters[String(base.statusCode)] ?? responseParameters['default'] ?? undefined;
  if (!overlay) return base;

  let statusCode = base.statusCode;
  const headers: Record<string, string> = { ...base.headers };
  for (const [key, value] of Object.entries(overlay)) {
    if (typeof value !== 'string') continue;
    const resolved = resolveResponseValue(value, responseCtx, base);
    if (key === 'overwrite:statuscode') {
      const next = Number(resolved);
      if (Number.isInteger(next) && next >= 100 && next < 600) statusCode = next;
      continue;
    }
    const headerMatch = /^(append|overwrite|remove):header\.(.+)$/i.exec(key);
    if (!headerMatch || !headerMatch[1] || !headerMatch[2]) {
      logger.warn(
        `ResponseParameters: key '${key}' does not match the expected shape ` +
          `'(append|overwrite|remove):header.<name>' or 'overwrite:statuscode'; ` +
          `the value was dropped. Check for typos (e.g. 'appen:' vs 'append:').`
      );
      continue;
    }
    const op = headerMatch[1].toLowerCase();
    const name = headerMatch[2].toLowerCase();
    if (isReservedHeader(name)) {
      // Mirrors the unmatched-key path above: surface the drop at warn
      // (not debug) so the user notices a reserved header silently
      // disappearing from the configured response mapping.
      logger.warn(
        `ResponseParameters: header '${name}' is reserved by API Gateway and was skipped`
      );
      continue;
    }
    if (op === 'remove') {
      delete headers[name];
    } else if (op === 'overwrite') {
      headers[name] = resolved;
    } else if (op === 'append') {
      headers[name] = headers[name] ? `${headers[name]},${resolved}` : resolved;
    }
  }
  return { statusCode, body: base.body, headers };
}

/**
 * Context for `ResponseParameters` resolution.
 */
export interface ResponseParameterContext {
  context: Readonly<Record<string, string>>;
  stageVariables: Readonly<Record<string, string>>;
}

function resolveResponseValue(
  value: string,
  ctx: ResponseParameterContext,
  base: ServiceIntegrationResult
): string {
  // Inline the same `${...}` interpolation engine as request-side. We
  // reuse the same dollar-bare form rules (whole-string match or
  // ${...} placeholders).
  if (value.startsWith('$') && !value.includes('${')) {
    const r = resolveSingleResponseRef(value, ctx, base);
    return r !== undefined ? r : value;
  }
  if (value.includes('${')) {
    let out = '';
    let i = 0;
    while (i < value.length) {
      const next = value.indexOf('${', i);
      if (next === -1) {
        out += value.slice(i);
        break;
      }
      out += value.slice(i, next);
      const end = value.indexOf('}', next + 2);
      if (end === -1) return value;
      const inner = value.slice(next + 2, end);
      const r = resolveSingleResponseRef('$' + inner, ctx, base);
      out += r ?? '';
      i = end + 1;
    }
    return out;
  }
  return value;
}

function resolveSingleResponseRef(
  ref: string,
  ctx: ResponseParameterContext,
  base: ServiceIntegrationResult
): string | undefined {
  if (ref.startsWith('$response.header.')) {
    const name = ref.substring('$response.header.'.length).toLowerCase();
    return base.headers[name] ?? '';
  }
  if (ref.startsWith('$context.')) {
    return ctx.context[ref.substring('$context.'.length)] ?? '';
  }
  if (ref.startsWith('$stageVariables.')) {
    return ctx.stageVariables[ref.substring('$stageVariables.'.length)] ?? '';
  }
  return undefined;
}

/**
 * Subset of AWS's reserved-headers list relevant to response mapping.
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-parameter-mapping.html#http-api-mapping-reserved-headers
 */
const RESERVED_HEADER_PREFIXES: readonly string[] = [
  'access-control-',
  'apigw-',
  'x-amz-',
  'x-amzn-',
];

const RESERVED_HEADER_EXACT: readonly string[] = [
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-location',
  'forwarded',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'via',
];

function isReservedHeader(lowerName: string): boolean {
  if (RESERVED_HEADER_EXACT.includes(lowerName)) return true;
  return RESERVED_HEADER_PREFIXES.some((p) => lowerName.startsWith(p));
}
