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
  'branch-gate.sh': ['Bash(*git*commit*)', 'Bash(*git*push*)'],
  'main-tree-branch-gate.sh': ['Bash(*git*switch*)', 'Bash(*git*checkout*)'],
  'commit-msg-heredoc-gate.sh': ['Bash(*git*commit*)'],
  'control-char-gate.sh': ['Bash(*git*commit*)'],
  'gh-pr-edit-deprecation-gate.sh': ['Bash(*gh*pr*edit*)'],
  'non-english-text-gate.sh': [
    'Bash(*gh*pr*create*)',
    'Bash(*gh*pr*edit*)',
    'Bash(*gh*pr*merge*)',
  ],
  'docs-inline-json-flag-gate.sh': [
    'Bash(*gh*pr*create*)',
    'Bash(*gh*pr*edit*)',
    'Bash(*gh*pr*merge*)',
  ],
  'post-merge-orphan-push-gate.sh': ['Bash(*git*push*)'],
  'closes-paren-form-gate.sh': ['Bash(*gh*pr*merge*)'],
  'issue-dup-check-gate.sh': ['Bash(*gh*issue*create*)', 'Bash(*gh*api*)'],
  'issue-classification-label-gate.sh': ['Bash(*gh*issue*create*)', 'Bash(*gh*issue*edit*)'],
  // Same two selectors as the dup-check gate, and for the same reason: the
  // REST mint (`gh api repos/<o>/<r>/issues`) is `gh issue create` through
  // another verb, so gating only the porcelain spelling under-approximates the
  // TRIGGER. `gh issue edit` is deliberately absent — re-classifying a filed
  // issue is the outcome that gate steers toward.
  'issue-deferral-criteria-gate.sh': ['Bash(*gh*issue*create*)', 'Bash(*gh*api*)'],
  'pr-body-item-number-gate.sh': [
    'Bash(*gh*pr*create*)',
    'Bash(*gh*pr*edit*)',
    'Bash(*gh*issue*create*)',
    'Bash(*gh*issue*comment*)',
    'Bash(*gh*api*)',
  ],
  'check-gate.sh': ['Bash(*git*commit*)'],
  'pr-review-gate.sh': ['Bash(*gh*pr*merge*)'],
  'verify-pr-gate.sh': ['Bash(*gh*pr*create*)', 'Bash(*gh*pr*merge*)'],
  'integ-gate.sh': ['Bash(*gh*pr*merge*)', 'Bash(*git*merge*)'],
  'cdkd-parity-gate.sh': ['Bash(*gh*pr*create*)'],
  'create-integ-gate.sh': ['Bash(*gh*pr*create*)'],
  'gh-pr-merge-worktree-gate.sh': ['Bash(*gh*pr*merge*)'],
  // The only BLOCKING gate selected on a non-`git`/`gh` command word
  // (go-to-k/cdk-local#571): a piped `markgate verify` reports the PIPE's
  // exit code, so a STALE gate reads as a pass.
  'markgate-pipe-gate.sh': ['Bash(*markgate*)'],
  // Selected on a non-`git`/`gh` word too, but it is NOT a gate: a
  // non-blocking warn on the integ fixture INVOCATION, which is the last
  // moment a rebase is still free. `/run-integ` section 5's one invocation
  // shape is `bash tests/integration/<name>/verify.sh`, redirected to a log,
  // so the selector is part of the script name rather than a command verb.
  // `*verify*` and NOT `*verify.sh*`: `_command-match.test.sh` cross-checks the
  // parsed hook-script list against a raw `[A-Za-z0-9_-]*\.sh` scan of this
  // block, so a `.sh` inside an `if` PATTERN is counted as a 24th hook script
  // and the two methods disagree (measured — that is exactly how the first
  // spelling of this entry reddened that suite). The wider glob also selects
  // `vp run verify` and the like; the hook exits 0 after one segment match, so
  // an over-selection costs a process spawn and an under-selection costs the
  // nudge this hook exists to give.
  'integ-stale-base-detector.sh': ['Bash(*verify*)'],
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
    expect(hooks.length).toBeGreaterThanOrEqual(19);
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

  // `git -C <path> commit` and `gh -R <owner/repo> pr create` put a FLAG between
  // the command and its verb, so a pattern demanding them adjacent
  // (`Bash(*git commit*)`) never selects those spellings — while the flow's own
  // guidance tells an agent to use `git -C` in multi-repo sessions, steering
  // straight into the gap (found 2026-08-21, the same class as
  // go-to-k/cdk-real-drift#1801). Simulate the glob to keep it closed.
  it('a flag between the command and its verb still selects the gate', () => {
    const globToRe = (pattern: string) =>
      new RegExp(
        `^${pattern
          .replace(/^Bash\(/, '')
          .replace(/\)$/, '')
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`
      );
    const selects = (gate: string, spelling: string) =>
      hooks.filter((h) => h.name === gate).some((h) => globToRe(h.condition).test(spelling));
    for (const spelling of [
      'git commit -m x',
      'git -C /w/t commit -m x',
      'git -c user.name=t commit -m x',
      'git add -A && git commit -m x',
    ]) {
      expect(selects('check-gate.sh', spelling), `check-gate misses: ${spelling}`).toBe(true);
    }
    for (const spelling of ['gh pr create --fill', 'gh -R go-to-k/x pr create --fill']) {
      expect(selects('verify-pr-gate.sh', spelling), `verify-pr-gate misses: ${spelling}`).toBe(
        true
      );
    }
    // markgate-pipe-gate is selected on the LAUNCHER-prefixed spelling every
    // skill in this repo writes, not on a bare `markgate …` — an anchored
    // `Bash(markgate*)` would miss all of these and the gate would be inert.
    for (const spelling of [
      'markgate verify check | tail -5',
      'mise exec -- markgate verify integ 2>&1 | tail -5',
      'cd /w/t && mise exec -- markgate set integ | tee /tmp/l',
    ]) {
      expect(
        selects('markgate-pipe-gate.sh', spelling),
        `markgate-pipe-gate misses: ${spelling}`
      ).toBe(true);
    }
  });

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
