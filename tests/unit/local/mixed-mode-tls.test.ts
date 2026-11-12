import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vite-plus/test';
import { createMixedModeTlsMaterials } from '../../../src/local/mixed-mode-tls.js';

describe('createMixedModeTlsMaterials', () => {
  it('issues a CA and a 127.0.0.1 / ::1 / localhost leaf signed by it', () => {
    const now = new Date('2026-11-12T00:00:00Z');
    const m = createMixedModeTlsMaterials(now);
    const ca = new X509Certificate(m.caCertPem);
    const leaf = new X509Certificate(m.certPem);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(leaf.checkIP('::1')).toBeDefined();
    expect(leaf.checkHost('localhost')).toBe('localhost');
    expect(leaf.checkIP('10.0.0.1')).toBeUndefined();
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(new Date(leaf.validFrom).getTime()).toBeLessThan(now.getTime());
    expect(new Date(leaf.validTo).getTime() - now.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(leaf.serialNumber).not.toBe(ca.serialNumber);
  });

  it('returns the leaf key only: no CA private key leaves the function', () => {
    const m = createMixedModeTlsMaterials();
    expect(Object.keys(m).sort()).toEqual(['caCertPem', 'certPem', 'keyPem']);
    expect(m.keyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(m.caCertPem).not.toMatch(/PRIVATE/);
    expect(m.certPem).not.toMatch(/PRIVATE/);
  });

  it('makes a fresh CA every run', () => {
    expect(createMixedModeTlsMaterials().caCertPem).not.toBe(createMixedModeTlsMaterials().caCertPem);
  });

  it('serves a TLS handshake a client trusting only the per-run CA verifies for 127.0.0.1', async () => {
    const m = createMixedModeTlsMaterials();
    const server = createServer({ key: m.keyPem, cert: m.certPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', ca: [m.caCertPem] }, (res) => {
          let b = '';
          res.on('data', (c: Buffer) => (b += c.toString()));
          res.on('end', () => resolve(b));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('ok');
      const other = createMixedModeTlsMaterials();
      const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/', ca: [other.caCertPem] }, (res) => {
          res.resume();
          resolve(undefined);
        });
        req.on('error', (e) => resolve(e));
        req.end();
      });
      expect(err?.code).toBeDefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
