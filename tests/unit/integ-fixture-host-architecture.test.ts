import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fence for issue #560.
 *
 * cdk-local pins `docker --platform` to each Lambda's declared
 * `Architectures` (`local-start-api.ts` `architecture` -> `pullImage` /
 * `architectureToPlatform`). A function that declares no `architecture`
 * defaults to `x86_64`, so on an arm64 host its container runs
 * `linux/amd64` under CPU emulation -- where the Go RIE inside
 * `public.ecr.aws/lambda/nodejs:20` faults intermittently
 * (`fatal error: fault`, `select on synctest channel from outside
 * bubble`, `sync: inconsistent mutex state`), failing a DIFFERENT
 * assertion on every run.
 *
 * The two fixtures below therefore declare the HOST's architecture, which
 * is native on an Apple Silicon dev host and on an x86_64 CI runner
 * alike. This test exists because the failure mode is silent and
 * environment-dependent: a new handler added without `architecture` would
 * pass on CI (amd64, where the default IS the host arch) and reintroduce
 * a flaky arm64-only failure that costs another diagnosis cycle.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Listed as literals on purpose: deriving this from a directory scan
 * would make the test blind to a fixture being removed from the set, and
 * would silently widen the fence to fixtures that have not been verified
 * on an arm64 host.
 */
const FIXTURE_STACKS = [
  'tests/integration/local-start-api/lib/local-start-api-stack.ts',
  'tests/integration/local-start-api-websocket/lib/stack.ts',
];

/**
 * Return the source text of every `new lambda.Function(...)` call in
 * `source`, delimited by brace/paren matching rather than a line regex so
 * that both the single-line and the wrapped
 * `new lambda.Function(\n  this,\n  'Id',\n  {...}\n)` spellings in these
 * fixtures are covered.
 */
function lambdaFunctionCalls(source: string): string[] {
  const calls: string[] = [];
  const needle = 'new lambda.Function(';
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    let depth = 0;
    let end = start + needle.length - 1;
    for (let i = start + needle.length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return calls;
}

describe('integ fixture Lambdas run at the host architecture (issue #560)', () => {
  for (const relPath of FIXTURE_STACKS) {
    describe(relPath, () => {
      const source = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

      it('derives HOST_ARCHITECTURE from process.arch, mapping arm64 -> ARM_64 and everything else -> X86_64', () => {
        // Hardcoding either arch would just move the emulation to the other
        // host: `ARM_64` would make CI (amd64) emulate, `X86_64` is the
        // default that caused #560 on arm64. Only the host-derived form is
        // native on both.
        const normalized = source.replace(/\s+/g, ' ');
        expect(
          normalized,
          `${relPath} must define HOST_ARCHITECTURE from process.arch`
        ).toContain(
          "const HOST_ARCHITECTURE = process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;"
        );
      });

      it('declares architecture: HOST_ARCHITECTURE on every lambda.Function', () => {
        const calls = lambdaFunctionCalls(source);
        expect(calls.length, `${relPath} should declare at least one lambda.Function`).toBeGreaterThan(0);

        const missing = calls
          .filter((call) => !call.includes('architecture: HOST_ARCHITECTURE'))
          // Name the offender by its construct id so the failure points at
          // the function to fix rather than at a count.
          .map((call) => /new lambda\.Function\(\s*this,\s*'([^']+)'/.exec(call)?.[1] ?? call.slice(0, 80));

        expect(
          missing,
          `${relPath}: these lambda.Function constructs are missing ` +
            `\`architecture: HOST_ARCHITECTURE\`, which reintroduces issue #560 ` +
            `(amd64 emulation on arm64 hosts) for them`
        ).toEqual([]);
      });
    });
  }
});
