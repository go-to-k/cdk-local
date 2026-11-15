import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Every command that synthesizes the app must expand CDK nested stacks
// (go-to-k/cdk-local#986): an unwrapped `new Synthesizer()` silently serves a
// parent stack without its nested stacks. Exceptions are listed explicitly.
const COMMANDS_DIR = join(import.meta.dirname, '../../../src/cli/commands');
const EXCEPTIONS: string[] = [];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('nested-stack expansion at every command synth site', () => {
  const sites = sourceFiles(COMMANDS_DIR).flatMap((file) => {
    const text = readFileSync(file, 'utf-8');
    return [...text.matchAll(/new Synthesizer\(\)/g)].map((m) => ({
      file: file.slice(COMMANDS_DIR.length + 1),
      wrapped: text.slice(Math.max(0, m.index! - 80), m.index).includes('withNestedStacks('),
    }));
  });

  it('finds the known synth sites (guards against the scan going blind)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it('wraps every `new Synthesizer()` as withNestedStacks(...)', () => {
    const unwrapped = sites.filter((s) => !s.wrapped && !EXCEPTIONS.includes(s.file));
    expect(unwrapped.map((s) => s.file)).toEqual([]);
  });
});
