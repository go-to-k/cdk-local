/**
 * go-to-k/cdk-local#948: `cdkl start-api --debug-port-base` hands each
 * Lambda's container the lifted function timeout alongside
 * `--inspect-brk`, so the RIE does not reset the runtime after the
 * function's 3 s Timeout while the handler waits for a debugger.
 */
import { describe, expect, it } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { buildContainerSpec } from '../../../src/cli/commands/local-start-api.js';
import { DEBUG_FUNCTION_TIMEOUT_SEC } from '../../../src/local/debug-timeout.js';

function stack(): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    dependencyNames: [],
    region: 'us-east-1',
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = () => {};' },
          },
        },
      },
    },
  } as unknown as StackInfo;
}

async function specEnv(debugPort: number | undefined): Promise<Record<string, string>> {
  const spec = await buildContainerSpec({
    logicalId: 'Fn',
    stacks: [stack()],
    overrides: undefined,
    assumeRole: undefined,
    containerHost: '127.0.0.1',
    stsRegion: 'us-east-1',
    inlineTmpDirs: new Set(),
    layerTmpDirs: new Set(),
    stateByStack: new Map(),
    skipPull: true,
    ...(debugPort !== undefined && { debugPort }),
  } as never);
  return spec.env;
}

describe('start-api buildContainerSpec — debug port timeout', () => {
  it('keeps the function Timeout without a debug port', async () => {
    const env = await specEnv(undefined);
    expect(env['AWS_LAMBDA_FUNCTION_TIMEOUT']).toBe('3');
    expect(env['NODE_OPTIONS']).toBeUndefined();
  });

  it('lifts the function Timeout with a debug port', async () => {
    const env = await specEnv(9601);
    expect(env['NODE_OPTIONS']).toBe('--inspect-brk=0.0.0.0:9601');
    expect(env['AWS_LAMBDA_FUNCTION_TIMEOUT']).toBe(String(DEBUG_FUNCTION_TIMEOUT_SEC));
  });
});
