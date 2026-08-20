import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Every PreToolUse gate must actually BE SELECTED for the commands it guards.
 *
 * On 2026-08-20 (go-to-k/cdk-real-drift#1801) none of them were. Each gate's `if`
 * joined its command spellings with ` or `:
 *
 *   "if": "Bash(git commit*) or Bash(git -C * commit*) or Bash(cd * && git commit*)"
 *
 * and that is not a supported expression — an `if` holding `A or B` matches
 * NOTHING, so the hook is never chosen and the gate is inert. It was proved with
 * three throwaway hooks in the sibling repo: an `if`-less hook fired, one with
 * `if: "Bash(git status*)"` fired, and one with `if: "Bash(git commit*) or
 * Bash(git status*)"` never did — while `git commit` on `main` with no markers
 * reached git in two different clients. All seventeen gates here were in that
 * shape, including `check-gate`, `branch-gate`, `verify-pr-gate`, `pr-review-gate`
 * and `integ-gate`.
 *
 * So: an `if` carries exactly ONE pattern, and a gate guarding two verbs gets two
 * ENTRIES. The pattern is deliberately UNANCHORED (`*git commit*`) because the
 * matcher's only job is to hand the script every candidate — each gate script
 * already re-derives its own target directory and re-matches the command
 * precisely, and an anchored matcher cannot see `git add -A && git commit`, the
 * commonest spelling there is. cdkd, whose gates have always fired, wires its
 * hooks with no `if` at all for the same reason.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const SETTINGS = join(here, '..', '..', '..', '.claude', 'settings.json');

/** Which command each gate must be selected for. */
const REQUIRED: Record<string, string[]> = {
  'branch-gate.sh': ['Bash(*git commit*)', 'Bash(*git push*)'],
  'main-tree-branch-gate.sh': ['Bash(*git switch*)', 'Bash(*git checkout*)'],
  'commit-msg-heredoc-gate.sh': ['Bash(*git commit*)'],
  'control-char-gate.sh': ['Bash(*git commit*)'],
  'gh-pr-edit-deprecation-gate.sh': ['Bash(*gh pr edit*)'],
  'non-english-text-gate.sh': [
    'Bash(*gh pr create*)',
    'Bash(*gh pr edit*)',
    'Bash(*gh pr merge*)',
  ],
  'docs-inline-json-flag-gate.sh': [
    'Bash(*gh pr create*)',
    'Bash(*gh pr edit*)',
    'Bash(*gh pr merge*)',
  ],
  'post-merge-orphan-push-gate.sh': ['Bash(*git push*)'],
  'closes-paren-form-gate.sh': ['Bash(*gh pr merge*)'],
  'pr-body-item-number-gate.sh': [
    'Bash(*gh pr create*)',
    'Bash(*gh pr edit*)',
    'Bash(*gh issue create*)',
    'Bash(*gh issue comment*)',
    'Bash(*gh api*)',
  ],
  'check-gate.sh': ['Bash(*git commit*)'],
  'pr-review-gate.sh': ['Bash(*gh pr merge*)'],
  'verify-pr-gate.sh': ['Bash(*gh pr create*)', 'Bash(*gh pr merge*)'],
  'integ-gate.sh': ['Bash(*gh pr merge*)', 'Bash(*git merge*)'],
  'cdkd-parity-gate.sh': ['Bash(*gh pr create*)'],
  'create-integ-gate.sh': ['Bash(*gh pr create*)'],
  'gh-pr-merge-worktree-gate.sh': ['Bash(*gh pr merge*)'],
};

interface GateHook {
  name: string;
  condition: string;
}

function gateHooks(): GateHook[] {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as {
    hooks?: {
      PreToolUse?: { matcher?: string; if?: string; hooks?: { command?: string; if?: string }[] }[];
    };
  };
  const out: GateHook[] = [];
  for (const matcher of settings.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks ?? []) {
      const command = hook.command ?? '';
      if (!command.includes('.claude/hooks/')) continue;
      out.push({
        name: basename(command.split(/\s+/)[0] ?? command),
        condition: hook.if ?? matcher.if ?? '',
      });
    }
  }
  return out;
}

describe('PreToolUse gate matchers (go-to-k/cdk-real-drift#1801)', () => {
  const hooks = gateHooks();
  const patternsOf = (gate: string) =>
    hooks.filter((h) => h.name === gate && h.condition).map((h) => h.condition);

  it('finds the gate hooks', () => {
    const names = new Set(hooks.map((h) => h.name));
    expect(names.has('check-gate.sh')).toBe(true);
    expect(names.has('verify-pr-gate.sh')).toBe(true);
    expect(hooks.length).toBeGreaterThanOrEqual(17);
  });

  // THE regression case: this exact join disabled every gate in the repo.
  it('no `if` joins patterns with `or` — that matches nothing and disables the hook', () => {
    const joined = hooks
      .filter((h) => / or /.test(h.condition))
      .map((h) => `${h.name}: ${h.condition}`);
    expect(
      joined,
      'an `if` takes ONE pattern; give the gate another ENTRY instead of joining'
    ).toEqual([]);
  });

  it('every `if` holds a single well-formed Bash(...) pattern', () => {
    const malformed = hooks
      .filter((h) => h.condition)
      .filter((h) => !/^Bash\([^()]*\)$/.test(h.condition))
      .map((h) => `${h.name}: ${h.condition}`);
    expect(malformed).toEqual([]);
  });

  it('every gate in settings.json is accounted for in the required table', () => {
    const undeclared = [...new Set(hooks.map((h) => h.name))].filter((n) => !(n in REQUIRED));
    expect(undeclared, 'a new gate must declare which commands select it').toEqual([]);
    const missing = Object.keys(REQUIRED).filter((n) => patternsOf(n).length === 0);
    expect(missing, 'REQUIRED names a gate settings.json no longer wires').toEqual([]);
  });

  for (const [gate, patterns] of Object.entries(REQUIRED)) {
    it(`${gate} is selected for every command it guards`, () => {
      const present = patternsOf(gate);
      const gaps = patterns.filter((p) => !present.includes(p));
      expect(gaps, `${gate} is missing an entry for ${gaps.join(', ')}`).toEqual([]);
    });
  }

  it('the patterns are unanchored, so a compound command still selects the gate', () => {
    const anchored = hooks
      .filter((h) => /^Bash\((git|gh)\b/.test(h.condition))
      .map((h) => `${h.name}: ${h.condition}`);
    expect(
      anchored,
      'write Bash(*git commit*), not Bash(git commit*) — the latter misses ' +
        '`git add -A && git commit` and `cd <wt> && git commit`'
    ).toEqual([]);
  });
});
