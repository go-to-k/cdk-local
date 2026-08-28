import { describe, expect, it } from 'vite-plus/test';

import {
  IAM_ROLE_ARN_MAX_LENGTH,
  describeRejectedRoleArn,
  isIamRoleArn,
} from '../../../src/utils/role-arn.js';

/**
 * Issue #607: `isIamRoleArn` is the single authority for "is this a role
 * ARN?", asked of a user-supplied `--assume-role` AND of values that arrive
 * off a live `GetFunctionConfiguration` / `GetAgentRuntime` response or out of
 * deployed stack state — where the accepted value is not only printed but
 * SENT, as `AssumeRoleCommand.RoleArn`.
 *
 * Fenced as a CLASSIFIER rather than with hand-picked values: the accepted
 * population is a CROSS-PRODUCT of every partition against every account
 * spelling against every role-tail shape, and the assertions are opt-OUT — a
 * generated member is asserted ACCEPTED unless it is explicitly named in
 * {@link GENERATED_REJECTIONS}. An unimagined shape added to any dimension
 * therefore fails by default instead of quietly going untested.
 *
 * Control characters are spelled as escapes rather than as literal bytes, per
 * this repo's `no-control-bytes` fence — a raw one makes `grep` treat the file
 * as binary and silently suppress every match in it.
 */

/** Every partition an IAM role ARN can legitimately carry. */
const PARTITIONS = ['aws', 'aws-cn', 'aws-us-gov', 'aws-iso', 'aws-iso-b', 'aws-iso-e', 'aws-eusc'];

/**
 * Account-id spellings. Real ids are 12 digits; the short forms are here
 * because this repo's own fixtures use them (`arn:aws:iam::111:role/...`) and
 * the predicate is deliberately a SHAPE bound, not a schema validator — AWS
 * rejects a wrong account id far better than cdk-local can.
 */
const ACCOUNTS = ['123456789012', '111', '0'];

/**
 * Role-tail shapes, INCLUDING the path-shaped ones the issue calls out by
 * name. IAM's path grammar is printable-ASCII segments, so all of these are
 * legitimate and none may be rejected.
 */
const ROLE_TAILS = [
  'MyRole',
  'service-role/Foo',
  'aws-service-role/x.amazonaws.com/Bar',
  'cdk-hnb659fds-cfn-exec-role-123456789012-us-east-1',
  'My_Role+Tag=1,name.ext@example-x',
  'a',
];

/**
 * Generated members that must be REJECTED despite being in the cross-product.
 * Empty today — every partition x account x tail combination is legitimate —
 * and kept as the opt-out hook so a future dimension can carry a known-bad
 * member without loosening the default for everything else.
 */
const GENERATED_REJECTIONS = new Set<string>();

function generated(): string[] {
  const out: string[] = [];
  for (const partition of PARTITIONS) {
    for (const account of ACCOUNTS) {
      for (const tail of ROLE_TAILS) {
        out.push(`arn:${partition}:iam::${account}:role/${tail}`);
      }
    }
  }
  return out;
}

describe('isIamRoleArn — accepted population (cross-product, opt-out)', () => {
  const members = generated();

  it('generates the full cross-product (guards the guard)', () => {
    // The LITERAL count, not `PARTITIONS.length * ACCOUNTS.length *
    // ROLE_TAILS.length`. That product was the whole assertion in an earlier
    // revision and it is a tautology: it is computed from the same three
    // arrays the triple loop walks, so deleting a partition shrinks both sides
    // together and the check stays green over a silently narrower population —
    // which is exactly the failure an opt-out fence exists to prevent.
    // 7 partitions x 3 accounts x 6 tails.
    expect(members).toHaveLength(126);
    expect(PARTITIONS).toHaveLength(7);
    expect(ACCOUNTS).toHaveLength(3);
    expect(ROLE_TAILS).toHaveLength(6);
    expect(new Set(members).size).toBe(members.length);
  });

  it.each(members)('classifies %s', (value) => {
    expect(isIamRoleArn(value)).toBe(!GENERATED_REJECTIONS.has(value));
  });
});

/**
 * Explicit rejections, each with the reason it is rejected — so a future
 * loosening of the pattern has to delete a named case rather than silently
 * flip a boolean.
 */
const REJECTED: Array<[reason: string, value: string]> = [
  ['empty string', ''],
  ['a bare role name', 'MyRole'],
  ['no arn prefix at all', 'not-an-arn'],
  ['merely starts with arn: — the check this replaces', 'arn:anything-at-all'],
  ['merely starts with arn: and is long', `arn:${'x'.repeat(500)}`],
  ['a non-IAM service', 'arn:aws:lambda:us-east-1:123456789012:function:Fn'],
  ['an IAM ARN of the wrong resource type', 'arn:aws:iam::123456789012:user/foo'],
  ['an IAM ARN of the wrong resource type (policy)', 'arn:aws:iam::123456789012:policy/foo'],
  ['role prefix without a name', 'arn:aws:iam::123456789012:role/'],
  ['a region in the iam slot (IAM ARNs are global)', 'arn:aws:iam:us-east-1:123456789012:role/R'],
  ['a non-numeric account', 'arn:aws:iam::not-an-account:role/R'],
  ['a missing account', 'arn:aws:iam:::role/R'],
  ['leading whitespace', ' arn:aws:iam::123456789012:role/R'],
  ['trailing whitespace', 'arn:aws:iam::123456789012:role/R '],
  ['a space inside the role name', 'arn:aws:iam::123456789012:role/My Role'],
  ['a space inside the partition', 'arn:aw s:iam::123456789012:role/R'],
  // The forging vector the old unanchored pattern left open: a well-formed
  // prefix, then a newline, then anything at all onto the log line.
  ['an embedded newline and a forged second line', 'arn:aws:iam::1:role/R\nERROR: forged'],
  ['an embedded carriage return', 'arn:aws:iam::1:role/R\rERROR: forged'],
  ['a trailing NUL', 'arn:aws:iam::1:role/R\u0000'],
  ['a bidi override in the role name', 'arn:aws:iam::1:role/R\u202Eevil'],
  ['a non-ASCII role name', 'arn:aws:iam::1:role/R\u00F4le'],
  // Length: the half a cap at the log line could never reach, because the
  // same value is SENT to STS.
  [
    'one character over the ceiling',
    `arn:aws:iam::123456789012:role/${'A'.repeat(IAM_ROLE_ARN_MAX_LENGTH - 31 + 1)}`,
  ],
  ['far over the ceiling', `arn:aws:iam::123456789012:role/${'A'.repeat(100_000)}`],
];

describe('isIamRoleArn — rejected population', () => {
  it.each(REJECTED)('rejects %s', (_reason, value) => {
    expect(isIamRoleArn(value)).toBe(false);
  });

  it('accepts a value exactly AT the ceiling', () => {
    const prefix = 'arn:aws:iam::123456789012:role/';
    const atLimit = `${prefix}${'A'.repeat(IAM_ROLE_ARN_MAX_LENGTH - prefix.length)}`;
    expect(atLimit.length).toBe(IAM_ROLE_ARN_MAX_LENGTH);
    expect(isIamRoleArn(atLimit)).toBe(true);
  });

  it('uses the ceiling the receiving API documents', () => {
    // Not an invented number: STS `AssumeRole` documents `RoleArn` as
    // "Maximum length of 2048", and that is the field this value is sent in.
    expect(IAM_ROLE_ARN_MAX_LENGTH).toBe(2048);
  });
});

/** Non-string inputs — the predicate is called on `unknown` at every wire site. */
const NON_STRINGS: Array<[label: string, value: unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['a number', 42],
  ['a boolean', true],
  ['an object', {}],
  ['an array', ['arn:aws:iam::123456789012:role/R']],
  // eslint-disable-next-line no-new-wrappers
  ['a String object', new String('arn:aws:iam::123456789012:role/R')],
  ['a symbol', Symbol('arn:aws:iam::123456789012:role/R')],
  ['a function', () => 'arn:aws:iam::123456789012:role/R'],
  ['an object with a matching toString', { toString: () => 'arn:aws:iam::1:role/R' }],
  ['a null-prototype object', Object.create(null) as unknown],
];

describe('isIamRoleArn — non-string inputs', () => {
  it.each(NON_STRINGS)('rejects %s', (_label, value) => {
    expect(isIamRoleArn(value)).toBe(false);
  });
});

describe('isIamRoleArn — linearity', () => {
  // The pattern runs on values off the wire, so it must not backtrack
  // super-linearly. Every quantified class is disjoint from the literal that
  // follows it and the last one is anchored, so there is no such input — this
  // pins that rather than trusting the reading. The adversarial cases sit AT
  // the ceiling, since anything longer is rejected on length before the
  // pattern sees it at all.
  // Every fixture is <= IAM_ROLE_ARN_MAX_LENGTH, checked below. An earlier
  // revision had two at 2052 characters — `arn:` plus 2048 — which the length
  // bound rejects BEFORE the pattern runs, so those two measured the `if` and
  // not the regex, contradicting the comment above them. The point of this
  // case is the pattern, so the fixtures have to reach it.
  const ADVERSARIAL = [
    `arn:${'a'.repeat(IAM_ROLE_ARN_MAX_LENGTH - 4)}`,
    `arn:${'a-'.repeat((IAM_ROLE_ARN_MAX_LENGTH - 4) / 2)}`,
    `arn:aws:iam::${'1'.repeat(IAM_ROLE_ARN_MAX_LENGTH - 13)}`,
    `arn:aws:iam::1:role/${'/'.repeat(IAM_ROLE_ARN_MAX_LENGTH - 20)}`,
    'arn:aws:iam::1:role'.repeat(107),
  ];

  it('the adversarial fixtures actually REACH the pattern', () => {
    // Guards the guard: a fixture over the ceiling is rejected by the length
    // `if` and never exercises the regex at all.
    for (const value of ADVERSARIAL) {
      expect(value.length).toBeLessThanOrEqual(IAM_ROLE_ARN_MAX_LENGTH);
    }
  });

  it('classifies adversarial near-misses in linear time', () => {
    const started = Date.now();
    for (let i = 0; i < 200; i++) {
      for (const value of ADVERSARIAL) isIamRoleArn(value);
    }
    // A catastrophically-backtracking pattern does not finish this at all;
    // the bound is deliberately loose so a slow CI box cannot flake it.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('describeRejectedRoleArn', () => {
  it('shows a short rejected value verbatim, with its length', () => {
    expect(describeRejectedRoleArn('not-an-arn')).toBe('"not-an-arn" (10 characters)');
  });

  it('flattens control characters so a forged line cannot survive', () => {
    const described = describeRejectedRoleArn('arn:aws:iam::1:role/R\nERROR: forged');
    expect(described).not.toContain('\n');
    expect(described).toContain('ERROR: forged');
  });

  it('clamps an over-long value and names its true length', () => {
    const described = describeRejectedRoleArn('A'.repeat(5000));
    expect(described).toContain('(5000 characters)');
    expect(described.length).toBeLessThan(200);
    expect(described).toContain('...');
  });

  it('does not split a surrogate pair when clamping', () => {
    const described = describeRejectedRoleArn('\u{1F600}'.repeat(200));
    // An emoji IS a surrogate pair, so the assertion is about LONE surrogates:
    // a cut on UTF-16 units rather than code points would leave a high
    // surrogate with no low one after it (or the reverse).
    const LONE_SURROGATE =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(described).not.toMatch(LONE_SURROGATE);
    expect(described).toContain('(200 characters)');
  });

  it('the preview keeps the DISTINGUISHING tail of a realistic rejected ARN', () => {
    // The nit this pins: `arn:aws:iam::123456789012:role/` is 31 characters,
    // so a 64-char preview left only 33 for the part that actually identifies
    // the role. A CDK-generated name does not fit in 33, and a preview that
    // elides exactly the informative half is not a diagnosis. Unpinned, the
    // constant silently regresses — a mutation probe reverting 128 to 64 left
    // this whole file green before this case existed.
    const name = 'MyStack-HandlerServiceRole1234ABCD-a1b2c3d4e5f6';
    // Rejected for its TRAILING SPACE, so the preview is what the user reads
    // to see that there is one.
    const rejected = `arn:aws:iam::123456789012:role/${name} `;
    expect(isIamRoleArn(rejected)).toBe(false);
    const described = describeRejectedRoleArn(rejected);
    expect(described).toContain(name);
    expect(described).not.toContain('...');
    // Still comfortably inside the bound every caller's tests assert.
    expect(described.length).toBeLessThan(400);
  });

  it('describes a non-string without interpolating it', () => {
    expect(describeRejectedRoleArn(42)).toBe('a non-string number value');
    expect(describeRejectedRoleArn(undefined)).toBe('a non-string undefined value');
    expect(describeRejectedRoleArn(null)).toBe('a non-string object value');
  });
});


/**
 * DIFFERENTIAL against the predicate this one was extracted from.
 *
 * `src/cli/options.ts` on `origin/main` carried
 * `const IAM_ROLE_ARN_REGEX = /^arn:[^:]+:iam::\d+:role\//` and validated
 * `--assume-role` with it. Moving a predicate is only safe if it still answers
 * the same way for the inputs its callers already had, so the old literal is
 * reproduced here and the two are compared over every `--assume-role` spelling
 * the existing suite exercises (`tests/unit/cli/options.test.ts`) plus the
 * fixture ARNs the state-provider tests use.
 *
 * The `TIGHTENINGS` table below is a SAMPLE of the difference, not the whole
 * of it — an earlier revision described it as the complete set, which it never
 * was (a partition containing `.`, `/` or `_` is another whole class it does
 * not name). Enumerating every class is the wrong shape of assertion anyway,
 * because the enumeration can only ever be as complete as the imagination that
 * wrote it.
 *
 * The property that DOES hold universally is stronger and is asserted
 * directly: the new predicate is a strict SUBSET of the old one. No input
 * exists that the new one accepts and the old one rejected, so migrating to it
 * cannot LOOSEN `--assume-role` in any way, whatever the input. The sample
 * then only has to show the subset is proper.
 */
const OLD_OPTIONS_REGEX = /^arn:[^:]+:iam::\d+:role\//;

describe('isIamRoleArn - differential vs the extracted origin/main predicate', () => {
  const COVERED_SPELLINGS = [
    'arn:aws:iam::123456789012:role/MyRole',
    'arn:aws:iam::123456789012:role/OtherRole',
    'arn:aws-cn:iam::123456789012:role/CnRole',
    'not-an-arn',
    'arn:aws:iam::123456789012:user/foo',
    'arn:aws:iam::111:role/Stack-AssumableExecRole-AAA',
    'arn:aws:iam::111:role/Stack-AgentRuntimeExecRole-AAA',
  ];

  it.each(COVERED_SPELLINGS)('agrees with the old regex on %s', (value) => {
    expect(isIamRoleArn(value)).toBe(OLD_OPTIONS_REGEX.test(value));
  });

  const TIGHTENINGS: Array<[what: string, value: string]> = [
    ['a forged second line after a well-formed prefix', 'arn:aws:iam::1:role/R\nERROR: forged'],
    ['a trailing NUL', 'arn:aws:iam::1:role/R\u0000'],
    ['a role prefix with no name after it', 'arn:aws:iam::123456789012:role/'],
    ['a space inside the partition', 'arn:a b:iam::1:role/R'],
    ['an unbounded value', `arn:aws:iam::1:role/${'A'.repeat(100_000)}`],
  ];

  it.each(TIGHTENINGS)('deliberately tightens (sample): %s', (_what, value) => {
    expect(OLD_OPTIONS_REGEX.test(value)).toBe(true);
    expect(isIamRoleArn(value)).toBe(false);
  });

  it('is a strict SUBSET of the old predicate — no input is newly accepted', () => {
    // The universal half, and the one that matters for a migration: whatever
    // the input, `new => old`. If that holds, replacing the old predicate
    // cannot admit anything it refused, so no `--assume-role` value becomes
    // newly valid and no caller becomes newly reachable.
    //
    // Swept over every value this FILE names — both populations of the
    // classifier, the differential's own tables, the non-strings — plus a
    // generated sweep over each byte position, which is where an unimagined
    // class would live.
    const corpus: unknown[] = [
      ...generated(),
      ...REJECTED.map(([, v]) => v),
      ...COVERED_SPELLINGS,
      ...TIGHTENINGS.map(([, v]) => v),
      ...NON_STRINGS.map(([, v]) => v),
    ];
    // One value per byte, injected at each of the five structural positions,
    // so a character class that differs between the two patterns is found
    // rather than guessed at.
    for (let code = 0; code < 256; code++) {
      const c = String.fromCharCode(code);
      corpus.push(
        `arn:aw${c}s:iam::123456789012:role/R`,
        `arn:aws:iam::12${c}34:role/R`,
        `arn:aws:iam::123456789012:role/R${c}`,
        `arn:aws:iam::123456789012:role/${c}R`,
        `${c}arn:aws:iam::123456789012:role/R`
      );
    }
    expect(corpus.length).toBeGreaterThan(1400);
    const newlyAccepted = corpus.filter(
      (v) => isIamRoleArn(v) && !(typeof v === 'string' && OLD_OPTIONS_REGEX.test(v))
    );
    expect(newlyAccepted).toEqual([]);
    // Guard the guard: the subset must be PROPER, or the assertion above would
    // hold trivially for a predicate identical to the old one.
    const newlyRejected = corpus.filter(
      (v) => typeof v === 'string' && OLD_OPTIONS_REGEX.test(v) && !isIamRoleArn(v)
    );
    expect(newlyRejected.length).toBeGreaterThan(0);
  });
});
