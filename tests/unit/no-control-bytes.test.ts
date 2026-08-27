import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fence for issue #576.
 *
 * `.claude/hooks/control-char-gate.sh` blocks a `git commit` whose staged
 * blobs carry a C0 control byte, because a raw control byte in committed
 * text is invisible in the worst possible way: `file` reports the whole
 * file as `data`, `git diff` reports `Bin 0 -> N bytes` and hides the added
 * lines, and -- the expensive one -- **`grep` returns NOTHING for that
 * file**, silently, for every pattern.
 *
 * The gate is a PreToolUse hook, so it only ever sees the AGENT's tool
 * calls, and issue #576 records a command shape that walks straight past
 * it (`git add -A && git commit ...` in one call presents the gate with
 * the tree as it was BEFORE the `git add`). Registration is not
 * execution, and the proof is that a byte got through: on 2026-08-27,
 * `src/local/front-door-server.ts` was found on `main` carrying two raw
 * NUL bytes -- inside a regex character class and its comment in
 * `sanitizeRawHeaderValue`. Functionally correct JavaScript, which is why
 * no test or type-check noticed, while `grep -c host` on that 49 KB file
 * answered `0`. That file is on the `UP_PATHS` security surface listed in
 * `.claude/hooks/pr-review-gate.sh`, so every grep-based audit over
 * `src/local/**` had been skipping it.
 *
 * This file is the part of that fence that runs in CI on every commit,
 * whatever shape the command took and whoever typed it.
 *
 * ## Population
 *
 * The population is derived from `git ls-files` rather than from a list of
 * directories, because the rule is about COMMITTED TEXT and not about any
 * particular subtree -- a hand-kept root list is the same defect wearing a
 * comment, and would have missed `src/local/**` just as readily as it
 * would miss whatever directory is added next. Only extensions whose
 * content is legitimately binary are excluded.
 *
 * That exclusion is the fence's own soft spot, so it is asserted directly
 * rather than described: adding `sh` to `BINARY_EXT` silently drops ~92
 * files -- every `.claude/hooks/*.sh`, which is the tree this fence's
 * rationale is about -- while leaving the file count and the three prefix
 * checks comfortably satisfied. So the tests below pin BOTH WHICH EXTENSIONS
 * the exclusion removes and that each text extension the repo actually
 * carries survives it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Extensions whose bytes are legitimately non-text. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|bmp|webp|woff2?|ttf|otf|eot|zip|gz|tgz|wasm|pdf|mp4|mov|jar|class|so|dylib|dll)$/i;

/**
 * Tab (0x09), LF (0x0A) and CR (0x0D) are the control bytes that belong in
 * text. Everything else in C0, plus DEL, is a defect.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((f) => f.length > 0)
    .filter((f) => !BINARY_EXT.test(f));
}

interface Offender {
  file: string;
  line: number;
  column: number;
  byte: string;
}

function scan(file: string): Offender[] {
  // Read as latin1 so every byte maps to exactly one code unit: a UTF-8
  // decode would fold a lone 0x00 into a valid code point either way, but
  // latin1 keeps the column numbers byte-accurate for the report.
  const text = readFileSync(path.join(REPO_ROOT, file), 'latin1');
  const found: Offender[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c] ?? '';
      if (FORBIDDEN.test(ch)) {
        found.push({
          file,
          line: i + 1,
          column: c + 1,
          byte: `0x${ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`,
        });
      }
    }
  }
  return found;
}

describe('committed text carries no C0 control bytes', () => {
  const files = trackedTextFiles();

  it('excludes only the extensions that are genuinely binary', () => {
    // The guard the docblock promises, and the fence's own soft spot: widening
    // BINARY_EXT by one common text extension silently shrinks the population
    // while every other assertion here stays green (`sh` alone costs ~92 files,
    // every `.claude/hooks/*.sh` -- the tree this fence's rationale is about).
    //
    // Asserted as a SET rather than a count. A count has to be tuned between
    // "loud enough to catch `yaml`" and "quiet enough to survive one more demo
    // GIF", and at the tuned value `html` cleared by exactly one file -- drop an
    // .html from the repo and that escape reopens silently. The set fires on the
    // FIRST file of a newly-excluded extension and never fires on an 8th GIF.
    const allTracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter((f) => f.length > 0);
    const excludedExts = [
      ...new Set(
        allTracked
          .filter((f) => BINARY_EXT.test(f))
          // `path.extname` is '' for a leading-dot basename ('.gif'), which
          // would put a token naming nothing into the failure diff. Fall back
          // to the basename so a failure always names the offender.
          .map((f) => (path.extname(f) || path.basename(f)).toLowerCase())
      ),
    ].sort();
    expect(excludedExts).toEqual(['.gif']);
  });

  it('keeps every text extension the repo actually carries', () => {
    // The other direction: name the extensions whose exclusion would gut the
    // fence, so a widened BINARY_EXT fails here rather than going quiet.
    for (const ext of ['.ts', '.sh', '.md', '.json', '.yml', '.js']) {
      expect(
        files.some((f) => f.endsWith(ext)),
        `no ${ext} file survived the binary-extension filter`
      ).toBe(true);
    }
  });

  it('has a non-trivial population to scan', () => {
    // A floor, so a broken `git ls-files` or an over-eager exclusion can
    // never pass by scanning nothing. The repo tracked 986 such files when
    // this was written.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/local/front-door-server.ts');
  });

  it('scans src/, tests/, docs/ and the agent-instruction files', () => {
    // Named because those are the trees whose content is grepped by the
    // repo's own audits; if the population ever stops reaching one of
    // them, this fails rather than silently narrowing.
    for (const prefix of ['src/', 'tests/', '.claude/']) {
      expect(files.some((f) => f.startsWith(prefix))).toBe(true);
    }
  });

  it('finds no control byte in any tracked text file', () => {
    const offenders = files.flatMap(scan);
    // Report file:line:column and the byte -- the consumer of a finding is
    // someone jumping to it, and a control byte is invisible on screen.
    const report = offenders
      .map((o) => `${o.file}:${o.line}:${o.column} contains ${o.byte}`)
      .join('\n');
    expect(report).toBe('');
  });
});

describe('sanitizeRawHeaderValue spells NUL as an escape, not a raw byte', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/local/front-door-server.ts'), 'utf8');

  it('still strips CR, LF and NUL from a raw header value', () => {
    // The behaviour the escape replaced: `\0` inside a character class IS
    // the NUL character, so the swap is byte-for-byte equivalent. Pinned
    // here because the fix edits a security-relevant sanitizer and
    // "equivalent" is exactly the kind of claim that should not rest on
    // the reader agreeing with it.
    const match = /\/\[\\r\\n\\u0000\]\/g/.exec(source);
    expect(match, 'the escape spelling is gone from sanitizeRawHeaderValue').not.toBeNull();

    // eslint-disable-next-line no-control-regex
    const withEscape = /[\r\n\u0000]/g;
    const withRawByte = new RegExp(`[\\r\\n${String.fromCharCode(0)}]`, 'g');
    const probe = `a\rb\nc${String.fromCharCode(0)}d`;
    expect(probe.replace(withEscape, ' ')).toBe(probe.replace(withRawByte, ' '));
    expect(probe.replace(withEscape, ' ')).toBe('a b c d');
  });
});
