import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockRead, MockAssemblyReader } = vi.hoisted(() => {
  const mockRead = vi.fn();
  const MockAssemblyReader = vi.fn().mockImplementation(() => ({ read: mockRead }));
  return { mockRead, MockAssemblyReader };
});

vi.mock('../../../src/synthesis/assembly-reader.js', () => ({
  AssemblyReader: MockAssemblyReader,
}));

import { Synthesizer } from '../../../src/synthesis/synthesizer.js';

describe('Synthesizer.synthesize', () => {
  beforeEach(() => {
    mockRead.mockReset();
    MockAssemblyReader.mockClear();
  });

  it('returns { stacks } pulled from AssemblyReader.read', async () => {
    const fakeStacks = [
      { stackName: 'A' },
      { stackName: 'B' },
    ];
    mockRead.mockResolvedValue(fakeStacks);

    const s = new Synthesizer();
    const result = await s.synthesize({ app: 'node app.ts' });

    expect(result).toEqual({ stacks: fakeStacks });
  });

  it('passes app as the first arg to AssemblyReader.read', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'node my-app.ts' });

    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockRead.mock.calls[0][0]).toBe('node my-app.ts');
  });

  it('forwards output to readOpts.outdir', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x', output: 'custom-out' });

    expect(mockRead).toHaveBeenCalledWith('x', { outdir: 'custom-out' });
  });

  it('omits readOpts.outdir when output is undefined', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x' });

    const opts = mockRead.mock.calls[0][1];
    expect(opts).not.toHaveProperty('outdir');
  });

  it('threads profile into readOpts.env.AWS_PROFILE AND readOpts.profile', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x', profile: 'dev' });

    expect(mockRead).toHaveBeenCalledWith('x', {
      env: { AWS_PROFILE: 'dev' },
      profile: 'dev',
    });
  });

  it('threads region into env (AWS_REGION + CDK_DEFAULT_REGION) AND readOpts.region', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x', region: 'us-east-1' });

    expect(mockRead).toHaveBeenCalledWith('x', {
      env: {
        AWS_REGION: 'us-east-1',
        CDK_DEFAULT_REGION: 'us-east-1',
      },
      region: 'us-east-1',
    });
  });

  it('threads profile + region into both env and the top-level readOpts fields', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x', profile: 'p', region: 'eu-west-1' });

    expect(mockRead).toHaveBeenCalledWith('x', {
      env: {
        AWS_PROFILE: 'p',
        AWS_REGION: 'eu-west-1',
        CDK_DEFAULT_REGION: 'eu-west-1',
      },
      profile: 'p',
      region: 'eu-west-1',
    });
  });

  it('omits readOpts.profile / readOpts.region when neither is set', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x' });

    const opts = mockRead.mock.calls[0][1];
    expect(opts).not.toHaveProperty('profile');
    expect(opts).not.toHaveProperty('region');
  });

  it('omits readOpts.env when neither profile nor region is set', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x' });

    const opts = mockRead.mock.calls[0][1];
    expect(opts).not.toHaveProperty('env');
  });

  it('forwards non-empty context to readOpts.context', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x', context: { k: 'v', k2: 'v2' } });

    expect(mockRead).toHaveBeenCalledWith('x', {
      context: { k: 'v', k2: 'v2' },
    });
  });

  it('omits readOpts.context when context is undefined', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x' });

    const opts = mockRead.mock.calls[0][1];
    expect(opts).not.toHaveProperty('context');
  });

  it('omits readOpts.context when context is an empty object', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x', context: {} });

    const opts = mockRead.mock.calls[0][1];
    expect(opts).not.toHaveProperty('context');
  });

  it('combines output + profile + region into a single readOpts object', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({
      app: 'x',
      output: 'dist-cdk',
      profile: 'p',
      region: 'ap-northeast-1',
    });

    expect(mockRead).toHaveBeenCalledWith('x', {
      outdir: 'dist-cdk',
      env: {
        AWS_PROFILE: 'p',
        AWS_REGION: 'ap-northeast-1',
        CDK_DEFAULT_REGION: 'ap-northeast-1',
      },
      profile: 'p',
      region: 'ap-northeast-1',
    });
  });

  it('instantiates a fresh AssemblyReader per call', async () => {
    mockRead.mockResolvedValue([]);
    const s = new Synthesizer();
    await s.synthesize({ app: 'x' });
    await s.synthesize({ app: 'y' });

    expect(MockAssemblyReader).toHaveBeenCalledTimes(2);
  });

  it('propagates the AssemblyReader.read rejection', async () => {
    const err = new Error('boom');
    mockRead.mockRejectedValue(err);

    const s = new Synthesizer();
    await expect(s.synthesize({ app: 'x' })).rejects.toThrow('boom');
  });
});
