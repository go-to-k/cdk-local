import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveFrontDoorTlsMaterials,
  defaultCacheDir,
} from '../../../src/local/front-door-tls.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cdkl-tls-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveFrontDoorTlsMaterials — pairing validation', () => {
  it('rejects --tls-cert without --tls-key', async () => {
    await expect(
      resolveFrontDoorTlsMaterials({ certPath: '/some/cert.pem', keyPath: undefined })
    ).rejects.toThrow(/--tls-cert is set but --tls-key is missing/);
  });

  it('rejects --tls-key without --tls-cert', async () => {
    await expect(
      resolveFrontDoorTlsMaterials({ certPath: undefined, keyPath: '/some/key.pem' })
    ).rejects.toThrow(/--tls-key is set but --tls-cert is missing/);
  });

  it('reads BYO PEM materials when both --tls-cert and --tls-key are set', async () => {
    const certPath = join(tmpRoot, 'cert.pem');
    const keyPath = join(tmpRoot, 'key.pem');
    writeFileSync(certPath, Buffer.from('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----'));
    writeFileSync(keyPath, Buffer.from('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'));

    const mats = await resolveFrontDoorTlsMaterials({ certPath, keyPath });
    expect(mats.certPem.toString()).toContain('BEGIN CERTIFICATE');
    expect(mats.keyPem.toString()).toContain('BEGIN PRIVATE KEY');
  });

  it('reports the missing PEM path when --tls-cert is unreadable', async () => {
    await expect(
      resolveFrontDoorTlsMaterials({
        certPath: join(tmpRoot, 'missing-cert.pem'),
        keyPath: join(tmpRoot, 'missing-key.pem'),
      })
    ).rejects.toThrow(/--tls-cert: cannot read PEM file/);
  });
});

describe('resolveFrontDoorTlsMaterials — self-signed cache', () => {
  it('generates a self-signed cert into the cache dir on first call (no BYO flags)', async () => {
    const mats = await resolveFrontDoorTlsMaterials({
      certPath: undefined,
      keyPath: undefined,
      cacheDir: tmpRoot,
    });
    expect(mats.certPem.toString()).toContain('BEGIN CERTIFICATE');
    expect(mats.keyPem.toString()).toContain('BEGIN PRIVATE KEY');
    expect(existsSync(join(tmpRoot, 'cert.pem'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'key.pem'))).toBe(true);
  });

  it('reuses the cached pair on a second call (cert.pem mtime is preserved)', async () => {
    await resolveFrontDoorTlsMaterials({
      certPath: undefined,
      keyPath: undefined,
      cacheDir: tmpRoot,
    });
    const firstCert = readFileSync(join(tmpRoot, 'cert.pem'));

    await resolveFrontDoorTlsMaterials({
      certPath: undefined,
      keyPath: undefined,
      cacheDir: tmpRoot,
    });
    const secondCert = readFileSync(join(tmpRoot, 'cert.pem'));

    // Same bytes means the second call hit the cache (no regeneration).
    expect(secondCert.equals(firstCert)).toBe(true);
  });

  it('regenerates a near-expiry cached cert (regenerateWithinDays > validityDays)', async () => {
    // Seed a 1-day cert, then ask for a 2-day "regenerate-within" — the
    // cached one is already inside the regen window so it must be rewritten.
    await resolveFrontDoorTlsMaterials({
      certPath: undefined,
      keyPath: undefined,
      cacheDir: tmpRoot,
      validityDays: 1,
    });
    const seed = readFileSync(join(tmpRoot, 'cert.pem'));

    await resolveFrontDoorTlsMaterials({
      certPath: undefined,
      keyPath: undefined,
      cacheDir: tmpRoot,
      regenerateWithinDays: 2,
      validityDays: 365,
    });
    const regenerated = readFileSync(join(tmpRoot, 'cert.pem'));

    expect(regenerated.equals(seed)).toBe(false);
  });
});

describe('defaultCacheDir', () => {
  it('honors $XDG_CACHE_HOME when set', () => {
    const prev = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = '/xdg-fake';
    try {
      expect(defaultCacheDir()).toBe('/xdg-fake/cdk-local/alb-https');
    } finally {
      if (prev === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = prev;
    }
  });

  it('falls back to ~/.cache when $XDG_CACHE_HOME is unset', () => {
    const prev = process.env['XDG_CACHE_HOME'];
    delete process.env['XDG_CACHE_HOME'];
    try {
      expect(defaultCacheDir()).toMatch(/\/\.cache\/cdk-local\/alb-https$/);
    } finally {
      if (prev !== undefined) process.env['XDG_CACHE_HOME'] = prev;
    }
  });
});
