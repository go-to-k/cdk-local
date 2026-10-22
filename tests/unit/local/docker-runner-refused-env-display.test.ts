/**
 * go-to-k/cdk-local#761: the refused sensitive env keys come from the
 * template (a task definition's `Secrets`, a Lambda's SecureString env), so
 * each one renders as its own value — bare when plain, one JSON literal
 * otherwise — and a forged key cannot write a clause of its own into the warn.
 */
import { describe, expect, it } from 'vite-plus/test';
import { describeRefusedSensitiveEnvKeys } from '../../../src/local/docker-runner.js';

const TAIL =
  ' share a name with a variable the container client reads (docker, or the CDK_DOCKER binary) ' +
  "or have a malformed name (empty, or containing '=' / NUL), and were NOT passed to the " +
  'container at all (a colliding name would hijack that client; a malformed name cannot form ' +
  'a valid environment variable). Rename the variable if the container needs it.';

describe('describeRefusedSensitiveEnvKeys renders each key (#761)', () => {
  it('prints plain keys bare, joined', () => {
    expect(describeRefusedSensitiveEnvKeys('Container web', ['DOCKER_HOST', 'DOCKER_CONFIG'])).toBe(
      `Container web: sensitive env var(s) DOCKER_HOST, DOCKER_CONFIG${TAIL}`
    );
  });

  it('quotes a key that could forge a clause, keeping the separator byte-exact', () => {
    expect(
      describeRefusedSensitiveEnvKeys('Container web', ["DOCKER_HOST' were passed", 'A=B'])
    ).toBe(`Container web: sensitive env var(s) "DOCKER_HOST' were passed", A=B${TAIL}`);
  });
});
