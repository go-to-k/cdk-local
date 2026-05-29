import { readCdkPathOrUndefined } from '../cli/cdk-path.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import { getLogger } from '../utils/logger.js';
import { AGENTCORE_RUNTIME_TYPE } from './agentcore-resolver.js';
import { discoverRoutes } from './route-discovery.js';
import { discoverWebSocketApis } from './websocket-route-discovery.js';

/**
 * One runnable target surfaced by `cdkl list`.
 *
 * Both addressable forms the four `cdkl` commands accept are carried so
 * the user can copy either: the stack-qualified logical ID
 * ({@link qualifiedId}, valid in every app) and — when the synthesized
 * resource carries `aws:cdk:path` metadata — the CDK Construct display
 * path ({@link displayPath}).
 */
export interface TargetEntry {
  /** CloudFormation logical ID (e.g. `OrdersServiceB12`). */
  logicalId: string;
  /** Physical stack name the resource lives in. */
  stackName: string;
  /**
   * Stack-qualified logical ID (`<stackName>:<logicalId>`) — a target
   * form accepted by every command, including multi-stack apps.
   */
  qualifiedId: string;
  /**
   * CDK Construct display path with a trailing `/Resource` stripped
   * (e.g. `MyStack/OrdersService`). Omitted when the resource carries no
   * `aws:cdk:path` metadata (hand-rolled `CfnResource`s).
   */
  displayPath?: string;
  /**
   * Human-readable surface kind, only set for `apis` entries
   * (`REST API v1` / `HTTP API v2` / `Function URL` / `WebSocket`). Lets
   * the interactive picker and `cdkl list` tell otherwise-similar API
   * targets apart. Omitted for Lambda / ECS targets.
   */
  kind?: string;
}

/**
 * Runnable targets discovered in a synthesized CDK app, grouped by the
 * command that consumes them.
 */
export interface TargetListing {
  /** `AWS::Lambda::Function` — `cdkl invoke`. */
  lambdas: TargetEntry[];
  /**
   * API surfaces `cdkl start-api` can serve — REST v1, HTTP API v2,
   * Function URLs, and WebSocket APIs. Each entry is one API surface
   * (de-duplicated across its routes).
   */
  apis: TargetEntry[];
  /** `AWS::ECS::Service` — `cdkl start-service`. */
  ecsServices: TargetEntry[];
  /** `AWS::ECS::TaskDefinition` — `cdkl run-task`. */
  ecsTaskDefinitions: TargetEntry[];
  /** `AWS::BedrockAgentCore::Runtime` — `cdkl invoke-agentcore`. */
  agentCoreRuntimes: TargetEntry[];
  /** Application `AWS::ElasticLoadBalancingV2::LoadBalancer` — `cdkl start-alb`. */
  loadBalancers: TargetEntry[];
}

function makeEntry(
  stackName: string,
  logicalId: string,
  cdkPath: string | undefined,
  kind?: string
): TargetEntry {
  const entry: TargetEntry = {
    logicalId,
    stackName,
    qualifiedId: `${stackName}:${logicalId}`,
  };
  // Mirror `cdkl invoke`'s own display-path suggestion: the L1 child a
  // CDK L2 construct emits carries a trailing `/Resource` the target
  // syntax does not need (the prefix rule matches the L2 ancestor).
  const display = cdkPath ? cdkPath.replace(/\/Resource$/, '') : undefined;
  if (display) entry.displayPath = display;
  if (kind) entry.kind = kind;
  return entry;
}

/** Map a discovered route's `source` to the human-readable surface kind. */
function apiKindLabel(source: 'http-api' | 'rest-v1' | 'function-url'): string {
  switch (source) {
    case 'http-api':
      return 'HTTP API v2';
    case 'rest-v1':
      return 'REST API v1';
    case 'function-url':
      return 'Function URL';
  }
}

function scanByType(stacks: readonly StackInfo[], type: string): TargetEntry[] {
  const entries: TargetEntry[] = [];
  for (const stack of stacks) {
    const resources = stack.template.Resources ?? {};
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== type) continue;
      entries.push(makeEntry(stack.stackName, logicalId, readCdkPathOrUndefined(resource)));
    }
  }
  return entries;
}

/**
 * Enumerate the API surfaces `cdkl start-api` can serve.
 *
 * Reuses the same discovery `start-api` runs (REST v1 / HTTP API v2 /
 * Function URL routes + WebSocket APIs) so the listed identifiers are
 * exactly the ones the `[target]` filter accepts. For a Function URL that
 * means the backing Lambda's logical ID and `aws:cdk:path` — start-api
 * addresses a Function URL by its backing Lambda, not by the URL
 * resource (see `routeMatchesIdentifier` in api-server-grouping.ts).
 * Routes are collapsed to one entry per API surface.
 *
 * Discovery is best-effort: a malformed template that would hard-error
 * `start-api` is downgraded to a warning here so `list` still surfaces
 * every other target.
 */
function listApiSurfaces(stacks: readonly StackInfo[]): TargetEntry[] {
  const byKey = new Map<string, TargetEntry>();
  const add = (
    stackName: string,
    logicalId: string,
    cdkPath: string | undefined,
    kind: string
  ): void => {
    const key = `${stackName}:${logicalId}`;
    if (!byKey.has(key)) byKey.set(key, makeEntry(stackName, logicalId, cdkPath, kind));
  };

  try {
    for (const route of discoverRoutes(stacks)) {
      if (!route.apiStackName) continue;
      // Mirror start-api's own identifier rule: a Function URL is keyed by
      // its BACKING LAMBDA's logical ID, every other surface by the API
      // resource's. Using the URL resource's own logical ID would print a
      // `Stack:LogicalId` that `start-api [target]` rejects.
      const logicalId =
        route.source === 'function-url' ? route.lambdaLogicalId : route.apiLogicalId;
      if (!logicalId) continue;
      add(route.apiStackName, logicalId, route.apiCdkPath, apiKindLabel(route.source));
    }
  } catch (err) {
    getLogger().warn(
      `Could not enumerate REST / HTTP / Function URL targets: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const { apis, errors } = discoverWebSocketApis(stacks);
  for (const api of apis) {
    add(api.apiStackName, api.apiLogicalId, api.apiCdkPath, 'WebSocket');
  }
  for (const e of errors) {
    getLogger().warn(`Could not enumerate a WebSocket API target: ${e}`);
  }

  return [...byKey.values()];
}

/**
 * Enumerate the application Load Balancers `cdkl start-alb` can front. Only
 * `Type: application` (the default) is included — NLBs / Gateway LBs are a
 * different architecture the local front-door does not emulate.
 */
function scanApplicationLoadBalancers(stacks: readonly StackInfo[]): TargetEntry[] {
  const entries: TargetEntry[] = [];
  for (const stack of stacks) {
    const resources = stack.template.Resources ?? {};
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== 'AWS::ElasticLoadBalancingV2::LoadBalancer') continue;
      const type = (resource.Properties as Record<string, unknown> | undefined)?.['Type'];
      if (type !== undefined && type !== 'application') continue;
      entries.push(makeEntry(stack.stackName, logicalId, readCdkPathOrUndefined(resource)));
    }
  }
  return entries;
}

/**
 * Walk every synthesized stack and collect the resources the `cdkl` commands
 * can run locally, grouped by command.
 *
 * Pure over the synthesized {@link StackInfo}[] — no Docker / AWS /
 * filesystem access — so both `cdkl list` and the interactive target
 * pickers can share it.
 */
export function listTargets(stacks: readonly StackInfo[]): TargetListing {
  return {
    lambdas: sortEntries(scanByType(stacks, 'AWS::Lambda::Function')),
    apis: sortApiEntries(listApiSurfaces(stacks)),
    ecsServices: sortEntries(scanByType(stacks, 'AWS::ECS::Service')),
    ecsTaskDefinitions: sortEntries(scanByType(stacks, 'AWS::ECS::TaskDefinition')),
    agentCoreRuntimes: sortEntries(scanByType(stacks, AGENTCORE_RUNTIME_TYPE)),
    loadBalancers: sortEntries(scanApplicationLoadBalancers(stacks)),
  };
}

const pathOf = (e: TargetEntry): string => e.displayPath ?? e.qualifiedId;

/** Stable, human-readable ordering: by display path, falling back to the qualified ID. */
function sortEntries(entries: TargetEntry[]): TargetEntry[] {
  return [...entries].sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
}

/** Display order for API surface kinds; entries are grouped in this order. */
const API_KIND_ORDER = ['HTTP API v2', 'REST API v1', 'Function URL', 'WebSocket'];

/**
 * Order API surfaces by stack, then kind (in {@link API_KIND_ORDER}), then
 * display path — so a multi-stack app shows each stack's APIs as a block,
 * grouped by kind inside it (single-stack apps are simply kind-grouped). Used
 * by both `cdkl list` and the interactive picker. Exported for unit testing.
 */
export function sortApiEntries(entries: TargetEntry[]): TargetEntry[] {
  return [...entries].sort((a, b) => {
    if (a.stackName !== b.stackName) return a.stackName.localeCompare(b.stackName);
    const ka = API_KIND_ORDER.indexOf(a.kind ?? '');
    const kb = API_KIND_ORDER.indexOf(b.kind ?? '');
    if (ka !== kb) return ka - kb;
    return pathOf(a).localeCompare(pathOf(b));
  });
}

/** Total number of targets across every category. */
export function countTargets(listing: TargetListing): number {
  return (
    listing.lambdas.length +
    listing.apis.length +
    listing.ecsServices.length +
    listing.ecsTaskDefinitions.length +
    listing.agentCoreRuntimes.length +
    listing.loadBalancers.length
  );
}
