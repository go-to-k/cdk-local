import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  EMULATOR_SCRUBBED_ENV_KEYS,
  effectiveLoopbackPorts,
  DEFAULT_AWS_EMULATOR_URL,
  awsEmulatorEnvName,
  probeAwsEmulatorHealth,
  resolveAwsEmulatorOption,
  getActiveWorkloadAwsWiring,
  parseAwsEndpoint,
  readEmulatorRunFiles,
  mergeJavaToolOptions,
  resetWorkloadAwsWiringForTest,
  resolveHostDefaultCredentials,
  resolveWorkloadAwsWiring,
  writeCaBundleFile,
} = await import('../../../src/local/workload-aws-wiring.js');
const { buildProxyClientConfig, getAwsEndpointOverride, setAwsEndpointOverride } = await import(
  '../../../src/utils/aws-proxy.js'
);
const { recordAssumedRole, resetWorkloadIdentity, workloadClientConfig } = await import(
  '../../../src/utils/workload-identity.js'
);
const { setEmbedConfig } = await import('../../../src/local/embed-config.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const EMU_KEY = { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'A'.repeat(40) };

let home: string;

const TRUSTSTORE = Buffer.from([0x30, 0x82, 0x01, 0x00, 0xde, 0xad, 0xbe, 0xef]);

function writeEmulatorRun(
  port: number,
  opts: { credentials?: boolean; truststore?: boolean } = {}
): string {
  const dir = path.join(home, '.aws', 'emulator', String(port));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ca.pem'), PEM, { mode: 0o600 });
  if (opts.truststore) writeFileSync(path.join(dir, 'truststore.p12'), TRUSTSTORE, { mode: 0o600 });
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

  it('reports the Java trust store when the run wrote one', () => {
    const dir = writeEmulatorRun(9297, { truststore: true });
    expect(readEmulatorRunFiles(9297, home).truststorePath).toBe(path.join(dir, 'truststore.p12'));
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

  it('copies certificate blocks only, never a private key', () => {
    const src = path.join(home, 'fullchain.pem');
    writeFileSync(src, `${PEM}-----BEGIN PRIVATE KEY-----\nSECRETKEY\n-----END PRIVATE KEY-----\n`);
    const f = writeCaBundleFile(src);
    try {
      const text = readFileSync(f.hostPath, 'utf8');
      expect(text).toContain('MIIBfake');
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain('SECRETKEY');
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

describe('resolveWorkloadAwsWiring — forward mode (no --aws-emulator)', () => {
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

describe('resolveWorkloadAwsWiring — --aws-emulator', () => {
  const healthy = vi.fn(async () => undefined);

  it('uses the run keys and CA, forces the endpoint + hygiene vars, and probes health', async () => {
    writeEmulatorRun(9297);
    const w = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9297',
      env: { AWS_ENDPOINT_URL_S3: 'https://elsewhere.example.com' },
      homeDir: home,
      probeHealth: healthy,
    });
    try {
      expect(healthy).toHaveBeenCalledWith('https://127.0.0.1:9297', path.join(home, '.aws/emulator/9297/ca.pem'));
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

  it('defaults to https://127.0.0.1:9297 and lets the port select the run directory', async () => {
    writeEmulatorRun(9297);
    writeEmulatorRun(9301);
    const def = await resolveWorkloadAwsWiring({ awsEmulator: true, env: {}, homeDir: home, probeHealth: healthy });
    expect(def.emulatorEndpoint?.url).toBe(DEFAULT_AWS_EMULATOR_URL);
    def.dispose();
    const other = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9301',
      env: {},
      homeDir: home,
      probeHealth: healthy,
    });
    expect(other.loopbackPorts).toEqual([9301]);
    other.dispose();
  });

  it('hands fixed placeholder keys (never real ones) to a healthy run without a keys file (--auth off)', async () => {
    writeEmulatorRun(9300, { credentials: false });
    const w = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9300',
      env: { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real' },
      homeDir: home,
      probeHealth: healthy,
    });
    try {
      expect(w.emulatorCredentials).toEqual(AUTH_OFF_PLACEHOLDER_CREDENTIALS);
    } finally {
      w.dispose();
    }
  });

  it('fails with actionable advice when the emulator does not answer its health check', async () => {
    await expect(
      resolveWorkloadAwsWiring({
        awsEmulator: 'https://127.0.0.1:9399',
        env: {},
        homeDir: home,
        probeHealth: async () => 'ECONNREFUSED',
      })
    ).rejects.toThrow(/no AWS Emulator answers its health check .*ECONNREFUSED.*running on port 9399/);
  });
});

describe('--aws-emulator: Java trust store', () => {
  const healthy = vi.fn(async () => undefined);
  const JAVA_OPTS =
    '-Djavax.net.ssl.trustStore=/cdk-local-aws/truststore.p12 -Djavax.net.ssl.trustStoreType=PKCS12';

  it("mounts a world-readable copy of the run's truststore.p12 and points JAVA_TOOL_OPTIONS at it", async () => {
    writeEmulatorRun(9297, { truststore: true });
    const w = await resolveWorkloadAwsWiring({ awsEmulator: true, env: {}, homeDir: home, probeHealth: healthy });
    try {
      expect(w.env['JAVA_TOOL_OPTIONS']).toBe(JAVA_OPTS);
      const mount = w.mounts.find((m) => m.containerPath === '/cdk-local-aws/truststore.p12');
      expect(mount).toBeDefined();
      // A copy, not the private run file: the container user may not be the host user.
      expect(mount!.hostPath).not.toContain(path.join('.aws', 'emulator'));
      expect(readFileSync(mount!.hostPath)).toEqual(TRUSTSTORE);
      expect(statSync(mount!.hostPath).mode & 0o777).toBe(0o644);
      // The PEM bundle mount is still there for the other runtimes.
      expect(w.mounts.map((m) => m.containerPath)).toContain('/cdk-local-aws/ca-bundle.pem');
      w.dispose();
      expect(() => statSync(mount!.hostPath)).toThrow();
    } finally {
      w.dispose();
    }
  });

  it('sets no JAVA_TOOL_OPTIONS when the run has no truststore.p12, or the endpoint is plain http', async () => {
    writeEmulatorRun(9297);
    const noStore = await resolveWorkloadAwsWiring({ awsEmulator: true, env: {}, homeDir: home, probeHealth: healthy });
    expect(noStore.env['JAVA_TOOL_OPTIONS']).toBeUndefined();
    noStore.dispose();
    writeEmulatorRun(9302, { truststore: true });
    const http = await resolveWorkloadAwsWiring({
      awsEmulator: 'http://127.0.0.1:9302',
      env: {},
      homeDir: home,
      probeHealth: healthy,
    });
    expect(http.env['JAVA_TOOL_OPTIONS']).toBeUndefined();
    expect(http.mounts).toEqual([]);
    http.dispose();
  });

  it('forward mode (a plain --ca-bundle PEM) sets no JAVA_TOOL_OPTIONS', async () => {
    const pem = path.join(home, 'ca.pem');
    writeFileSync(pem, PEM);
    const w = await resolveWorkloadAwsWiring({ caBundle: pem, env: {}, homeDir: home });
    expect(w.env['JAVA_TOOL_OPTIONS']).toBeUndefined();
    w.dispose();
  });

  it('an unreadable truststore.p12 skips only the Java wiring, with a warning', async () => {
    const dir = writeEmulatorRun(9297);
    mkdirSync(path.join(dir, 'truststore.p12')); // EISDIR on read
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const w = await resolveWorkloadAwsWiring({ awsEmulator: true, env: {}, homeDir: home, probeHealth: healthy });
    try {
      expect(w.env['JAVA_TOOL_OPTIONS']).toBeUndefined();
      expect(w.mounts.map((m) => m.containerPath)).toEqual(['/cdk-local-aws/ca-bundle.pem']);
      expect(warn.mock.calls.some((c) => /truststore\.p12 cannot be read/.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
      w.dispose();
    }
  });

  it("appends to a container's own JAVA_TOOL_OPTIONS instead of replacing it", async () => {
    writeEmulatorRun(9297, { truststore: true });
    const w = await resolveWorkloadAwsWiring({ awsEmulator: true, env: {}, homeDir: home, probeHealth: healthy });
    try {
      expect(applyWorkloadAwsWiringToEnv({ JAVA_TOOL_OPTIONS: '-Xmx256m' }, w)['JAVA_TOOL_OPTIONS']).toBe(
        `-Xmx256m ${JAVA_OPTS}`
      );
      expect(applyWorkloadAwsWiringToEnv({}, w)['JAVA_TOOL_OPTIONS']).toBe(JAVA_OPTS);
    } finally {
      w.dispose();
    }
  });

  it('mergeJavaToolOptions keeps a value that already names a trust store', () => {
    const own = '-Djavax.net.ssl.trustStore=/opt/my.jks -Xss1m';
    expect(mergeJavaToolOptions(own, JAVA_OPTS)).toBe(own);
    expect(mergeJavaToolOptions('  ', JAVA_OPTS)).toBe(JAVA_OPTS);
    expect(mergeJavaToolOptions(undefined, JAVA_OPTS)).toBe(JAVA_OPTS);
  });
});

describe('resolveAwsEmulatorOption', () => {
  it('takes the flag first, then CDK_LOCAL_AWS_EMULATOR (1/true = default URL)', () => {
    expect(awsEmulatorEnvName()).toBe('CDK_LOCAL_AWS_EMULATOR');
    expect(resolveAwsEmulatorOption('https://127.0.0.1:9300', {})).toBe('https://127.0.0.1:9300');
    expect(resolveAwsEmulatorOption(true, {})).toBe(true);
    expect(resolveAwsEmulatorOption(undefined, {})).toBeUndefined();
    expect(resolveAwsEmulatorOption(undefined, { CDK_LOCAL_AWS_EMULATOR: 'true' })).toBe(true);
    expect(resolveAwsEmulatorOption(undefined, { CDK_LOCAL_AWS_EMULATOR: '1' })).toBe(true);
    expect(resolveAwsEmulatorOption(undefined, { CDK_LOCAL_AWS_EMULATOR: 'false' })).toBeUndefined();
    expect(resolveAwsEmulatorOption(undefined, { CDK_LOCAL_AWS_EMULATOR: 'https://127.0.0.1:9400' })).toBe(
      'https://127.0.0.1:9400'
    );
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
  afterEach(() => resetWorkloadIdentity());

  it('builds one SDK provider and asks it on every call (the SDK refreshes expiring keys)', async () => {
    defaultChainMock.mockResolvedValue({ accessKeyId: 'K', secretAccessKey: 'S', sessionToken: 'T' });
    await expect(resolveHostDefaultCredentials()).resolves.toEqual({
      accessKeyId: 'K',
      secretAccessKey: 'S',
      sessionToken: 'T',
    });
    await resolveHostDefaultCredentials();
    expect(defaultProviderMock).toHaveBeenCalledTimes(1);
    expect(defaultProviderMock).toHaveBeenCalledWith({});
    expect(defaultChainMock).toHaveBeenCalledTimes(2);
  });

  it('honours a profile per call', async () => {
    defaultChainMock.mockResolvedValue({ accessKeyId: 'K', secretAccessKey: 'S' });
    await resolveHostDefaultCredentials({ profile: 'dev' });
    expect(defaultProviderMock).toHaveBeenCalledWith({ profile: 'dev' });
  });

  it('after a --role-arn assume, reads the chain WITHOUT its env link (the env holds the role)', async () => {
    recordAssumedRole(undefined, { accessKeyId: 'ROLE', secretAccessKey: 'r', sessionToken: 't' });
    defaultChainMock.mockResolvedValue({ accessKeyId: 'CALLER', secretAccessKey: 'c' });
    await resolveHostDefaultCredentials();
    expect(defaultProviderMock).toHaveBeenCalledWith({ profile: 'default' });
  });

  it('resolves undefined when the chain finds nothing, and remembers the miss briefly', async () => {
    defaultChainMock.mockRejectedValue(new Error('Could not load credentials from any providers'));
    await expect(resolveHostDefaultCredentials()).resolves.toBeUndefined();
    await expect(resolveHostDefaultCredentials()).resolves.toBeUndefined();
    expect(defaultChainMock).toHaveBeenCalledTimes(1);
  });
});

describe('workloadClientConfig under an endpoint override', () => {
  afterEach(() => resetWorkloadIdentity());

  it('signs with the emulator keys even in caller mode after an assume', async () => {
    setEmbedConfig({ workloadIdentity: 'caller' });
    try {
      recordAssumedRole(
        { accessKeyId: 'CALLERREAL', secretAccessKey: 'real' },
        { accessKeyId: 'ROLE', secretAccessKey: 'r', sessionToken: 't' }
      );
      setAwsEndpointOverride({ endpoint: 'https://127.0.0.1:9297', credentials: EMU_KEY });
      await expect(workloadClientConfig().credentials!({})).resolves.toEqual(EMU_KEY);
    } finally {
      setEmbedConfig(undefined);
    }
  });
});

describe('scrub and CA details', () => {
  const healthy = async (): Promise<undefined> => undefined;

  it('emulator mode scrubs every key in EMULATOR_SCRUBBED_ENV_KEYS', async () => {
    writeEmulatorRun(9297);
    const w = await resolveWorkloadAwsWiring({ awsEmulator: true, env: {}, homeDir: home, probeHealth: healthy });
    try {
      expect(w.scrubEnvKeys).toEqual(EMULATOR_SCRUBBED_ENV_KEYS);
      const dirty = Object.fromEntries(EMULATOR_SCRUBBED_ENV_KEYS.map((k) => [k, 'x']));
      const out = applyWorkloadAwsWiringToEnv(dirty, w);
      for (const k of EMULATOR_SCRUBBED_ENV_KEYS) expect(out[k]).toBeUndefined();
    } finally {
      w.dispose();
    }
  });

  it('emulator mode: --ca-bundle beats the run ca.pem; an http URL mounts no CA; localhost becomes 127.0.0.1', async () => {
    writeEmulatorRun(9297);
    writeFileSync(path.join(home, 'flag.pem'), PEM.replace('fake', 'flag'));
    const probe = vi.fn(healthy);
    const flagged = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://localhost:9297',
      caBundle: path.join(home, 'flag.pem'),
      env: {},
      homeDir: home,
      probeHealth: probe,
    });
    expect(flagged.emulatorEndpoint?.url).toBe('https://127.0.0.1:9297');
    // The host probe trusts the same bundle that gets mounted.
    expect(probe).toHaveBeenCalledWith('https://127.0.0.1:9297', path.join(home, 'flag.pem'));
    expect(readFileSync(flagged.caHostPath!, 'utf8')).toContain('MIIBflag');
    flagged.dispose();
    writeEmulatorRun(9302);
    const plain = await resolveWorkloadAwsWiring({
      awsEmulator: 'http://127.0.0.1:9302',
      env: {},
      homeDir: home,
      probeHealth: healthy,
    });
    expect(plain.mounts).toEqual([]);
    expect(plain.probeHealth).toBe(false);
  });

  it("forward mode mounts the profile's ca_bundle, and skips an unusable host bundle with a warning", async () => {
    mkdirSync(path.join(home, '.aws'));
    writeFileSync(path.join(home, 'p.pem'), PEM);
    writeFileSync(path.join(home, '.aws', 'config'), `[default]\nca_bundle = ${path.join(home, 'p.pem')}\n`);
    const w = await resolveWorkloadAwsWiring({ env: {}, homeDir: home });
    expect(w.mounts).toHaveLength(1);
    w.dispose();
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const skipped = await resolveWorkloadAwsWiring({
      env: { AWS_CA_BUNDLE: path.join(home, 'missing.pem') },
      homeDir: home,
    });
    expect(skipped.mounts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cannot be read.*not mounted/));
    warn.mockRestore();
    await expect(
      resolveWorkloadAwsWiring({ caBundle: path.join(home, 'missing.pem'), env: {}, homeDir: home })
    ).rejects.toThrow(/cannot be read/);
  });

  it('effectiveLoopbackPorts drops a forwarded port the final env no longer uses', () => {
    const w = {
      mode: 'forward' as const,
      env: {},
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [9297, 9400],
      probeHealth: false,
      dispose: () => undefined,
    };
    expect(
      effectiveLoopbackPorts(
        { AWS_ENDPOINT_URL: 'http://task-declared:1', AWS_ENDPOINT_URL_S3: 'https://localhost:9400' },
        w
      )
    ).toEqual([9400]);
  });
});

describe('activateWorkloadAwsWiring', () => {
  it('under --aws-emulator, installs the wiring and points cdk-local clients at the emulator', async () => {
    writeEmulatorRun(9297);
    const prevHome = process.env['HOME'];
    process.env['HOME'] = home;
    const server = await startHealthServer();
    try {
      // The health probe must answer: point the flag at a plain-http stand-in
      // whose port has a run directory.
      writeEmulatorRun(server.port);
      const w = await activateWorkloadAwsWiring({ awsEmulator: `http://127.0.0.1:${server.port}` });
      expect(getActiveWorkloadAwsWiring()).toBe(w);
      expect(getAwsEndpointOverride()).toMatchObject({
        endpoint: `http://127.0.0.1:${server.port}`,
        credentials: EMU_KEY,
      });
      // http URL: no CA to trust.
      expect(getAwsEndpointOverride()?.caPem).toBeUndefined();
      const cfg = buildProxyClientConfig({ profile: 'prod' });
      expect(cfg.endpoint).toBe(`http://127.0.0.1:${server.port}`);
      expect(cfg.requestHandler).toBeDefined();
      await expect(cfg.credentials!({})).resolves.toEqual(EMU_KEY);
    } finally {
      await server.close();
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
  });

  it('without the flag, leaves cdk-local clients on their default endpoints', async () => {
    vi.stubEnv('HOME', home);
    vi.stubEnv('AWS_CA_BUNDLE', '');
    vi.stubEnv('AWS_CONFIG_FILE', path.join(home, 'none'));
    vi.stubEnv('CDK_LOCAL_AWS_EMULATOR', '');
    await activateWorkloadAwsWiring({});
    vi.unstubAllEnvs();
    expect(getAwsEndpointOverride()).toBeUndefined();
    expect(buildProxyClientConfig().endpoint).toBeUndefined();
  });
});

async function startHealthServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.statusCode = req.url === '/__admin/health' ? 200 : 404;
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

describe('probeAwsEmulatorHealth', () => {
  it('resolves undefined on 200 and a reason otherwise', async () => {
    const server = await startHealthServer();
    try {
      await expect(probeAwsEmulatorHealth(`http://127.0.0.1:${server.port}`, undefined)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
    await expect(probeAwsEmulatorHealth(`http://127.0.0.1:${server.port}`, undefined)).resolves.toBe(
      'ECONNREFUSED'
    );
  });
});
