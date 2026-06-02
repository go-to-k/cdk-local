import { describe, it, expect } from 'vite-plus/test';
import * as main from '../../src/index.js';
import * as internal from '../../src/internal.js';

describe('package export surface', () => {
  it('exposes the stable public API from the main entry', () => {
    // A representative slice of the semver-covered public surface. These
    // must never silently disappear from `cdk-local` (the main entry).
    const publicSymbols = [
      'createLocalInvokeCommand',
      'createLocalInvokeAgentCoreCommand',
      'createLocalStartApiCommand',
      'createLocalRunTaskCommand',
      'createLocalStartServiceCommand',
      'createLocalStartAlbCommand',
      'createLocalListCommand',
      'createLocalStudioCommand',
      'setEmbedConfig',
      'getEmbedConfig',
      'resetEmbedConfig',
    ];
    for (const sym of publicSymbols) {
      expect(main, `main entry is missing public symbol ${sym}`).toHaveProperty(sym);
    }
  });

  it('exposes low-level building blocks from the cdk-local/internal entry', () => {
    const internalKeys = Object.keys(internal);
    expect(internalKeys.length).toBeGreaterThan(0);
    // Spot-check a few internal-only helpers a shim host consumes.
    expect(internal).toHaveProperty('pickRefLogicalId');
    expect(internal).toHaveProperty('resolveLambdaArnIntrinsic');
  });

  it('does NOT leak internal building blocks into the main entry', () => {
    // The internal surface is reachable ONLY via `cdk-local/internal`; the
    // main entry must not re-export it (otherwise those symbols would be
    // frozen into the semver-covered public API). If someone re-adds an
    // `export * from './internal.js'` to the main entry, this breaks loudly.
    const leaked = Object.keys(internal).filter((key) => key in main);
    expect(leaked, `internal symbols leaked into the main entry: ${leaked.join(', ')}`).toEqual([]);
  });
});
