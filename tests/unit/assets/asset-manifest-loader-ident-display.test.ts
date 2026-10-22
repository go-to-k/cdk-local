/**
 * go-to-k/cdk-local#761: the asset-manifest failure names a path that embeds
 * the assembly-chosen stack name, so it renders through
 * `displayUntrustedValue` — bare when plain, one JSON literal otherwise.
 */
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetManifestLoader } from '../../../src/assets/asset-manifest-loader.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function failureFor(dirName: string, stackName: string): Promise<{ dir: string; message: string }> {
  const root = mkdtempSync(join(tmpdir(), 'cdkl-761-'));
  roots.push(root);
  const dir = join(root, dirName);
  mkdirSync(dir);
  writeFileSync(join(dir, `${stackName}.assets.json`), '{ not json');
  const err = await new AssetManifestLoader().loadManifest(dir, stackName).catch((e: unknown) => e);
  return { dir, message: (err as Error).message };
}

describe('AssetManifestLoader failure renders the manifest path (#761)', () => {
  it('prints a plain path bare', async () => {
    const { dir, message } = await failureFor('cdk.out', 'MyStack');
    expect(message.startsWith(`Failed to load asset manifest from ${dir}/MyStack.assets.json: `)).toBe(
      true
    );
  });

  it("quotes a path whose stack name carries cdk-local's own quote", async () => {
    const { dir, message } = await failureFor('cdk.out', "My' Stack");
    expect(
      message.startsWith(`Failed to load asset manifest from "${dir}/My' Stack.assets.json": `)
    ).toBe(true);
  });
});
