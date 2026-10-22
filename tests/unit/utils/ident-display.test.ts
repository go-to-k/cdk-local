/**
 * go-to-k/cdk-local#761 — the identifier renderer, a port of the host's
 * `displayIdent` / `displayStackName` (go-to-k/cdkd `src/utils/display-safe.ts`).
 *
 * The cut-marker digests below are the HOST's own pinned values, copied from
 * its suite rather than recomputed here: the port is only worth having if a
 * value cdkd embeds from cdk-local renders byte-identically on both sides.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  UNRENDERABLE,
  displayIdent,
  displayStackName,
  displayToolOutput,
} from '../../../src/utils/ident-display.js';

describe('displayIdent', () => {
  it('is the identity on every legitimate identifier shape', () => {
    for (const v of [
      'MyBucketF68F3FF0',
      'AWS::S3::Bucket',
      'AWS::CloudFormation::Stack::MODULE',
      'Custom::my-thing_v2@x',
      'web',
      'my_container-1',
      'MyStage-Api',
      'MyStack/Api/Default/GET/Resource',
      'public.ecr.aws/lambda/nodejs:20',
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo@sha256:abc',
      'method.request.header.Authorization',
      'arn:aws:iam::123456789012:role/deploy+role,x=y',
    ]) {
      expect(displayIdent(v)).toBe(v);
    }
  });

  it("quotes a value carrying cdk-local's own quote, so it cannot close a clause", () => {
    expect(displayIdent("a' b")).toBe(`"a' b"`);
    expect(displayIdent("web'. Contained and healthy. '")).toBe(
      `"web'. Contained and healthy. '"`
    );
  });

  it('quotes a value that could plant an annotation, and escapes its own `"`', () => {
    expect(displayIdent('X (AWS::RDS::DBInstance) -- ok')).toBe('"X (AWS::RDS::DBInstance) -- ok"');
    expect(displayIdent('X" (Y) "Z')).toBe('"X\\" (Y) \\"Z"');
    expect(displayIdent('[web] forged')).toBe('"[web] forged"');
  });

  it('flattens control characters to a space and then quotes, so no line is forged', () => {
    expect(displayIdent('x\u001b[2K\rforged')).toBe('"x [2K forged"');
    expect(displayIdent('a\nWARN: b')).toBe('"a WARN: b"');
    expect(displayIdent('Vic​tim')).toBe('"Vic tim"');
  });

  it('quotes a value whose only change was trimmed padding (the identity half)', () => {
    for (const v of ['Prod ', ' Prod', '\tProd', 'Prod\u0000', '\u001bProd', 'Prod​']) {
      expect(displayIdent(v)).toBe('"Prod"');
    }
  });

  it('renders absent and nothing-left values as the placeholder', () => {
    expect(displayIdent('')).toBe(UNRENDERABLE);
    expect(displayIdent(undefined)).toBe(UNRENDERABLE);
    expect(displayIdent(null)).toBe(UNRENDERABLE);
    expect(displayIdent('​')).toBe(UNRENDERABLE);
    expect(UNRENDERABLE).toBe('<unrenderable>');
  });

  it('stringifies a non-string, and survives a throwing toString', () => {
    expect(displayIdent(42)).toBe('42');
    const boom = {
      toString: () => {
        throw new Error('boom');
      },
    };
    expect(displayIdent(boom)).toBe('"[object Object]"');
  });

  it('reads the value ONCE, so a value that changes between reads cannot go bare', () => {
    let n = 0;
    const flipFlop = { toString: () => (n++ === 0 ? 'Prod ' : 'Prod') };
    expect(displayIdent(flipFlop)).toBe('"Prod"');
    expect(n).toBe(1);
  });

  it("cuts past the cap with the host's marker and digest", () => {
    expect(IDENT_MAX_CODE_POINTS).toBe(255);
    const atCap = 'A'.repeat(255);
    expect(displayIdent(atCap)).toBe(atCap);
    expect(displayIdent('A'.repeat(300))).toBe(
      `${atCap} [cut: 45 more characters withheld, tail sha256:ac752ced452069c55c7567a0717b8761]`
    );
    expect(displayIdent('ABCDEFGH', { maxCodePoints: 3 })).toBe(
      'ABC [cut: 5 more characters withheld, tail sha256:b0114036cd9b98ee5bfe692b6beeb9fe]'
    );
  });

  it('floors the cap at 1 and takes the default for a non-finite one', () => {
    const one = 'A [cut: 7 more characters withheld, tail sha256:1766c972e1b52e28af81dfd043f44219]';
    expect(displayIdent('ABCDEFGH', { maxCodePoints: 0 })).toBe(one);
    expect(displayIdent('ABCDEFGH', { maxCodePoints: -5 })).toBe(one);
    expect(displayIdent('ABCDEFGH', { maxCodePoints: 0.5 })).toBe(one);
    expect(displayIdent('A'.repeat(258), { maxCodePoints: Number.POSITIVE_INFINITY })).toBe(
      `${'A'.repeat(255)} [cut: 3 more characters withheld, tail sha256:cb1ad2119d8fafb69566510ee712661f]`
    );
  });

  it('quotes AND cuts together, keeping the marker outside the quotes', () => {
    expect(displayIdent('X (us-east-1) '.repeat(30), { maxCodePoints: 20 })).toBe(
      '"X (us-east-1) X (us-" [cut: 399 more characters withheld, tail sha256:630cb481296e5a1e306045ab50eee812]'
    );
  });

  it('listMember makes a bare comma take the boundary', () => {
    expect(displayIdent('Prod,')).toBe('Prod,');
    expect(displayIdent('Prod,', { listMember: true })).toBe('"Prod,"');
    expect(displayIdent('Prod', { listMember: true })).toBe('Prod');
  });
});

describe('the cut marker names the withheld tail (host go-to-k/cdkd#4002)', () => {
  // An independent spelling of the marker, so the cases below do not trust
  // the implementation under test to compute their own expectation.
  const marker = (tail: string): string =>
    `[cut: ${tail.length} more characters withheld, tail sha256:${createHash('sha256').update(tail).digest('hex').slice(0, 32)}]`;

  it('renders two cut values sharing the kept prefix AND the length apart', () => {
    const prefix = 'P'.repeat(IDENT_MAX_CODE_POINTS);
    const a = displayIdent(`${prefix}${'a'.repeat(20)}`);
    const b = displayIdent(`${prefix}${'a'.repeat(19)}b`);
    expect(a).toBe(`${prefix} ${marker('a'.repeat(20))}`);
    expect(b).toBe(`${prefix} ${marker(`${'a'.repeat(19)}b`)}`);
    expect(a).not.toBe(b);
  });

  it('keeps a value forged to END in a cut marker from rendering as itself', () => {
    const prefix = 'a'.repeat(IDENT_MAX_CODE_POINTS);
    const tail = ` ${marker('x'.repeat(70))}`;
    const forged = `${prefix}${tail}`;
    expect(displayIdent(forged)).not.toBe(forged);
    expect(displayIdent(forged)).toBe(`${prefix} ${marker(tail)}`);
  });

  it('renders a throwing Symbol.toStringTag as the quoted sentinel, not as absent', () => {
    const doubleBoom = {
      toString: null,
      get [Symbol.toStringTag]() {
        throw new Error('boom from the tag');
      },
    };
    expect(displayIdent(doubleBoom)).toBe(`"${UNRENDERABLE}"`);
  });
});

describe('displayStackName', () => {
  it('uses the stack-ref cap, so a long construct path is not cut at 255', () => {
    expect(STACK_REF_MAX_CODE_POINTS).toBe(1152);
    const path = `MyStack/${'Nested'.repeat(60)}/Resource`;
    expect(path.length).toBeGreaterThan(255);
    expect(displayStackName(path)).toBe(path);
    // `printf A | shasum -a 256`, first 32 hex characters.
    expect(displayStackName('A'.repeat(1153))).toBe(
      `${'A'.repeat(1152)} [cut: 1 more characters withheld, tail sha256:559aead08264d5795d3909718cdd05ab]`
    );
  });

  it('quotes a forging stack name exactly like displayIdent', () => {
    expect(displayStackName("Prod' (us-east-1)")).toBe(`"Prod' (us-east-1)"`);
  });
});

describe('displayToolOutput', () => {
  it('keeps line breaks and tabs, so multi-line output stays multi-line', () => {
    expect(displayToolOutput('step 1/3\n\tRUN npm ci\nerror: x')).toBe(
      'step 1/3\n\tRUN npm ci\nerror: x'
    );
  });

  it('escapes CR, ESC, DEL, C1, the line separators and the bidi controls', () => {
    expect(displayToolOutput('a\r\u001b[2Kb')).toBe('a\\u000d\\u001b[2Kb');
    expect(displayToolOutput('\u007f\u0085\u009b')).toBe('\\u007f\\u0085\\u009b');
    expect(displayToolOutput('  ‮⁦')).toBe('\\u2028\\u2029\\u202e\\u2066');
    expect(displayToolOutput('\u0000\u000b\u000c')).toBe('\\u0000\\u000b\\u000c');
  });

  it('leaves printable text, quotes and non-ASCII letters alone', () => {
    expect(displayToolOutput(`it's "fine" — café`)).toBe(`it's "fine" — café`);
  });
});
