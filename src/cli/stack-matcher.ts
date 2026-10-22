/**
 * Match stacks against user-supplied name patterns, with the rule cdkd (the
 * embedding host) ships, so `cdkd local` and `cdkl` select the same stacks
 * (go-to-k/cdkd#4474, go-to-k/cdk-local#746):
 *
 * - A pattern is matched against the stack's HIERARCHICAL id (`displayName`:
 *   `MyStack` for a top-level stack, `MyStage/MyStack` inside a `cdk.Stage`)
 *   with a path-aware glob — `*` stays within one `/` segment, `**` spans any
 *   number — so `'*'` selects the top-level stacks, `'MyStage/*'` one Stage's
 *   stacks and `'**'` every stack. See {@link pathGlobMatches}.
 * - A pattern that is EXACTLY a stack's physical CloudFormation name
 *   (`MyStage-MyStack`) selects it, but only when no stack's hierarchical id
 *   matches the pattern. Exact only, never a glob: a wildcard over physical
 *   names would make `'*'` select every Stage's stacks as well.
 *
 * Results keep input order and are de-duplicated by IDENTITY, never by
 * `stackName`: two Stage stacks may share an explicit physical name (one Stage
 * deployed to two accounts), and collapsing them would silently drop one —
 * a caller expecting exactly one match must see both and refuse.
 */
import { stackForPathFormTarget } from './cdk-path.js';
import { displayUntrustedValue } from '../utils/assembly-path.js';

export interface StackLike {
  stackName: string;
  displayName?: string;
}

export function matchStacks<T extends StackLike>(stacks: T[], patterns: string[]): T[] {
  if (patterns.length === 0) return [];
  const selected = new Set<T>();
  for (const pattern of patterns) {
    for (const stack of stacksForPattern(stacks, pattern)) selected.add(stack);
  }
  return stacks.filter((s) => selected.has(s));
}

/**
 * The stacks ONE pattern selects. The hierarchical id wins: the exact physical
 * name is consulted only when no stack's id matched, so a name that is one
 * stack's construct id and ANOTHER stack's physical name selects only the
 * former — never both, which a union would.
 */
function stacksForPattern<T extends StackLike>(stacks: readonly T[], pattern: string): T[] {
  const byId = stacks.filter((s) => pathGlobMatches(pattern, s.displayName ?? s.stackName));
  return byId.length > 0 ? byId : stacks.filter((s) => s.stackName === pattern);
}

/**
 * Whether `pattern` could select `stack` on its own: the hierarchical id under
 * a path-aware glob, or the physical name exactly. SELECTION goes through
 * {@link matchStacks}, where the id takes precedence over the physical name.
 */
export function stackMatchesPattern(stack: StackLike, pattern: string): boolean {
  return (
    pathGlobMatches(pattern, stack.displayName ?? stack.stackName) || pattern === stack.stackName
  );
}

/**
 * Render a stack for diagnostic messages. When `displayName` differs from the
 * physical name, both are shown so the user can see which forms are valid as
 * patterns (e.g. `MyStage-Api (MyStage/Api)`). Both names come from the Cloud
 * Assembly, so each goes through `displayUntrustedValue` — the identity on
 * every plain value, a JSON string literal otherwise.
 */
export function describeStack(stack: StackLike): string {
  const name = displayUntrustedValue(stack.stackName);
  if (stack.displayName && stack.displayName !== stack.stackName) {
    return `${name} (${displayUntrustedValue(stack.displayName)})`;
  }
  return name;
}

/** {@link describeStack} over a list, comma-separated. */
export function describeStacks(stacks: readonly StackLike[]): string {
  return stacks.map(describeStack).join(', ');
}

/**
 * The outcome of resolving a target's owning stack — one rule for every
 * target resolver (`invoke`, `run-task`, `start-service`, `start-alb`,
 * `start-cloudfront`, `invoke-agentcore` / `start-agentcore`), each of which
 * maps a miss onto its own error class and wording.
 *
 * - `no-prefix` — the target names no stack and the app has more than one.
 *   EVERY enumerated stack counts, a `cdk.Stage`'s included, as cdkd counts
 *   them: an app with one top-level stack plus a Stage is multi-stack.
 * - `not-found` / `ambiguous` — the target's stack head matched zero / more
 *   than one stack.
 */
export type TargetStackSelection<T> =
  | { kind: 'found'; stack: T }
  | { kind: 'no-prefix' }
  | { kind: 'not-found'; pattern: string }
  | { kind: 'ambiguous'; pattern: string; matched: T[] };

/**
 * Resolve a parsed target (`parseTarget` / `parseEcsTarget`) to its stack.
 *
 * A PATH-form target's stack is the one whose display path is the LONGEST
 * prefix of the target ({@link stackForPathFormTarget}) — the first segment of
 * a Stage stack's target is the Stage id, which names no stack. A head no
 * display path prefixes (a wildcard such as `My*`) and the colon form
 * (`Stack:LogicalId`, which keeps the stack it names) go through
 * {@link matchStacks}.
 */
export function selectTargetStack<T extends StackLike>(
  parsed: { stackPattern: string | null; pathOrId: string; isPath: boolean },
  target: string,
  stacks: readonly T[]
): TargetStackSelection<T> {
  if (parsed.stackPattern === null) {
    return stacks.length === 1 ? { kind: 'found', stack: stacks[0]! } : { kind: 'no-prefix' };
  }
  const byPrefix = stackForPathFormTarget(parsed, target, stacks);
  if (byPrefix) return { kind: 'found', stack: byPrefix };
  const matched = matchStacks([...stacks], [parsed.stackPattern]);
  if (matched.length === 1) return { kind: 'found', stack: matched[0]! };
  if (matched.length === 0) return { kind: 'not-found', pattern: parsed.stackPattern };
  return { kind: 'ambiguous', pattern: parsed.stackPattern, matched };
}

/**
 * Best-effort form of {@link selectTargetStack} for the callers that only need
 * the CANDIDATE stack before full resolution (the state source of
 * `--from-cfn-stack`, an image-resolution context): the stack, or `undefined`
 * on any miss — the resolver then surfaces its own error. Sharing the rule is
 * what keeps a Stage target from resolving the resource while its candidate
 * (the Stage id) matched nothing, which ran it with no state source, silently
 * (go-to-k/cdkd#3953).
 */
export function candidateTargetStack<T extends StackLike>(
  parsed: { stackPattern: string | null; pathOrId: string; isPath: boolean },
  target: string,
  stacks: readonly T[]
): T | undefined {
  const selection = selectTargetStack(parsed, target, stacks);
  return selection.kind === 'found' ? selection.stack : undefined;
}

/**
 * Whether `subject` matches the glob `pattern`, where `*` matches any run of
 * characters (the empty run included) and EVERY other character is literal.
 * One SEGMENT of a stack pattern; {@link pathGlobMatches} applies it per
 * `/`-separated segment.
 *
 * **Never a RegExp**: a `*`-to-`.*` translation backtracks exponentially on a
 * pattern with several `*` separated by literals, and leaves every other
 * character live regex syntax (`My.Stage*` matched `MyXStage1`; `My(Stage*`
 * threw). The walk anchors the text before the first `*` at the start and the
 * text after the last `*` at the end, then places each middle segment at its
 * LEFTMOST occurrence after the previous one — optimal when `*` is the only
 * wildcard, so no backtracking is needed. Same algorithm as cdkd's.
 */
export function globMatches(pattern: string, subject: string): boolean {
  const segments = pattern.split('*');
  if (segments.length === 1) return pattern === subject;

  const head = segments[0]!;
  const tail = segments[segments.length - 1]!;
  // The head and tail must not overlap: `a*a` needs at least two characters.
  if (subject.length < head.length + tail.length) return false;
  if (!subject.startsWith(head) || !subject.endsWith(tail)) return false;

  const end = subject.length - tail.length;
  let cursor = head.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (segment === '') continue;
    const at = subject.indexOf(segment, cursor);
    if (at === -1 || at + segment.length > end) return false;
    cursor = at + segment.length;
  }
  return true;
}

/**
 * Whether a `/`-separated `subject` matches the path glob `pattern`, as the
 * AWS CDK CLI matches a stack pattern against a stack's hierarchical id:
 *
 * - `*` matches any run of characters WITHIN one segment and never crosses
 *   `/`, so `'*'` selects top-level stacks only and `'Stage/*'` the stacks
 *   directly inside `Stage`;
 * - a segment that is exactly `**` matches zero or more whole segments, so
 *   `'**'` selects every stack at any depth;
 * - every other character is literal, as in {@link globMatches}.
 *
 * Bottom-up dynamic programming over (pattern segment, subject segment), so a
 * run of `**` costs O(|pattern| x |subject|) segment matches and no recursion.
 */
export function pathGlobMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('/');
  const s = subject.split('/');
  // can[j] = whether p[i..] matches s[j..], filled from the last pattern
  // segment back.
  let can: boolean[] = s.map(() => false).concat(true);
  for (let i = p.length - 1; i >= 0; i--) {
    const next: boolean[] = new Array<boolean>(s.length + 1).fill(false);
    if (p[i] === '**') {
      // Zero segments (can[j]), or one more and stay on the globstar.
      for (let j = s.length; j >= 0; j--) next[j] = can[j]! || (j < s.length && next[j + 1]!);
    } else {
      for (let j = 0; j < s.length; j++) next[j] = can[j + 1]! && globMatches(p[i]!, s[j]!);
    }
    can = next;
  }
  return can[0]!;
}
