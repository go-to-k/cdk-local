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

/** The one Lambda constructor spelling both fixtures are required to use. */
const CANONICAL_CTOR = 'new lambda.Function(';

/**
 * Every `new <Something>Function(` constructor call, in any spelling.
 *
 * `lambdaFunctionCalls` below keys off the single canonical spelling, so on
 * its own it would report a clean pass for a handler added as
 * `NodejsFunction` / `lambda.DockerImageFunction` / a named-import
 * `new Function(` / even `new lambda.Function (` with a space -- i.e. it
 * would be blind to exactly the "someone adds a handler" case this file
 * exists to catch. Matching the broad shape and then requiring every hit to
 * be the canonical spelling turns an unrecognized spelling into a loud
 * failure instead of a silent pass.
 */
const ANY_FUNCTION_CTOR = /new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?[\w$]*Function\s*\(/g;

/**
 * Return the source text of every `new lambda.Function(...)` call in
 * `source`, delimited by brace/paren matching rather than a line regex so
 * that both the single-line and the wrapped
 * `new lambda.Function(\n  this,\n  'Id',\n  {...}\n)` spellings in these
 * fixtures are covered.
 */
function lambdaFunctionCalls(source: string): string[] {
  const calls: string[] = [];
  const needle = CANONICAL_CTOR;
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
      // Read inside each test rather than at collection time, so a renamed or
      // deleted fixture fails as a named test rather than as a suite-level
      // ENOENT that names no expectation.
      const read = (): string => readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

      it('derives HOST_ARCHITECTURE from process.arch, mapping arm64 -> ARM_64 and everything else -> X86_64', () => {
        const source = read();
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

      it('defines its Lambdas only via the canonical `new lambda.Function(` spelling', () => {
        // Guards the assumption the next test depends on. Without this, a
        // handler added as `NodejsFunction` / `lambda.DockerImageFunction` /
        // `new Function(` would not be found at all, and "every construct
        // declares the architecture" would be vacuously true of it.
        const source = read();
        const found = [...source.matchAll(ANY_FUNCTION_CTOR)].map((m) => m[0]);
        const nonCanonical = found.filter((spelling) => spelling !== CANONICAL_CTOR);

        expect(
          nonCanonical,
          `${relPath}: found Lambda constructor spelling(s) this fence does not ` +
            `understand. Either use \`${CANONICAL_CTOR}\` or teach ` +
            `lambdaFunctionCalls() the new spelling -- otherwise the ` +
            `architecture check silently skips those constructs`
        ).toEqual([]);
        expect(found.length, `${relPath} should declare at least one Lambda`).toBeGreaterThan(0);
      });

      it('declares architecture: HOST_ARCHITECTURE on every lambda.Function', () => {
        const source = read();
        const calls = lambdaFunctionCalls(source);
        // The two counts must agree, or the brace matcher mis-delimited a call.
        expect(calls.length, `${relPath}: brace matcher and regex disagree on the Lambda count`).toBe(
          [...source.matchAll(ANY_FUNCTION_CTOR)].length
        );
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
