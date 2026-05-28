import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(() => false),
}));

import { isCancel, multiselect, select } from '@clack/prompts';
import {
  isInteractive,
  pickManyTargets,
  pickOneTarget,
  resolveMultiTarget,
  resolveSingleTarget,
} from '../../../src/local/target-picker.js';
import {
  CdkLocalError,
  InteractiveTtyRequiredError,
  TargetSelectionCancelledError,
} from '../../../src/utils/error-handler.js';
import type { TargetEntry } from '../../../src/local/target-lister.js';

const entries: TargetEntry[] = [
  { logicalId: 'A', stackName: 'S', qualifiedId: 'S:A', displayPath: 'S/A', kind: 'HTTP API v2' },
  { logicalId: 'B', stackName: 'S', qualifiedId: 'S:B' }, // no display path, no kind
];

let origStdin: boolean | undefined;
let origStdout: boolean | undefined;

function setTty(value: boolean): void {
  (process.stdin as { isTTY?: boolean }).isTTY = value;
  (process.stdout as { isTTY?: boolean }).isTTY = value;
}

beforeEach(() => {
  origStdin = process.stdin.isTTY;
  origStdout = process.stdout.isTTY;
  vi.clearAllMocks();
  vi.mocked(isCancel).mockReturnValue(false);
});

afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = origStdin;
  (process.stdout as { isTTY?: boolean }).isTTY = origStdout;
});

const onMissing = (): CdkLocalError => new CdkLocalError('target required', 'MISSING');

describe('isInteractive', () => {
  it('is true only when both stdin and stdout are TTYs', () => {
    setTty(true);
    expect(isInteractive()).toBe(true);
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    expect(isInteractive()).toBe(false);
    setTty(false);
    expect(isInteractive()).toBe(false);
  });
});

describe('pickOneTarget', () => {
  it('maps entries to options (display path label, surface-kind hint), appends a key hint, and returns the choice', async () => {
    vi.mocked(select).mockResolvedValue('S/A');
    const result = await pickOneTarget('Pick one', entries);
    expect(result).toBe('S/A');
    expect(select).toHaveBeenCalledWith({
      message: 'Pick one (up/down to move, enter to select)',
      options: [
        { value: 'S/A', label: 'S/A', hint: 'HTTP API v2' },
        { value: 'S:B', label: 'S:B' },
      ],
    });
  });

  it('throws TargetSelectionCancelledError when the prompt is cancelled', async () => {
    vi.mocked(select).mockResolvedValue(Symbol('cancel') as unknown as string);
    vi.mocked(isCancel).mockReturnValue(true);
    await expect(pickOneTarget('Pick one', entries)).rejects.toBeInstanceOf(
      TargetSelectionCancelledError
    );
  });
});

describe('pickManyTargets', () => {
  it('requires at least one selection and returns the chosen array', async () => {
    vi.mocked(multiselect).mockResolvedValue(['S/A', 'S:B']);
    const result = await pickManyTargets('Pick many', entries);
    expect(result).toEqual(['S/A', 'S:B']);
    expect(multiselect).toHaveBeenCalledWith({
      message: 'Pick many (space to select, enter to confirm)',
      options: [
        { value: 'S/A', label: 'S/A', hint: 'HTTP API v2' },
        { value: 'S:B', label: 'S:B' },
      ],
      required: true,
    });
  });

  it('pre-selects every row via initialValues when preselectAll is set (Enter = all)', async () => {
    vi.mocked(multiselect).mockResolvedValue(['S/A', 'S:B']);
    const result = await pickManyTargets('Pick many', entries, { preselectAll: true });
    expect(result).toEqual(['S/A', 'S:B']);
    expect(multiselect).toHaveBeenCalledWith({
      message: 'Pick many (space to select, enter to confirm)',
      options: [
        { value: 'S/A', label: 'S/A', hint: 'HTTP API v2' },
        { value: 'S:B', label: 'S:B' },
      ],
      required: true,
      initialValues: ['S/A', 'S:B'],
    });
  });

  it('omits initialValues when preselectAll is not set (no pre-selection)', async () => {
    vi.mocked(multiselect).mockResolvedValue(['S/A']);
    await pickManyTargets('Pick many', entries);
    const callArg = vi.mocked(multiselect).mock.calls[0]?.[0] as { initialValues?: unknown };
    expect(callArg.initialValues).toBeUndefined();
  });

  it('throws TargetSelectionCancelledError on cancel', async () => {
    vi.mocked(multiselect).mockResolvedValue(Symbol('cancel') as unknown as string[]);
    vi.mocked(isCancel).mockReturnValue(true);
    await expect(pickManyTargets('Pick many', entries)).rejects.toBeInstanceOf(
      TargetSelectionCancelledError
    );
  });
});

describe('resolveSingleTarget', () => {
  it('returns the provided target without prompting', async () => {
    setTty(true);
    const result = await resolveSingleTarget('Stack/Given', {
      entries,
      message: 'm',
      noun: 'Lambda functions',
      onMissing,
    });
    expect(result).toBe('Stack/Given');
    expect(select).not.toHaveBeenCalled();
  });

  it('returns the provided target without prompting even in a non-TTY', async () => {
    setTty(false);
    const result = await resolveSingleTarget('Stack/Given', {
      entries,
      message: 'm',
      noun: 'Lambda functions',
      onMissing,
    });
    expect(result).toBe('Stack/Given');
    expect(select).not.toHaveBeenCalled();
  });

  it('throws the command onMissing error when omitted in a non-TTY', async () => {
    setTty(false);
    await expect(
      resolveSingleTarget(undefined, {
        entries,
        message: 'm',
        noun: 'Lambda functions',
        onMissing,
      })
    ).rejects.toMatchObject({ code: 'MISSING' });
    expect(select).not.toHaveBeenCalled();
  });

  it('errors when there are no candidates to pick from (TTY, omitted)', async () => {
    setTty(true);
    await expect(
      resolveSingleTarget(undefined, {
        entries: [],
        message: 'm',
        noun: 'Lambda functions',
        onMissing,
      })
    ).rejects.toBeInstanceOf(InteractiveTtyRequiredError);
    expect(select).not.toHaveBeenCalled();
  });

  it('prompts when the target is omitted in a TTY', async () => {
    setTty(true);
    vi.mocked(select).mockResolvedValue('S:B');
    const result = await resolveSingleTarget(undefined, {
      entries,
      message: 'm',
      noun: 'Lambda functions',
      onMissing,
    });
    expect(result).toBe('S:B');
    expect(select).toHaveBeenCalledOnce();
  });
});

describe('resolveMultiTarget', () => {
  it('returns provided targets without prompting', async () => {
    setTty(true);
    const result = await resolveMultiTarget(['S/A', 'S:B'], {
      entries,
      message: 'm',
      noun: 'ECS services',
      onMissing,
    });
    expect(result).toEqual(['S/A', 'S:B']);
    expect(multiselect).not.toHaveBeenCalled();
  });

  it('multi-selects when omitted in a TTY', async () => {
    setTty(true);
    vi.mocked(multiselect).mockResolvedValue(['S/A']);
    const result = await resolveMultiTarget([], {
      entries,
      message: 'm',
      noun: 'ECS services',
      onMissing,
    });
    expect(result).toEqual(['S/A']);
    expect(multiselect).toHaveBeenCalledOnce();
  });

  it('throws the onMissing error when omitted in a non-TTY', async () => {
    setTty(false);
    await expect(
      resolveMultiTarget([], {
        entries,
        message: 'm',
        noun: 'ECS services',
        onMissing,
      })
    ).rejects.toMatchObject({ code: 'MISSING' });
  });
});
