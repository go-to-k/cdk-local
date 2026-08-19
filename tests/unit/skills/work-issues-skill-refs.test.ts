import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * go-to-k/cdk-local#514: `.claude/skills/work-issues/SKILL.md` is mirrored
 * across three sibling repos, so a bare `#N` issue reference — which GitHub
 * renders against whichever repo is READING it — silently rewrites a correct
 * citation into a dead link or an unrelated issue when the file travels.
 * The skill's own section 10-c requires every issue / PR reference in its
 * plain prose to be written fully qualified (`go-to-k/<repo>#N`); this test
 * mechanizes that rule so a regression fails CI instead of shipping.
 *
 * Exempt contexts, so a paragraph can still show a bare `#N` as its own
 * counter-example: the YAML frontmatter block, fenced code blocks, and
 * single-line inline code spans. An inline span must NOT wrap across lines —
 * the stripper is line-based, so a ref inside a wrapped span is flagged,
 * which deliberately enforces the keep-spans-on-one-line convention.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const skillPath = join(here, '..', '..', '..', '.claude', 'skills', 'work-issues', 'SKILL.md');

interface Violation {
  line: number;
  text: string;
}

/** Exported shape of the scan, kept pure so the test can also feed it fixtures. */
export function findUnqualifiedIssueRefs(markdown: string): Violation[] {
  const lines = markdown.split('\n');
  const violations: Violation[] = [];
  let inFrontmatter = false;
  let frontmatterDone = false;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (i === 0 && raw.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (raw.trim() === '---' && !frontmatterDone) {
        inFrontmatter = false;
        frontmatterDone = true;
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Drop single-line inline code spans; what remains is plain prose.
    const prose = raw.replace(/`[^`]*`/g, '');
    // A qualified ref (`go-to-k/<repo>#N`) has a word character directly
    // before the `#`, so requiring a non-word, non-slash (or line-start)
    // prefix matches exactly the bare forms: ` #506`, `(#506)`, `(PR #513)`.
    const bare = /(^|[^\w/])#\d+/g;
    let m: RegExpExecArray | null;
    while ((m = bare.exec(prose)) !== null) {
      violations.push({ line: i + 1, text: raw.trim() });
    }
  }
  return violations;
}

describe('work-issues SKILL.md issue references (go-to-k/cdk-local#514)', () => {
  it('has no unqualified #N issue references in plain prose', () => {
    const markdown = readFileSync(skillPath, 'utf-8');
    const violations = findUnqualifiedIssueRefs(markdown);
    const detail = violations.map((v) => `  L${v.line}: ${v.text}`).join('\n');
    expect(
      violations,
      `Unqualified issue reference(s) in .claude/skills/work-issues/SKILL.md — ` +
        `write them as go-to-k/<repo>#N (the file is mirrored across repos, so a bare ` +
        `#N resolves against whichever repo reads it), or wrap a deliberate ` +
        `counter-example in a single-line backtick span:\n${detail}`
    ).toEqual([]);
  });

  it('flags a bare ref in prose but not frontmatter / fences / code spans (self-test)', () => {
    const fixture = [
      '---',
      "argument-hint: \"e.g. '#231 #234'\"",
      '---',
      'Qualified go-to-k/cdk-local#506 is fine, but bare #507 is not.',
      'A span like `#508` is exempt.',
      '```bash',
      'gh issue view 509 # refs #509 freely',
      '```',
      'And (PR #510) is bare too.',
    ].join('\n');
    const violations = findUnqualifiedIssueRefs(fixture);
    expect(violations.map((v) => v.line)).toEqual([4, 9]);
  });
});
