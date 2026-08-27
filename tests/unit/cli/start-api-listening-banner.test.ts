import { describe, expect, it } from 'vite-plus/test';
import { formatServerListeningBanner } from '../../../src/cli/commands/local-start-api.js';

/**
 * Issue go-to-k/cdk-local#599 — an EMITTER-side fence on the repo's most
 * machine-parsed line. The reader side is covered (studio's `readyRe` is
 * driven with a bracketed banner in `studio-serve-manager.test.ts`); this is
 * the other half, so a change to what start-api PRINTS cannot pass on the
 * strength of the reader still being able to parse a line nobody emits.
 */

/** studio's `SERVE_SPECS.api.readyRe`, byte-identical. */
const STUDIO_READY_RE = /^Server listening on (\S+)/;

/** `tests/integration/local-start-api/verify.sh`'s port extraction, transcribed. */
function integPortOf(line: string): string {
  const m = /^Server listening on http:\/\/[^\s]+\s+\(.*\)/.exec(line);
  if (!m) return '';
  return /.*:\/\/.*:([0-9]+).*/.exec(line)?.[1] ?? '';
}

describe('formatServerListeningBanner (issue #599)', () => {
  it('brackets an IPv6 host into a banner studio can resolve', () => {
    const line = formatServerListeningBanner('http', '::1', 51234, '', 'MyApi').trimEnd();
    expect(line).toBe('Server listening on http://[::1]:51234  (MyApi)');

    const captured = STUDIO_READY_RE.exec(line)?.[1];
    expect(captured).toBe('http://[::1]:51234');
    // The whole point: what studio captures must survive `new URL(...)`, which
    // is what it does before it will front the serve with a capture proxy.
    expect(new URL(captured as string).hostname).toBe('[::1]');
  });

  it('brackets an IPv6 host on the WebSocket banner, path suffix intact', () => {
    const line = formatServerListeningBanner(
      'ws',
      '::',
      49160,
      '/ws',
      'MyWsApi (WebSocket API)'
    ).trimEnd();
    expect(line).toBe('Server listening on ws://[::]:49160/ws  (MyWsApi (WebSocket API))');
    const url = new URL(STUDIO_READY_RE.exec(line)?.[1] as string);
    expect(url.hostname).toBe('[::]');
    expect(url.pathname).toBe('/ws');
  });

  it('leaves an IPv4 host BYTE-IDENTICAL — the integ fixtures grep this line', () => {
    const line = formatServerListeningBanner(
      'http',
      '127.0.0.1',
      3000,
      '',
      'MyStack/HttpApi (HTTP API v2)'
    );
    expect(line).toBe('Server listening on http://127.0.0.1:3000  (MyStack/HttpApi (HTTP API v2))\n');
    // Not just the string: the fixture's own extraction still finds the port.
    expect(integPortOf(line.trimEnd())).toBe('3000');
  });

  it('leaves a DNS host unbracketed', () => {
    expect(formatServerListeningBanner('https', 'localhost', 8443, '', 'X').trimEnd()).toBe(
      'Server listening on https://localhost:8443  (X)'
    );
  });

  it('always terminates with exactly one newline', () => {
    for (const host of ['::1', '127.0.0.1', 'localhost'])
      expect(formatServerListeningBanner('http', host, 1, '', 'L')).toMatch(/[^\n]\n$/);
  });
});
