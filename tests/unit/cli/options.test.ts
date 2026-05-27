import { describe, it, expect, vi } from 'vite-plus/test';

import {
  parseContextOptions,
  parseAssumeRoleToken,
  effectiveAssumeRoleArn,
  warnIfDeprecatedRegion,
  type AssumeRoleOption,
} from '../../../src/cli/options.js';

const VALID_ARN = 'arn:aws:iam::123456789012:role/MyRole';
const VALID_ARN_2 = 'arn:aws:iam::123456789012:role/OtherRole';

describe('parseContextOptions', () => {
  it('returns an empty record when input is undefined', () => {
    expect(parseContextOptions()).toEqual({});
  });

  it('returns an empty record when input is empty', () => {
    expect(parseContextOptions([])).toEqual({});
  });

  it('parses a single key=value pair', () => {
    expect(parseContextOptions(['env=prod'])).toEqual({ env: 'prod' });
  });

  it('parses multiple key=value pairs', () => {
    expect(parseContextOptions(['k1=v1', 'k2=v2'])).toEqual({ k1: 'v1', k2: 'v2' });
  });

  it('treats only the first = as the delimiter (preserves further = in value)', () => {
    expect(parseContextOptions(['key=a=b=c'])).toEqual({ key: 'a=b=c' });
  });

  it('skips entries with no =', () => {
    expect(parseContextOptions(['key=val', 'noequals'])).toEqual({ key: 'val' });
  });

  it('skips entries where = is at index 0 (empty key, eqIndex > 0 guard)', () => {
    expect(parseContextOptions(['=value', 'k=v'])).toEqual({ k: 'v' });
  });

  it('preserves an empty value (trailing =)', () => {
    expect(parseContextOptions(['k='])).toEqual({ k: '' });
  });

  it('last duplicate key wins', () => {
    expect(parseContextOptions(['k=v1', 'k=v2'])).toEqual({ k: 'v2' });
  });
});

describe('parseAssumeRoleToken', () => {
  describe('bare ARN', () => {
    it('sets globalArn when previous is undefined', () => {
      const result = parseAssumeRoleToken(VALID_ARN, undefined);
      expect(result).toEqual({ globalArn: VALID_ARN, perLambda: {} });
    });

    it('overwrites previous globalArn (last bare token wins)', () => {
      const acc = parseAssumeRoleToken(VALID_ARN, undefined);
      const next = parseAssumeRoleToken(VALID_ARN_2, acc);
      expect(next.globalArn).toBe(VALID_ARN_2);
    });

    it('throws on non-ARN string', () => {
      expect(() => parseAssumeRoleToken('not-an-arn', undefined)).toThrow(
        /Invalid --assume-role/
      );
    });

    it('throws on ARN whose resource type is not role/', () => {
      expect(() =>
        parseAssumeRoleToken('arn:aws:iam::123456789012:user/foo', undefined)
      ).toThrow(/Invalid --assume-role/);
    });

    it('accepts gov-cloud / china partition (regex matches arn:<partition>)', () => {
      const arn = 'arn:aws-cn:iam::123456789012:role/CnRole';
      const result = parseAssumeRoleToken(arn, undefined);
      expect(result.globalArn).toBe(arn);
    });
  });

  describe('LogicalId=arn form', () => {
    it('sets perLambda[id] = arn', () => {
      const result = parseAssumeRoleToken(`MyFn=${VALID_ARN}`, undefined);
      expect(result).toEqual({ perLambda: { MyFn: VALID_ARN } });
    });

    it('accumulates per-Lambda entries across calls', () => {
      const acc = parseAssumeRoleToken(`MyFn=${VALID_ARN}`, undefined);
      const next = parseAssumeRoleToken(`OtherFn=${VALID_ARN_2}`, acc);
      expect(next.perLambda).toEqual({ MyFn: VALID_ARN, OtherFn: VALID_ARN_2 });
    });

    it('trims whitespace around logicalId and arn', () => {
      const result = parseAssumeRoleToken(`  MyFn  =  ${VALID_ARN}  `, undefined);
      expect(result.perLambda.MyFn).toBe(VALID_ARN);
    });

    it('throws when logicalId contains a non-alphanumeric character', () => {
      expect(() => parseAssumeRoleToken(`my-fn=${VALID_ARN}`, undefined)).toThrow(
        /left-hand side/
      );
    });

    it('throws when logicalId starts with a digit', () => {
      expect(() => parseAssumeRoleToken(`1Fn=${VALID_ARN}`, undefined)).toThrow(
        /left-hand side/
      );
    });

    it('throws when arn portion is invalid', () => {
      expect(() => parseAssumeRoleToken('MyFn=not-an-arn', undefined)).toThrow(
        /right-hand side/
      );
    });

    it('overwrites a prior perLambda entry for the same logicalId', () => {
      const acc = parseAssumeRoleToken(`MyFn=${VALID_ARN}`, undefined);
      const next = parseAssumeRoleToken(`MyFn=${VALID_ARN_2}`, acc);
      expect(next.perLambda.MyFn).toBe(VALID_ARN_2);
    });
  });

  describe('mixed bare + per-Lambda accumulation', () => {
    it('keeps perLambda entries when a later bare arn updates global', () => {
      const acc = parseAssumeRoleToken(`MyFn=${VALID_ARN}`, undefined);
      const next = parseAssumeRoleToken(VALID_ARN_2, acc);
      expect(next).toEqual({
        globalArn: VALID_ARN_2,
        perLambda: { MyFn: VALID_ARN },
      });
    });

    it('initializes perLambda when previous.perLambda is missing (defensive)', () => {
      const accWithoutPerLambda = { globalArn: VALID_ARN } as AssumeRoleOption;
      const next = parseAssumeRoleToken(`MyFn=${VALID_ARN_2}`, accWithoutPerLambda);
      expect(next.perLambda).toEqual({ MyFn: VALID_ARN_2 });
    });
  });
});

describe('effectiveAssumeRoleArn', () => {
  it('returns undefined when opt is undefined', () => {
    expect(effectiveAssumeRoleArn('MyFn', undefined)).toBeUndefined();
  });

  it('returns perLambda value when logicalId hits', () => {
    const opt: AssumeRoleOption = {
      globalArn: VALID_ARN_2,
      perLambda: { MyFn: VALID_ARN },
    };
    expect(effectiveAssumeRoleArn('MyFn', opt)).toBe(VALID_ARN);
  });

  it('falls back to globalArn when perLambda misses', () => {
    const opt: AssumeRoleOption = {
      globalArn: VALID_ARN_2,
      perLambda: { MyFn: VALID_ARN },
    };
    expect(effectiveAssumeRoleArn('Other', opt)).toBe(VALID_ARN_2);
  });

  it('returns undefined when perLambda misses and no globalArn', () => {
    const opt: AssumeRoleOption = { perLambda: {} };
    expect(effectiveAssumeRoleArn('MyFn', opt)).toBeUndefined();
  });

  it('returns undefined when both perLambda and globalArn are absent', () => {
    const opt = {} as AssumeRoleOption;
    expect(effectiveAssumeRoleArn('MyFn', opt)).toBeUndefined();
  });
});

describe('warnIfDeprecatedRegion', () => {
  it('does not write to stderr when region is undefined', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfDeprecatedRegion({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('writes a deprecation warning to stderr when region is provided', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfDeprecatedRegion({ region: 'us-east-1' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/deprecated/);
    spy.mockRestore();
  });

  it('warns even when region is empty string (strict !== undefined check)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnIfDeprecatedRegion({ region: '' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
