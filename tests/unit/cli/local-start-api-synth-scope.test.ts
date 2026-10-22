import { describe, expect, it } from 'vite-plus/test';
import {
  deriveSynthStackPrefix,
  shouldPromptBareMultiSelect,
  shouldSynthAllStacks,
  targetStackHint,
} from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

describe('shouldPromptBareMultiSelect (bare picker decision)', () => {
  it('prompts when bare (no filters), not --all-stacks, in a TTY', () => {
    expect(shouldPromptBareMultiSelect([], false, true)).toBe(true);
    expect(shouldPromptBareMultiSelect([], undefined, true)).toBe(true);
  });

  it('does NOT prompt in a non-TTY (CI / pipe serves all without asking)', () => {
    expect(shouldPromptBareMultiSelect([], false, false)).toBe(false);
  });

  it('does NOT prompt when an explicit target subset was named', () => {
    expect(shouldPromptBareMultiSelect(['MyStack/MyApi'], false, true)).toBe(false);
  });

  it('does NOT prompt when --all-stacks was passed (that path serves every API)', () => {
    expect(shouldPromptBareMultiSelect([], true, true)).toBe(false);
  });
});

function stack(stackName: string, displayName = stackName): StackInfo {
  return { stackName, displayName, template: { Resources: {} } } as unknown as StackInfo;
}

const MY = stack('MyStack');
const WEB = stack('WebStack');
const ADMIN = stack('AdminStack');
// A top-level stack plus a nested Stage: `Outer/Inner/Api` must win over a
// top-level stack whose display path is `Outer`.
const OUTER = stack('Outer');
const STAGE_API = stack('Outer-Inner-Api', 'Outer/Inner/Api');
const STAGE_API_V2 = stack('Outer-Inner-ApiV2', 'Outer/Inner/ApiV2');
const STACKS = [MY, WEB, ADMIN, OUTER, STAGE_API, STAGE_API_V2];

describe('deriveSynthStackPrefix (multi-target synth-scope optimization)', () => {
  it('returns undefined for the empty (serve-all) target list', () => {
    expect(deriveSynthStackPrefix([], STACKS)).toBeUndefined();
  });

  it('returns the single stack for one Construct-path target', () => {
    expect(deriveSynthStackPrefix(['MyStack/MyApi'], STACKS)).toBe(MY);
  });

  it('returns the shared stack when every target lives in the same stack', () => {
    expect(deriveSynthStackPrefix(['MyStack/MyApi', 'MyStack/OtherApi'], STACKS)).toBe(MY);
  });

  it('returns undefined when targets span different stacks (synth all)', () => {
    expect(
      deriveSynthStackPrefix(['WebStack/MyApi', 'AdminStack/AdminApi'], STACKS)
    ).toBeUndefined();
  });

  it('returns undefined when any target is a bare logical id (cannot infer a stack)', () => {
    expect(deriveSynthStackPrefix(['MyApi'], STACKS)).toBeUndefined();
    expect(deriveSynthStackPrefix(['MyStack/MyApi', 'BareId'], STACKS)).toBeUndefined();
  });

  it("picks a Stage stack by its LONGEST display-path prefix, not the Stage id (#746)", () => {
    expect(deriveSynthStackPrefix(['Outer/Inner/Api/HttpApi'], STACKS)).toBe(STAGE_API);
    // The trailing `/` keeps `Outer/Inner/Api` from claiming `Outer/Inner/ApiV2/...`.
    expect(deriveSynthStackPrefix(['Outer/Inner/ApiV2/HttpApi'], STACKS)).toBe(STAGE_API_V2);
    // A top-level `Outer` stack is still reachable by its own path.
    expect(deriveSynthStackPrefix(['Outer/Fn'], STACKS)).toBe(OUTER);
  });

  it('treats two Stage stacks of one Stage as DIFFERENT stacks', () => {
    expect(
      deriveSynthStackPrefix(['Outer/Inner/Api/A', 'Outer/Inner/ApiV2/B'], STACKS)
    ).toBeUndefined();
  });

  it('falls back to the first segment as a pattern when no stack path prefixes it', () => {
    expect(deriveSynthStackPrefix(['My*/MyApi'], STACKS)).toBe('My*');
  });
});

describe('targetStackHint', () => {
  it('returns undefined for a target with no `/`', () => {
    expect(targetStackHint('BareId', STACKS)).toBeUndefined();
  });

  it('returns the stack whose display path prefixes the target', () => {
    expect(targetStackHint('Outer/Inner/Api/Fn', STACKS)).toBe(STAGE_API);
  });

  it('returns the stack ITSELF when two stacks share a physical name', () => {
    // One Stage deployed to two accounts under one explicit stackName: a
    // name would re-match both, the stack object selects exactly one.
    const beta = stack('Shared', 'Beta/Api');
    const prod = stack('Shared', 'Prod/Api');
    expect(targetStackHint('Prod/Api/Fn', [beta, prod])).toBe(prod);
  });
});

describe('shouldSynthAllStacks (item 5: multi-stack synth fallback)', () => {
  it('is false when there are no targets (serve-all synths everything via the regular path)', () => {
    expect(shouldSynthAllStacks([], undefined, undefined, STACKS)).toBe(false);
  });

  it('is false when a single target pins one stack via its Construct-path prefix', () => {
    expect(shouldSynthAllStacks(['MyStack/MyApi'], undefined, undefined, STACKS)).toBe(false);
  });

  it('is false when multiple targets all share one stack prefix', () => {
    expect(shouldSynthAllStacks(['MyStack/A', 'MyStack/B'], undefined, undefined, STACKS)).toBe(
      false
    );
  });

  it('is true when targets span different stacks and no other selector pins one', () => {
    expect(
      shouldSynthAllStacks(['WebStack/A', 'AdminStack/B'], undefined, undefined, STACKS)
    ).toBe(true);
  });

  it('is true when a bare-logical-id target leaves the synth stack unresolved', () => {
    expect(shouldSynthAllStacks(['BareId'], undefined, undefined, STACKS)).toBe(true);
  });

  it('is false when --stack explicitly pins the synth stack (overrides target inference)', () => {
    expect(
      shouldSynthAllStacks(['WebStack/A', 'AdminStack/B'], 'WebStack', undefined, STACKS)
    ).toBe(false);
  });

  it('is false when an explicit --from-cfn-stack <name> pins the synth stack', () => {
    expect(
      shouldSynthAllStacks(['WebStack/A', 'AdminStack/B'], undefined, 'WebStack', STACKS)
    ).toBe(false);
  });
});
