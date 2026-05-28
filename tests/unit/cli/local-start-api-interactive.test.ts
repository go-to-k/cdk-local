import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { assertStartApiInteractiveAllowed } from '../../../src/cli/commands/local-start-api.js';
import { InteractiveTtyRequiredError } from '../../../src/utils/error-handler.js';

let origStdin: boolean | undefined;
let origStdout: boolean | undefined;

function setTty(value: boolean): void {
  (process.stdin as { isTTY?: boolean }).isTTY = value;
  (process.stdout as { isTTY?: boolean }).isTTY = value;
}

beforeEach(() => {
  origStdin = process.stdin.isTTY;
  origStdout = process.stdout.isTTY;
});

afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = origStdin;
  (process.stdout as { isTTY?: boolean }).isTTY = origStdout;
});

describe('assertStartApiInteractiveAllowed', () => {
  it('is a no-op when -i is not set (bare start-api keeps serving every API)', () => {
    setTty(false);
    expect(() => assertStartApiInteractiveAllowed(false, 'MyStack/MyApi', true)).not.toThrow();
  });

  it('rejects -i combined with a positional target / --api (apiFilter set)', () => {
    setTty(true);
    expect(() => assertStartApiInteractiveAllowed(true, 'MyStack/MyApi', false)).toThrow(
      /cannot be combined with a positional target, --api, or --all-stacks/
    );
  });

  it('rejects -i combined with --all-stacks', () => {
    setTty(true);
    expect(() => assertStartApiInteractiveAllowed(true, undefined, true)).toThrow(
      /cannot be combined/
    );
  });

  it('rejects -i without a TTY', () => {
    setTty(false);
    expect(() => assertStartApiInteractiveAllowed(true, undefined, false)).toThrow(
      InteractiveTtyRequiredError
    );
  });

  it('allows -i with no conflicting selector in a TTY', () => {
    setTty(true);
    expect(() => assertStartApiInteractiveAllowed(true, undefined, false)).not.toThrow();
    expect(() => assertStartApiInteractiveAllowed(true, undefined, undefined)).not.toThrow();
  });
});
