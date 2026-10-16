/**
 * go-to-k/cdk-local#783 — `start-api`'s container env under caller mode: the
 * forwarded `AWS_*` triple is the caller's, not the `--role-arn` role's, and a
 * stripped triple warns only when no `--profile` overlay filled it back in.
 */
import { rmSync } from 'node:fs';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { buildContainerSpec } = await import('../../../src/cli/commands/local-start-api.js');
const { resetEmbedConfig, setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { recordAssumedRole, resetWorkloadIdentity } = await import(
  '../../../src/utils/workload-identity.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');

const KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;

describe('start-api buildContainerSpec — caller workload identity (go-to-k/cdk-local#783)', () => {
  let saved: Record<string, string | undefined>;
  const inlineTmpDirs = new Set<string>();

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAROLE';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'roleSecret';
    process.env['AWS_SESSION_TOKEN'] = 'roleToken';
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of inlineTmpDirs) rmSync(d, { recursive: true, force: true });
    inlineTmpDirs.clear();
    resetWorkloadIdentity();
    resetEmbedConfig();
    vi.restoreAllMocks();
  });

  const stack = {
    stackName: 'S',
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

  const build = (extra: Record<string, unknown> = {}) =>
    buildContainerSpec({
      logicalId: 'Fn',
      stacks: [stack],
      overrides: undefined,
      assumeRole: undefined,
      containerHost: '127.0.0.1',
      stsRegion: undefined,
      inlineTmpDirs,
      layerTmpDirs: new Set(),
      stateByStack: new Map(),
      skipPull: true,
      ...extra,
    });

  it('caller mode restores the caller triple (not the role)', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    const spec = await build();
    expect(spec.env['AWS_ACCESS_KEY_ID']).toBe('AKIACALLER');
    expect(spec.env['AWS_SECRET_ACCESS_KEY']).toBe('callerSecret');
    expect('AWS_SESSION_TOKEN' in spec.env).toBe(false);
  });

  it('caller mode with no static caller triple strips the triple and warns once', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(undefined);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const spec = await build();
    for (const k of KEYS) expect(k in spec.env).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('--profile');
  });

  it('a stripped triple filled by a --profile overlay does NOT warn', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    recordAssumedRole(undefined);
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const spec = await build({
      profileCredentials: { accessKeyId: 'AKIAPROFILE', secretAccessKey: 'profileSecret' },
    });
    expect(spec.env['AWS_ACCESS_KEY_ID']).toBe('AKIAPROFILE');
    expect(warn).not.toHaveBeenCalled();
  });

  it('role mode forwards the process env as before', async () => {
    recordAssumedRole({ accessKeyId: 'AKIACALLER', secretAccessKey: 'callerSecret' });
    const spec = await build();
    expect(spec.env['AWS_ACCESS_KEY_ID']).toBe('AKIAROLE');
    expect(spec.env['AWS_SESSION_TOKEN']).toBe('roleToken');
  });
});
