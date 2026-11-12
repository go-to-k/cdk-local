import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { defaultChainMock, defaultProviderMock } = vi.hoisted(() => {
  const defaultChainMock = vi.fn();
  return { defaultChainMock, defaultProviderMock: vi.fn(() => defaultChainMock) };
});
vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: defaultProviderMock }));

const {
  AUTH_OFF_PLACEHOLDER_CREDENTIALS,
  CA_TRUST_ENV_KEYS,
  activateWorkloadAwsWiring,
  applyWorkloadAwsWiringToEnv,
  collectHostEndpointOverrides,
  getActiveWorkloadAwsWiring,
  parseAwsEndpoint,
  readEmulatorRunFiles,
  resetWorkloadAwsWiringForTest,
  resolveHostDefaultCredentials,
  resolveWorkloadAwsWiring,
  writeCaBundleFile,
} = await import('../../../src/local/workload-aws-wiring.js');
const { buildProxyClientConfig, getAwsEndpointOverride } = await import(
  '../../../src/utils/aws-proxy.js'
);

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const EMU_KEY = { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'A'.repeat(40) };

let home: string;

function writeEmulatorRun(port: number, opts: { credentials?: boolean } = {}): string {
  const dir = path.join(home, '.aws', 'emulator', String(port));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ca.pem'), PEM, { mode: 0o600 });
  writeFileSync(path.join(dir, 'config'), '[default]\nregion = us-east-1\n');
  if (opts.credentials !== false) {
    writeFileSync(
      path.join(dir, 'emulator_credentials'),
      `[default]\naws_access_key_id = ${EMU_KEY.accessKeyId}\naws_secret_access_key = ${EMU_KEY.secretAccessKey}\n`,
      { mode: 0o600 }
    );
  }
  return dir;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'wiring-home-'));
  defaultChainMock.mockReset();
  defaultProviderMock.mockClear();
  resetWorkloadAwsWiringForTest();
});

afterEach(() => {
  resetWorkloadAwsWiringForTest();
  rmSync(home, { recursive: true, force: true });
});

describe('parseAwsEndpoint', () => {
  it('parses a loopback https endpoint with its port', () => {
    expect(parseAwsEndpoint('https://127.0.0.1:9297/')).toEqual({
      url: 'https://127.0.0.1:9297',
      hostname: '127.0.0.1',
      port: 9297,
      loopback: true,
    });
  });

  it('defaults the port from the scheme and flags non-loopback hosts', () => {
    expect(parseAwsEndpoint('https://emulator.example.com')).toMatchObject({ port: 443, loopback: false });
    expect(parseAwsEndpoint('http://localhost')).toMatchObject({ port: 80, loopback: true });
  });

  it('rejects non-URLs, other schemes, and URLs with a path or credentials', () => {
    expect(() => parseAwsEndpoint('127.0.0.1:9297')).toThrow(/http\(s\) URL|not a URL/);
    expect(() => parseAwsEndpoint('ftp://127.0.0.1')).toThrow(/http\(s\) URL/);
    expect(() => parseAwsEndpoint('https://127.0.0.1:9297/x')).toThrow(/bare/);
    expect(() => parseAwsEndpoint('https://u:p@127.0.0.1:9297')).toThrow(/bare/);
  });
});

describe('collectHostEndpointOverrides', () => {
  it('forwards AWS_ENDPOINT_URL and every AWS_ENDPOINT_URL_<SERVICE>', () => {
    expect(
      collectHostEndpointOverrides(
        {
          AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
          AWS_ENDPOINT_URL_S3: 'http://10.0.0.5:4566',
          AWS_ENDPOINT: 'ignored',
          HOME: home,
        },
        { homeDir: home }
      )
    ).toEqual({ AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_ENDPOINT_URL_S3: 'http://10.0.0.5:4566' });
  });

  it("falls back to the active profile's endpoint_url", () => {
    mkdirSync(path.join(home, '.aws'));
    writeFileSync(
      path.join(home, '.aws', 'config'),
      '[default]\nendpoint_url = https://127.0.0.1:1111\n[profile emu]\nendpoint_url = https://127.0.0.1:9297\n'
    );
    expect(collectHostEndpointOverrides({}, { homeDir: home })).toEqual({
      AWS_ENDPOINT_URL: 'https://127.0.0.1:1111',
    });
    expect(collectHostEndpointOverrides({ AWS_PROFILE: 'emu' }, { homeDir: home })).toEqual({
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
    });
    expect(collectHostEndpointOverrides({}, { homeDir: home, profile: 'emu' })).toEqual({
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
    });
  });

  it('honours AWS_IGNORE_CONFIGURED_ENDPOINT_URLS and drops values that are not URLs', () => {
    expect(
      collectHostEndpointOverrides(
        { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
        { homeDir: home }
      )
    ).toEqual({});
    expect(collectHostEndpointOverrides({ AWS_ENDPOINT_URL_SQS: 'not a url' }, { homeDir: home })).toEqual({});
  });
});

describe('readEmulatorRunFiles', () => {
  it('reads the run keys and CA path for the port', () => {
    const dir = writeEmulatorRun(9297);
    expect(readEmulatorRunFiles(9297, home)).toEqual({
      dir,
      present: true,
      credentials: EMU_KEY,
      caPath: path.join(dir, 'ca.pem'),
    });
  });

  it('reports a run without keys (--auth off) and a port with no run', () => {
    writeEmulatorRun(9300, { credentials: false });
    expect(readEmulatorRunFiles(9300, home)).toMatchObject({ present: true });
    expect(readEmulatorRunFiles(9300, home).credentials).toBeUndefined();
    expect(readEmulatorRunFiles(9399, home)).toMatchObject({ present: false });
  });
});

describe('writeCaBundleFile', () => {
  it('writes the PEM plus the public roots, world-readable', () => {
    const src = path.join(home, 'ca.pem');
    writeFileSync(src, PEM, { mode: 0o600 });
    const f = writeCaBundleFile(src);
    try {
      const text = readFileSync(f.hostPath, 'utf8');
      expect(text.startsWith(PEM.trimEnd())).toBe(true);
      expect(text.split('-----BEGIN CERTIFICATE-----').length).toBeGreaterThan(10);
      expect(statSync(f.hostPath).mode & 0o777).toBe(0o644);
    } finally {
      f.dispose();
    }
  });

  it('refuses a file with no PEM certificate', () => {
    const src = path.join(home, 'x.txt');
    writeFileSync(src, 'nope');
    expect(() => writeCaBundleFile(src)).toThrow(/no PEM certificate/);
    expect(() => writeCaBundleFile(path.join(home, 'missing.pem'))).toThrow(/cannot be read/);
  });
});

describe('resolveWorkloadAwsWiring — forward mode (no --emulator-endpoint)', () => {
  it('is empty when the host carries no override and no CA', async () => {
    const w = await resolveWorkloadAwsWiring({ env: {}, homeDir: home });
    expect(w).toMatchObject({ mode: 'forward', env: {}, mounts: [], loopbackPorts: [] });
  });

  it('forwards endpoints unchanged, collects loopback ports, and mounts AWS_CA_BUNDLE', async () => {
    const ca = path.join(home, 'ca.pem');
    writeFileSync(ca, PEM);
    const w = await resolveWorkloadAwsWiring({
      env: {
        AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
        AWS_ENDPOINT_URL_S3: 'https://localhost:9400',
        AWS_ENDPOINT_URL_SQS: 'https://10.1.2.3:4566',
        AWS_CA_BUNDLE: ca,
      },
      homeDir: home,
    });
    try {
      expect(w.env).toMatchObject({
        AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
        AWS_ENDPOINT_URL_S3: 'https://localhost:9400',
        AWS_ENDPOINT_URL_SQS: 'https://10.1.2.3:4566',
      });
      expect(w.loopbackPorts).toEqual([9297, 9400]);
      for (const k of CA_TRUST_ENV_KEYS) expect(w.env[k]).toBe('/cdk-local-aws/ca-bundle.pem');
      expect(w.mounts).toEqual([{ hostPath: w.caHostPath, containerPath: '/cdk-local-aws/ca-bundle.pem' }]);
      expect(w.probeHealth).toBe(false);
    } finally {
      w.dispose();
    }
  });

  it('prefers --ca-bundle over AWS_CA_BUNDLE and expands ~', async () => {
    writeFileSync(path.join(home, 'flag.pem'), PEM.replace('fake', 'flag'));
    writeFileSync(path.join(home, 'env.pem'), PEM);
    const w = await resolveWorkloadAwsWiring({
      caBundle: '~/flag.pem',
      env: { AWS_CA_BUNDLE: path.join(home, 'env.pem') },
      homeDir: home,
    });
    try {
      expect(readFileSync(w.caHostPath!, 'utf8')).toContain('MIIBflag');
    } finally {
      w.dispose();
    }
  });
});

describe('resolveWorkloadAwsWiring — emulator mode', () => {
  it('uses the run keys and CA, forces the endpoint + hygiene vars, and probes health', async () => {
    writeEmulatorRun(9297);
    const w = await resolveWorkloadAwsWiring({
      emulatorEndpoint: 'https://127.0.0.1:9297',
      env: { AWS_ENDPOINT_URL_S3: 'https://elsewhere.example.com' },
      homeDir: home,
    });
    try {
      expect(w.mode).toBe('emulator');
      expect(w.emulatorCredentials).toEqual(EMU_KEY);
      expect(w.env).toMatchObject({
        AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
        NODE_EXTRA_CA_CERTS: '/cdk-local-aws/ca-bundle.pem',
      });
      // The host's own service overrides are not forwarded under the flag.
      expect(w.env['AWS_ENDPOINT_URL_S3']).toBeUndefined();
      expect(w.loopbackPorts).toEqual([9297]);
      expect(w.probeHealth).toBe(true);
      expect(readFileSync(w.caHostPath!, 'utf8').startsWith(PEM.trimEnd())).toBe(true);
    } finally {
      w.dispose();
    }
  });

  it('hands placeholder keys to a run started with --auth off', async () => {
    writeEmulatorRun(9300, { credentials: false });
    const w = await resolveWorkloadAwsWiring({ emulatorEndpoint: 'https://127.0.0.1:9300', env: {}, homeDir: home });
    try {
      expect(w.emulatorCredentials).toEqual(AUTH_OFF_PLACEHOLDER_CREDENTIALS);
    } finally {
      w.dispose();
    }
  });

  it('falls back to the profile chain (never env vars) for an endpoint with no run files', async () => {
    const fallback = vi.fn(async () => ({ accessKeyId: 'PROFILEKEY', secretAccessKey: 's' }));
    const w = await resolveWorkloadAwsWiring({
      emulatorEndpoint: 'http://10.0.0.9:4566',
      env: { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real' },
      homeDir: home,
      resolveFallbackCredentials: fallback,
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(w.emulatorCredentials).toEqual({ accessKeyId: 'PROFILEKEY', secretAccessKey: 's' });
    expect(w.loopbackPorts).toEqual([]);
    expect(w.probeHealth).toBe(false);
  });
});

describe('applyWorkloadAwsWiringToEnv', () => {
  const forward = {
    mode: 'forward' as const,
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_CA_BUNDLE: '/cdk-local-aws/ca-bundle.pem' },
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9297],
    probeHealth: false,
    dispose: () => undefined,
  };
  const emulator = {
    ...forward,
    mode: 'emulator' as const,
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:9297', AWS_EC2_METADATA_DISABLED: 'true' },
    scrubEnvKeys: ['AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE'],
    emulatorCredentials: EMU_KEY,
  };

  it('forward: fills only keys the container env does not set', () => {
    const out = applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL: 'http://mine:1', A: '1' }, forward);
    expect(out).toEqual({
      AWS_ENDPOINT_URL: 'http://mine:1',
      AWS_CA_BUNDLE: '/cdk-local-aws/ca-bundle.pem',
      A: '1',
    });
  });

  it('forward: default-chain credentials fill only an env without AWS_ACCESS_KEY_ID', () => {
    const chain = { accessKeyId: 'CHAIN', secretAccessKey: 'cs', sessionToken: 'ct' };
    expect(applyWorkloadAwsWiringToEnv({}, forward, chain)).toMatchObject({
      AWS_ACCESS_KEY_ID: 'CHAIN',
      AWS_SECRET_ACCESS_KEY: 'cs',
      AWS_SESSION_TOKEN: 'ct',
    });
    // --assume-role / --profile already put a triple in the env: it wins.
    expect(
      applyWorkloadAwsWiringToEnv({ AWS_ACCESS_KEY_ID: 'ROLE', AWS_SECRET_ACCESS_KEY: 'rs' }, forward, chain)
    ).toMatchObject({ AWS_ACCESS_KEY_ID: 'ROLE', AWS_SECRET_ACCESS_KEY: 'rs' });
  });

  it('emulator: scrubs host credential sources and replaces the triple with the run keys', () => {
    const out = applyWorkloadAwsWiringToEnv(
      {
        AWS_ACCESS_KEY_ID: 'AKIAREAL',
        AWS_SECRET_ACCESS_KEY: 'real',
        AWS_SESSION_TOKEN: 'realtoken',
        AWS_PROFILE: 'prod',
        AWS_SHARED_CREDENTIALS_FILE: '/cdk-local-aws/credentials',
        AWS_ENDPOINT_URL: 'https://real.example.com',
        TABLE_NAME: 't',
      },
      emulator
    );
    expect(out).toEqual({
      AWS_ACCESS_KEY_ID: EMU_KEY.accessKeyId,
      AWS_SECRET_ACCESS_KEY: EMU_KEY.secretAccessKey,
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9297',
      AWS_EC2_METADATA_DISABLED: 'true',
      TABLE_NAME: 't',
    });
  });

  it('emulator: with no endpoint keys the container gets no credentials at all', () => {
    const { emulatorCredentials: _unused, ...noKeys } = emulator;
    const out = applyWorkloadAwsWiringToEnv({ AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'r' }, noKeys);
    expect(out['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(out['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('mirrors AWS_REGION into AWS_DEFAULT_REGION (boto3 reads only the latter)', () => {
    expect(applyWorkloadAwsWiringToEnv({ AWS_REGION: 'us-east-1' }, forward)['AWS_DEFAULT_REGION']).toBe(
      'us-east-1'
    );
    expect(
      applyWorkloadAwsWiringToEnv({ AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'eu-west-1' }, forward)[
        'AWS_DEFAULT_REGION'
      ]
    ).toBe('eu-west-1');
  });
});

describe('resolveHostDefaultCredentials (cdkd#6129)', () => {
  it('resolves the SDK default chain once per process', async () => {
    defaultChainMock.mockResolvedValue({ accessKeyId: 'K', secretAccessKey: 'S', sessionToken: 'T' });
    await expect(resolveHostDefaultCredentials()).resolves.toEqual({
      accessKeyId: 'K',
      secretAccessKey: 'S',
      sessionToken: 'T',
    });
    await resolveHostDefaultCredentials();
    expect(defaultChainMock).toHaveBeenCalledOnce();
  });

  it('resolves undefined when the chain finds nothing', async () => {
    defaultChainMock.mockRejectedValue(new Error('Could not load credentials from any providers'));
    await expect(resolveHostDefaultCredentials()).resolves.toBeUndefined();
  });
});

describe('activateWorkloadAwsWiring', () => {
  it('under --emulator-endpoint, installs the wiring and points cdk-local clients at the endpoint', async () => {
    writeEmulatorRun(9297);
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const w = await activateWorkloadAwsWiring({ emulatorEndpoint: 'https://127.0.0.1:9297' });
      expect(getActiveWorkloadAwsWiring()).toBe(w);
      expect(getAwsEndpointOverride()).toMatchObject({ endpoint: 'https://127.0.0.1:9297', credentials: EMU_KEY });
      const cfg = buildProxyClientConfig({ profile: 'prod' });
      expect(cfg.endpoint).toBe('https://127.0.0.1:9297');
      expect(cfg.requestHandler).toBeDefined();
      await expect(cfg.credentials!({})).resolves.toEqual(EMU_KEY);
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
  });

  it('reads the endpoint from CDKL_EMULATOR_ENDPOINT when the flag is absent', async () => {
    process.env['CDKL_EMULATOR_ENDPOINT'] = 'http://10.0.0.9:4566';
    try {
      const w = await activateWorkloadAwsWiring({});
      expect(w.mode).toBe('emulator');
      expect(w.emulatorEndpoint?.url).toBe('http://10.0.0.9:4566');
    } finally {
      delete process.env['CDKL_EMULATOR_ENDPOINT'];
    }
  });

  it('without the flag, leaves cdk-local clients on their default endpoints', async () => {
    await activateWorkloadAwsWiring({});
    expect(getAwsEndpointOverride()).toBeUndefined();
    expect(buildProxyClientConfig().endpoint).toBeUndefined();
  });
});
