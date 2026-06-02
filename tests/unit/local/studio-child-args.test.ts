import { describe, it, expect } from 'vite-plus/test';
import { buildSharedChildArgs } from '../../../src/local/studio-child-args.js';

describe('buildSharedChildArgs', () => {
  it('returns no args for an empty config', () => {
    expect(buildSharedChildArgs({})).toEqual([]);
  });

  it('threads app / profile / region / context', () => {
    expect(
      buildSharedChildArgs({
        app: 'node app.ts',
        profile: 'dev',
        region: 'us-west-2',
        context: { stage: 'dev', foo: 'bar' },
      })
    ).toEqual([
      '--app',
      'node app.ts',
      '--profile',
      'dev',
      '--region',
      'us-west-2',
      '-c',
      'stage=dev',
      '-c',
      'foo=bar',
    ]);
  });

  it('forwards a bare --from-cfn-stack (true) without a value', () => {
    expect(buildSharedChildArgs({ fromCfnStack: true })).toEqual(['--from-cfn-stack']);
  });

  it('forwards a named --from-cfn-stack with its value', () => {
    expect(buildSharedChildArgs({ fromCfnStack: 'MyStack' })).toEqual([
      '--from-cfn-stack',
      'MyStack',
    ]);
  });

  it('omits --from-cfn-stack when false / empty-string', () => {
    expect(buildSharedChildArgs({ fromCfnStack: false })).toEqual([]);
    expect(buildSharedChildArgs({ fromCfnStack: '' })).toEqual([]);
  });

  it('forwards --assume-role with its ARN value (no bare form)', () => {
    expect(buildSharedChildArgs({ assumeRole: 'arn:aws:iam::123456789012:role/app' })).toEqual([
      '--assume-role',
      'arn:aws:iam::123456789012:role/app',
    ]);
  });

  it('omits --assume-role for an empty string', () => {
    expect(buildSharedChildArgs({ assumeRole: '' })).toEqual([]);
  });

  it('composes every flag in a stable order', () => {
    expect(
      buildSharedChildArgs({
        app: 'cdk.out',
        profile: 'prod',
        region: 'eu-west-1',
        context: { k: 'v' },
        fromCfnStack: 'Stack',
        assumeRole: 'arn:aws:iam::1:role/r',
      })
    ).toEqual([
      '--app',
      'cdk.out',
      '--profile',
      'prod',
      '--region',
      'eu-west-1',
      '-c',
      'k=v',
      '--from-cfn-stack',
      'Stack',
      '--assume-role',
      'arn:aws:iam::1:role/r',
    ]);
  });
});
