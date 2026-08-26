import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fence for issues #560 and #569.
 *
 * cdk-local pins `docker --platform` to each Lambda's declared
 * `Architectures` (`local-invoke.ts` / `local-start-api.ts` `architecture`
 * -> `pullImage` / `architectureToPlatform`). A function that declares no
 * `architecture` defaults to `x86_64`, so on an arm64 host its container
 * runs `linux/amd64` under CPU emulation -- where the Go RIE inside the
 * `public.ecr.aws/lambda/*` base images faults intermittently
 * (`fatal error: fault`, `select on synctest channel from outside
 * bubble`, `sync: inconsistent mutex state`), failing a DIFFERENT
 * assertion on every run.
 *
 * The fixtures below therefore declare the HOST's architecture, which is
 * native on an Apple Silicon dev host and on an x86_64 CI runner alike.
 * This test exists because the failure mode is silent and
 * environment-dependent: a new handler added without `architecture` would
 * pass on CI (amd64, where the default IS the host arch) and reintroduce
 * a flaky arm64-only failure that costs another diagnosis cycle. The
 * fixtures' own `verify.sh` scripts send stderr to `/dev/null`, so even
 * cdk-local's "running under emulation" warning is invisible during a
 * normal run -- this file is the only thing standing between a new
 * handler and a silent regression.
 *
 * Three things this fence deliberately does NOT do:
 *
 *  - It does not glob the fixture directory. `HOST_ARCHITECTURE_STACKS`
 *    is literal so a fixture joins the set consciously, having actually
 *    been run on an arm64 host, rather than by a directory scan that
 *    would also make the fence blind to a fixture being REMOVED.
 *  - It does not assume every `*Function(` constructor is a Lambda, nor
 *    that anything it fails to recognize is harmless. A spelling that is
 *    neither a known Lambda constructor nor an explicitly listed
 *    non-Lambda one FAILS. `cloudfront.Function` is the non-Lambda case
 *    this will meet first -- a different service with no `architecture`
 *    at all -- and it joins `NON_LAMBDA_CTORS` when the first fixture
 *    containing one joins the set above.
 *  - It does not require every fixture to use the host arch.
 *    `PINNED_STACKS` records the fixtures whose architecture must match a
 *    prebuilt BINARY rather than the host, and asserts the pin is still
 *    there -- an exemption nobody checks is just a hole.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The exact declaration every converted fixture must carry.
 *
 * Compared against the source with whitespace collapsed, so reformatting
 * is fine but the SEMANTICS are pinned: hardcoding either architecture
 * would merely move the emulation to the other host (`ARM_64` makes an
 * amd64 CI runner emulate; `X86_64` is the default that caused #560 on
 * arm64). Only the host-derived form is native on both.
 */
const HOST_ARCH_DECL =
  "const HOST_ARCHITECTURE = process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;";

/**
 * Lambda constructor spellings this fence understands, mapped to the
 * architecture property each one requires.
 *
 * The L1 `CfnFunction` takes a `string[]` of architecture NAMES rather
 * than the L2 `Architecture` object, which is why it needs its own entry
 * instead of being folded in with the others.
 */
const LAMBDA_CTORS = new Map<string, string>([
  ['new lambda.Function(', 'architecture: HOST_ARCHITECTURE'],
  ['new lambda.CfnFunction(', 'architectures: [HOST_ARCHITECTURE.name]'],
]);

/**
 * `*Function(` constructors that are NOT Lambdas and must never be given
 * an architecture.
 *
 * Empty until a fixture containing one joins `HOST_ARCHITECTURE_STACKS`
 * (`cloudfront.Function`, in `local-start-cloudfront-lambda-url` and
 * `local-studio`, is the first that will). The list is what keeps an
 * unrecognized spelling a LOUD failure: the moment the fence treats
 * "not a constructor I know" as "probably fine", it stops fencing.
 */
const NON_LAMBDA_CTORS = new Set<string>([]);

/** Fixtures required to run their Lambdas at the host architecture. */
const HOST_ARCHITECTURE_STACKS = [
  'tests/integration/local-start-api/lib/local-start-api-stack.ts',
  'tests/integration/local-start-api-websocket/lib/stack.ts',
  'tests/integration/local-invoke/lib/local-invoke-stack.ts',
  'tests/integration/local-invoke-assume-role/lib/local-invoke-assume-role-stack.ts',
  'tests/integration/local-invoke-layers/lib/local-invoke-layers-stack.ts',
  'tests/integration/local-invoke-python/lib/local-invoke-python-stack.ts',
  'tests/integration/local-invoke-ruby/lib/local-invoke-ruby-stack.ts',
  'tests/integration/local-invoke-java/lib/local-invoke-java-stack.ts',
  'tests/integration/local-invoke-dotnet/lib/local-invoke-dotnet-stack.ts',
];

/**
 * Fixtures whose architecture is pinned to a PREBUILT ARTIFACT and must
 * NOT be converted to the host architecture.
 */
const PINNED_STACKS = [
  {
    relPath: 'tests/integration/local-invoke-provided/lib/local-invoke-provided-stack.ts',
    pin: 'architecture: lambda.Architecture.X86_64',
    why:
      "its verify.sh cross-compiles the bootstrap with GOARCH=amd64, so the declared " +
      'architecture must match the BINARY, not the host; converting it to ' +
      'HOST_ARCHITECTURE would hand an arm64 base image an amd64 executable',
  },
];

/**
 * Every `new <ns...>.<Name>Function(` constructor call, in any spelling.
 *
 * The namespace part is `(?:...)*` rather than `(?:...)?` on purpose: with
 * a single optional segment, the standard submodule form
 * `new cdk.aws_lambda.Function(` does not match at all, so a handler
 * written that way would be a SILENT PASS -- exactly the case this fence
 * exists to catch. Matching the broad shape and then requiring every hit
 * to be a recognized spelling turns an unknown constructor into a loud
 * failure instead.
 */
const ANY_FUNCTION_CTOR = /new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*[\w$]*Function\s*\(/g;

/** Collapse internal whitespace so `new  lambda . Function (` compares equal. */
function normalizeCtor(spelling: string): string {
  return spelling.replace(/\s+/g, '').replace('new', 'new ');
}

/**
 * Return the source text of every `needle` call in `source`, delimited by
 * paren matching rather than a line regex so both the single-line and the
 * wrapped `new lambda.Function(\n  this,\n  'Id',\n  {...}\n)` spellings
 * are covered.
 */
function constructorCalls(source: string, needle: string): string[] {
  const calls: string[] = [];
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

/** Name a call by its construct id, so a failure points at the function to fix. */
function constructId(call: string): string {
  return /new\s+[\w$.]*\(\s*this,\s*'([^']+)'/.exec(call)?.[1] ?? call.slice(0, 80);
}

describe('integ fixture Lambdas run at the host architecture (issues #560, #569)', () => {
  for (const relPath of HOST_ARCHITECTURE_STACKS) {
    describe(relPath, () => {
      // Read inside each test rather than at collection time, so a renamed or
      // deleted fixture fails as a named test rather than as a suite-level
      // ENOENT that names no expectation.
      const read = (): string => readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

      it('derives HOST_ARCHITECTURE from process.arch, mapping arm64 -> ARM_64 and everything else -> X86_64', () => {
        const normalized = read().replace(/\s+/g, ' ');
        expect(
          normalized,
          `${relPath} must define HOST_ARCHITECTURE from process.arch`
        ).toContain(HOST_ARCH_DECL);
      });

      it('defines its Lambdas only via constructor spellings this fence understands', () => {
        // Guards the assumption the next test depends on. Without this, a
        // handler added as `NodejsFunction` / `new Function(` / a deeper
        // namespace path would not be found at all, and "every construct
        // declares the architecture" would be vacuously true of it.
        const source = read();
        const found = [...source.matchAll(ANY_FUNCTION_CTOR)].map((m) => normalizeCtor(m[0]));
        const unknown = found.filter(
          (spelling) => !LAMBDA_CTORS.has(spelling) && !NON_LAMBDA_CTORS.has(spelling)
        );

        expect(
          unknown,
          `${relPath}: found constructor spelling(s) this fence does not understand. ` +
            `Use one of [${[...LAMBDA_CTORS.keys()].join(', ')}], or -- if the ` +
            `construct is not a Lambda -- add it to NON_LAMBDA_CTORS. Leaving it ` +
            `unlisted would let the architecture check silently skip those constructs`
        ).toEqual([]);
        expect(found.length, `${relPath} should declare at least one Lambda`).toBeGreaterThan(0);
      });

      it('declares the host architecture on every Lambda construct', () => {
        const source = read();
        const seen: string[] = [];
        const missing: string[] = [];

        for (const [ctor, requiredProp] of LAMBDA_CTORS) {
          for (const call of constructorCalls(source, ctor)) {
            seen.push(call);
            if (!call.includes(requiredProp)) {
              missing.push(`${constructId(call)} (needs \`${requiredProp}\`)`);
            }
          }
        }

        // The two counts must agree, or the paren matcher mis-delimited a
        // call and some construct went unexamined.
        const regexHits = [...source.matchAll(ANY_FUNCTION_CTOR)].filter((m) =>
          LAMBDA_CTORS.has(normalizeCtor(m[0]))
        ).length;
        expect(
          seen.length,
          `${relPath}: paren matcher and regex disagree on the Lambda count`
        ).toBe(regexHits);
        expect(seen.length, `${relPath} should declare at least one Lambda`).toBeGreaterThan(0);

        expect(
          missing,
          `${relPath}: these Lambda constructs are missing their architecture ` +
            `declaration, which reintroduces issue #560 (amd64 emulation on arm64 ` +
            `hosts) for them`
        ).toEqual([]);
      });

      it('never hardcodes an architecture, which would only move the emulation to the other host', () => {
        // `architecture: lambda.Architecture.ARM_64` would satisfy a reader
        // looking for "an architecture is declared" while making every amd64
        // CI runner emulate instead. The only permitted mention of
        // `lambda.Architecture` in these fixtures is inside the
        // HOST_ARCHITECTURE declaration itself.
        const source = read();
        const offenders = source
          .split('\n')
          .map((line, i) => [i + 1, line] as const)
          .filter(([, line]) => /lambda\.Architecture\.(?:ARM_64|X86_64)/.test(line))
          .filter(([, line]) => !line.includes('process.arch'))
          .map(([lineNo, line]) => `${relPath}:${lineNo}: ${line.trim()}`);

        expect(
          offenders,
          `${relPath}: hardcoded architecture(s) found outside the HOST_ARCHITECTURE ` +
            `declaration. Hardcoding ARM_64 makes an amd64 CI runner emulate; ` +
            `hardcoding X86_64 is the default that caused #560 on arm64 hosts. If ` +
            `this fixture genuinely must pin an architecture to match a prebuilt ` +
            `binary, move it to PINNED_STACKS instead`
        ).toEqual([]);
      });
    });
  }

  describe('fixtures pinned to a prebuilt binary keep their explicit architecture', () => {
    for (const { relPath, pin, why } of PINNED_STACKS) {
      it(`${relPath} still pins its architecture`, () => {
        const source = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

        expect(
          source,
          `${relPath} must keep \`${pin}\`: ${why}`
        ).toContain(pin);
        expect(
          source.includes('HOST_ARCHITECTURE'),
          `${relPath} must NOT be converted to HOST_ARCHITECTURE: ${why}`
        ).toBe(false);
      });
    }
  });
});
