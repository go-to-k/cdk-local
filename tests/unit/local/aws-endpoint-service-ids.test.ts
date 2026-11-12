import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { AWS_ENDPOINT_SERVICE_IDS } from '../../../src/local/aws-endpoint-service-ids.js';
import { normalizeAwsEndpointServiceId } from '../../../src/utils/aws-proxy.js';

// The pinned list is what `validateAwsEmulatorSentinels` accepts. Fence it
// against the SDK's own source of truth for every client installed here: each
// `@aws-sdk/client-*` declares its `serviceId`, and the SDK reads
// `AWS_ENDPOINT_URL_<serviceId, uppercased, spaces as underscores>`.
const require = createRequire(import.meta.url);

function installedClientServiceIds(): Array<{ pkg: string; id: string }> {
  // The project's own `node_modules/@aws-sdk` (pnpm links each direct dependency there).
  const scopeDir = fileURLToPath(new URL('../../../node_modules/@aws-sdk/', import.meta.url));
  const out: Array<{ pkg: string; id: string }> = [];
  for (const name of readdirSync(scopeDir).filter((n) => n.startsWith('client-'))) {
    const pkg = `@aws-sdk/${name}`;
    const shared = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'dist-cjs', 'runtimeConfig.shared.js');
    const m = /serviceId: config\?\.serviceId \?\? "([^"]+)"/.exec(readFileSync(shared, 'utf8'));
    expect(m, `${pkg} declares its serviceId in runtimeConfig.shared.js`).not.toBeNull();
    out.push({ pkg, id: normalizeAwsEndpointServiceId(m![1]!) });
  }
  return out;
}

describe('AWS_ENDPOINT_SERVICE_IDS', () => {
  it("holds every installed AWS SDK client's endpoint service id", () => {
    const clients = installedClientServiceIds();
    expect(clients.length).toBeGreaterThanOrEqual(10);
    const missing = clients.filter((c) => !AWS_ENDPOINT_SERVICE_IDS.has(c.id));
    expect(missing).toEqual([]);
  });

  it('is in the variable-suffix form, and no two ids differ only by underscores', () => {
    const bare = new Set<string>();
    for (const id of AWS_ENDPOINT_SERVICE_IDS) {
      expect(id).toMatch(/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/);
      // The refusal's spelling suggestion matches with underscores ignored.
      expect(bare.has(id.replace(/_/g, '')), id).toBe(false);
      bare.add(id.replace(/_/g, ''));
    }
    expect(AWS_ENDPOINT_SERVICE_IDS.size).toBeGreaterThan(400);
  });
});
