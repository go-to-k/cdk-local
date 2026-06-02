import { describe, it, expect } from 'vite-plus/test';
import {
  createLocalStudioCommand,
  parseStudioPort,
} from '../../../src/cli/commands/local-studio.js';

describe('createLocalStudioCommand', () => {
  it('is named "studio"', () => {
    expect(createLocalStudioCommand().name()).toBe('studio');
  });

  it('exposes --studio-port (default 9999) and --no-open', () => {
    const cmd = createLocalStudioCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--studio-port');
    expect(longs).toContain('--no-open');
    const portOpt = cmd.options.find((o) => o.long === '--studio-port');
    expect(portOpt?.defaultValue).toBe('9999');
  });
});

describe('parseStudioPort', () => {
  it('accepts a valid port', () => {
    expect(parseStudioPort('9999')).toBe(9999);
  });

  it('accepts 0 (OS-assigned)', () => {
    expect(parseStudioPort('0')).toBe(0);
  });

  it('accepts the upper bound 65535', () => {
    expect(parseStudioPort('65535')).toBe(65535);
  });

  it.each(['-1', '65536', 'abc', '', '80.5'])('rejects %p', (raw) => {
    expect(() => parseStudioPort(raw)).toThrow(/--studio-port must be 0\.\.65535/);
  });
});
