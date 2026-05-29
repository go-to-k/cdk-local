import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';

// Site-level binding test for the `--from-cfn-stack` SSM-parameter
// resolution wired into `cdkl run-task`'s ECS image-resolution context
// (issue #94 — the exact error the issue shows is the ECS container
// `Environment 'FOO' dropped: Ref ...` shape). This locks the CALL SITE:
// `buildEcsImageResolutionContext` passes the candidate stack's TEMPLATE
// to the provider's `resolveTemplateSsmParameters` and stashes the result
// on `ctx.stateParameters` (which `buildSubstitutionContextFromImageContext`
// then copies into `SubstitutionContext.parameters`).

const { stsSendMock } = vi.hoisted(() => ({ stsSendMock: vi.fn() }));

// `buildEcsImageResolutionContext` issues one `sts:GetCallerIdentity` for
// the pseudo-parameter bag when env/secret substitution is needed; stub
// it so the test stays hermetic.
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = stsSendMock;
    destroy(): void {}
  },
  GetCallerIdentityCommand: class {},
}));

const { buildEcsImageResolutionContext } = await import(
  '../../../src/cli/commands/local-run-task.js'
);

function taskStackWithSsmParam(): StackInfo {
  return {
    stackName: 'MyStack',
    region: 'us-east-1',
    template: {
      Parameters: {
        SsmDbHost: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/db-host' },
      },
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              { Name: 'app', Environment: [{ Name: 'DB_HOST', Value: { Ref: 'SsmDbHost' } }] },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('buildEcsImageResolutionContext SSM-parameter resolution (site binding)', () => {
  beforeEach(() => {
    stsSendMock.mockReset();
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
  });

  it('passes the stack template to resolveTemplateSsmParameters and stashes ctx.stateParameters', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      resolveTemplateSsmParameters: vi
        .fn()
        .mockResolvedValue({ values: { SsmDbHost: 'db.internal' }, secureStringLogicalIds: [] }),
      dispose: vi.fn(),
    } as unknown as LocalStateProvider & {
      resolveTemplateSsmParameters: ReturnType<typeof vi.fn>;
    };

    const ctx = await buildEcsImageResolutionContext(taskStackWithSsmParam(), provider, {} as never);

    expect(provider.resolveTemplateSsmParameters).toHaveBeenCalledTimes(1);
    const passed = provider.resolveTemplateSsmParameters.mock.calls[0]![0] as {
      Parameters?: Record<string, unknown>;
    };
    expect(passed.Parameters?.['SsmDbHost']).toBeDefined();
    expect(ctx?.stateParameters).toEqual({ SsmDbHost: 'db.internal' });
    // No SecureString -> no sensitive logical IDs threaded.
    expect(ctx?.stateSensitiveParameters).toBeUndefined();
  });

  it('stashes stateSensitiveParameters for SecureString params (issue #99)', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      resolveTemplateSsmParameters: vi.fn().mockResolvedValue({
        values: { SsmDbHost: 's3cr3t' },
        secureStringLogicalIds: ['SsmDbHost'],
      }),
      dispose: vi.fn(),
    } as unknown as LocalStateProvider;

    const ctx = await buildEcsImageResolutionContext(taskStackWithSsmParam(), provider, {} as never);
    expect(ctx?.stateParameters).toEqual({ SsmDbHost: 's3cr3t' });
    expect(ctx?.stateSensitiveParameters).toEqual(['SsmDbHost']);
  });

  it('leaves stateParameters absent when the provider resolves nothing', async () => {
    const provider = {
      label: '--from-cfn-stack',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      resolveTemplateSsmParameters: vi
        .fn()
        .mockResolvedValue({ values: {}, secureStringLogicalIds: [] }),
      dispose: vi.fn(),
    } as unknown as LocalStateProvider;

    const ctx = await buildEcsImageResolutionContext(taskStackWithSsmParam(), provider, {} as never);
    expect(ctx?.stateParameters).toBeUndefined();
    expect(ctx?.stateSensitiveParameters).toBeUndefined();
  });

  it('skips SSM resolution cleanly for a provider without resolveTemplateSsmParameters', async () => {
    const provider = {
      label: '--from-state',
      load: vi.fn().mockResolvedValue({ resources: {}, outputs: {}, region: 'us-east-1' }),
      buildCrossStackResolver: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    } as unknown as LocalStateProvider;

    const ctx = await buildEcsImageResolutionContext(taskStackWithSsmParam(), provider, {} as never);
    expect(ctx?.stateParameters).toBeUndefined();
  });
});
