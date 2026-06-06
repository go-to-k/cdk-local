#!/usr/bin/env node
// Mint a JWT signed by the JWKS sidecar's embedded RSA-2048 private key,
// so the local front-door's authenticate-oidc verifier accepts (or, in
// the negative-path tests, rejects) it.
//
// Usage:
//   node sign-jwt.mjs --iss <issuer> --aud <audience> --exp-offset <seconds>
//
// `--exp-offset` is added to `now` to compute the `exp` claim. Negative
// values mint an already-expired token (used by the expired-JWT phase).
//
// All claims:
//   iss   = --iss
//   aud   = --aud
//   sub   = "integ-test-subject"
//   iat   = now (seconds)
//   exp   = now + --exp-offset (seconds)
//   token_use = "id"
//
// The signed JWT is printed to stdout on a single line, no trailing
// newline characters in the token itself.

import { createSign } from 'node:crypto';
import { SIDECAR_PRIVATE_KEY_PEM, SIDECAR_KID } from './jwks-sidecar.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith('--') || value === undefined) {
      throw new Error(`bad arg pair near '${key}'`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

function base64UrlEncode(buf) {
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const iss = args['iss'];
  const aud = args['aud'];
  const expOffset = Number.parseInt(args['exp-offset'] ?? '300', 10);
  if (!iss || !aud) {
    process.stderr.write('usage: sign-jwt.mjs --iss <issuer> --aud <audience> --exp-offset <seconds>\n');
    process.exit(2);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: SIDECAR_KID };
  const payload = {
    iss,
    aud,
    sub: 'integ-test-subject',
    iat: now,
    exp: now + expOffset,
    token_use: 'id',
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(SIDECAR_PRIVATE_KEY_PEM);
  const sigB64 = base64UrlEncode(signature);

  process.stdout.write(`${signingInput}.${sigB64}`);
}

main();
