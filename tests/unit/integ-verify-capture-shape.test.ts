import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Fence for issue #733 (the cdk-local twin of go-to-k/cdkd#3126 / #3133): a
 * `verify.sh` that runs under `pipefail` must not read a command's output
 * with the shape
 *
 *     VAR=$(cmd ... 2>/dev/null | tail -1)
 *
 * Under `set -euo pipefail` a non-zero exit of `cmd` fails the pipeline,
 * which fails the substitution, which fails the assignment, and `set -e`
 * kills the script AT THE ASSIGNMENT -- before the assertion that would have
 * printed `FAIL: ... got: ${VAR}`, and with the command's stderr already
 * discarded. Issue #577 replaced the shape in the `local-*` fixtures with the
 * `capture` helper; four `invoke_with_retry` loops kept it (`set -e` is
 * suspended in a condition, so they ran, but every attempt's stderr was
 * gone), and the helper itself emitted the last stdout line whatever the
 * exit status, so a response that happened to look right PASSED a failed
 * invoke -- the one property the banned shape had. Both closed by #733.
 *
 * The helper keeps a TRAP-HELD stderr file (`CDKL_STDERR`) on purpose --
 * `local-invoke/verify.sh` asserts on its contents after a capture -- which
 * is the one way it differs from cdkd's per-call block.
 *
 * Three layers, each of which the others cannot replace: table tests on the
 * classifier; tree-wide zero abort-shaped captures under pipefail, every
 * `capture` copy byte-identical to `CANONICAL_CAPTURE` (and the two sibling
 * helpers to theirs), coverage floors; and real-code + bash probes -- the
 * banned shape re-introduced into a real fixture is flagged at its line, and
 * under bash the banned shape dies with no diagnostic while `capture`
 * survives with one and emits nothing. What it does NOT claim: a file that
 * does not set pipefail is out of scope (none exists; pinned), `$(cmd 2>&1 |
 * tail -1)` and `$(cmd 2>"${file}" | tail -1)` are legal, and comment lines
 * / heredoc bodies are data.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../tests/integration');

/** `capture`, byte-identical in every fixture that defines it. */
const CANONICAL_CAPTURE = `capture() {
  local out rc=0
  out="$("$@" 2>"\${CDKL_STDERR}")" || rc=$?
  if [ "\${rc}" -ne 0 ]; then
    echo "[verify] command exited \${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\\n' "\${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "\${CDKL_STDERR}" >&2
    return 0
  fi
  printf '%s\\n' "\${out}" | tail -1
}
`;

/** `capture_all`, the whole-stdout sibling (`local-invoke-agentcore`). */
const CANONICAL_CAPTURE_ALL = `capture_all() {
  local out rc=0
  out="$("$@" 2>"\${CDKL_STDERR}")" || rc=$?
  if [ "\${rc}" -ne 0 ]; then
    echo "[verify] command exited \${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\\n' "\${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "\${CDKL_STDERR}" >&2
    return 0
  fi
  printf '%s\\n' "\${out}"
}
`;

/** `invoke_capture`, `local-invoke-assume-role`'s own wrapper with the same failure contract. */
const CANONICAL_INVOKE_CAPTURE = `invoke_capture() {
  # Run cdkl invoke and return the last JSON-looking line on stdout.
  # \`--no-pull\` skips docker pull (image already cached by step 1c) so the
  # repeat invocations are fast.
  #
  # The exit status is captured EXPLICITLY (issue #577). The old shape,
  #     \${CLI} invoke "$@" --no-pull 2>/dev/null | tail -1
  # aborted the WHOLE script at the caller's ASSIGNMENT when cdkl exited
  # non-zero: pipefail failed the pipeline, the command substitution failed,
  # and \`set -e\` killed the script BEFORE the grep, before the FAIL message
  # and before that branch's stderr re-run -- then the EXIT trap destroyed
  # the stack, taking the evidence with it. All the operator saw was
  # \`[verify] FAIL (exit 1) - attempting cdk destroy to clean up\`.
  #
  # Now a non-zero exit prints the status, the last stdout line and the
  # captured stderr, and emits NOTHING, so the assertion still runs and its
  # FAIL branch is actually reachable -- and a response that happened to
  # look right never passes a failed invoke (issue #733).
  local out rc=0
  out="$(\${CLI} invoke "$@" --no-pull 2>"\${CDKL_STDERR}")" || rc=$?
  if [ "\${rc}" -ne 0 ]; then
    echo "[verify] cdkl invoke exited \${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\\n' "\${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "\${CDKL_STDERR}" >&2
    return 0
  fi
  printf '%s\\n' "\${out}" | tail -1
}
`;

/**
 * Fixtures that define `capture`, pinned by NAME: a literal list cannot
 * silently widen to a fixture whose copy nobody compared against the
 * canonical text. Add a name when a fixture adopts the helper.
 */
const CAPTURE_FIXTURES = [
  'local-invoke',
  'local-invoke-agentcore',
  'local-invoke-agentcore-froms3',
  'local-invoke-agentcore-froms3-from-cfn',
  'local-invoke-container',
  'local-invoke-dotnet',
  'local-invoke-java',
  'local-invoke-layers',
  'local-invoke-provided',
  'local-invoke-python',
  'local-invoke-ruby',
].sort();

interface FlaggedCapture {
  /** 1-based number of the statement's FIRST physical line. */
  line: number;
  /** The `$( ... )` body, nested substitutions masked. */
  body: string;
}

interface CaptureShapeClassification {
  /** `set -euo pipefail` / `set -o pipefail` somewhere in the script. */
  setsPipefail: boolean;
  /**
   * Command substitutions whose body discards stderr to /dev/null and then
   * pipes to a line picker (`tail` / `head`). Reported regardless of
   * `setsPipefail`; the tree-wide test decides what is a violation.
   */
  abortShapedCaptures: FlaggedCapture[];
  /** `capture() {` is defined. */
  definesCapture: boolean;
  /** Contains `CANONICAL_CAPTURE` verbatim. */
  hasCanonicalCaptureBlock: boolean;
  /** Calls `capture ` in command position somewhere (outside its definition). */
  callsCapture: boolean;
}

/** Depth of `$(` left open at the end of `text` (never negative). */
function openSubstitutions(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (depth === 0) {
      if (text[i] === '$' && text[i + 1] === '(') {
        depth = 1;
        i++;
      }
      continue;
    }
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  return depth;
}

const HEREDOC_OPENER = /(?<!<)<<-?(?!<)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

/**
 * Joins one logical statement out of its physical lines -- a backslash
 * continuation, a line ending in `|` / `&&` / `||`, or a `$(` still open
 * at the line's end (a wrapped `R=$(cmd 2>/dev/null |` newline `tail -1)`
 * was invisible to the first cut, review of go-to-k/cdkd#3133) -- and blanks
 * comment lines and heredoc bodies, keeping the line count so a report's
 * line number is the first physical line of the statement.
 *
 * A heredoc is recognised on the PHYSICAL line that opens it, including one
 * opened inside a still-open `$(` (`V="$(python3 - <<'PY'` ... `PY` ... `)"`,
 * four of them in `dynamodb-globaltable/verify.sh`): its body is blanked
 * from there and the join resumes after the terminator. The first cut
 * joined first and looked for the opener afterwards, so the body was
 * swallowed into the statement and the terminator search ran past it to the
 * NEXT same-named terminator, blanking 53 lines of real code in that file
 * (second review round). A `<<` that is part of a here-string (`<<<`) is
 * not a heredoc, and a heredoc whose terminator never comes is not skipped
 * either: both used to blank the rest of the file, which made the fence
 * silently inert from that line on. Trailing comments stay: the banned
 * shape cannot sit inside one without also being code on that line, and a
 * quote-aware stripper is more machinery than the question needs.
 */
function codeLines(content: string): Array<{ line: number; text: string }> {
  const raw = content.split('\n');
  const out: Array<{ line: number; text: string }> = [];
  const continues = (text: string) =>
    /(\\|\||&&)\s*$/.test(text) || openSubstitutions(text) > 0;
  // Blank a heredoc body opened on physical line `at`; returns the index of
  // the terminator line (also blanked), or `at` when there is no terminator.
  const skipHeredoc = (at: number): number => {
    const here = HEREDOC_OPENER.exec(raw[at]!);
    if (!here) return at;
    const end = new RegExp(`^\\s*${here[1]}\\s*$`);
    const stop = raw.findIndex((l, k) => k > at && end.test(l));
    if (stop === -1) return at;
    for (let k = at + 1; k <= stop; k++) out.push({ line: k + 1, text: '' });
    return stop;
  };
  for (let i = 0; i < raw.length; i++) {
    const start = i;
    let text = raw[i]!;
    if (/^\s*#/.test(text)) {
      out.push({ line: start + 1, text: '' });
      continue;
    }
    i = skipHeredoc(i);
    while (continues(text) && i + 1 < raw.length) {
      i++;
      const next = raw[i]!;
      if (/^\s*#/.test(next)) {
        out.push({ line: i + 1, text: '' });
        continue;
      }
      text = /\\$/.test(text) ? text.replace(/\\$/, ' ') + next.trim() : `${text} ${next.trim()}`;
      i = skipHeredoc(i);
    }
    out.push({ line: start + 1, text });
  }
  return out.sort((x, y) => x.line - y.line);
}

/**
 * Every `$( ... )` body on the line, parentheses balanced, nested
 * substitutions masked so an inner capture's redirections are never read as
 * the outer one's (each nested body is returned as its own entry). Newlines
 * inside a joined statement are ordinary whitespace here.
 */
function substitutionBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '(') continue;
    let depth = 1;
    let j = i + 2;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
    }
    if (depth !== 0) continue;
    const body = text.slice(i + 2, j - 1);
    let masked = '';
    let d = 0;
    for (let k = 0; k < body.length; k++) {
      if (d === 0 && body[k] === '$' && body[k + 1] === '(') {
        d = 1;
        k++;
        masked += '__NESTED__';
        continue;
      }
      if (d > 0) {
        if (body[k] === '(') d++;
        else if (body[k] === ')') d--;
        continue;
      }
      masked += body[k];
    }
    bodies.push(masked);
  }
  return bodies;
}

/**
 * stderr to /dev/null, then (through any number of stages) a pipe into a line
 * picker, with NO `||` fallback after it. A fallback (`... | head -1 || true`)
 * hands the caller an explicit empty value to check -- issue #1120's class,
 * judged there -- so the assignment cannot abort and the diagnostic is the
 * caller's own check.
 */
const ABORT_SHAPE = /(?:2>\s*\/dev\/null|&>\s*\/dev\/null|2>&1\s*>\s*\/dev\/null)[\s\S]*?\|\s*(?:tail|head)\b(?![\s\S]*\|\|)/;

function classifyCaptureShape(content: string): CaptureShapeClassification {
  const lines = codeLines(content);
  const abortShapedCaptures: FlaggedCapture[] = [];
  let callsCapture = false;
  for (const { line, text } of lines) {
    for (const body of substitutionBodies(text)) {
      if (ABORT_SHAPE.test(body)) abortShapedCaptures.push({ line, body });
    }
    // Command position only: start of line, after `$(`, or after a
    // separator, with optional env-assignment prefixes -- `echo "... capture
    // ..."` is prose (two fixtures say the word in a banner).
    if (/(?:^|\$\(|[;|&]\s*)\s*(?:[A-Z0-9_]+=\S+\s+)*capture\s+\S/.test(text)) callsCapture = true;
  }
  return {
    // `set -euo pipefail`, `set -o pipefail`, `set -e -o pipefail`,
    // `set -o errexit -o pipefail`: any `set` line whose `-o` names pipefail.
    setsPipefail: lines.some(({ text }) => /^\s*set\s+(?:-[a-zA-Z]*o|.*\s-o)\s+pipefail\b/.test(text)),
    abortShapedCaptures,
    definesCapture: /^capture\(\)\s*\{/m.test(content),
    hasCanonicalCaptureBlock: content.includes(CANONICAL_CAPTURE),
    callsCapture,
  };
}


function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => {
      const content = readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8');
      return { name: e.name, content, ...classifyCaptureShape(content) };
    });
}

describe('classifyCaptureShape', () => {
  const PIPEFAIL = 'set -euo pipefail\nCDKL="node ../../../dist/cli.js"\n';

  it.each([
    ['the originating shape', 'RESULT_1=$(${CDKL} invoke Fn --no-pull 2>/dev/null | tail -1)'],
    ['spaced /dev/null', 'R=$(${CDKL} invoke Fn 2> /dev/null | tail -1)'],
    ['head as the line picker', 'R=$(${CDKL} invoke Fn 2>/dev/null | head -1)'],
    ['env-prefixed', 'R=$(AWS_REGION=x AWS_DEFAULT_REGION=x ${CDKL} invoke Fn 2>/dev/null | tail -1)'],
    ['inside an if condition (the retry-loop shape)', 'if out=$(${CLI} invoke "${args[@]}" 2>/dev/null | tail -1) && echo x; then :; fi'],
    ['&> /dev/null', 'R=$(${CDKL} invoke Fn &>/dev/null | tail -1)'],
    ['a second pipe stage before tail', 'R=$(${CDKL} invoke Fn 2>/dev/null | grep x | tail -1)'],
    ['the strict-idiom ordering, silenced then piped', 'R=$(${CDKL} invoke Fn 2>&1 >/dev/null | tail -1)'],
  ])('flags: %s', (_label, stmt) => {
    const c = classifyCaptureShape(`${PIPEFAIL}${stmt}\n`);
    expect(c.setsPipefail).toBe(true);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it.each([
    ['a pipe at the line end', 'R=$(${CDKL} invoke Fn 2>/dev/null |\n  tail -1)'],
    ['an open $( at the line end', 'R=$(\n  ${CDKL} invoke Fn 2>/dev/null | tail -1\n)'],
    ['a comment line inside the open substitution', 'R=$(${CDKL} invoke Fn 2>/dev/null |\n  # pick the response\n  tail -1)'],
  ])('flags a statement wrapped WITHOUT a backslash, at its first line: %s', (_label, stmt) => {
    // The first cut joined backslash continuations only; a wrapped `|` or an
    // open `$(` hid the shape entirely (review of go-to-k/cdkd#3133 (the cdkd twin)).
    const c = classifyCaptureShape(`${PIPEFAIL}${stmt}\necho after\n`);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it('attributes a statement joined after a `&&`-ending line to that line, not the next', () => {
    // The `|` / `&&` / `||` arm of the join is observable only through the
    // line number: the open-`$(` arm already joins a wrapped pipe by itself.
    const c = classifyCaptureShape(`${PIPEFAIL}[ -n "$X" ] &&\n  R=$(x 2>/dev/null | tail -1)\n`);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it('a heredoc opened inside an open $( is blanked in place and the join resumes after its terminator', () => {
    // Second review round: joining first and looking for the opener
    // afterwards swallowed the body into the statement, and the terminator
    // search then ran to the NEXT same-named terminator -- 53 real lines of
    // dynamodb-globaltable/verify.sh went inert. Both directions pinned: the
    // real statement after the block is seen, the body's own shape is not.
    const body = [
      `V="$(python3 - <<'PY'`,
      'print(1)',
      'PY',
      ')"',
      'R=$(x 2>/dev/null | tail -1)',
      `W="$(python3 - <<'PY'`,
      'print(2)',
      'PY',
      ')"',
      '',
    ].join('\n');
    expect(classifyCaptureShape(`${PIPEFAIL}${body}`).abortShapedCaptures.map((f) => f.line)).toEqual([7]);
    const inBody = `V="$(bash <<'SH'\nls 2>/dev/null | tail -1\nSH\n)"\n`;
    expect(classifyCaptureShape(`${PIPEFAIL}${inBody}`).abortShapedCaptures).toEqual([]);
  });

  it('flags a backslash-continued statement at its FIRST physical line', () => {
    const c = classifyCaptureShape(
      `${PIPEFAIL}R=$(AWS_ACCESS_KEY_ID=a \\\n  AWS_REGION=us-east-1 \\\n  \${CDKL} invoke-agentcore T --sigv4 2>/dev/null | tail -1)\n`,
    );
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it.each([
    ['the capture form', 'R=$(capture ${CDKL} invoke Fn --no-pull)'],
    ['env-prefixed capture form', 'R=$(AWS_REGION=x capture ${CDKL} invoke Fn)'],
    ['stderr kept in a file (retry loop)', 'if out=$(${CLI} invoke "${args[@]}" 2>"${err}" | tail -1); then :; fi'],
    ['stderr merged into the capture', 'R=$(${CDKL} invoke Fn 2>&1 | tail -1)'],
    ['tail without a silenced stderr', 'R=$(${CDKL} invoke Fn | tail -1)'],
    ['silenced but no line picker', 'R=$(${CDKL} invoke Fn 2>/dev/null)'],
    ['the shape quoted in a comment line', '#     VAR=$(${CDKL} invoke ... 2>/dev/null | tail -1)'],
    ['the shape inside a heredoc body', 'cat <<EOF\nR=$(x 2>/dev/null | tail -1)\nEOF'],
    ['tail outside the substitution', 'R=$(${CDKL} invoke Fn 2>/dev/null); echo "$R" | tail -1'],
    ['a fallback after the picker (the caller checks the empty value -- #1120 class)', 'T=$(ls cdk.out/*.template.json 2>/dev/null | head -1 || true)'],
    ['the word capture in a banner is not a call', 'echo "==> Phase 2: capture + confirm the policy"'],
    ['a here-string is not a heredoc (the line AFTER it still counts)', 'read -r x <<< foo\necho ok'],
  ])('does not flag: %s', (_label, stmt) => {
    const c = classifyCaptureShape(`${PIPEFAIL}${stmt}\n`);
    expect(c.abortShapedCaptures).toEqual([]);
  });

  it('tells a capture CALL from the word in prose, env prefix included', () => {
    expect(classifyCaptureShape(`${PIPEFAIL}R=$(capture x)\n`).callsCapture).toBe(true);
    expect(classifyCaptureShape(`${PIPEFAIL}R=$(AWS_REGION=x capture x)\n`).callsCapture).toBe(true);
    expect(classifyCaptureShape(`${PIPEFAIL}echo "==> Phase 2: capture + confirm"\n`).callsCapture).toBe(false);
  });

  it.each([
    ['a bare-word here-string', 'read -r x <<< foo\nR=$(x 2>/dev/null | tail -1)\n'],
    ['a quoted here-string', "read -r x <<< 'foo'\nR=$(x 2>/dev/null | tail -1)\n"],
    ['a heredoc whose terminator never comes', 'echo "<<EOF"\nR=$(x 2>/dev/null | tail -1)\n'],
    // The here-string's word DOES appear later as a standalone line, so the
    // unterminated-heredoc guard cannot rescue this one: only the `<<<`
    // exclusion keeps line 4 visible (second review round).
    ['a here-string whose word later closes a would-be heredoc', 'for w in a; do\n  read -r x <<< done\n  R=$(x 2>/dev/null | tail -1)\ndone\n'],
  ])('does not blank the rest of the file after %s', (_label, body) => {
    // Both shapes used to open a heredoc that never closed, so every later
    // line was data and the fence was silently inert from there on.
    const c = classifyCaptureShape(`${PIPEFAIL}${body}`);
    const expected = body.split('\n').findIndex((l) => l.includes('2>/dev/null')) + 3;
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([expected]);
  });

  it('attributes a nested substitution\'s redirections to the inner body only', () => {
    // The outer `$( ... )` carries no silenced stderr of its own; the inner
    // one does and is the one flagged.
    const c = classifyCaptureShape(`${PIPEFAIL}R=$(echo "$(x 2>/dev/null | tail -1)" | tr a b)\n`);
    expect(c.abortShapedCaptures).toHaveLength(1);
    expect(c.abortShapedCaptures[0]!.body).toBe('x 2>/dev/null | tail -1');
  });

  it('reads pipefail from any of its spellings, and its absence', () => {
    expect(classifyCaptureShape('set -euo pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -eu\nset -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -e -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -o errexit -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -eEuo pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -eu\n').setsPipefail).toBe(false);
    expect(classifyCaptureShape('# set -euo pipefail\n').setsPipefail).toBe(false);
  });

  it('recognizes the canonical block, a definition, and a call', () => {
    const c = classifyCaptureShape(`${PIPEFAIL}${CANONICAL_CAPTURE}R=$(capture true)\n`);
    expect(c.definesCapture).toBe(true);
    expect(c.hasCanonicalCaptureBlock).toBe(true);
    expect(c.callsCapture).toBe(true);
    // A one-character drift in the helper is a different helper.
    const drifted = CANONICAL_CAPTURE.replace('tail -20', 'tail -10');
    const d = classifyCaptureShape(`${PIPEFAIL}${drifted}R=$(capture true)\n`);
    expect(d.definesCapture).toBe(true);
    expect(d.hasCanonicalCaptureBlock).toBe(false);
  });

  it('does not read the definition line as a call', () => {
    const c = classifyCaptureShape(`${PIPEFAIL}${CANONICAL_CAPTURE}`);
    expect(c.definesCapture).toBe(true);
    expect(c.callsCapture).toBe(false);
  });
});

describe('codeLines / substitutionBodies', () => {
  it('keeps the physical line count while blanking comments and heredoc bodies', () => {
    const lines = codeLines('a\n# c\ncat <<EOF\nbody\nEOF\nb \\\n  c\nd\n');
    // Body AND terminator lines are kept as blanks, so every physical line
    // but a joined continuation has an entry and the numbering stays honest.
    expect(lines.map((l) => [l.line, l.text])).toEqual([
      [1, 'a'],
      [2, ''],
      [3, 'cat <<EOF'],
      [4, ''],
      [5, ''],
      [6, 'b  c'],
      [8, 'd'],
      [9, ''],
    ]);
  });

  it('balances parentheses through JMESPath calls', () => {
    expect(substitutionBodies('N=$(aws x --query "length(Items)" 2>/dev/null | tail -1)')).toEqual([
      'aws x --query "length(Items)" 2>/dev/null | tail -1',
    ]);
  });
});

describe('tree-wide (issue #733)', () => {
  const fixtures = readFixtures();

  it('sees the corpus (coverage floors)', () => {
    // 58 fixtures carried a verify.sh at the sweep, every one setting
    // pipefail. A scanner that parsed nothing would report zero violations
    // just the same.
    expect(fixtures.length).toBeGreaterThanOrEqual(55);
    expect(fixtures.filter((f) => f.setsPipefail).length).toBeGreaterThanOrEqual(55);
  });

  it('every verify.sh sets pipefail (the shape is out of scope without it, so none may slip out)', () => {
    expect(fixtures.filter((f) => !f.setsPipefail).map((f) => f.name)).toEqual([]);
  });

  it('no verify.sh under pipefail carries an abort-shaped capture', () => {
    const violations = fixtures
      .filter((f) => f.setsPipefail)
      .flatMap((f) => f.abortShapedCaptures.map((v) => `${f.name}/verify.sh:${v.line}: $(${v.body})`));
    expect(
      violations,
      'Under `set -euo pipefail`, `$(cmd 2>/dev/null | tail -1)` aborts the script at the assignment with no diagnostic. Use the `capture` helper (copy CANONICAL_CAPTURE from this file, with its trap-held CDKL_STDERR): `VAR=$(capture cmd ...)`. In a retry loop, route stderr to a file (`2>"${err}"`) and print its tail on the failure paths.',
    ).toEqual([]);
  });

  it('the capture-defining fixtures are exactly the pinned set, each carrying the canonical block byte-for-byte', () => {
    const defining = fixtures.filter((f) => f.definesCapture).map((f) => f.name).sort();
    expect(defining).toEqual(CAPTURE_FIXTURES);
    const drifted = fixtures.filter((f) => f.definesCapture && !f.hasCanonicalCaptureBlock).map((f) => f.name);
    expect(drifted, 'a fixture\'s capture() differs from CANONICAL_CAPTURE -- update the constant AND every copy together').toEqual([]);
  });

  it('the two sibling helpers carry the same failure contract, byte-identical to their constants', () => {
    const byName = new Map(fixtures.map((f) => [f.name, f.content]));
    expect(byName.get('local-invoke-agentcore')!.includes(CANONICAL_CAPTURE_ALL)).toBe(true);
    expect(byName.get('local-invoke-assume-role')!.includes(CANONICAL_INVOKE_CAPTURE)).toBe(true);
    // The contract itself, on all three: a non-zero exit logs the last stdout
    // line and returns BEFORE any stdout is emitted.
    for (const block of [CANONICAL_CAPTURE, CANONICAL_CAPTURE_ALL, CANONICAL_INVOKE_CAPTURE]) {
      expect(block).toContain('[verify] last stdout line:');
      expect(block.indexOf('return 0')).toBeLessThan(block.lastIndexOf("printf '%s"));
    }
    // Nothing else in the tree defines a capture-like helper without the fence knowing.
    const others = fixtures
      .flatMap((f) => [...f.content.matchAll(/^([a-z_]*capture[a-z_]*)\(\) \{/gm)].map((m) => `${f.name}:${m[1]}`))
      .filter((x) => !/:(capture|capture_all|invoke_capture)$/.test(x));
    expect(others).toEqual([]);
  });

  it('every fixture that calls capture defines it, and every one that defines it calls it', () => {
    expect(fixtures.filter((f) => f.callsCapture && !f.definesCapture).map((f) => f.name)).toEqual([]);
    expect(fixtures.filter((f) => f.definesCapture && !f.callsCapture).map((f) => f.name)).toEqual([]);
  });

  it('no heredoc opener line ends in a continuation (the scanner\'s stated assumption)', () => {
    // `cat <<EOF \` puts the body after the LOGICAL line in bash; the scanner
    // blanks from the physical opener line and would then join the line after
    // the terminator. Zero such lines in the corpus (round-3 review); this
    // pins the assumption rather than modelling the case.
    const offenders = fixtures.flatMap((f) =>
      f.content
        .split('\n')
        .map((l, k) => [l, k + 1] as const)
        .filter(([l]) => !/^\s*#/.test(l) && /(?<!<)<<-?(?!<)\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(l) && /(\\|\||&&)\s*$/.test(l))
        .map(([, k]) => `${f.name}/verify.sh:${k}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the canonical function is the one local-invoke/verify.sh carries (the constant tracks a real file)', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke', 'verify.sh'), 'utf8');
    expect(real.includes(CANONICAL_CAPTURE)).toBe(true);
  });
});

describe('real-code probes (issue #733)', () => {
  it('re-introducing the shape into local-invoke/verify.sh is flagged at that line', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke', 'verify.sh'), 'utf8');
    const fixed = 'RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --no-pull)';
    expect(real.split(fixed)).toHaveLength(2);
    const broken = real.replace(
      fixed,
      'RESULT_1=$(${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null | tail -1)',
    );
    const line = broken.slice(0, broken.indexOf('RESULT_1=$(')).split('\n').length;
    const c = classifyCaptureShape(broken);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([line]);
    expect(classifyCaptureShape(real).abortShapedCaptures).toEqual([]);
  });

  it('re-wrapping a real site across two lines without a backslash is still flagged', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke', 'verify.sh'), 'utf8');
    const fixed = 'RESULT_1=$(capture ${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --no-pull)';
    const broken = real.replace(
      fixed,
      'RESULT_1=$(${CDKL} invoke CdkLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null |\n  tail -1)',
    );
    const line = broken.slice(0, broken.indexOf('RESULT_1=$(')).split('\n').length;
    expect(classifyCaptureShape(broken).abortShapedCaptures.map((f) => f.line)).toEqual([line]);
  });

  it('re-introducing the retry-loop shape into local-invoke-from-cfn-stack/verify.sh is flagged', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke-from-cfn-stack', 'verify.sh'), 'utf8');
    const fixed = 'if out=$(${CLI} invoke "${args[@]}" 2>"${err}" | tail -1) && \\';
    expect(real.split(fixed)).toHaveLength(2);
    const broken = real.replace(fixed, 'if out=$(${CLI} invoke "${args[@]}" 2>/dev/null | tail -1) && \\');
    expect(classifyCaptureShape(broken).abortShapedCaptures).toHaveLength(1);
    expect(classifyCaptureShape(real).abortShapedCaptures).toEqual([]);
  });
});

describe('bash behavior (the convention itself, not the scanner)', () => {
  // A stub CLI: prints one stdout line, one stderr line, exits 7.
  const STUB = 'stub() { echo "partial"; echo "boom: the real cause" >&2; return 7; }\n';
  // The helper's stderr file is trap-held by the fixture; the harness plays
  // that role.
  const PRELUDE = 'CDKL_STDERR="$(mktemp)"\ntrap \'rm -f "${CDKL_STDERR}"\' EXIT\n';

  function runScript(body: string) {
    const dir = mkdtempSync(join(tmpdir(), 'cdkl-733-'));
    try {
      const script = join(dir, 'verify.sh');
      writeFileSync(script, `set -euo pipefail\n${STUB}${PRELUDE}${body}`);
      const r = spawnSync('bash', [script], { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the banned shape dies at the assignment with no diagnostic', () => {
    const r = runScript('R=$(stub 2>/dev/null | tail -1)\necho "reached assertion: [$R]"\n');
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('reached assertion');
    expect(r.stderr).not.toContain('boom');
  });

  it('capture reaches the assertion with the status, last stdout line and stderr tail in the log, and emits nothing', () => {
    const r = runScript(`${CANONICAL_CAPTURE}R=$(capture stub)\necho "reached assertion: [$R]"\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reached assertion: []');
    expect(r.stderr).toContain('[verify] command exited 7: stub');
    expect(r.stderr).toContain('[verify] last stdout line: partial');
    expect(r.stderr).toContain('boom: the real cause');
  });

  it("a good-looking last line does NOT pass a failed invoke (the property the old shape had; #577's helper let it through)", () => {
    const r = runScript(
      `${CANONICAL_CAPTURE}bad() { echo '{"greeting":"hello"}'; echo "teardown failed" >&2; return 1; }\n` +
        'R=$(capture bad)\necho "$R" | grep -q \'"greeting":"hello"\' && echo PASSED || echo FAILED-AS-IT-SHOULD\n',
    );
    expect(r.stdout).toContain('FAILED-AS-IT-SHOULD');
    expect(r.stdout).not.toContain('PASSED');
    expect(r.stderr).toContain('last stdout line: {"greeting":"hello"}');
  });

  it('capture_all and invoke_capture keep the same contract', () => {
    const all = runScript(`${CANONICAL_CAPTURE_ALL}R=$(capture_all stub)\necho "got: [$R]"\n`);
    expect(all.stdout).toContain('got: []');
    expect(all.stderr).toContain('last stdout line: partial');
    const ok = runScript(`${CANONICAL_CAPTURE_ALL}two() { echo one; echo two; }\nR=$(capture_all two)\necho "got: [$R]"\n`);
    expect(ok.stdout).toContain('got: [one\ntwo]');
    // invoke_capture prefixes the CLI itself; give it a stub CLI.
    const inv = runScript(`CLI=stubcli\nstubcli() { shift; stub; }\n${CANONICAL_INVOKE_CAPTURE}R=$(invoke_capture Fn)\necho "got: [$R]"\n`);
    expect(inv.stdout).toContain('got: []');
    expect(inv.stderr).toContain('cdkl invoke exited 7');
    expect(inv.stderr).toContain('last stdout line: partial');
  });

  it('on success capture emits the last stdout line and nothing on stderr', () => {
    const r = runScript(`${CANONICAL_CAPTURE}ok() { echo one; echo two; }\nR=$(capture ok)\necho "got: [$R]"\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('got: [two]');
    expect(r.stderr).toBe('');
  });

  it('an env prefix before capture reaches the command', () => {
    const r = runScript(`${CANONICAL_CAPTURE}show() { echo "region=\${AWS_REGION:-unset}"; }\nR=$(AWS_REGION=US-EAST-1 capture show)\necho "got: [$R]"\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('got: [region=US-EAST-1]');
  });
});
