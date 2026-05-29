import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

interface MsInstance {
  opts: {
    options: { value: string; label: string; hint?: string }[];
    initialValues?: string[];
    required?: boolean;
    render: () => string;
  };
  options: { value: string }[];
  value: string[];
  state: string;
  cursor: number;
  handlers: Record<string, (key: string | undefined, info: { name: string }) => void>;
}

const { msState } = vi.hoisted(() => ({
  // `results` is a queue: each `prompt()` call shifts the next picker result,
  // so a confirm-decline loop can be driven across iterations. Throwing when
  // it is empty turns an accidental infinite loop into a clear test failure.
  msState: { instances: [] as MsInstance[], results: [] as unknown[] },
}));

// `pickManyTargets` builds a custom prompt on `@clack/core`'s
// `MultiSelectPrompt`; mock it so we can assert the constructed options /
// initialValues, drive the Right/Left key handlers, and smoke the render.
vi.mock('@clack/core', () => ({
  MultiSelectPrompt: class {
    opts: MsInstance['opts'];
    options: { value: string }[];
    value: string[];
    state = 'active';
    cursor = 0;
    handlers: MsInstance['handlers'] = {};
    constructor(opts: MsInstance['opts']) {
      this.opts = opts;
      this.options = opts.options;
      this.value = opts.initialValues ?? [];
      msState.instances.push(this as unknown as MsInstance);
    }
    on(event: string, cb: (key: string | undefined, info: { name: string }) => void): void {
      this.handlers[event] = cb;
    }
    prompt(): Promise<unknown> {
      if (msState.results.length === 0) {
        throw new Error('mock MultiSelectPrompt: no queued result (would infinite-loop)');
      }
      return Promise.resolve(msState.results.shift());
    }
  },
}));

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  S_BAR: '|',
  S_BAR_START: 'T',
  S_BAR_END: 'L',
  S_CHECKBOX_ACTIVE: '>',
  S_CHECKBOX_INACTIVE: 'o',
  S_CHECKBOX_SELECTED: 'x',
}));

import { confirm, isCancel, select } from '@clack/prompts';
import {
  bulkSelectValues,
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
  vi.mocked(confirm).mockResolvedValue(true);
  msState.instances = [];
  msState.results = [];
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

describe('bulkSelectValues', () => {
  it('returns every option value for "all" and an empty array for "none"', () => {
    const opts = [{ value: 'a' }, { value: 'b' }] as { value: string }[];
    expect(bulkSelectValues(opts as never, 'all')).toEqual(['a', 'b']);
    expect(bulkSelectValues(opts as never, 'none')).toEqual([]);
  });
});

function confirmMessage(call: number): string {
  return (vi.mocked(confirm).mock.calls[call]![0] as { message: string }).message;
}

describe('pickManyTargets', () => {
  it('builds an unselected, optional prompt and returns the confirmed selection', async () => {
    msState.results = [['S/A', 'S:B']];
    const result = await pickManyTargets('Pick many', entries);
    expect(result).toEqual(['S/A', 'S:B']);
    const inst = msState.instances.at(-1)!;
    expect(inst.opts.options).toEqual([
      { value: 'S/A', label: 'S/A', hint: 'HTTP API v2' },
      { value: 'S:B', label: 'S:B' },
    ]);
    // Rows start unselected (no initialValues) and an empty submit is allowed
    // (required: false) so it can be treated as "exit".
    expect(inst.opts.required).toBe(false);
    expect(inst.opts.initialValues).toBeUndefined();
    expect(inst.value).toEqual([]);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('lists the selected targets in the confirmation message', async () => {
    msState.results = [['S/A', 'S:B']];
    await pickManyTargets('Pick many', entries);
    const msg = confirmMessage(0);
    expect(msg).toContain('• [HTTP API v2] S/A');
    expect(msg).toContain('• S:B');
  });

  it('asks to confirm exit when nothing is selected; Yes exits (throws)', async () => {
    msState.results = [[]];
    await expect(pickManyTargets('Pick many', entries)).rejects.toBeInstanceOf(
      TargetSelectionCancelledError
    );
    expect(confirmMessage(0)).toMatch(/nothing selected/i);
  });

  it('returns to the picker when the empty-exit confirm is declined', async () => {
    msState.results = [[], ['S/A']]; // empty -> "exit?" no -> loop -> pick S/A
    vi.mocked(confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = await pickManyTargets('Pick many', entries);
    expect(result).toEqual(['S/A']);
    expect(msState.instances).toHaveLength(2);
  });

  it('returns to the picker (selection preserved) when the run confirm is declined', async () => {
    msState.results = [['S/A'], ['S/A', 'S:B']];
    vi.mocked(confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = await pickManyTargets('Pick many', entries);
    expect(result).toEqual(['S/A', 'S:B']);
    expect(msState.instances).toHaveLength(2);
    expect(msState.instances[1]!.opts.initialValues).toEqual(['S/A']);
  });

  it('Right selects all and Left clears, pinning the cursor to the top', async () => {
    msState.results = [['S/A']];
    await pickManyTargets('Pick many', entries);
    const inst = msState.instances.at(-1)!;
    inst.value = [];
    inst.cursor = 2;
    inst.handlers.key?.(undefined, { name: 'right' });
    expect(inst.value).toEqual(['S/A', 'S:B']);
    expect(inst.cursor).toBe(0); // bulk op resets the cursor (arrows also move it)
    inst.cursor = 2;
    inst.handlers.key?.(undefined, { name: 'left' });
    expect(inst.value).toEqual([]);
    expect(inst.cursor).toBe(0);
  });

  it('leaves the selection and cursor unchanged on other keys', async () => {
    msState.results = [['S/A']];
    await pickManyTargets('Pick many', entries);
    const inst = msState.instances.at(-1)!;
    inst.value = ['S/A'];
    inst.cursor = 2;
    inst.handlers.key?.(undefined, { name: 'down' });
    expect(inst.value).toEqual(['S/A']);
    expect(inst.cursor).toBe(2);
  });

  it('render returns a string in the active and submit states (smoke)', async () => {
    msState.results = [['S/A']];
    await pickManyTargets('Pick many', entries);
    const inst = msState.instances.at(-1)!;
    expect(typeof inst.opts.render.call(inst)).toBe('string');
    inst.state = 'submit';
    expect(typeof inst.opts.render.call(inst)).toBe('string');
  });

  it('throws TargetSelectionCancelledError on cancel', async () => {
    msState.results = [Symbol('cancel')];
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
    expect(msState.instances).toHaveLength(0);
  });

  it('multi-selects when omitted in a TTY', async () => {
    setTty(true);
    msState.results = [['S/A']];
    const result = await resolveMultiTarget([], {
      entries,
      message: 'm',
      noun: 'ECS services',
      onMissing,
    });
    expect(result).toEqual(['S/A']);
    expect(msState.instances).toHaveLength(1);
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
