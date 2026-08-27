import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { signAgentCoreInvocation } from '../../../src/local/agentcore-sigv4-sign.js';
import { buildRedirectLocation } from '../../../src/local/front-door-server.js';

/**
 * Issue go-to-k/cdk-local#599 — the `Host:` header cases.
 *
 * RFC 7230 §5.4 defines `Host = uri-host [ ":" port ]` with RFC 3986's
 * `uri-host`, so an IP-literal is bracketed there exactly as it is in a URL.
 * That is the reasoning; the two cases this file opens with are the
 * MEASUREMENT, because the sigv4 site's correctness depends on the premise
 * being true of the actual stack rather than of the RFC.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          s.closeAllConnections?.();
        })
    )
  );
});

/** True when this host can bind IPv6 loopback at all. */
function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

/** Boot an echo server on `host` that reports the `Host` header it received. */
function bootHostEcho(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host }));
    });
    servers.push(s);
    s.once('error', reject);
    s.listen(0, host, () => resolve((s.address() as AddressInfo).port));
  });
}

function receivedHost(body: string): string {
  return (JSON.parse(body) as { host: string }).host;
}

function get(url: string): Promise<string> {
  return fetch(url).then((r) => r.text());
}

describe('what Node actually transmits as the Host header (issue #599, measured)', () => {
  it('brackets an IPv6 literal', async (ctx) => {
    if (!(await hasIpv6Loopback())) {
      // Nothing to bind, so there is no measurement to take. Reported as
      // SKIPPED rather than passing with no assertion.
      ctx.skip();
      return;
    }
    const port = await bootHostEcho('::1');

    // Measured 2026-08-27, Node 24 — every client shape agrees:
    //   fetch('http://[::1]:P/')                     -> Host: [::1]:P
    //   http.request({ hostname: '::1', family: 6 }) -> Host: [::1]:P
    //   http.request({ host: '::1', family: 6 })     -> Host: [::1]:P
    // (`hostname: '[::1]'` is the one spelling that FAILS — ENOTFOUND, since
    // node:net resolves the bracketed form as a NAME. That asymmetry is why
    // the URL layer brackets and the socket layer must not.)
    expect(receivedHost(await get(`http://[::1]:${port}/`))).toBe(`[::1]:${port}`);

    const viaRequest = await new Promise<string>((resolve, reject) => {
      const r = request({ hostname: '::1', port, path: '/', family: 6 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
      r.on('error', reject);
      r.end();
    });
    expect(receivedHost(viaRequest)).toBe(`[::1]:${port}`);
  });

  it('does NOT bracket an IPv4 literal', async () => {
    const port = await bootHostEcho('127.0.0.1');
    expect(receivedHost(await get(`http://127.0.0.1:${port}/`))).toBe(`127.0.0.1:${port}`);
  });
});

describe('signAgentCoreInvocation — the SIGNED Host header (issue #599)', () => {
  const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
  const base = {
    credentials,
    region: 'us-east-1',
    path: '/invocations',
    body: '{}',
    sessionId: 's'.repeat(33),
    now: () => Date.parse('2026-01-01T00:00:00Z'),
  };

  function signatureOf(authorization: string): string {
    const m = /Signature=([0-9a-f]+)/.exec(authorization);
    expect(m, `no Signature= in ${authorization}`).not.toBeNull();
    return (m as RegExpExecArray)[1] as string;
  }

  /**
   * An INDEPENDENT oracle: sign the identical request with the smithy signer
   * directly, choosing the `Host` header spelling ourselves. Comparing the
   * module's signature against each spelling says which authority it actually
   * signed — rather than inferring it from two of the module's own outputs.
   */
  async function oracleSignature(hostname: string, hostHeader: string): Promise<string> {
    const signer = new SignatureV4({
      credentials,
      region: 'us-east-1',
      service: 'bedrock-agentcore',
      sha256: Sha256,
    });
    const signed = await signer.sign(
      {
        method: 'POST',
        protocol: 'http:',
        hostname,
        port: 8080,
        path: '/invocations',
        headers: {
          'Content-Type': 'application/json',
          Host: hostHeader,
          'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': base.sessionId,
        },
        body: '{}',
      } as never,
      { signingDate: new Date(base.now()) }
    );
    const auth = Object.entries(signed.headers).find(
      ([k]) => k.toLowerCase() === 'authorization'
    )?.[1];
    return signatureOf(String(auth));
  }

  /** What the module under test signs for `host`. */
  async function moduleSignature(host: string): Promise<string> {
    return signatureOf((await signAgentCoreInvocation({ ...base, host, port: 8080 })).authorization);
  }

  it('signs the BRACKETED authority for an IPv6 host — what Node puts on the wire', async () => {
    // The whole point: @smithy/signature-v4 signs the `Host` header VERBATIM
    // rather than deriving it from `hostname`, and Node transmits
    // `[::1]:8080` (measured above). Signing the unbracketed form therefore
    // signed a value that never goes on the wire, so the signature could not
    // verify against what the server canonicalises.
    const actual = await moduleSignature('::1');

    const bracketed = await oracleSignature('::1', '[::1]:8080');
    const unbracketed = await oracleSignature('::1', '::1:8080');

    // Guard the guard: if the signer ignored the Host header (deriving it from
    // `hostname` instead) both oracles would agree and the assertions below
    // would pass vacuously.
    expect(bracketed).not.toBe(unbracketed);

    expect(actual).toBe(bracketed);
    expect(actual).not.toBe(unbracketed);
  });

  it('is idempotent for a host that arrives already bracketed', async () => {
    const bare = await signAgentCoreInvocation({ ...base, host: '::1', port: 8080 });
    const pre = await signAgentCoreInvocation({ ...base, host: '[::1]', port: 8080 });
    expect(signatureOf(pre.authorization)).toBe(signatureOf(bare.authorization));
  });

  // The IPv4 / DNS guard, against the SAME independent oracle. Comparing the
  // module with itself proves nothing here: signing is deterministic, so two
  // identical calls agree even if the module signed `[127.0.0.1]:8080`. This
  // is the only fence on the signed Host for a non-IPv6 host, and it is the
  // site where a wrong value yields a signature that will not verify.
  for (const host of ['127.0.0.1', 'localhost', 'example.internal']) {
    it(`signs the BARE authority for '${host}' — no brackets`, async () => {
      const bare = await oracleSignature(host, `${host}:8080`);
      const bracketed = await oracleSignature(host, `[${host}]:8080`);
      // Guard the guard, again: the two spellings must be distinguishable.
      expect(bare).not.toBe(bracketed);

      const actual = await moduleSignature(host);
      expect(actual).toBe(bare);
      expect(actual).not.toBe(bracketed);
    });
  }
});

describe('buildRedirectLocation — ALB #{host} from the request Host header (issue #599)', () => {
  const redirect = { kind: 'redirect', statusCode: 301 } as never;

  function locationFor(hostHeader: string, action: object = {}): string {
    return buildRedirectLocation(
      { ...redirect, ...action } as never,
      { url: '/a/b?x=1', headers: { host: hostHeader } },
      8080
    );
  }

  it('reads the host out of a BRACKETED IPv6 Host header and re-brackets it', () => {
    // Before: `split(':')[0]` read `'['`, so the Location came out as
    // `http://[:8080/a/b?x=1` — not a URL at all.
    const loc = locationFor('[::1]:8080');
    expect(loc).toBe('http://[::1]:8080/a/b?x=1');
    expect(new URL(loc).hostname).toBe('[::1]');
  });

  it('brackets an IPv6 host in the default-port branch too', () => {
    const loc = buildRedirectLocation(
      { kind: 'redirect', statusCode: 301, port: '80' } as never,
      { url: '/a', headers: { host: '[::1]:8080' } },
      8080
    );
    expect(loc).toBe('http://[::1]/a');
    expect(new URL(loc).hostname).toBe('[::1]');
  });

  it('leaves an IPv4 Host header byte-identical', () => {
    expect(locationFor('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/a/b?x=1');
  });

  it('leaves a DNS Host header byte-identical', () => {
    expect(locationFor('example.com:8080')).toBe('http://example.com:8080/a/b?x=1');
    expect(locationFor('example.com')).toBe('http://example.com:8080/a/b?x=1');
  });

  it('keeps an explicit literal host in the action untouched', () => {
    expect(locationFor('127.0.0.1:8080', { host: 'elsewhere.example' })).toBe(
      'http://elsewhere.example:8080/a/b?x=1'
    );
  });

  /**
   * The END STATE of `hostFromAuthority`'s refusal, pinned here rather than
   * left for a reader to derive from the helper's return value. A malformed
   * `Host` yields no host, so the `Location` names nowhere — an unfollowable
   * URL, which is the correct outcome for input that named nothing readable.
   */
  it('emits a hostless Location for a malformed Host header rather than a guessed one', () => {
    // An UNCLOSED bracket is the one that matters. `[evil.example` used to
    // read back as `evil.example`, so this redirect emitted a VALID Location
    // to a host the client only half-named — and a client follows a valid
    // Location. Now nothing is named.
    const guessed = 'http://evil.example:8080/a/b?x=1';
    const loc = locationFor('[evil.example');
    expect(loc).not.toBe(guessed);
    expect(loc).toBe('http://:8080/a/b?x=1');
    expect(() => new URL(loc)).toThrow();

    // The unbracketed multi-colon arm reaches the same end state.
    expect(locationFor('a:b:c')).toBe('http://:8080/a/b?x=1');
    // ...and trailing junk after the brackets is not silently dropped.
    expect(locationFor('[a:b]junk')).toBe('http://:8080/a/b?x=1');
  });
});
