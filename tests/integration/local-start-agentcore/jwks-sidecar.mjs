#!/usr/bin/env node
// JWKS sidecar for the local-start-alb-auth-jwks integ test.
//
// Serves the two endpoints the local front-door's authenticate-oidc
// verifier may reach:
//
//   GET /.well-known/openid-configuration -> { issuer, jwks_uri }
//   GET /.well-known/jwks.json            -> { keys: [<RSA public JWK>] }
//
// The front-door only fetches the JWKS endpoint for an authenticate-oidc
// action — the discovery endpoint is here for parity with the AgentCore
// customJwtAuthorizer flow and so a future verifier change that switches
// to discovery would Just Work without rewiring the fixture.
//
// The RSA key pair is hard-coded for test reproducibility. THIS KEY IS
// PUBLIC — DO NOT REUSE IT FOR ANY PRODUCTION PURPOSE. Anyone reading
// this file can mint tokens that the sidecar will accept.
//
// Usage:
//   node jwks-sidecar.mjs [port]
// Defaults to port 19000. verify.sh starts it on port 19000 to match
// the issuer URL embedded in the fixture stack
// (lib/local-start-alb-auth-jwks-stack.ts).

import { createServer } from 'node:http';
import { createPublicKey } from 'node:crypto';

// Embedded RSA-2048 private key (PEM, PKCS#8). The matching public JWK
// is derived from it at boot so the two never drift out of sync.
// `kid` is fixed so the verify-side signer + the JWKS response agree.
export const SIDECAR_KID = 'cdkl-integ-key-1';

export const SIDECAR_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC93iCdU4zZ2250
E8mmLwgZP7iybzsvuAHmcBIUkw+1ZCtWD1WatU/Ob5k7nvggF1aVMdYg9bHbd6Ud
L8+AJsaXIVxLd2oVjoOYCE0k0ipG19wug+4Tuuq6ANF/iyWkoON0WE1J6SREI35R
bvR7km7P2PkpsGAG4dUMOcxDrCzykorhrr7CzLw0CkgGwSZOMWj155TJFVmANlVI
CWd5dUbR69eEFoJfD93ZMy2+LQrGmdGmb6BoLw0FBacu7UJ9de5dWfFx3NDrrRFe
Cu9swsKbUPvIa4ryDhcUh0b/a2vuL+wvegrnGED4HCR/b+3bVhqj+eWGCgzFA+Xm
c4WyID8nAgMBAAECggEABbP01dTrH6YUKL9paKjz/NIpqY5mwDWuNO471MtgBupF
1PVr9FQq3AAFIcHSISCiVKPlEyNeHsH2vywu9uHzSBnT7F5fXNtlf30MWCVJ6MvW
DL2guo38O+8HW+XhkRLWEioO1EAA+1z3j9md1VJeKrcRMNvf3oUNAauAw62ZwgVw
gNejKiyF3h4k2Ff8Xi33ltlGEPg16dPVKs063ZItBcUaX30x7Vq7vasbdut2dwfv
xpaDrS/Jzp0BDv393M+i4NlnD13xI0Bea3LibqMoutvSnTgyOZTc7UtzVCoIvmk7
gT1gE7F//7nyfZahYIr8TaEPyeFkU5SxS1HqLsv+AQKBgQDzA7905+5Iqr54GWLT
THK+RltHzOhJghxYuecFFaGSZr78cmieuSbne2INn0gWQyGOEQDG1mSmwGr837Dy
5DjfesyudWfPIQS/GiNfB3fLoI/Y1D0rgmYAHGfYspbwUttY6PY/rGXhBp1Kh4uu
hr3EMp9Gar52mIQkB21d/ha5JwKBgQDIA17N0D7gbvW5oCRLkpMyFwTueS5xdXQs
+xAn5OT9MA1M6hIaMmgB0tCnLBqMzQZd6lEZdko83EPV8PGun98CNQfospbiS3gu
ZUmSJgMyBOQwJfMDU2y4uo+U2DHN7zbvaxLvkZ/AvB4h4WCknZHrl92n5HTZm34l
4G1pvYIKAQKBgE7PmlnJleePKDI+2WP5WQUIQDYq5/Je9d54e8mUWE/obmvklrVT
CqDrzMLqMzC1GL7AGOZjRUUnBgt4aCR9i0w+wP6bKM1tweJQEcSR4XHyYnRJcIUZ
xwamL6+BS54o4OYWtzWzLV8rC/vNtakmHYjxeeIWYCqKD+C3X+qpqqjlAoGAAqiA
zw1weH0hCOmG8fYtvKGvsBeuNVXRSHPBwDX7kR3dX2NRAEYhObz6hu5AIBTte7wM
feEjlXF7+VDtdVuslBPuWfpdpP5Jx5wTAT0+F6EXA0jN1QJ71GyuUdUZvFnsifwL
UWHHFMGrSNn89dMeSFpJWNzhbK7zWz+DVL9vBgECgYAQyeEQrmtAHDfku0MmJvMT
sp4lJk01wyK7TJd8mKWnFczqtRrT0UqH5YQaLtiEd3VniTp7LCZJC/4hPjOMNFEy
8sjVUrpTeGS1G77vWr0+R661GZizqNIkv2zQUBQjQHxM8/8SrQ5Sxhc0be/M7Ifk
aLIXaXH76Nx8J1zO9+o53A==
-----END PRIVATE KEY-----
`;

// The matching SPKI public key — handy for debugging; the served JWK is
// derived from this. Kept in source so a casual reader can verify the
// keypair without running Node.
export const SIDECAR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvd4gnVOM2dtudBPJpi8I
GT+4sm87L7gB5nASFJMPtWQrVg9VmrVPzm+ZO574IBdWlTHWIPWx23elHS/PgCbG
lyFcS3dqFY6DmAhNJNIqRtfcLoPuE7rqugDRf4slpKDjdFhNSekkRCN+UW70e5Ju
z9j5KbBgBuHVDDnMQ6ws8pKK4a6+wsy8NApIBsEmTjFo9eeUyRVZgDZVSAlneXVG
0evXhBaCXw/d2TMtvi0KxpnRpm+gaC8NBQWnLu1CfXXuXVnxcdzQ660RXgrvbMLC
m1D7yGuK8g4XFIdG/2tr7i/sL3oK5xhA+Bwkf2/t21Yao/nlhgoMxQPl5nOFsiA/
JwIDAQAB
-----END PUBLIC KEY-----
`;

function buildJwk() {
  const publicKey = createPublicKey(SIDECAR_PUBLIC_KEY_PEM);
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    ...jwk,
    kid: SIDECAR_KID,
    alg: 'RS256',
    use: 'sig',
  };
}

function main() {
  const port = Number.parseInt(process.argv[2] ?? '19000', 10);
  const host = '127.0.0.1';
  const issuer = `http://${host}:${port}`;
  const jwk = buildJwk();

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          id_token_signing_alg_values_supported: ['RS256'],
        })
      );
      return;
    }
    if (url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });

  server.listen(port, host, () => {
    process.stdout.write(`jwks-sidecar listening on ${issuer}\n`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
    });
  }
}

// Run when invoked directly (node jwks-sidecar.mjs). Importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
