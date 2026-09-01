import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Issue #570 — the TENTH-site fence.
 *
 * `sts-error-relay-sites.test.ts` drives nine known sites and fails when any of
 * them stops routing through `describeAwsFailureForWarn`. What it cannot see is
 * a site that did not exist when the table was written: a new
 * `logger.warn('... STS <Op> failed: ${err.message}')` generates no case, so it
 * generates no failure either. That is the shape this file closes.
 *
 * It is a SOURCE-TEXT check, and every draft of it has been weaker than it
 * read. Five evasions found by review are closed, each with the assertion that
 * closes it:
 *
 *   - A tenth site in a SIXTH file was invisible, because the file list was
 *     hard-coded. The scan walks every `src/cli/commands/*.ts` now and the file
 *     set is asserted rather than assumed.
 *   - The helper check matched the window TEXT, and every site carries a
 *     comment naming the helper — so a tenth site keeping the comment and
 *     writing `${(err as Error).message}` passed. A CALL is matched now.
 *   - Comment stripping only handled a LEADING `//`; a TRAILING one on a line
 *     of real code still vouched for it.
 *   - The raw-relay check matched one exact ternary spelling.
 *   - Detection was per-line, so a template wrapping across a `+` — the house
 *     style at four of the nine sites — was invisible.
 *
 * Issue #613 added the half the first draft could not express. The four
 * `--assume-role` relays catch a class cdk-local THROWS ITSELF
 * (`AssumeRoleFailure`, whose `detail` was pre-rendered by the policy at
 * throw time), so the correct shape at those sites is a ternary:
 *
 *   err instanceof AssumeRoleFailure ? err.detail : describeAwsFailureForWarn(err, op)
 *
 * Drop the `instanceof` half and what remains is exactly what `HELPER_CALL`
 * requires -- so the fence BLESSED the defective form, which WITHHOLDS text
 * the policy had already sanitized (`ExpiredTokenException: ...` became
 * `Error; 138-character message withheld`). That happened twice in one PR
 * (go-to-k/cdk-local#611), caught both times by per-occurrence literal
 * assertions, never here. Now a site whose announcement names `STS
 * AssumeRole` must ALSO carry the own-throw branch, read from a slightly
 * wider window (see `OWN_THROW_LINES_BEFORE`).
 *
 * The same issue widened what may vouch for a site: a NAMED RENDERER defined
 * in the scanned tree, so the four duplicated ternaries CAN be factored into
 * one function without defeating the tenth-site property (PR #611 tried, and
 * the fence failed all three factored sites; the ternaries were inlined to
 * satisfy it). Recognition is deliberately strict so an arbitrary
 * neighbouring call cannot vouch: the callee must be DEFINED in
 * `src/cli/commands/*.ts`, its body must carry the FULL policy shape (the
 * helper call AND the own-throw branch), it must not `warn` itself (a
 * renderer renders; a site warns), and the body must close within
 * `RENDERER_BODY_MAX_LINES`. Anything the collector cannot model is NOT a
 * renderer -- fail-closed: the site using it is reported and the author
 * reacts, rather than an unmodelled shape vouching silently.
 *
 * WHAT IT STILL DOES NOT CATCH, stated so nobody reads more into a green run:
 *
 *   - It does not match the error VALUE. A `describeAwsFailureForWarn(other, …)`
 *     one line away vouches for an unguarded neighbour. Only per-error matching
 *     fixes that, which needs an AST.
 *   - It is wording-bound. A tenth site spelled `STS ${op} failure` or with no
 *     `STS` token at all produces no finding — though a copy-paste-shaped one
 *     trips the pinned count loudly.
 *   - Its directory scope is `src/cli/commands/*.ts`, non-recursively. FOUR
 *     relays of the same shape live outside it, and issue #579 added two of
 *     them: `src/utils/role-arn.ts`'s `assumeRoleCredentials` and
 *     `applyRoleArnIfSet`. The second is the NINE-caller site, the most
 *     reachable AssumeRole relay in the repo, and neither is reachable by this
 *     scan. Both are fenced behaviourally in
 *     `tests/unit/utils/role-arn.test.ts` — but that is per-occurrence
 *     coverage, NOT the tenth-site property: a NEW unguarded relay added
 *     beside them still produces no finding here. Stated rather than left
 *     implicit, because "it has tests" and "a new sibling cannot slip in" are
 *     different guarantees and only the first holds there. The other two —
 *     `src/local/layer-arn-materializer.ts`'s `STS AssumeRole(${roleArn})
 *     failed:` and `src/local/ecr-puller.ts`'s `Failed to assume role ${arn}
 *     for ECR pull:`. Issue #579 routed both through the shared policy and
 *     fences them per-occurrence in
 *     `tests/unit/local/aws-error-relay-sites.test.ts`, but this file's
 *     TENTH-SITE property does not extend to them: a NEW unguarded STS relay
 *     added under `src/local/**` still produces no finding here. Widening the
 *     scan is not free — `src/local/**` carries far more prose naming STS than
 *     the command layer does, and a fence that has to be suppressed is a fence
 *     nobody keeps — so it is left undone deliberately rather than overlooked.
 *   - `stripComments` handles a leading and a trailing `//`, not a trailing
 *     BLOCK comment: one opening with a slash-star, naming the helper, and
 *     closing again on the same line, placed beside a destructured
 *     `const { message } = awsErr;`, vouches for the code and evades the
 *     raw check at once. Deliberate self-evasion, not accident.
 *   - The announcing check needs `STS <Op>` on ONE physical line, so a template
 *     that wraps between `STS ` and the operation is undetected. The `+`-wrap
 *     fix covered the `failed` half of the split, not this one.
 *   - The own-throw classifier is wording-bound like the rest of the file: a
 *     relay announcing `STS AssumeRole` under any other spelling is not asked
 *     for the branch. And it derives "throws AssumeRoleFailure" from the
 *     OPERATION NAME, not from the call graph -- true today because every
 *     AssumeRole in this repo goes through a helper that throws it
 *     (`assumeRoleCredentials` / `applyRoleArnIfSet` in
 *     `src/utils/role-arn.ts`, `assumeAgentCoreExecutionRole` in
 *     `local-invoke-agentcore.ts`); a future direct SDK send would inherit a
 *     requirement it does not need, which errs STRICT and loud, never silent.
 *   - A renderer defined OUTSIDE `src/cli/commands/*.ts` is not recognized,
 *     same fail-closed direction as the rest of the scan scope.
 *   - `RAW_RELAY` is identifier-bound to `err` / `error` / `e`, so
 *     `caught.message`, a destructured `{ message }`, `err.toString()` and
 *     `JSON.stringify(err)` all miss. That only bites inside the adjacency
 *     case above, where something else already vouches.
 *
 * Its scope stays narrow on purpose: only lines that name an STS operation as
 * having failed. A broader rule ("no `err.message` in any warn") would be
 * wrong — these files carry dozens of legitimate Docker / filesystem / synth
 * relays, and a fence that has to be suppressed is a fence nobody keeps.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..', 'src');
const COMMANDS = join(SRC, 'cli', 'commands');

/**
 * Announces an STS failure. Matched against a JOINED window rather than one
 * line: four of the nine existing sites wrap their template across a `+`,
 * which is the house style, and a per-line pattern misses every one of those
 * in the FAIL-OPEN direction (no finding, so no count trip either).
 *
 * `STS` is matched CASE-SENSITIVELY and on a word boundary, and both halves
 * were paid for. A case-insensitive `/sts\s+/` matched the word `lists ` in
 * `local-start-alb.ts`'s `--tls-cert` help text ("the cert lists DNS:localhost
 * ... will fail the SAN check"), reporting an option definition as an
 * unguarded relay. cdk-local writes the service as `STS` everywhere, so
 * insisting on that spelling costs nothing and removes a whole class of prose
 * false positives.
 */
const STS_FAILURE_LINE = /\bSTS\s+[A-Za-z$][\s\S]{0,200}?fail/;

/**
 * A read of anything wire-derived off the error. Deliberately broader than
 * `.message`: `err.name` is the `x-amzn-errortype` forging vector this whole
 * change exists to close, and `String(err)` / `err.stack` carry the message
 * anyway. Each spelling here was added because a review probe got past the
 * previous one.
 */
const RAW_RELAY =
  /\b(?:err|error|e)\s*(?:as\s+[A-Za-z.<>\[\]]+\s*)?\)?\s*[?!]?\.\s*(?:message|name|stack)\b|\bString\s*\(\s*err/;

/** A CALL to the shared helper, not a comment mentioning it. */
const HELPER_CALL = /describeAwsFailureForWarn\s*\(/;

/**
 * Issue #613 -- classifies a finding as a relay of a class cdk-local throws
 * itself. Every `STS AssumeRole` in this repo goes through a helper that
 * throws `AssumeRoleFailure` with a pre-rendered `detail`, so the operation
 * name in the announcement IS the discriminator -- no call graph needed.
 * Matched against the same joined DETECTION text `STS_FAILURE_LINE` matched,
 * so a helper-call string above or below the warn cannot reclassify a site.
 */
const OWN_THROW_ANNOUNCE = /\bSTS\s+AssumeRole\b/;

/**
 * The two halves of the own-throw branch, required SEPARATELY rather than as
 * one exact ternary spelling (the raw-relay lesson above: one-spelling
 * patterns rot). `.detail` is what makes the branch USE the pre-rendered
 * text; `instanceof` alone would also match the inverted defect
 * (re-rendering the own throw and printing the helper's withhold line).
 */
const OWN_THROW_GUARD = /\binstanceof\s+AssumeRoleFailure\b/;
const OWN_THROW_DETAIL = /\.detail\b/;

/**
 * How many source lines around the announcing line count as part of the site.
 *
 * Measured, not guessed: seven sites render inline on the announcing line or
 * the one after it, and one (`local-invoke.ts`'s `--assume-role` site) hoists
 * the render into a `const reason = ...` two lines above. A one-sided window
 * reported that one as unguarded. The numbers are the measured need and no
 * more — a wider window lets one site's helper call vouch for an unguarded
 * neighbour.
 */
const LINES_BEFORE = 2;
const LINES_AFTER = 1;

/**
 * The own-throw check reads a WIDER window. Measured like the numbers above:
 * at all four sites the layout is `const <name> =` / `err instanceof
 * AssumeRoleFailure` / `? err.detail` / `: describeAwsFailureForWarn(...)` /
 * `logger.warn(` / the announcing line -- the `instanceof` sits exactly four
 * lines above the announcement, two above the helper-call window's reach.
 * The vouching concern that keeps `LINES_BEFORE` at 2 applies here too, but
 * asymmetrically: this check is a REQUIREMENT on the site, not permission to
 * relay, so a neighbour's branch leaking into the window can only excuse a
 * missing `instanceof` marker -- and only when two AssumeRole relays sit
 * within four lines of each other, which the per-file counts below would
 * surface as a new finding first.
 */
const OWN_THROW_LINES_BEFORE = 4;

/**
 * Issue #613 -- a named renderer's body must CLOSE within this many lines of
 * its definition or it is not a renderer. The canonical shape is a
 * one-expression function; a workflow function that happens to contain the
 * policy shape somewhere in a long body must not become a name that vouches.
 */
const RENDERER_BODY_MAX_LINES = 12;

interface Finding {
  file: string;
  line: number;
  /** The window with comments stripped — what `HELPER_CALL` is matched against. */
  code: string;
  /** The window verbatim — what `RAW_RELAY` is matched against. See below. */
  raw: string;
  /**
   * The `OWN_THROW_LINES_BEFORE` window, comments stripped — what the
   * own-throw branch check reads. Stripped like `code`, because for a
   * PRESENCE check stripping can only remove a mark, never invent one.
   */
  wideCode: string;
  /** Whether the DETECTION text announced `STS AssumeRole` (issue #613). */
  ownThrow: boolean;
}

/** A function name the helper check accepts as vouching for a site. */
interface NamedRenderer {
  name: string;
}

/**
 * Remove comment text so a comment cannot vouch for code.
 *
 * Both forms matter and the first draft only handled the first: a LEADING
 * `//` line, and a TRAILING `// ... describeAwsFailureForWarn(err, op)` on a
 * line of real code, which satisfied the helper check while the code beside it
 * relayed the message raw. Measured.
 *
 * The `//` strip is naive about a `//` inside a string literal — a URL in a
 * message truncates the line. An earlier draft called that "fail-CLOSED", which
 * was wrong and is worth spelling out, because the reasoning covered only half
 * the file: it IS fail-closed for `HELPER_CALL` (stripping can only remove a
 * call, never invent one), and fail-OPEN for `RAW_RELAY` (stripping can remove
 * a raw read that sat after the URL). A reviewer demonstrated the combination —
 * a helper call before the URL, a raw relay after it — passing both assertions.
 *
 * So the two checks read DIFFERENT text, which makes the claim true by
 * construction rather than by argument: `HELPER_CALL` gets the stripped window,
 * `RAW_RELAY` gets the verbatim one. The cost is that a COMMENT containing
 * something like `err.message` would trip the raw check; that is the
 * fail-closed direction, and the assertion names the line so it is a
 * ten-second fix.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const t = l.trimStart();
      if (t.startsWith('*') || t.startsWith('/*')) return '';
      return l.replace(/\/\/.*$/, '');
    })
    .join('\n');
}

function commandFiles(): string[] {
  return readdirSync(COMMANDS)
    .filter((f) => f.endsWith('.ts'))
    .sort();
}

function scanSource(text: string, file: string): Finding[] {
  const lines = text.split('\n');
  const found: Finding[] = [];
  for (const [i, line] of lines.entries()) {
    const bare = line.trimStart();
    // Prose cannot relay anything.
    if (bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*')) continue;
    // A site is announced by a line that opens a template naming STS; the
    // `failed` half may wrap onto the next one, so the DETECTION window looks
    // forward from here while the GUARD window also looks back (the two
    // ARN-quoting sites hoist their render into a `const reason` above).
    const ahead = lines.slice(i, i + LINES_AFTER + 1).join('\n');
    if (!/\bSTS\s+[A-Za-z$]/.test(line) || !STS_FAILURE_LINE.test(ahead)) continue;
    const window = lines.slice(Math.max(0, i - LINES_BEFORE), i + LINES_AFTER + 1).join('\n');
    const wide = lines
      .slice(Math.max(0, i - OWN_THROW_LINES_BEFORE), i + LINES_AFTER + 1)
      .join('\n');
    found.push({
      file,
      line: i + 1,
      code: stripComments(window),
      raw: window,
      wideCode: stripComments(wide),
      // Classified from the DETECTION text, not the guard window: the guard
      // window at a GetCallerIdentity site can legitimately contain the
      // string 'STS AssumeRole' inside a neighbouring helper-call argument.
      ownThrow: OWN_THROW_ANNOUNCE.test(ahead),
    });
  }
  return found;
}

function stsFailureRelays(file: string): Finding[] {
  return scanSource(readFileSync(join(COMMANDS, file), 'utf8'), file);
}

/**
 * A definition that CAN open a renderer: `function name(` or
 * `const name = (`-style arrow. `const name =` with the initializer on the
 * next line never matches (the `\(` must sit on the definition line), which
 * is what keeps the four sites' own `const reason =` hoists out of here.
 */
const RENDERER_DEF =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;

/**
 * Body = the definition line through the line where its braces re-balance,
 * or — for an expression-arrow that never opens a brace — through the line
 * ending in `;`. `undefined` when `RENDERER_BODY_MAX_LINES` is hit first: an
 * unmodelled or long shape is NOT a renderer (fail-closed). Brace counting is
 * naive about braces inside string literals, and that is fine for the same
 * reason: imbalance means no capture means no name to vouch with.
 */
function captureBody(lines: string[], start: number): string | undefined {
  let depth = 0;
  let opened = false;
  const taken: string[] = [];
  for (let i = start; i < Math.min(lines.length, start + RENDERER_BODY_MAX_LINES); i++) {
    const l = lines[i]!;
    taken.push(l);
    for (const ch of l) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (opened && depth <= 0) return taken.join('\n');
    if (!opened && /;\s*$/.test(l)) return taken.join('\n');
  }
  return undefined;
}

/**
 * The names allowed to vouch for a site (issue #613). Qualification is the
 * FULL policy shape, every condition load-bearing:
 *
 *   - a `describeAwsFailureForWarn` CALL — the body routes through the policy;
 *   - the own-throw branch (`instanceof AssumeRoleFailure` + `.detail`) — a
 *     bare-helper wrapper is the defective shape one indirection away, and
 *     recognizing it would re-open exactly the hole this issue closes;
 *   - no `.warn(` — a renderer RENDERS and returns; a function that warns is
 *     a SITE, and letting a site's name vouch elsewhere is the adjacency
 *     evasion in function form;
 *   - a body the bounded capture can model at all.
 */
function collectRenderersFromText(text: string): NamedRenderer[] {
  const lines = stripComments(text).split('\n');
  const out: NamedRenderer[] = [];
  for (const [i, line] of lines.entries()) {
    const m = RENDERER_DEF.exec(line);
    if (!m) continue;
    const name = m[1] ?? m[2]!;
    const body = captureBody(lines, i);
    if (body === undefined) continue;
    if (!HELPER_CALL.test(body)) continue;
    if (!OWN_THROW_GUARD.test(body) || !OWN_THROW_DETAIL.test(body)) continue;
    if (/\.warn\s*\(/.test(body)) continue;
    out.push({ name });
  }
  return out;
}

function callsRenderer(code: string, renderers: NamedRenderer[]): boolean {
  return renderers.some((r) =>
    new RegExp(`\\b${r.name.replace(/\$/g, '\\$')}\\s*\\(`).test(code)
  );
}

/** The issue #613 helper check: a direct call, or a named renderer's. */
function isHelperGuarded(f: Finding, renderers: NamedRenderer[]): boolean {
  return HELPER_CALL.test(f.code) || callsRenderer(f.code, renderers);
}

/** The issue #613 own-throw check, read from the wider window. */
function isOwnThrowGuarded(f: Finding, renderers: NamedRenderer[]): boolean {
  return (
    (OWN_THROW_GUARD.test(f.wideCode) && OWN_THROW_DETAIL.test(f.wideCode)) ||
    callsRenderer(f.wideCode, renderers)
  );
}

describe('#570 — a tenth STS relay site cannot be added unguarded', () => {
  const all = commandFiles().flatMap(stsFailureRelays);
  const renderers = commandFiles().flatMap((f) =>
    collectRenderersFromText(readFileSync(join(COMMANDS, f), 'utf8'))
  );

  it('finds the STS failure lines it is supposed to be guarding', () => {
    // Non-vacuity: if the regex ever stops matching (a reworded message, a
    // renamed file), every assertion below passes over an empty list. Both the
    // count AND the identity of the files carrying them are pinned, so a new
    // site in a file not previously carrying one fails here rather than
    // slipping past a hard-coded list.
    // ELEVEN since issue #579, which derived the population of catch-less SDK
    // sends rather than working the enumerated list: round 3 added
    // `local-run-task.ts`'s `resolvePlaceholderAccount` and round 4 its twin in
    // `ecs-service-emulator.ts` (deferred one round only because PR #610 held
    // that file). Both had no `catch` at all.
    //
    // This assertion FIRED on each of them as they were written — the
    // tenth-site property the file exists for, triggering on real new sites
    // rather than on hypothetical ones. It also caught a formatting detail on
    // the first: an inline render wrapped across three lines put the helper
    // call outside the guard window, and the fix was to hoist it into a `const`
    // rather than to widen the window.
    expect(all).toHaveLength(11);
    expect([...new Set(all.map((f) => f.file))].sort()).toEqual([
      'ecs-service-emulator.ts',
      'local-invoke-agentcore.ts',
      'local-invoke.ts',
      'local-run-task.ts',
      'local-start-api.ts',
    ]);
  });

  it('classifies exactly the four --assume-role relays as own-throw sites (issue #613)', () => {
    // The classifier's own non-vacuity, both ways: the `STS AssumeRole`
    // announcements are exactly the four ternary sites, and the seven
    // GetCallerIdentity relays are NOT asked for a branch they do not need
    // (nothing on their catch path throws AssumeRoleFailure).
    expect(
      all
        .filter((f) => f.ownThrow)
        .map((f) => f.file)
        .sort()
    ).toEqual([
      'local-invoke-agentcore.ts',
      'local-invoke-agentcore.ts',
      'local-invoke-agentcore.ts',
      'local-invoke.ts',
    ]);
  });

  it('recognizes no named renderer in the tree today', () => {
    // Pins the collector against silent over-collection: a name in this list
    // is a name `isHelperGuarded` accepts as vouching for a site, so an entry
    // must arrive DELIBERATELY (the issue #613 refactor would land an
    // `assumeRoleDetail` here by name), never as a side effect of an
    // unrelated function happening to match the shape.
    expect(renderers).toEqual([]);
  });

  it('routes every one of them through a describeAwsFailureForWarn CALL or a named renderer', () => {
    const unguarded = all.filter((f) => !isHelperGuarded(f, renderers));
    expect(
      unguarded.map((f) => `${f.file}:${f.line}`),
      'an STS failure warn that does not render its error through the shared policy'
    ).toEqual([]);
  });

  it('requires the own-throw branch at every site relaying a class cdk-local throws itself (issue #613)', () => {
    // At the four --assume-role sites the helper call ALONE is the DEFECTIVE
    // shape: re-rendering an `AssumeRoleFailure` through the policy WITHHOLDS
    // text the policy had already sanitized at throw time. Until this check
    // the fence blessed exactly that form — twice shipped in PR #611's review
    // rounds, both caught by per-occurrence literal assertions, never here.
    const missing = all.filter((f) => f.ownThrow && !isOwnThrowGuarded(f, renderers));
    expect(
      missing.map((f) => `${f.file}:${f.line}`),
      'an --assume-role relay missing the `err instanceof AssumeRoleFailure ? err.detail` branch'
    ).toEqual([]);
  });

  it('leaves none of them reading the raw error message', () => {
    const raw = all.filter((f) => RAW_RELAY.test(f.raw));
    expect(
      raw.map((f) => `${f.file}:${f.line}`),
      'an STS failure warn still reading err.message directly'
    ).toEqual([]);
  });

  it('proves the guard discriminates, on each evasion it closes', () => {
    // Without this, the assertions above are "no bad rows in a list I built"
    // and would pass just as well against a matcher that matches nothing.

    // (a) the shape a tenth site would have, inline.
    const inline = [
      '      logger.warn(',
      "        `--assume-role: STS AssumeRole(${arn}) failed: ${err instanceof Error ? err.message : String(err)}. ` +",
      "          'Falling back.'",
    ].join('\n');
    expect(STS_FAILURE_LINE.test(inline.split('\n')[1]!)).toBe(true);
    expect(HELPER_CALL.test(stripComments(inline))).toBe(false);
    expect(RAW_RELAY.test(stripComments(inline))).toBe(true);

    // (b) a comment naming the helper must NOT vouch for the code.
    const commentOnly = [
      '      // rendered via describeAwsFailureForWarn(err, ...)',
      "        `STS AssumeRole failed: ${(err as Error).message}`",
    ].join('\n');
    expect(HELPER_CALL.test(stripComments(commentOnly))).toBe(false);
    expect(RAW_RELAY.test(stripComments(commentOnly))).toBe(true);

    // (c) spellings earlier drafts' raw-relay regex missed, each from a probe.
    for (const spelling of [
      '`${error.message}`',
      '`${(err as any).message}`',
      '`${err?.message}`',
      '`${err!.message}`',
      '`${e.message}`',
      '`${(err as Error).name}`',
      '`${err.stack}`',
      '`${String(err)}`',
    ]) {
      expect(RAW_RELAY.test(spelling), `RAW_RELAY missed ${spelling}`).toBe(true);
    }

    // (d) a TRAILING comment naming the helper must not vouch for the code.
    const trailing =
      "        `STS AssumeRole failed: ${String(err)}`, // describeAwsFailureForWarn(err, 'x')";
    expect(HELPER_CALL.test(stripComments(trailing))).toBe(false);
    expect(RAW_RELAY.test(trailing)).toBe(true);

    // (d2) and the reverse: a `//` inside a STRING must not let the strip hide
    // a raw read that follows it. This is why `RAW_RELAY` reads the verbatim
    // window while `HELPER_CALL` reads the stripped one.
    const urlInString =
      '        `STS AssumeRole failed: ${describeAwsFailureForWarn(err, op)} (https://aws.amazon.com) raw=${err.message}`';
    expect(HELPER_CALL.test(stripComments(urlInString))).toBe(true);
    expect(RAW_RELAY.test(stripComments(urlInString))).toBe(false);
    expect(RAW_RELAY.test(urlInString), 'the verbatim window must still see it').toBe(true);

    // (e) a template wrapping across a `+` is still DETECTED.
    const wrapped = ['      `... STS AssumeRole(${arn}) ` +', '        `failed: ${err.message}`'].join(
      '\n'
    );
    expect(STS_FAILURE_LINE.test(wrapped)).toBe(true);

    // (f) and prose must NOT be: the `/i` draft matched `lists DNS...fail` in a
    // `--tls-cert` help string and reported an option definition as a relay.
    expect(
      STS_FAILURE_LINE.test('the cert lists DNS:localhost as SubjectAltName, will fail the check')
    ).toBe(false);

    // And the positive control: a genuine site is accepted.
    const guarded = "        `STS GetCallerIdentity failed: ${describeAwsFailureForWarn(err, 'x')}`";
    expect(STS_FAILURE_LINE.test(guarded)).toBe(true);
    expect(HELPER_CALL.test(stripComments(guarded))).toBe(true);
    expect(RAW_RELAY.test(stripComments(guarded))).toBe(false);
  });

  it('proves the issue #613 additions discriminate, in both directions', () => {
    // (g) the DEFECTIVE shape — the helper call WITHOUT the own-throw branch
    // at an AssumeRole announcement. This is the form the fence used to
    // bless, and the red-today assertion the issue names: `isHelperGuarded`
    // is satisfied (that is the old fence passing it) while
    // `isOwnThrowGuarded` rejects it.
    const defective = scanSource(
      [
        '      } catch (err) {',
        "        const reason = describeAwsFailureForWarn(err, 'STS AssumeRole');",
        '        logger.warn(',
        '          `--assume-role: STS AssumeRole(${arn}) failed: ${reason}. ` +',
        "            'Falling back.'",
        '        );',
        '      }',
      ].join('\n'),
      'x.ts'
    );
    expect(defective).toHaveLength(1);
    expect(defective[0]!.ownThrow).toBe(true);
    expect(isHelperGuarded(defective[0]!, [])).toBe(true);
    expect(isOwnThrowGuarded(defective[0]!, [])).toBe(false);

    // (h) the genuine inline ternary — the shape at all four real sites —
    // is accepted by BOTH halves.
    const genuine = scanSource(
      [
        '      } catch (err) {',
        '        const reason =',
        '          err instanceof AssumeRoleFailure',
        '            ? err.detail',
        "            : describeAwsFailureForWarn(err, 'STS AssumeRole');",
        '        logger.warn(',
        '          `--assume-role: STS AssumeRole(${arn}) failed: ${reason}. ` +',
        "            'Falling back.'",
        '        );',
        '      }',
      ].join('\n'),
      'x.ts'
    );
    expect(genuine).toHaveLength(1);
    expect(genuine[0]!.ownThrow).toBe(true);
    expect(isHelperGuarded(genuine[0]!, [])).toBe(true);
    expect(isOwnThrowGuarded(genuine[0]!, [])).toBe(true);

    // (i) a GetCallerIdentity relay is NOT classified own-throw — the branch
    // is required only where cdk-local's own class can arrive.
    const gci = scanSource(
      [
        "        const detail = describeAwsFailureForWarn(err, 'STS GetCallerIdentity');",
        '        logger.warn(',
        '          `STS GetCallerIdentity failed: ${detail}. Falling back.`',
        '        );',
      ].join('\n'),
      'x.ts'
    );
    expect(gci).toHaveLength(1);
    expect(gci[0]!.ownThrow).toBe(false);
    expect(isHelperGuarded(gci[0]!, [])).toBe(true);

    // (j) a NAMED RENDERER — the refactor the fence used to forbid — is
    // collected, and a site delegating to it passes both halves...
    const rendererSource = [
      'function assumeRoleDetail(err: unknown, op: string): string {',
      '  return err instanceof AssumeRoleFailure ? err.detail : describeAwsFailureForWarn(err, op);',
      '}',
    ].join('\n');
    const collected = collectRenderersFromText(rendererSource);
    expect(collected.map((r) => r.name)).toEqual(['assumeRoleDetail']);
    const delegating = scanSource(
      [
        "        const reason = assumeRoleDetail(err, 'STS AssumeRole');",
        '        logger.warn(',
        '          `--assume-role: STS AssumeRole(${arn}) failed: ${reason}. ` +',
        "            'Falling back.'",
        '        );',
      ].join('\n'),
      'x.ts'
    );
    expect(delegating).toHaveLength(1);
    expect(isHelperGuarded(delegating[0]!, collected)).toBe(true);
    expect(isOwnThrowGuarded(delegating[0]!, collected)).toBe(true);
    // ...and WITHOUT the definition in the tree the SAME site fails both —
    // an arbitrary neighbouring call cannot vouch (the tenth-site property).
    expect(isHelperGuarded(delegating[0]!, [])).toBe(false);
    expect(isOwnThrowGuarded(delegating[0]!, [])).toBe(false);

    // (k) deleting what the collector REQUIRES de-recognizes the renderer.
    // The body no longer routes through the policy:
    expect(
      collectRenderersFromText(
        [
          'function assumeRoleDetail(err: unknown, op: string): string {',
          '  return err instanceof AssumeRoleFailure ? err.detail : String(err);',
          '}',
        ].join('\n')
      )
    ).toEqual([]);
    // The own-throw branch is gone (the defective shape one indirection away):
    expect(
      collectRenderersFromText(
        [
          'function assumeRoleDetail(err: unknown, op: string): string {',
          '  return describeAwsFailureForWarn(err, op);',
          '}',
        ].join('\n')
      )
    ).toEqual([]);
    // A body that WARNS is a site, not a renderer:
    expect(
      collectRenderersFromText(
        [
          'function warnAssumeRoleFailure(err: unknown): void {',
          '  const d =',
          '    err instanceof AssumeRoleFailure ? err.detail : describeAwsFailureForWarn(err, "op");',
          '  logger.warn(`bad: ${d}`);',
          '}',
        ].join('\n')
      )
    ).toEqual([]);

    // (l) an expression-arrow renderer is modelled too.
    expect(
      collectRenderersFromText(
        [
          'const assumeRoleDetail = (err: unknown, op: string): string =>',
          '  err instanceof AssumeRoleFailure ? err.detail : describeAwsFailureForWarn(err, op);',
        ].join('\n')
      ).map((r) => r.name)
    ).toEqual(['assumeRoleDetail']);

    // (m) a body that does not close within the bound is NOT a renderer —
    // a long workflow function containing the shape somewhere must not
    // become a name that vouches; the unmodelled shape fails closed.
    expect(
      collectRenderersFromText(
        [
          'function bigWorkflow(err: unknown): string {',
          ...Array.from({ length: 12 }, () => '  something();'),
          '  return err instanceof AssumeRoleFailure ? err.detail : describeAwsFailureForWarn(err, "op");',
          '}',
        ].join('\n')
      )
    ).toEqual([]);

    // (n) a comment mentioning a renderer name does not vouch — the check
    // reads the STRIPPED window, same as the direct helper call.
    const commentVouch = scanSource(
      [
        "        // rendered via assumeRoleDetail(err, 'STS AssumeRole')",
        '        logger.warn(',
        '          `--assume-role: STS AssumeRole(${arn}) failed: ${String(err)}. ` +',
        "            'Falling back.'",
        '        );',
      ].join('\n'),
      'x.ts'
    );
    expect(commentVouch).toHaveLength(1);
    expect(isHelperGuarded(commentVouch[0]!, collected)).toBe(false);
    expect(isOwnThrowGuarded(commentVouch[0]!, collected)).toBe(false);
  });
});
