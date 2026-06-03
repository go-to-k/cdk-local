import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { compileCloudFrontFunction } from '../../../src/local/cloudfront-function-runtime.js';
import type {
  ResolvedBehavior,
  ResolvedDistribution,
} from '../../../src/local/cloudfront-resolver.js';
import {
  matchBehavior,
  startCloudFrontServer,
  type StartedCloudFrontServer,
} from '../../../src/local/cloudfront-server.js';

let dir: string;
let server: StartedCloudFrontServer;

const rewriteFn = compileCloudFrontFunction(
  'RewriteFn',
  "function handler(event){var r=event.request; if(r.uri.endsWith('/')) r.uri+='index.html'; return r;}",
  'cloudfront-js-2.0'
);
const headerFn = compileCloudFrontFunction(
  'HeaderFn',
  "function handler(event){var r=event.response; r.headers['x-cdkl']={value:'1'}; return r;}",
  'cloudfront-js-2.0'
);

function distribution(): ResolvedDistribution {
  const def: ResolvedBehavior = {
    targetOriginId: 'o1',
    hasLambdaEdge: false,
    viewerRequest: rewriteFn,
    viewerResponse: headerFn,
  };
  return {
    logicalId: 'Dist',
    stackName: 'Stack',
    defaultRootObject: 'index.html',
    behaviors: [def],
    origins: new Map([['o1', { kind: 's3', originId: 'o1', localDirs: [dir] }]]),
    customErrorResponses: [{ errorCode: 403, responseCode: 200, responsePagePath: '/index.html' }],
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cdkl-cf-server-'));
  writeFileSync(join(dir, 'index.html'), '<h1>root</h1>');
  mkdirSync(join(dir, 'foo'), { recursive: true });
  writeFileSync(join(dir, 'foo', 'index.html'), '<h1>foo</h1>');
  server = await startCloudFrontServer({ distribution: distribution(), host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('startCloudFrontServer — pipeline', () => {
  it('serves the default root object at / with the viewer-response header applied', async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('root');
    expect(res.headers.get('x-cdkl')).toBe('1');
  });

  it('runs the viewer-request rewrite (/foo/ -> /foo/index.html)', async () => {
    const res = await fetch(`${server.url}/foo/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('foo');
  });

  it('applies the custom-error SPA fallback for a missing key', async () => {
    const res = await fetch(`${server.url}/missing-key`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('root');
  });

  it('update() swaps the served distribution (a --watch reload)', async () => {
    const second = mkdtempSync(join(tmpdir(), 'cdkl-cf-server2-'));
    writeFileSync(join(second, 'index.html'), '<h1>reloaded</h1>');
    try {
      const next = distribution();
      next.origins = new Map([['o1', { kind: 's3', originId: 'o1', localDirs: [second] }]]);
      server.update(next);
      const res = await fetch(`${server.url}/`);
      expect(await res.text()).toContain('reloaded');
    } finally {
      // Restore for sibling test isolation, then remove.
      server.update(distribution());
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('returns 502 for an unresolved S3 origin', async () => {
    const unresolved = distribution();
    unresolved.origins = new Map([['o1', { kind: 's3-unresolved', originId: 'o1' }]]);
    server.update(unresolved);
    try {
      const res = await fetch(`${server.url}/`);
      expect(res.status).toBe(502);
    } finally {
      server.update(distribution());
    }
  });

  it('skips an invalid function-returned header instead of 500-ing the response', async () => {
    const badHeaderFn = compileCloudFrontFunction(
      'BadHeaderFn',
      "function handler(event){ var r=event.response; r.headers['x-bad'] = { value: 'a\\r\\nInjected: 1' }; r.headers['x-good'] = { value: 'ok' }; return r; }",
      'cloudfront-js-2.0'
    );
    const withBad = distribution();
    withBad.behaviors = [
      { targetOriginId: 'o1', hasLambdaEdge: false, viewerResponse: badHeaderFn },
    ];
    server.update(withBad);
    try {
      const res = await fetch(`${server.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-good')).toBe('ok');
      // The CRLF in the bad value is stripped, never reflected as a real header.
      expect(res.headers.get('injected')).toBeNull();
    } finally {
      server.update(distribution());
    }
  });
});

describe('matchBehavior', () => {
  const def: ResolvedBehavior = { targetOriginId: 'o', hasLambdaEdge: false };
  const api: ResolvedBehavior = { pathPattern: '/api/*', targetOriginId: 'o', hasLambdaEdge: false };

  it('prefers a matching path pattern over the default', () => {
    expect(matchBehavior([def, api], '/api/x')).toBe(api);
  });
  it('falls back to the default behavior when no pattern matches', () => {
    expect(matchBehavior([def, api], '/other')).toBe(def);
  });
  it('returns undefined when there is no default and nothing matches', () => {
    expect(matchBehavior([api], '/other')).toBeUndefined();
  });
});
