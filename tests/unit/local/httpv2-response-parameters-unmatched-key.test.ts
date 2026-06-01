import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  applyResponseParameters,
  type ResponseParameterContext,
} from '../../../src/local/httpv2-service-integration.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * Issue #246 site 1 — `ResponseParameters` keys that do not match the
 * `(append|overwrite|remove):header.<name>` shape were silently dropped at
 * `logger.debug`, leaving the user staring at a missing header with no
 * cdkl output line to explain why. This file locks the bump to
 * `logger.warn` and asserts the offending key surfaces in the warning so
 * the user can spot the typo.
 */
describe('applyResponseParameters — unmatched key surfaces a warn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctx: ResponseParameterContext = {
    context: {},
    stageVariables: {},
  };

  it('warns (not debugs) when a ResponseParameters key does not match the expected shape', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
    const result = applyResponseParameters(
      { statusCode: 200, body: 'ok', headers: {} },
      {
        '200': {
          // Typical typo: 'appen' instead of 'append'.
          'appen:header.x-custom': 'value',
        },
      },
      ctx
    );
    // The unmatched key is dropped (correct), but the user must SEE that.
    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({});
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain("'appen:header.x-custom'");
    expect(warns[0]).toContain('append|overwrite|remove');
    // The path should NOT silently fall through debug.
    const debugs = debugSpy.mock.calls.map((c) => String(c[0]));
    expect(debugs.join('\n')).not.toContain("'appen:header.x-custom'");
  });

  it('keeps the reserved-header skip path as a separate warn (regression guard)', () => {
    // The reserved-header branch at line 587 already used `warn`. We want
    // to make sure the new unmatched-key warn coexists with it and they
    // log distinct messages.
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    applyResponseParameters(
      { statusCode: 200, body: 'ok', headers: {} },
      {
        '200': {
          // Reserved header (Connection / Transfer-Encoding / etc.) — the
          // reserved-header skip warn fires regardless of the new branch.
          'overwrite:header.content-length': '42',
        },
      },
      ctx
    );
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    // The reserved branch logs its own line (already warn) — assert the
    // unmatched-key warn did NOT fire on this well-formed key.
    expect(warns.some((w) => w.includes('does not match the expected shape'))).toBe(false);
  });

  it('does NOT warn for a well-formed key (overwrite:header.foo applies and stays quiet)', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const result = applyResponseParameters(
      { statusCode: 200, body: 'ok', headers: {} },
      { '200': { 'overwrite:header.x-custom': 'value' } },
      ctx
    );
    expect(result.headers['x-custom']).toBe('value');
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('does not match the expected shape'))).toBe(false);
  });
});
