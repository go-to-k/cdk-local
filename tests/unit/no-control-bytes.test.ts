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
 * checks comfortably satisfied. So the tests below pin BOTH that every
 * excluded extension is one this file names as genuinely binary, and that
 * each text extension the repo actually carries survives the filter.
 *
 * ## Why a SUBSET check and not an equality pin (issue #630)
 *
 * That first assertion used to read `expect(excludedExts).toEqual(['.gif'])`
 * -- `.gif` being the only excluded extension the tree carried. This file is
 * a repo-wide scanner and therefore sits OUTSIDE the `check` markgate gate's
 * include (the deliberate carve-out documented in `.markgate.yml`), and that
 * carve-out is only proportionate while the condition the scanner fires on is
 * RARE. A raw C0 control byte in committed text is rare. Committing a `.png`
 * screenshot, a `.pdf`, or a `.woff2` font is ORDINARY -- and under the
 * equality pin any one of them reddened this suite, in a file the committer
 * has no reason to open. The predicate, not the breadth of the population,
 * is what decides whether a whole-tree scanner is a fair carve-out.
 *
 * The subset form keeps everything the equality pin was for. The failure it
 * exists to catch is a TEXT extension entering `BINARY_EXT` and silently
 * shrinking the population; such an extension is absent from
 * LEGITIMATELY_BINARY, so it still fails here on the FIRST file of that
 * extension, and never on an 8th GIF or a 1st PNG. LEGITIMATELY_BINARY is
 * hand-written and deliberately NOT derived from `BINARY_EXT`: derived, the
 * check would be a tautology satisfied by whatever the regex happens to say.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * The extensions whose exclusion from the scan is legitimate, spelled
 * INDEPENDENTLY of `BINARY_EXT` below (see the docblock): a value appearing
 * in `BINARY_EXT` but not here is the regression this list exists to catch,
 * so deriving one from the other would make the assertion vacuous. Adding an
 * entry here is the deliberate, reviewable second edit that widening
 * `BINARY_EXT` should cost.
 */
const LEGITIMATELY_BINARY = [
  '.bmp',
  '.class',
  '.dll',
  '.dylib',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.so',
  '.tgz',
  '.ttf',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
];

/** Extensions whose bytes are legitimately non-text. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|bmp|webp|woff2?|ttf|otf|eot|zip|gz|tgz|wasm|pdf|mp4|mov|jar|class|so|dylib|dll)$/i;

/**
 * Tab (0x09), LF (0x0A) and CR (0x0D) are the control bytes that belong in
 * text. Everything else in C0, plus DEL, is a defect.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/**
 * U+FEFF (BOM), as its THREE UTF-8 bytes rather than as the code point.
 *
 * It is not in C0, so `FORBIDDEN` never saw it -- and `main` really did carry
 * one, spelled as a literal character inside a regex in
 * `tests/unit/gates/markgate-include-globs.test.ts` (go-to-k/cdk-local#675). It
 * is invisible on screen, so nothing but a byte scan finds it, and the repo's
 * pre-commit hook `control-char-gate.sh` is C0-only for the same reason this
 * was.
 *
 * Written as bytes because `scan` reads latin1 (see its comment): under that
 * decode a BOM arrives as `ï` `»` `¿`, so a `\uFEFF` character class here would
 * match NOTHING and this fence would be silently vacuous. That spelling is
 * load-bearing and is asserted below ("the BOM spelling matches a latin1 read"),
 * because no tracked file carries a BOM -- so respelling this constant is
 * invisible to every other assertion in the file.
 *
 * SCOPE: U+FEFF only. U+00A0 (NBSP) is the same class of defect but a different
 * decision -- it is an ordinary paste accident in markdown prose, and this
 * suite's docblock argues a whole-tree scan stays proportionate only while its
 * predicate is RARE. That policy call is go-to-k/cdk-local#677.
 */
const BOM_UTF8 = '\u00ef\u00bb\u00bf';

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
    // Separate pass: a BOM is a three-byte SEQUENCE under the latin1 read, so
    // the per-character loop above cannot express it.
    for (let at = line.indexOf(BOM_UTF8); at !== -1; at = line.indexOf(BOM_UTF8, at + 1)) {
      found.push({
        file,
        line: i + 1,
        column: at + 1,
        byte: '0xEF 0xBB 0xBF (U+FEFF, a BOM -- spell it \\uFEFF)',
      });
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
    // Asserted as a SUBSET of LEGITIMATELY_BINARY rather than as an equality
    // pin or a count. A count has to be tuned between "loud enough to catch
    // `yaml`" and "quiet enough to survive one more demo GIF"; an equality pin
    // fired on ordinary content (see the docblock, issue #630). The subset
    // fires on the FIRST file of a newly-excluded TEXT extension, and never on
    // an 8th GIF or a 1st PNG.
    const allTracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter((f) => f.length > 0);
    // Floor: an empty or broken `git ls-files` would leave `excludedExts`
    // empty, and an empty set is a subset of everything -- the assertion below
    // would pass having examined nothing.
    expect(allTracked.length, 'git ls-files returned no tracked files').toBeGreaterThan(500);
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
    const unexpected = excludedExts.filter((e) => !LEGITIMATELY_BINARY.includes(e));
    expect(
      unexpected,
      `BINARY_EXT excludes ${unexpected.join(', ')} from the control-byte scan, and ` +
        `LEGITIMATELY_BINARY does not name ${unexpected.length === 1 ? 'it' : 'them'}. ` +
        `If the extension really is binary, add it there too; if it is text, this is ` +
        `the population silently shrinking -- narrow BINARY_EXT instead.`
    ).toEqual([]);
  });

  it('every extension LEGITIMATELY_BINARY names really holds binary bytes', () => {
    // Guard-the-guard, in the direction the subset check cannot see: the
    // subset only asks "is every EXCLUDED extension listed here", so an
    // over-broad entry is waved through the moment someone widens BINARY_EXT
    // to match it.
    //
    // The anchor is deliberately NOT the scanned population. An earlier draft
    // compared LEGITIMATELY_BINARY against `files`'s extensions -- but `files`
    // is ALREADY filtered by BINARY_EXT, so adding `yaml` to BOTH lists
    // removed every .yaml from `files` and the overlap came back empty: the
    // one case the guard existed for was the one case it could not see
    // (measured during #630's review: 13 tracked files silently dropped from
    // the scan, suite still 7 passed).
    //
    // So judge by CONTENT instead, from the unfiltered index: for every listed
    // extension the repo actually tracks, at least one of those files must
    // really contain a byte no text file has. A text extension smuggled into
    // the list fails here whatever BINARY_EXT says.
    const allTracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter((f) => f.length > 0);
    expect(allTracked.length, 'git ls-files returned no tracked files').toBeGreaterThan(500);

    const judged: string[] = [];
    const notBinary: string[] = [];
    for (const ext of LEGITIMATELY_BINARY) {
      const held = allTracked.filter((f) => f.toLowerCase().endsWith(ext));
      // An extension the repo does not carry excludes nothing, so there is
      // nothing to judge -- and nothing at risk either.
      if (held.length === 0) continue;
      judged.push(ext);
      const anyBinary = held.some((f) =>
        FORBIDDEN.test(readFileSync(path.join(REPO_ROOT, f), 'latin1'))
      );
      if (!anyBinary) notBinary.push(`${ext} (${held.length} file(s), e.g. ${held[0]})`);
    }
    expect(
      notBinary,
      `LEGITIMATELY_BINARY names ${notBinary.join(', ')}, but every tracked file with ` +
        `that extension is plain text. Excluding it removes real files from the ` +
        `control-byte scan for nothing -- narrow the list, and narrow BINARY_EXT with it.`
    ).toEqual([]);
    // NO vacuity floor here, deliberately (issue #630, review round 4). The
    // obvious one -- `expect(judged).not.toEqual([])` -- was satisfied by
    // exactly ONE extension: `.gif`, from the three demo GIFs in `assets/`, a
    // directory in no gate's include. Reformatting or deleting them reddened
    // this suite with the `check` marker FRESH -- measured, and it is the
    // go-to-k/cdk-local#620 class this PR exists to close, re-introduced by a
    // floor guarding a harmless case: an extension the repo does not carry
    // excludes nothing, so there is nothing at risk in not judging it. The
    // failure this arm exists for -- a TEXT extension entering
    // LEGITIMATELY_BINARY -- always has files to judge, because having files
    // is what makes it a problem. Scoping `assets/**` in was the alternative
    // and buys nothing: it would make every demo-GIF change stale the marker
    // to keep a floor that guards nothing.
    void judged;
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

  it('the BOM spelling matches a latin1 read, so the arm is not vacuous', () => {
    // `scan` reads latin1, so BOM_UTF8 must be the three UTF-8 BYTES and not
    // the code point. Nothing else can see a mistake here: the repo carries no
    // BOM, so respelling the constant `'\uFEFF'` leaves every other assertion
    // in this file green and the arm silently matches nothing. Asserted against
    // the real encoder rather than against a hand-written literal, so it stays
    // true by construction.
    const asRead = Buffer.from('a\uFEFFb', 'utf8').toString('latin1');
    expect(
      asRead.includes(BOM_UTF8),
      `BOM_UTF8 does not appear in a latin1 read of a UTF-8 BOM, so the scan arm ` +
        `matches nothing. It must be the BYTES (0xEF 0xBB 0xBF), not '\\uFEFF'.`
    ).toBe(true);
    // ...and the code-point spelling really is the wrong one, so the assertion
    // above is discriminating rather than trivially true.
    expect(asRead.includes('\uFEFF')).toBe(false);
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
