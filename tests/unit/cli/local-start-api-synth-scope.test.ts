import { describe, expect, it } from 'vite-plus/test';
import {
  deriveSynthStackPrefix,
  shouldPromptBareMultiSelect,
  shouldSynthAllStacks,
} from '../../../src/cli/commands/local-start-api.js';

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

describe('deriveSynthStackPrefix (multi-target synth-scope optimization)', () => {
  it('returns undefined for the empty (serve-all) target list', () => {
    expect(deriveSynthStackPrefix([])).toBeUndefined();
  });

  it('returns the single stack prefix for one Construct-path target', () => {
    expect(deriveSynthStackPrefix(['MyStack/MyApi'])).toBe('MyStack');
  });

  it('returns the shared prefix when every target lives in the same stack', () => {
    expect(deriveSynthStackPrefix(['MyStack/MyApi', 'MyStack/OtherApi'])).toBe('MyStack');
  });

  it('returns undefined when targets span different stack prefixes (synth all)', () => {
    expect(deriveSynthStackPrefix(['WebStack/MyApi', 'AdminStack/AdminApi'])).toBeUndefined();
  });

  it('returns undefined when any target is a bare logical id (cannot infer a stack)', () => {
    expect(deriveSynthStackPrefix(['MyApi'])).toBeUndefined();
    expect(deriveSynthStackPrefix(['MyStack/MyApi', 'BareId'])).toBeUndefined();
  });
});

describe('shouldSynthAllStacks (item 5: multi-stack synth fallback)', () => {
  it('is false when there are no targets (serve-all synths everything via the regular path)', () => {
    expect(shouldSynthAllStacks([], undefined, undefined)).toBe(false);
  });

  it('is false when a single target pins one stack via its Construct-path prefix', () => {
    expect(shouldSynthAllStacks(['MyStack/MyApi'], undefined, undefined)).toBe(false);
  });

  it('is false when multiple targets all share one stack prefix', () => {
    expect(shouldSynthAllStacks(['MyStack/A', 'MyStack/B'], undefined, undefined)).toBe(false);
  });

  it('is true when targets span different stacks and no other selector pins one', () => {
    expect(shouldSynthAllStacks(['WebStack/A', 'AdminStack/B'], undefined, undefined)).toBe(true);
  });

  it('is true when a bare-logical-id target leaves the synth stack unresolved', () => {
    expect(shouldSynthAllStacks(['BareId'], undefined, undefined)).toBe(true);
  });

  it('is false when --stack explicitly pins the synth stack (overrides target inference)', () => {
    expect(shouldSynthAllStacks(['WebStack/A', 'AdminStack/B'], 'WebStack', undefined)).toBe(false);
  });

  it('is false when an explicit --from-cfn-stack <name> pins the synth stack', () => {
    expect(shouldSynthAllStacks(['WebStack/A', 'AdminStack/B'], undefined, 'WebStack')).toBe(false);
  });
});
