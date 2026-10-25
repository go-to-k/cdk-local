import type { ResolvedZipLambda } from './lambda-resolver.js';
import type { ResolvedWebFunction } from './web-function-resolver.js';
import { displayIdent } from '../utils/ident-display.js';
import { isIamRoleArn } from '../utils/role-arn.js';

/** The env var a web function server reads its bind address from. */
export const WEB_FUNCTION_HTTP_ENDPOINT_ENV = 'AWS_LAMBDA_HTTP_ENDPOINT';

/** The `AuthType` cdk-local serves as the cloud does: the app authenticates requests itself. */
export const APPLICATION_MANAGED_AUTH = 'ApplicationManaged';

/** The `EndpointType` cdk-local reproduces: one endpoint in the function's home region. */
export const HOME_REGION_ENDPOINT = 'HomeRegion';

/** The parts of a revision's `ServiceConfig` the local run reads. */
export interface WebFunctionServiceConfig {
  /** `EnvironmentVariables` when it is an object (its values may still be intrinsics). */
  environmentVariables: Record<string, unknown> | undefined;
  /** `EnvironmentVariables` is present but not an object (a whole-map intrinsic). */
  environmentUnreadable: boolean;
  /** `ExecutionRoleArn` as written (a literal ARN or an intrinsic). */
  executionRoleArn: unknown;
  /** `EgressNetworkConnectorArn`, when set. */
  egressNetworkConnectorArn: unknown;
  /** `TimeoutSeconds` when a literal number. */
  timeoutSeconds: number | undefined;
  /** `TelemetryConfig.LoggingConfig.LogGroup` when a literal string. */
  logGroup: string | undefined;
}

/** Read a revision's `ServiceConfig`. Pure; never throws on a missing or odd shape. */
export function readWebFunctionServiceConfig(
  revision: ResolvedWebFunction['revision']
): WebFunctionServiceConfig {
  const sc = asObject(revision.Properties?.['ServiceConfig']) ?? {};
  const envRaw = sc['EnvironmentVariables'];
  const envObj = asObject(envRaw);
  // A whole-map intrinsic (`{ "Fn::If": [...] }`) is one key, not a variable named `Fn::If`.
  const envKeys = envObj ? Object.keys(envObj) : [];
  const env =
    envKeys.length === 1 && (envKeys[0] === 'Ref' || envKeys[0]!.startsWith('Fn::'))
      ? undefined
      : envObj;
  const logGroup = asObject(asObject(sc['TelemetryConfig'])?.['LoggingConfig'])?.['LogGroup'];
  return {
    environmentVariables: env,
    environmentUnreadable: envRaw !== undefined && env === undefined,
    executionRoleArn: sc['ExecutionRoleArn'],
    egressNetworkConnectorArn: sc['EgressNetworkConnectorArn'],
    timeoutSeconds: typeof sc['TimeoutSeconds'] === 'number' ? sc['TimeoutSeconds'] : undefined,
    logGroup: typeof logGroup === 'string' && logGroup.length > 0 ? logGroup : undefined,
  };
}

/**
 * The revision as the shared Lambda container-env resolver sees it, so a web
 * function gets the SAME env pipeline `cdkl invoke` uses — `--env-vars`
 * overrides keyed by the revision's logical id or construct path,
 * `--from-cfn-stack` intrinsic substitution, `{{resolve:...}}` dynamic
 * references, `--assume-role` / `--profile` / shell credentials and the
 * fallback `AWS_REGION` — rather than a second copy of it.
 * `ServiceConfig.EnvironmentVariables` becomes `Environment.Variables`;
 * nothing else of the view is read for a web function.
 */
export function buildWebFunctionLambdaView(
  resolved: ResolvedWebFunction,
  config: WebFunctionServiceConfig,
  runtime: string
): ResolvedZipLambda {
  return {
    kind: 'zip',
    stack: resolved.stack,
    logicalId: resolved.revisionLogicalId,
    resource: {
      Type: resolved.revision.Type,
      Properties: {
        ...(config.environmentVariables !== undefined && {
          Environment: { Variables: config.environmentVariables },
        }),
        // So a bare --assume-role resolves the GetAtt / Ref CDK always
        // synthesizes here against the loaded state.
        ...(config.executionRoleArn !== undefined && { Role: config.executionRoleArn }),
      },
      ...(resolved.revision.Metadata !== undefined && { Metadata: resolved.revision.Metadata }),
    },
    memoryMb: 128,
    timeoutSec: config.timeoutSeconds ?? 0,
    layers: [],
    runtime,
    handler: '',
    // The bundle is mounted by the container plan, never by this view.
    codePath: null,
    architecture: 'arm64',
  };
}

/**
 * The `--assume-role` value to hand the shared resolver. A bare
 * `--assume-role` resolves the revision's own `ExecutionRoleArn` when that is a
 * literal role ARN; an intrinsic one (what CDK synthesizes) passes the bare
 * form through, where the resolver reads it from the view's `Role` against the
 * state-source flag's deployed state (`resolveTemplateRoleArnFromState`), and
 * without state warns that the ARN must be given explicitly.
 */
export function webFunctionAssumeRole(
  assumeRole: string | boolean | undefined,
  config: WebFunctionServiceConfig
): string | boolean | undefined {
  if (assumeRole === true && isIamRoleArn(config.executionRoleArn)) {
    return config.executionRoleArn;
  }
  return assumeRole;
}

/**
 * Turn the shared resolver's Lambda container env into a web function's: drop
 * the event-invoke variables a web function runtime does not define, name the
 * function, and set `AWS_LAMBDA_HTTP_ENDPOINT` LAST — the published port
 * depends on it, so a declared value cannot move the server. Returns the env
 * and whether a declared `AWS_LAMBDA_HTTP_ENDPOINT` was replaced.
 */
export function finalizeWebFunctionEnv(
  lambdaEnv: Readonly<Record<string, string>>,
  opts: {
    functionName: string;
    containerPort: number;
    timeoutSeconds: number | undefined;
    logGroup: string | undefined;
  }
): { env: Record<string, string>; replacedHttpEndpoint: boolean } {
  const env: Record<string, string> = { ...lambdaEnv };
  delete env['AWS_LAMBDA_FUNCTION_MEMORY_SIZE'];
  delete env['AWS_LAMBDA_FUNCTION_VERSION'];
  delete env['AWS_LAMBDA_FUNCTION_TIMEOUT'];
  env['AWS_LAMBDA_FUNCTION_NAME'] = opts.functionName;
  env['AWS_LAMBDA_LOG_GROUP_NAME'] = opts.logGroup ?? `/aws/lambda/${opts.functionName}`;
  if (opts.timeoutSeconds !== undefined) {
    env['AWS_LAMBDA_FUNCTION_TIMEOUT'] = String(opts.timeoutSeconds);
  }
  const replacedHttpEndpoint = Object.hasOwn(lambdaEnv, WEB_FUNCTION_HTTP_ENDPOINT_ENV);
  env[WEB_FUNCTION_HTTP_ENDPOINT_ENV] = `0.0.0.0:${opts.containerPort}`;
  return { env, replacedHttpEndpoint };
}

/**
 * One line per cloud behavior the local serve does NOT reproduce for this
 * revision, for the caller to warn ONCE at boot. None of them fails the run.
 */
export function webFunctionFidelityWarnings(
  resolved: ResolvedWebFunction,
  config: WebFunctionServiceConfig
): string[] {
  const out: string[] = [];
  const rev = displayIdent(resolved.revisionLogicalId);
  if (config.egressNetworkConnectorArn !== undefined) {
    out.push(
      `Revision ${rev} sets ServiceConfig.EgressNetworkConnectorArn; the network connector is ` +
        `not emulated, so the container reaches the network through Docker's default bridge.`
    );
  }
  if (config.environmentUnreadable) {
    out.push(
      `Revision ${rev} declares ServiceConfig.EnvironmentVariables as an intrinsic rather than a ` +
        `map; none of its variables reach the container. Supply them with --env-vars.`
    );
  }
  const endpoint = resolved.endpoint;
  if (endpoint) {
    const ep = displayIdent(endpoint.logicalId);
    if (endpoint.endpointType !== undefined && endpoint.endpointType !== HOME_REGION_ENDPOINT) {
      out.push(
        `Endpoint ${ep} has EndpointType ${displayIdent(endpoint.endpointType)}; only a single ` +
          `${HOME_REGION_ENDPOINT} endpoint is reproduced, on one local port.`
      );
    }
    if (endpoint.authType !== undefined && endpoint.authType !== APPLICATION_MANAGED_AUTH) {
      out.push(
        `Endpoint ${ep} has AuthType ${displayIdent(endpoint.authType)}; it is not enforced ` +
          `locally — every request reaches the server unauthenticated.`
      );
    }
    const routed = endpoint.weights.filter((w) => w.weight > 0);
    if (routed.length > 1) {
      out.push(
        `Endpoint ${ep} splits traffic across ${routed.length} revisions; weighted routing is ` +
          `not emulated — every request goes to revision ${rev}.`
      );
    }
  }
  return out;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
