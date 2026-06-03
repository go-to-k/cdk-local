import { describe, expect, it } from 'vite-plus/test';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { DiscoveredWebSocketApi } from '../../../src/local/websocket-route-discovery.js';
import { resolveApiTargetSubset } from '../../../src/cli/commands/local-start-api.js';

// Mirror of `tests/unit/local/api-server-grouping.test.ts`'s `makeRoute`:
// build a minimal `RouteWithAuth` from a partial `DiscoveredRoute` so the
// subset resolver can be exercised without booting the server.
function makeRoute(partial: Partial<DiscoveredRoute>): RouteWithAuth {
  const route: DiscoveredRoute = {
    method: partial.method ?? 'GET',
    pathPattern: partial.pathPattern ?? '/',
    lambdaLogicalId: partial.lambdaLogicalId ?? 'Handler',
    source: partial.source ?? 'http-api',
    apiVersion: partial.apiVersion ?? 'v2',
    stage: partial.stage ?? '$default',
    declaredAt: partial.declaredAt ?? 'Stack/Method',
    ...(partial.apiLogicalId !== undefined && { apiLogicalId: partial.apiLogicalId }),
    ...(partial.apiStackName !== undefined && { apiStackName: partial.apiStackName }),
    ...(partial.apiCdkPath !== undefined && { apiCdkPath: partial.apiCdkPath }),
  };
  return { route, authorizer: undefined };
}

// Minimal `DiscoveredWebSocketApi` — the subset resolver only reads the
// identity fields (apiLogicalId / apiStackName / apiCdkPath) for matching.
function makeWsApi(partial: Partial<DiscoveredWebSocketApi>): DiscoveredWebSocketApi {
  return {
    apiLogicalId: partial.apiLogicalId ?? 'WsApi',
    apiStackName: partial.apiStackName ?? 'Stack',
    declaredAt: partial.declaredAt ?? `${partial.apiStackName ?? 'Stack'}/${partial.apiLogicalId ?? 'WsApi'}`,
    routeSelectionExpression: partial.routeSelectionExpression ?? '$request.body.action',
    stage: partial.stage ?? 'prod',
    routes: partial.routes ?? [],
    ...(partial.apiCdkPath !== undefined && { apiCdkPath: partial.apiCdkPath }),
  };
}

describe('resolveApiTargetSubset (variadic start-api subset resolution)', () => {
  it('returns the union of valid identifiers with an empty unmatched list', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi', pathPattern: '/public' }),
      makeRoute({ source: 'rest-v1', apiLogicalId: 'AdminApi', apiVersion: 'v1' }),
      makeRoute({ source: 'function-url', lambdaLogicalId: 'GoHandler', apiLogicalId: undefined }),
    ];
    const { filtered, unmatched } = resolveApiTargetSubset(
      routes,
      ['PublicApi', 'GoHandler'],
      ['Stack']
    );
    expect(unmatched).toEqual([]);
    // The union keeps exactly the two named surfaces, dropping AdminApi.
    expect(filtered).toHaveLength(2);
    const ids = filtered.map((r) =>
      r.route.source === 'function-url' ? r.route.lambdaLogicalId : r.route.apiLogicalId
    );
    expect(ids.sort()).toEqual(['GoHandler', 'PublicApi']);
  });

  it('keeps the matching siblings and reports a single typo in unmatched', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi', pathPattern: '/public' }),
      makeRoute({ source: 'http-api', apiLogicalId: 'AdminApi', pathPattern: '/admin' }),
    ];
    const { filtered, unmatched } = resolveApiTargetSubset(
      routes,
      ['PublicApi', 'Typo', 'AdminApi'],
      ['Stack']
    );
    // Exactly the typo is reported; the two valid siblings survive.
    expect(unmatched).toEqual(['Typo']);
    expect(filtered).toHaveLength(2);
  });

  it('throws the empty-union error when every identifier is a typo', () => {
    const routes = [makeRoute({ source: 'http-api', apiLogicalId: 'PublicApi' })];
    expect(() => resolveApiTargetSubset(routes, ['Nope', 'AlsoNope'], ['Stack'])).toThrow(
      /did not match any discovered API/
    );
  });

  it('throws the missing-prefix error for a bare logical id with >1 stack', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'MyApi', apiStackName: 'WebStack' }),
    ];
    expect(() => resolveApiTargetSubset(routes, ['MyApi'], ['WebStack', 'AdminStack'])).toThrow(
      /missing a stack prefix/
    );
  });

  it('accepts a bare logical id when the app has exactly one stack', () => {
    const routes = [
      makeRoute({ source: 'http-api', apiLogicalId: 'MyApi', apiStackName: 'OnlyStack' }),
    ];
    const { filtered, unmatched } = resolveApiTargetSubset(routes, ['MyApi'], ['OnlyStack']);
    expect(unmatched).toEqual([]);
    expect(filtered).toHaveLength(1);
  });

  it('does NOT reject a stack-qualified id in a multi-stack app', () => {
    // `:` / `/` forms are unambiguous, so the multi-stack guard must let
    // them through (only the bare form is rejected).
    const routes = [
      makeRoute({
        source: 'http-api',
        apiLogicalId: 'MyApi',
        apiStackName: 'WebStack',
        apiCdkPath: 'WebStack/MyApi',
      }),
    ];
    const colon = resolveApiTargetSubset(routes, ['WebStack:MyApi'], ['WebStack', 'AdminStack']);
    expect(colon.filtered).toHaveLength(1);
    expect(colon.unmatched).toEqual([]);
    const slash = resolveApiTargetSubset(routes, ['WebStack/MyApi'], ['WebStack', 'AdminStack']);
    expect(slash.filtered).toHaveLength(1);
    expect(slash.unmatched).toEqual([]);
  });

  // --- WebSocket APIs as explicit targets (issue #311) ---

  it('resolves a WebSocket-API-only target (no route match) without throwing', () => {
    const ws = makeWsApi({ apiLogicalId: 'WsApi', apiCdkPath: 'Stack/WsApi' });
    const routes = [makeRoute({ source: 'http-api', apiLogicalId: 'MyHttpApi' })];
    const r = resolveApiTargetSubset(routes, ['Stack/WsApi'], ['Stack'], [ws]);
    expect(r.filtered).toHaveLength(0); // no route matched
    expect(r.filteredWebSocketApis).toEqual([ws]); // the WS API matched
    expect(r.unmatched).toEqual([]);
  });

  it('narrows WebSocket APIs to the target subset (an HTTP target drops WS APIs)', () => {
    const ws = makeWsApi({ apiLogicalId: 'WsApi', apiCdkPath: 'Stack/WsApi' });
    const routes = [makeRoute({ source: 'http-api', apiLogicalId: 'MyHttpApi' })];
    const r = resolveApiTargetSubset(routes, ['MyHttpApi'], ['Stack'], [ws]);
    expect(r.filtered).toHaveLength(1);
    expect(r.filteredWebSocketApis).toEqual([]); // WS API NOT dragged along
  });

  it('lists WebSocket API identifiers in the empty-union error', () => {
    const ws = makeWsApi({ apiLogicalId: 'WsApi', apiCdkPath: 'Stack/WsApi' });
    const routes = [makeRoute({ source: 'http-api', apiLogicalId: 'MyHttpApi' })];
    expect(() => resolveApiTargetSubset(routes, ['Nope'], ['Stack'], [ws])).toThrow(/Stack\/WsApi/);
  });

  it('treats a matched WebSocket id as matched in the unmatched scan', () => {
    const ws = makeWsApi({ apiLogicalId: 'WsApi', apiCdkPath: 'Stack/WsApi' });
    const routes = [makeRoute({ source: 'http-api', apiLogicalId: 'MyHttpApi' })];
    // 'MyHttpApi' matches a route, 'Stack/WsApi' matches the WS API, 'Typo' neither.
    const r = resolveApiTargetSubset(
      routes,
      ['MyHttpApi', 'Stack/WsApi', 'Typo'],
      ['Stack'],
      [ws]
    );
    expect(r.unmatched).toEqual(['Typo']);
    expect(r.filtered).toHaveLength(1);
    expect(r.filteredWebSocketApis).toEqual([ws]);
  });
});
