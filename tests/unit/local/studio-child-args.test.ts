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

  it('omits the state bindings when omitStateBindings is set (issue #367)', () => {
    // start-cloudfront declares neither flag; the serve-manager opts out for it.
    expect(
      buildSharedChildArgs(
        { fromCfnStack: 'MyStack', assumeRole: 'arn:aws:iam::123456789012:role/app' },
        { omitStateBindings: true }
      )
    ).toEqual([]);
    // Other shared flags still pass through.
    expect(
      buildSharedChildArgs(
        { app: 'node app.ts', region: 'us-east-1', fromCfnStack: 'MyStack' },
        { omitStateBindings: true }
      )
    ).toEqual(['--app', 'node app.ts', '--region', 'us-east-1']);
  });

  describe('assembly-dir reuse (issue #324)', () => {
    it('forwards --app <app> by default (preferAssembly omitted)', () => {
      expect(
        buildSharedChildArgs({ app: 'node app.ts', assemblyDir: '/abs/cdk.out' })
      ).toEqual(['--app', 'node app.ts']);
    });

    it('forwards --app <assemblyDir> when preferAssembly is true and a dir is set', () => {
      expect(
        buildSharedChildArgs(
          { app: 'node app.ts', assemblyDir: '/abs/cdk.out' },
          { preferAssembly: true }
        )
      ).toEqual(['--app', '/abs/cdk.out']);
    });

    it('falls back to --app <app> when preferAssembly is true but no assemblyDir is set', () => {
      expect(
        buildSharedChildArgs({ app: 'node app.ts' }, { preferAssembly: true })
      ).toEqual(['--app', 'node app.ts']);
    });

    it('forwards --app <app> when preferAssembly is false even with an assemblyDir', () => {
      expect(
        buildSharedChildArgs(
          { app: 'node app.ts', assemblyDir: '/abs/cdk.out' },
          { preferAssembly: false }
        )
      ).toEqual(['--app', 'node app.ts']);
    });

    it('keeps the assemblyDir off the argv when neither app nor preferAssembly applies', () => {
      // assemblyDir alone (no preferAssembly) does not leak onto the argv.
      expect(buildSharedChildArgs({ assemblyDir: '/abs/cdk.out' })).toEqual([]);
    });
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
