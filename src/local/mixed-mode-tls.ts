// Per-run TLS material for the AWS Emulator re-signing sidecar (mixed mode).
//
// The sidecar terminates TLS on `127.0.0.1:<port>` inside a workload's network
// namespace, so it needs a server certificate the workload trusts. Each run
// makes a fresh CA and one leaf certificate for `127.0.0.1` / `::1` /
// `localhost`, both ECDSA P-256, built here with `node:crypto` alone (Node
// can sign but not issue certificates, and requiring `openssl` on the host
// would add a dependency the rest of the feature does not have).
//
// The CA's private key never leaves this function: it signs the leaf and is
// dropped, so nothing can mint another certificate under the CA the workload
// trusts. Only the CA certificate (public) and the leaf key pair are returned.
//
// The extensions are the ones strict verifiers require (Python 3.13's
// VERIFY_X509_STRICT, OpenSSL's x509_strict): a critical basicConstraints and
// keyUsage on both, subject and authority key identifiers, and a leaf with an
// extendedKeyUsage of serverAuth and a subjectAltName.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** The material {@link createMixedModeTlsMaterials} returns, all PEM. */
export interface MixedModeTlsMaterials {
  /** The per-run CA certificate: what the workload trusts. */
  caCertPem: string;
  /** The sidecar's server certificate, for 127.0.0.1 / ::1 / localhost. */
  certPem: string;
  /** The sidecar's private key (PKCS#8). Secret. */
  keyPem: string;
}

// --- DER encoding -----------------------------------------------------------

function der(tag: number, content: Buffer): Buffer {
  const n = content.length;
  let len: Buffer;
  if (n < 0x80) len = Buffer.from([n]);
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    len = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));
const octets = (b: Buffer): Buffer => der(0x04, b);
const bits = (b: Buffer, unused = 0): Buffer =>
  der(0x03, Buffer.concat([Buffer.from([unused]), b]));
const bool = (v: boolean): Buffer => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s: string): Buffer => der(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n: number, inner: Buffer): Buffer => der(0xa0 + n, inner);

function integer(b: Buffer): Buffer {
  let v = b;
  while (v.length > 1 && v[0] === 0 && (v[1]! & 0x80) === 0) v = v.subarray(1);
  if ((v[0]! & 0x80) !== 0) v = Buffer.concat([Buffer.from([0]), v]);
  return der(0x02, v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128))
      stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return der(0x06, Buffer.from(out));
}

function utcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0');
  const s =
    p(d.getUTCFullYear() % 100) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    'Z';
  return der(0x17, Buffer.from(s, 'ascii'));
}

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_CN = '2.5.4.3';
const OID_SKI = '2.5.29.14';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SAN = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_AKI = '2.5.29.35';
const OID_EKU = '2.5.29.37';
const OID_NAME_CONSTRAINTS = '2.5.29.30';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const name = (cn: string): Buffer => seq(set(seq(oid(OID_CN), utf8(cn))));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

/** The SHA-1 of the subjectPublicKey BIT STRING contents (RFC 5280 4.2.1.2 method 1). */
function keyIdentifier(spkiDer: Buffer): Buffer {
  // SPKI = SEQ { AlgorithmIdentifier, BIT STRING }: the key is the last TLV.
  // For P-256 the BIT STRING is 66 bytes (tag, len 0x42, unused 0x00, 65-byte point).
  const point = spkiDer.subarray(spkiDer.length - 65);
  return createHash('sha1').update(point).digest();
}

function serialNumber(): Buffer {
  const b = randomBytes(16);
  b[0] = (b[0]! & 0x7f) | 0x01;
  return b;
}

interface CertSpec {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signingKey: KeyObject;
  extensions: Buffer[];
  notBefore: Date;
  notAfter: Date;
}

function issue(spec: CertSpec): string {
  const sigAlg = seq(oid(OID_ECDSA_SHA256));
  const spki = spec.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serialNumber()),
    sigAlg,
    name(spec.issuer),
    seq(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    name(spec.subject),
    spki,
    explicit(3, seq(...spec.extensions))
  );
  const signature = sign('sha256', tbs, spec.signingKey);
  const cert = seq(tbs, sigAlg, bits(signature));
  const b64 = cert.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64.replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Make a fresh CA and a server certificate for `127.0.0.1` / `::1` /
 * `localhost` signed by it. Valid from an hour ago (clock skew between the
 * host and a container VM) for 30 days. The CA's private key is discarded
 * before this returns.
 *
 * Host-side use case: a host CLI that starts its own re-signing sidecar
 * (mixed mode) without going through `resolveWorkloadAwsWiring`.
 */
export function createMixedModeTlsMaterials(
  now: Date = new Date(),
  /** Test seam: the leaf's DNS names. Production uses `localhost` only. */
  leafDnsNames: readonly string[] = ['localhost']
): MixedModeTlsMaterials {
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caKeyId = keyIdentifier(ca.publicKey.export({ type: 'spki', format: 'der' }));
  const leafKeyId = keyIdentifier(leaf.publicKey.export({ type: 'spki', format: 'der' }));
  const aki = (id: Buffer): Buffer => seq(der(0x80, id));
  const caCn = `cdk-local mixed-mode CA ${randomBytes(4).toString('hex')}`;

  const caCertPem = issue({
    subject: caCn,
    issuer: caCn,
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [
      extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true), integer(Buffer.from([0])))),
      // keyCertSign (bit 5) + cRLSign (bit 6): 0b0000_0110, 1 unused bit.
      extension(OID_KEY_USAGE, true, bits(Buffer.from([0x06]), 1)),
      extension(OID_SKI, false, octets(caKeyId)),
      extension(OID_AKI, false, aki(caKeyId)),
      // Defence in depth: even a leaked CA could only vouch for loopback.
      // permittedSubtrees [0]: 127.0.0.1/32, ::1/128, DNS localhost.
      extension(
        OID_NAME_CONSTRAINTS,
        true,
        seq(
          der(
            0xa0,
            Buffer.concat([
              seq(der(0x87, Buffer.from([127, 0, 0, 1, 255, 255, 255, 255]))),
              seq(
                der(
                  0x87,
                  Buffer.from([
                    ...new Array<number>(15).fill(0),
                    1,
                    ...new Array<number>(16).fill(255),
                  ])
                )
              ),
              seq(der(0x82, Buffer.from('localhost', 'ascii'))),
            ])
          )
        )
      ),
    ],
  });

  const san = seq(
    der(0x87, Buffer.from([127, 0, 0, 1])),
    der(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
    ...leafDnsNames.map((n) => der(0x82, Buffer.from(n, 'ascii')))
  );
  const certPem = issue({
    subject: '127.0.0.1',
    issuer: caCn,
    publicKey: leaf.publicKey,
    signingKey: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [
      extension(OID_BASIC_CONSTRAINTS, true, seq()),
      // digitalSignature (bit 0): 0b1000_0000, 7 unused bits.
      extension(OID_KEY_USAGE, true, bits(Buffer.from([0x80]), 7)),
      extension(OID_EKU, false, seq(oid(OID_SERVER_AUTH))),
      extension(OID_SAN, false, san),
      extension(OID_SKI, false, octets(leafKeyId)),
      extension(OID_AKI, false, aki(caKeyId)),
    ],
  });

  return {
    caCertPem,
    certPem,
    keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
