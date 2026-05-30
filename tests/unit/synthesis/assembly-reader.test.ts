import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const {
  MockToolkit,
  mockFromCdkApp,
  mockFromAssemblyDirectory,
  mockSynth,
  mockDispose,
  mockAwsCliCompatible,
  MockCdkAppMultiContext,
  baseCredsSentinel,
} = vi.hoisted(() => {
  const baseCredsSentinel = { __baseCreds: true };
  const mockAwsCliCompatible = vi.fn(() => baseCredsSentinel);
  const mockDispose = vi.fn().mockResolvedValue(undefined);
  const mockSynth = vi.fn().mockResolvedValue({
    cloudAssembly: { stacks: [] },
    dispose: mockDispose,
  });
  const mockFromCdkApp = vi.fn().mockResolvedValue({ __source: true });
  const mockFromAssemblyDirectory = vi.fn().mockResolvedValue({ __source: 'dir' });
  const MockToolkit = vi.fn().mockImplementation(() => ({
    fromCdkApp: mockFromCdkApp,
    fromAssemblyDirectory: mockFromAssemblyDirectory,
    synth: mockSynth,
  }));
  const MockCdkAppMultiContext = vi.fn();
  return {
    MockToolkit,
    mockFromCdkApp,
    mockFromAssemblyDirectory,
    mockSynth,
    mockDispose,
    mockAwsCliCompatible,
    MockCdkAppMultiContext,
    baseCredsSentinel,
  };
});

vi.mock('@aws-cdk/toolkit-lib', () => ({
  Toolkit: MockToolkit,
  CdkAppMultiContext: MockCdkAppMultiContext,
  BaseCredentials: { awsCliCompatible: mockAwsCliCompatible },
  // CdklIoHost extends NonInteractiveIoHost; provide a stub so the
  // subclass `extends` clause resolves under the mocked module.
  NonInteractiveIoHost: class {
    async notify(): Promise<void> {}
  },
}));

vi.mock('@aws-cdk/cloud-assembly-api', () => ({
  AssetManifestArtifact: class {},
}));

import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';

describe('AssemblyReader.read — toolkit SDK credential wiring', () => {
  beforeEach(() => {
    MockToolkit.mockClear();
    mockFromCdkApp.mockClear();
    mockSynth.mockClear();
    mockDispose.mockClear();
    mockAwsCliCompatible.mockClear();
  });

  it('passes profile + region into BaseCredentials.awsCliCompatible', async () => {
    await new AssemblyReader().read('node app.ts', {
      profile: 'myprof',
      region: 'ap-northeast-1',
    });

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({
      profile: 'myprof',
      defaultRegion: 'ap-northeast-1',
    });
  });

  it('seeds the Toolkit sdkConfig.baseCredentials with the awsCliCompatible result', async () => {
    await new AssemblyReader().read('node app.ts', { profile: 'p' });

    expect(MockToolkit).toHaveBeenCalledTimes(1);
    const toolkitArgs = MockToolkit.mock.calls[0][0];
    expect(toolkitArgs.sdkConfig.baseCredentials).toBe(baseCredsSentinel);
  });

  it('omits defaultRegion when only profile is set', async () => {
    await new AssemblyReader().read('x', { profile: 'p' });

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({ profile: 'p' });
  });

  it('omits profile when only region is set', async () => {
    await new AssemblyReader().read('x', { region: 'us-east-1' });

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({ defaultRegion: 'us-east-1' });
  });

  it('calls awsCliCompatible with no profile/region keys when neither is supplied', async () => {
    await new AssemblyReader().read('x');

    expect(mockAwsCliCompatible).toHaveBeenCalledWith({});
  });

  it('still drives fromCdkApp + synth + dispose for the happy path', async () => {
    const stacks = await new AssemblyReader().read('node app.ts');

    expect(mockFromCdkApp).toHaveBeenCalledTimes(1);
    expect(mockFromCdkApp.mock.calls[0][0]).toBe('node app.ts');
    expect(mockSynth).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(stacks).toEqual([]);
  });
});

describe('AssemblyReader.readFromDirectory — pre-synth assembly', () => {
  beforeEach(() => {
    MockToolkit.mockClear();
    mockFromAssemblyDirectory.mockClear();
    mockSynth.mockClear();
    mockDispose.mockClear();
  });

  it('passes failOnMissingContext: false so an assembly with unresolved context lookups is accepted', async () => {
    await new AssemblyReader().readFromDirectory('/path/to/cdk.out');

    expect(mockFromAssemblyDirectory).toHaveBeenCalledTimes(1);
    expect(mockFromAssemblyDirectory).toHaveBeenCalledWith('/path/to/cdk.out', {
      failOnMissingContext: false,
    });
  });

  it('drives fromAssemblyDirectory + synth + dispose for the happy path', async () => {
    const stacks = await new AssemblyReader().readFromDirectory('/path/to/cdk.out');

    expect(mockSynth).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(stacks).toEqual([]);
  });
});
