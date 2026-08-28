import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * go-to-k/cdk-local#514: the agent-instruction files under `.claude/**` are
 * mirrored across three sibling repos, so a bare `#N` issue reference — which
 * GitHub renders against whichever repo is READING it — silently rewrites a
 * correct citation into a dead link or an unrelated issue when the file
 * travels. `work-issues` section 10-c requires every issue / PR reference in
 * plain prose to be written fully qualified (`<owner>/<repo>#N`); this test
 * mechanizes that rule so a regression fails CI instead of shipping.
 *
 * Two probes shaped what it scans, both run against the real tree on
 * 2026-08-20 rather than reasoned about (go-to-k/cdkd#2111's lesson):
 *
 * - SPELLING. The first version required only "a non-word, non-slash character
 *   before the `#`", so it accepted the two HALF-qualified spellings —
 *   `cdk-local#5` (no owner) and `go-to-k#5` (no repo) — which GitHub does not
 *   autolink at all. The rule below asks for the whole `<owner>/<repo>` prefix.
 * - POPULATION. It read ONE hardcoded path while the rule it mechanizes is
 *   about MIRRORING, so the sibling agent-instruction files it never opened had
 *   drifted: `.claude/skills/review-pr/SKILL.md`, `.claude/skills/cleanup/SKILL.md`,
 *   `.claude/rules/hooks.md` and `.claude/agents/pr-code-reviewer.md` carried
 *   eight bare refs between them, and both `#501` and `#402` resolve in cdkd to
 *   real but unrelated issues. The population is now every mirrored
 *   agent-instruction file.
 *
 * Exempt contexts, so a paragraph can still show a bare `#N` as its own
 * counter-example: the YAML frontmatter block, fenced code blocks, and
 * single-line inline code spans. An inline span must NOT wrap across lines —
 * the stripper is line-based, so a ref inside a wrapped span is flagged,
 * which deliberately enforces the keep-spans-on-one-line convention.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/**
 * The mirrored set: files that travel to `../cdkd` / `../cdk-real-drift` and so
 * lose the repo a bare `#N` means. `.claude/CLAUDE.md` is deliberately NOT here
 * — it is repo-specific and never mirrored, so its bare refs are correct.
 * `references/*.md` joins the set with the work-issues split (a thin SKILL.md
 * orchestrator plus per-stage files): the stage files carry the bulk of the
 * mirrored prose now, so scanning only SKILL.md would exempt exactly the text
 * this rule exists for. The glob is directory-derived (`git ls-files`), so a
 * new stage file — or a future split of another skill — joins the scan on
 * creation with no edit here.
 */
const MIRRORED_GLOBS = [
  '.claude/skills/*/SKILL.md',
  '.claude/skills/*/references/*.md',
  '.claude/agents/*.md',
  '.claude/rules/*.md',
];

interface Violation {
  line: number;
  text: string;
}

function mirroredFiles(): string[] {
  const out = execFileSync('git', ['ls-files', ...MIRRORED_GLOBS], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return out.split('\n').filter((p) => p.length > 0);
}

/** Exported shape of the scan, kept pure so the test can also feed it fixtures. */
export function findUnqualifiedIssueRefs(markdown: string): Violation[] {
  const lines = markdown.split('\n');
  const violations: Violation[] = [];
  let inFrontmatter = false;
  let frontmatterDone = false;
  // A fence is CLOSED only by its own marker, at least as long as the opener
  // (CommonMark). Toggling on any marker lets one nested ``` inside a ~~~ block
  // invert the state and silently mute the scan for the whole rest of the file.
  let openFence: { char: string; length: number } | null = null;
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
    const fence = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      const marker = fence[1]!;
      if (openFence === null) {
        openFence = { char: marker[0]!, length: marker.length };
        continue;
      }
      if (marker[0] === openFence.char && marker.length >= openFence.length) {
        openFence = null;
      }
      continue;
    }
    if (openFence !== null) continue;
    // Drop single-line inline code spans; what remains is plain prose. The
    // DOUBLE-backtick form is stripped first: it is how a counter-example
    // containing a backtick is written, and a single-span-only strip leaves its
    // contents exposed as prose (found in review of go-to-k/cdk-local#538).
    const prose = raw.replace(/``.*?``/g, '').replace(/`[^`]*`/g, '');
    // Every ref must carry the WHOLE `<owner>/<repo>` prefix. Matching on the
    // ref and inspecting what precedes it catches the half-qualified spellings
    // (`cdk-local#5`, `go-to-k#5`) that a "not a word character before `#`"
    // rule accepts and GitHub does not autolink.
    const ref = /#\d+/g;
    let m: RegExpExecArray | null;
    while ((m = ref.exec(prose)) !== null) {
      const before = prose.slice(0, m.index);
      if (/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(before)) continue;
      violations.push({ line: i + 1, text: raw.trim() });
    }
  }
  return violations;
}

describe('mirrored agent-instruction issue references (go-to-k/cdk-local#514)', () => {
  it('scans every mirrored agent-instruction file, work-issues included', () => {
    const files = mirroredFiles();
    expect(files).toContain('.claude/skills/work-issues/SKILL.md');
    expect(files).toContain('.claude/skills/review-pr/SKILL.md');
    expect(files).toContain('.claude/agents/pr-code-reviewer.md');
    expect(files).toContain('.claude/rules/hooks.md');
    expect(files.length).toBeGreaterThan(5);
  });

  it('scans the work-issues per-stage reference files (the split moved the prose there)', () => {
    // The split left SKILL.md a thin orchestrator; the mirrored prose — and
    // with it nearly every cross-repo citation — lives in references/*.md now.
    // A glob that silently stopped matching them would leave this suite green
    // while exempting the bulk of the corpus, so pin the population: 8 stage
    // files at the split.
    const refs = mirroredFiles().filter((f) =>
      f.startsWith('.claude/skills/work-issues/references/')
    );
    expect(refs).toContain('.claude/skills/work-issues/references/triage.md');
    expect(refs).toContain('.claude/skills/work-issues/references/retro.md');
    expect(refs.length).toBeGreaterThanOrEqual(6);
  });

  it('the work-issues corpus still carries its qualified citations (the split moved content, not dropped it)', () => {
    // Every other assertion in this file is a "no bad refs" upper bound, which
    // an emptied file satisfies vacuously. This floor notices the incident
    // citations being DROPPED rather than moved: the pre-split SKILL.md carried
    // well over 60 qualified `go-to-k/<repo>#N` refs in its prose.
    const docs = mirroredFiles().filter((f) => f.startsWith('.claude/skills/work-issues/'));
    const qualified = /[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+/g;
    const total = docs.reduce(
      (n, f) => n + (readFileSync(join(repoRoot, f), 'utf-8').match(qualified)?.length ?? 0),
      0
    );
    expect(
      total,
      'the work-issues skill docs (SKILL.md + references/*.md) have almost no qualified refs left'
    ).toBeGreaterThanOrEqual(60);
  });

  it('has no unqualified #N issue references in plain prose', () => {
    const offenders: string[] = [];
    for (const file of mirroredFiles()) {
      const markdown = readFileSync(join(repoRoot, file), 'utf-8');
      for (const v of findUnqualifiedIssueRefs(markdown)) {
        offenders.push(`  ${file}:${v.line}: ${v.text}`);
      }
    }
    expect(
      offenders,
      `Unqualified issue reference(s) in mirrored agent-instruction file(s) — ` +
        `write them as <owner>/<repo>#N (these files are mirrored across repos, so a bare ` +
        `#N resolves against whichever repo reads it, and a half-qualified ` +
        `cdk-local#N / go-to-k#N does not link at all), or wrap a deliberate ` +
        `counter-example in a single-line backtick span:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('exempts a double-backtick span, the form used to show a ref inside backticks', () => {
    expect(findUnqualifiedIssueRefs('A span like ``#609 in `ticks` `` is exempt.')).toEqual([]);
    expect(findUnqualifiedIssueRefs('But a bare #610 beside it is not.')).toHaveLength(1);
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

  it('flags every half-qualified spelling, not just the bare one (spelling probe)', () => {
    const spellings = [
      'A bare #601 ref.',
      'A repo-only cdk-local#602 ref.',
      'An owner-only go-to-k#603 ref.',
      'A parenthesised (PR #604) ref.',
      'A line-leading #605 ref.',
    ];
    for (const line of spellings) {
      expect(findUnqualifiedIssueRefs(line), line).toHaveLength(1);
    }
    expect(findUnqualifiedIssueRefs('A qualified go-to-k/cdk-local#606 ref.')).toEqual([]);
    expect(findUnqualifiedIssueRefs('A qualified go-to-k/cdk-real-drift#607 ref.')).toEqual([]);
  });

  it('keeps scanning after a nested fence marker (deletion probe on the fence state)', () => {
    // A ``` block nested inside a ~~~ block: toggling on ANY marker leaves the
    // scanner "inside a fence" for the rest of the file and mutes it silently.
    const fixture = [
      '~~~text',
      '```bash',
      'echo hi',
      '```',
      '~~~',
      'A bare #608 after the block must still be flagged.',
    ].join('\n');
    expect(findUnqualifiedIssueRefs(fixture).map((v) => v.line)).toEqual([6]);
  });
});
