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
  msState: { instances: [] as MsInstance[], result: undefined as unknown },
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
      return Promise.resolve(msState.result);
    }
  },
}));

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  S_BAR: '|',
  S_BAR_START: 'T',
  S_BAR_END: 'L',
  S_CHECKBOX_ACTIVE: '>',
  S_CHECKBOX_INACTIVE: 'o',
  S_CHECKBOX_SELECTED: 'x',
}));

import { isCancel, select } from '@clack/prompts';
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
  msState.instances = [];
  msState.result = undefined;
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

describe('pickManyTargets', () => {
  it('builds the prompt with kind-hinted options and returns the chosen array', async () => {
    msState.result = ['S/A', 'S:B'];
    const result = await pickManyTargets('Pick many', entries);
    expect(result).toEqual(['S/A', 'S:B']);
    const inst = msState.instances.at(-1)!;
    expect(inst.opts.options).toEqual([
      { value: 'S/A', label: 'S/A', hint: 'HTTP API v2' },
      { value: 'S:B', label: 'S:B' },
    ]);
    expect(inst.opts.required).toBe(true);
    expect(inst.opts.initialValues).toBeUndefined();
  });

  it('pre-selects every row via initialValues when preselectAll is set (Enter = all)', async () => {
    msState.result = ['S/A', 'S:B'];
    await pickManyTargets('Pick many', entries, { preselectAll: true });
    const inst = msState.instances.at(-1)!;
    expect(inst.opts.initialValues).toEqual(['S/A', 'S:B']);
  });

  it('Right selects all and Left clears, via the key handler', async () => {
    msState.result = ['S/A'];
    await pickManyTargets('Pick many', entries);
    const inst = msState.instances.at(-1)!;
    inst.value = [];
    inst.handlers.key?.(undefined, { name: 'right' });
    expect(inst.value).toEqual(['S/A', 'S:B']);
    inst.handlers.key?.(undefined, { name: 'left' });
    expect(inst.value).toEqual([]);
  });

  it('leaves the selection unchanged on other keys', async () => {
    msState.result = ['S/A'];
    await pickManyTargets('Pick many', entries);
    const inst = msState.instances.at(-1)!;
    inst.value = ['S/A'];
    inst.handlers.key?.(undefined, { name: 'down' });
    expect(inst.value).toEqual(['S/A']);
  });

  it('render returns a string in the active and submit states (smoke)', async () => {
    msState.result = ['S/A'];
    await pickManyTargets('Pick many', entries);
    const inst = msState.instances.at(-1)!;
    expect(typeof inst.opts.render.call(inst)).toBe('string');
    inst.state = 'submit';
    expect(typeof inst.opts.render.call(inst)).toBe('string');
  });

  it('throws TargetSelectionCancelledError on cancel', async () => {
    msState.result = Symbol('cancel');
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
    msState.result = ['S/A'];
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
