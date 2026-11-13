import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vite-plus/test';
import { buildJavaTrustStore, createMixedModeTlsMaterials } from '../../../src/local/mixed-mode-tls.js';

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

  it('name-constrains the CA to loopback: a leaf it signed for another name is refused', async () => {
    // The test seam issues a leaf that ALSO names evil.example; the CA's
    // permitted subtrees (127.0.0.1/32, ::1/128, localhost) exclude it.
    const m = createMixedModeTlsMaterials(new Date(), ['localhost', 'evil.example']);
    const server = createServer({ key: m.keyPem, cert: m.certPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/', ca: [m.caCertPem], servername: 'evil.example' },
          (res) => {
            res.resume();
            resolve(undefined);
          }
        );
        req.on('error', (e) => resolve(e));
        req.end();
      });
      expect(err?.message).toMatch(/permitted subtree violation/);
    } finally {
      await new Promise((r) => server.close(r));
    }
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

describe('buildJavaTrustStore', () => {
  const der = (pem: string): Buffer =>
    Buffer.from(pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64');

  it('lays out a password-less PKCS#12 of JDK trusted-certificate entries, one per certificate', () => {
    const a = createMixedModeTlsMaterials().caCertPem;
    const b = createMixedModeTlsMaterials().caCertPem;
    const store = buildJavaTrustStore([a + b], 'x');
    // PFX v3: SEQUENCE { INTEGER 3, ContentInfo(data) } and no MAC after it.
    expect(store[0]).toBe(0x30);
    const len = store[1] === 0x82 ? store.readUInt16BE(2) : store[1]!;
    expect(store.length).toBe(len + (store[1] === 0x82 ? 4 : 2));
    expect(store.subarray(4, 7)).toEqual(Buffer.from([0x02, 0x01, 0x03]));
    for (const cert of [der(a), der(b)]) expect(store.includes(cert)).toBe(true);
    // The JDK trusted-key-usage attribute (2.16.840.1.113894.746875.1.1), once per entry.
    const trusted = Buffer.from([0x06, 0x0c, 0x60, 0x86, 0x48, 0x01, 0x86, 0xf9, 0x66, 0xad, 0xca, 0x7b, 0x01, 0x01]);
    let n = 0;
    for (let i = store.indexOf(trusted); i >= 0; i = store.indexOf(trusted, i + 1)) n++;
    expect(n).toBe(2);
    // Distinct aliases (BMPString friendly names).
    expect(store.includes(Buffer.from('x-0', 'utf16le').swap16())).toBe(true);
    expect(store.includes(Buffer.from('x-1', 'utf16le').swap16())).toBe(true);
    // Certificates only: nothing that looks like a key bag (pkcs8ShroudedKeyBag / keyBag OIDs).
    expect(store.includes(Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x0a, 0x01, 0x02]))).toBe(false);
    expect(store.includes(Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x0a, 0x01, 0x01]))).toBe(false);
  });

  it('ignores anything that is not a certificate block', () => {
    const empty = buildJavaTrustStore(['-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n']);
    expect(empty.includes(Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x0a, 0x01, 0x03]))).toBe(false);
  });
});
