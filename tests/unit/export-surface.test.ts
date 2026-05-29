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

  it('re-exports every internal symbol from the main entry (non-breaking union)', () => {
    // The main entry re-exports `cdk-local/internal` so existing shim-host
    // imports from `cdk-local` keep working. If someone drops the
    // `export * from './internal.js'` re-export, this breaks loudly.
    const missing = Object.keys(internal).filter((key) => !(key in main));
    expect(missing, `internal symbols missing from the main entry: ${missing.join(', ')}`).toEqual(
      [],
    );
  });
});
