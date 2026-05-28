import { readCdkPath } from '../cli/cdk-path.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import { getLogger } from '../utils/logger.js';
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
}

function makeEntry(stackName: string, logicalId: string, cdkPath: string | undefined): TargetEntry {
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
  return entry;
}

function scanByType(stacks: readonly StackInfo[], type: string): TargetEntry[] {
  const entries: TargetEntry[] = [];
  for (const stack of stacks) {
    const resources = stack.template.Resources ?? {};
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== type) continue;
      entries.push(makeEntry(stack.stackName, logicalId, readCdkPath(resource) || undefined));
    }
  }
  return entries;
}

/**
 * Enumerate the API surfaces `cdkl start-api` can serve.
 *
 * Reuses the same discovery `start-api` runs (REST v1 / HTTP API v2 /
 * Function URL routes + WebSocket APIs) so the listed identifiers are
 * exactly the ones the `[target]` filter accepts — for a Function URL
 * that means the backing Lambda's `aws:cdk:path`, not the URL resource's
 * own path. Routes are collapsed to one entry per API surface.
 *
 * Discovery is best-effort: a malformed template that would hard-error
 * `start-api` is downgraded to a warning here so `list` still surfaces
 * every other target.
 */
function listApiSurfaces(stacks: readonly StackInfo[]): TargetEntry[] {
  const byKey = new Map<string, TargetEntry>();

  try {
    for (const route of discoverRoutes(stacks)) {
      if (!route.apiLogicalId || !route.apiStackName) continue;
      const key = `${route.apiStackName}:${route.apiLogicalId}`;
      if (byKey.has(key)) continue;
      byKey.set(key, makeEntry(route.apiStackName, route.apiLogicalId, route.apiCdkPath));
    }
  } catch (err) {
    getLogger().warn(
      `Could not enumerate REST / HTTP / Function URL targets: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const { apis, errors } = discoverWebSocketApis(stacks);
  for (const api of apis) {
    const key = `${api.apiStackName}:${api.apiLogicalId}`;
    if (byKey.has(key)) continue;
    byKey.set(key, makeEntry(api.apiStackName, api.apiLogicalId, api.apiCdkPath));
  }
  for (const e of errors) {
    getLogger().warn(`Could not enumerate a WebSocket API target: ${e}`);
  }

  return [...byKey.values()];
}

/**
 * Walk every synthesized stack and collect the resources the four
 * `cdkl` commands can run locally, grouped by command.
 *
 * Pure over the synthesized {@link StackInfo}[] — no Docker / AWS /
 * filesystem access — so both `cdkl list` and (future) interactive
 * target pickers can share it.
 */
export function listTargets(stacks: readonly StackInfo[]): TargetListing {
  return {
    lambdas: sortEntries(scanByType(stacks, 'AWS::Lambda::Function')),
    apis: sortEntries(listApiSurfaces(stacks)),
    ecsServices: sortEntries(scanByType(stacks, 'AWS::ECS::Service')),
    ecsTaskDefinitions: sortEntries(scanByType(stacks, 'AWS::ECS::TaskDefinition')),
  };
}

/** Stable, human-readable ordering: by display path, falling back to the qualified ID. */
function sortEntries(entries: TargetEntry[]): TargetEntry[] {
  return [...entries].sort((a, b) =>
    (a.displayPath ?? a.qualifiedId).localeCompare(b.displayPath ?? b.qualifiedId)
  );
}

/** Total number of targets across every category. */
export function countTargets(listing: TargetListing): number {
  return (
    listing.lambdas.length +
    listing.apis.length +
    listing.ecsServices.length +
    listing.ecsTaskDefinitions.length
  );
}
