import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Command } from 'commander';
import type { CdkAppSynthesizer, SynthesisOptions } from '../../../src/synthesis/synthesizer.js';

/**
 * A host's `synthesizer` replaces the built-in toolkit-lib one in every serve
 * command that synthesizes, so an embedding CLI keeps one synthesis path; with
 * none, the built-in one runs as before.
 */

const builtIn = vi.hoisted(() => ({ constructed: 0, calls: [] as unknown[] }));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: class {
    constructor() {
      builtIn.constructed++;
    }
    async synthesize(opts: unknown): Promise<never> {
      builtIn.calls.push(opts);
      throw new Error('STOP: built-in synthesizer');
    }
  },
}));
vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
}));

const { createLocalStartAgentCoreCommand } = await import(
  '../../../src/cli/commands/local-start-agentcore.js'
);
const { createLocalStartCloudFrontCommand } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
);
const { createLocalStartServiceCommand } = await import(
  '../../../src/cli/commands/local-start-service.js'
);
const { createLocalStartAlbCommand } = await import('../../../src/cli/commands/local-start-alb.js');
const { createLocalStartWebFunctionCommand } = await import(
  '../../../src/cli/commands/local-start-web-function.js'
);

type Factory = (opts: { synthesizer?: CdkAppSynthesizer }) => Command;

const COMMANDS: Array<[string, Factory, string[]]> = [
  ['start-agentcore', createLocalStartAgentCoreCommand, ['Stack/Agent']],
  ['start-cloudfront', createLocalStartCloudFrontCommand, ['Stack/Dist']],
  ['start-service', createLocalStartServiceCommand, ['Stack/Service']],
  ['start-alb', createLocalStartAlbCommand, ['Stack/Alb']],
  ['start-web-function', createLocalStartWebFunctionCommand, ['Stack/Endpoint']],
];

class Exit extends Error {}

beforeEach(() => {
  builtIn.constructed = 0;
  builtIn.calls = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(factory: Factory, synthesizer: CdkAppSynthesizer | undefined, args: string[]) {
  const cmd = factory(synthesizer === undefined ? {} : { synthesizer });
  cmd.exitOverride();
  await expect(
    cmd.parseAsync(['node', 'cdkl', ...args, '--app', 'node app.js', '-c', 'k=v'])
  ).rejects.toThrow(Exit);
}

describe.each(COMMANDS)('%s', (_name, factory, args) => {
  it("synthesizes with the host's synthesizer, never the built-in one", async () => {
    const calls: SynthesisOptions[] = [];
    const host: CdkAppSynthesizer = {
      async synthesize(opts) {
        calls.push(opts);
        throw new Error('STOP: host synthesizer');
      },
    };
    await run(factory, host, args);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ app: 'node app.js', context: { k: 'v' } });
    expect(builtIn.constructed).toBe(0);
  });

  it('synthesizes with the built-in synthesizer when the host passes none', async () => {
    await run(factory, undefined, args);
    expect(builtIn.constructed).toBe(1);
    expect(builtIn.calls).toHaveLength(1);
    expect(builtIn.calls[0]).toMatchObject({ app: 'node app.js', context: { k: 'v' } });
  });
});
