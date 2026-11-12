import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
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
  CA_TRUST_ENV_KEYS,
  activateWorkloadAwsWiring,
  applyWorkloadAwsWiringToEnv,
  effectiveLoopbackPorts,
  loopbackForwarderPlan,
  resetWorkloadAwsWiringForTest,
  resolveWorkloadAwsWiring,
} = await import('../../../src/local/workload-aws-wiring.js');
const { findAwsEmulatorSentinels, MIXED_MODE_RESIGN_PORT } = await import(
  '../../../src/local/aws-emulator-mixed-mode.js'
);
const { getAwsEndpointOverride, setAwsEndpointOverride } = await import('../../../src/utils/aws-proxy.js');
const { createMixedModeTlsMaterials } = await import('../../../src/local/mixed-mode-tls.js');
const { buildLoopbackForwarderDockerArgs, buildNamespaceOwnerForwarderDockerArgs } = await import(
  '../../../src/local/loopback-forwarder.js'
);
const { MIXED_MODE_RESIGN_BODY_CAP_BYTES } = await import('../../../src/local/emulator-resign-sidecar.js');

const EMU_CA = createMixedModeTlsMaterials().caCertPem;
const EMU_KEY = { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'A'.repeat(40) };
const REAL = { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real-secret', AWS_SESSION_TOKEN: 'real-tok' };
const SENTINELS = findAwsEmulatorSentinels({
  Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' },
  'Stack/Fn': { AWS_ENDPOINT_URL_S3: 'aws-emulator' },
});

let home: string;

function writeEmulatorRun(port: number, credentials = true): void {
  const dir = path.join(home, '.aws', 'emulator', String(port));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ca.pem'), EMU_CA, { mode: 0o600 });
  if (credentials) {
    writeFileSync(
      path.join(dir, 'emulator_credentials'),
      `[default]\naws_access_key_id = ${EMU_KEY.accessKeyId}\naws_secret_access_key = ${EMU_KEY.secretAccessKey}\n`,
      { mode: 0o600 }
    );
  }
}

const healthy = async (): Promise<undefined> => undefined;

async function mixed(port = 9361, credentials = true, env: NodeJS.ProcessEnv = {}) {
  writeEmulatorRun(port, credentials);
  return resolveWorkloadAwsWiring({
    awsEmulator: `https://127.0.0.1:${port}`,
    awsEmulatorSentinels: SENTINELS,
    homeDir: home,
    env,
    probeHealth: healthy,
  });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'wiring-mixed-'));
  resetWorkloadAwsWiringForTest();
});

afterEach(() => {
  resetWorkloadAwsWiringForTest();
  rmSync(home, { recursive: true, force: true });
});

describe('resolveWorkloadAwsWiring — mixed mode', () => {
  it('stays forward mode (real identity) with the sidecar, its config and a two-CA trust bundle', async () => {
    const w = await mixed();
    try {
      expect(w.mode).toBe('forward');
      expect(w.emulatorCredentials).toBeUndefined();
      expect(w.scrubEnvKeys).toEqual([]);
      expect(w.mixed).toMatchObject({
        services: ['DYNAMODB', 'S3'],
        resignPort: MIXED_MODE_RESIGN_PORT,
        resignEndpoint: `https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`,
        emulatorClientOverride: { endpoint: 'https://127.0.0.1:9361', credentials: EMU_KEY },
      });
      expect(w.loopbackPorts).toEqual([9361, MIXED_MODE_RESIGN_PORT]);
      expect(w.probeHealth).toBe(true);
      for (const k of CA_TRUST_ENV_KEYS) expect(w.env[k]).toBe('/cdk-local-aws/ca-bundle.pem');
      expect(w.env['AWS_ENDPOINT_URL']).toBeUndefined();

      // The bundle: the emulator CA, the sidecar's per-run CA, then the public roots.
      const bundle = readFileSync(w.caHostPath!, 'utf8');
      expect(bundle).toContain(EMU_CA.trim());
      const cfg = JSON.parse(readFileSync(w.mixed!.resignConfigHostPath, 'utf8'));
      const leaf = new X509Certificate(cfg.certPem);
      const certs = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!;
      expect(certs.some((c) => leaf.checkIssued(new X509Certificate(c)))).toBe(true);
      expect(bundle).not.toContain('PRIVATE KEY');
      expect(statSync(w.caHostPath!).mode & 0o777).toBe(0o644);

      // The config: 0600 in a 0700 dir, the emulator keys, never a CA private key.
      expect(statSync(w.mixed!.resignConfigHostPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(w.mixed!.resignConfigHostPath)).mode & 0o777).toBe(0o700);
      expect(cfg).toMatchObject({
        port: MIXED_MODE_RESIGN_PORT,
        upstream: 'https://127.0.0.1:9361',
        credentials: EMU_KEY,
        capBytes: MIXED_MODE_RESIGN_BODY_CAP_BYTES,
      });
      expect(cfg.upstreamCaPem).toContain(EMU_CA.trim());
      expect(Object.keys(cfg).sort()).toEqual(
        ['capBytes', 'certPem', 'credentials', 'keyPem', 'port', 'upstream', 'upstreamCaPem'].sort()
      );
    } finally {
      w.dispose();
    }
    expect(existsSync(w.mixed!.resignConfigHostPath)).toBe(false);
    expect(existsSync(path.dirname(w.mixed!.resignConfigHostPath))).toBe(false);
    expect(existsSync(w.caHostPath!)).toBe(false);
  });

  it('signs with the auth-off placeholders when the emulator has no keys file', async () => {
    const w = await mixed(9362, false);
    try {
      const cfg = JSON.parse(readFileSync(w.mixed!.resignConfigHostPath, 'utf8'));
      expect(cfg.credentials.accessKeyId).toBe('EMULATORAUTHOFF00000');
    } finally {
      w.dispose();
    }
  });

  it('does not forward host endpoint overrides (a host AWS_ENDPOINT_URL would carry real signatures)', async () => {
    const w = await mixed(9361, true, {
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9361',
      AWS_ENDPOINT_URL_SQS: 'https://127.0.0.1:9361',
    });
    try {
      expect(Object.keys(w.env).filter((k) => k.startsWith('AWS_ENDPOINT_URL'))).toEqual([]);
    } finally {
      w.dispose();
    }
  });

  it('without sentinels, --aws-emulator stays full emulator mode', async () => {
    writeEmulatorRun(9363);
    const w = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9363',
      awsEmulatorSentinels: [],
      homeDir: home,
      env: {},
      probeHealth: healthy,
    });
    try {
      expect(w.mode).toBe('emulator');
      expect(w.mixed).toBeUndefined();
    } finally {
      w.dispose();
    }
  });
});

describe('applyWorkloadAwsWiringToEnv — mixed mode', () => {
  it('replaces each sentinel with the sidecar endpoint and keeps the real identity and literal URLs', async () => {
    const w = await mixed();
    try {
      const env = applyWorkloadAwsWiringToEnv(
        {
          ...REAL,
          AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator',
          AWS_ENDPOINT_URL_SQS: 'https://127.0.0.1:9361',
          AWS_REGION: 'us-east-1',
        },
        w
      );
      expect(env['AWS_ENDPOINT_URL_DYNAMODB']).toBe(`https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`);
      expect(env['AWS_ENDPOINT_URL_SQS']).toBe('https://127.0.0.1:9361');
      expect(env).toMatchObject(REAL);
      expect(env['SSL_CERT_FILE']).toBe('/cdk-local-aws/ca-bundle.pem');
      // A container without credentials gets the host default chain, as in forward mode.
      const chain = applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_S3: 'aws-emulator' }, w, {
        accessKeyId: 'AKIACHAIN',
        secretAccessKey: 's',
      });
      expect(chain['AWS_ACCESS_KEY_ID']).toBe('AKIACHAIN');
    } finally {
      w.dispose();
    }
  });

  it('refuses a sentinel that reaches a container outside mixed mode', async () => {
    const forward = await resolveWorkloadAwsWiring({ env: {}, homeDir: home });
    expect(() =>
      applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' }, forward)
    ).toThrow(/outside mixed mode.*--aws-emulator/);
  });

  it('effectiveLoopbackPorts adds the emulator port when the env uses the sidecar, and the plan splits them', async () => {
    const w = await mixed();
    try {
      const wired = applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' }, w);
      const ports = effectiveLoopbackPorts(wired, w);
      expect(ports).toEqual([9361, MIXED_MODE_RESIGN_PORT]);
      expect(loopbackForwarderPlan(w, ports)).toEqual({
        ports: [9361],
        resignConfigHostPath: w.mixed!.resignConfigHostPath,
      });
      // A workload with no sentinel needs no forwarder at all.
      expect(effectiveLoopbackPorts(applyWorkloadAwsWiringToEnv({}, w), w)).toEqual([]);
      // A literal emulator URL gets the TCP forwarder only (no re-signing).
      const literal = effectiveLoopbackPorts({ AWS_ENDPOINT_URL_SQS: 'https://127.0.0.1:9361' }, w);
      expect(loopbackForwarderPlan(w, literal)).toEqual({ ports: [9361] });
    } finally {
      w.dispose();
    }
  });
});

describe('activateWorkloadAwsWiring — sentinels in --env-vars', () => {
  function envFile(content: unknown): string {
    const f = path.join(home, 'env.json');
    writeFileSync(f, JSON.stringify(content));
    return f;
  }

  it('refuses a sentinel without --aws-emulator, naming the flag', async () => {
    const f = envFile({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } });
    await expect(activateWorkloadAwsWiring({ envVars: f })).rejects.toThrow(
      /AWS_ENDPOINT_URL_DYNAMODB.*needs --aws-emulator \[url\] \(or CDK_LOCAL_AWS_EMULATOR\)/
    );
  });

  it('a file without sentinels changes nothing', async () => {
    const f = envFile({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'https://example.com' } });
    const w = await activateWorkloadAwsWiring({ envVars: f });
    expect(w.mixed).toBeUndefined();
  });

  it("keeps cdk-local's own clients on real AWS in mixed mode", async () => {
    // A healthy fake emulator, found through HOME like a real run.
    const tls = createMixedModeTlsMaterials();
    const server = createHttpsServer({ key: tls.keyPem, cert: tls.certPem }, (_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const dir = path.join(home, '.aws', 'emulator', String(port));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'ca.pem'), tls.caCertPem);
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    setAwsEndpointOverride({ endpoint: 'https://stale' });
    try {
      const f = envFile({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } });
      const w = await activateWorkloadAwsWiring({ envVars: f, awsEmulator: `https://127.0.0.1:${port}` });
      expect(w.mixed?.services).toEqual(['DYNAMODB']);
      expect(getAwsEndpointOverride()).toBeUndefined();
    } finally {
      process.env['HOME'] = savedHome;
      await new Promise((r) => server.close(r));
    }
  });
});

describe('forwarder argv with the re-signing sidecar', () => {
  it('mounts the config read-only, prepends the sidecar code and passes only the path', () => {
    const args = buildLoopbackForwarderDockerArgs({
      workloadContainer: 'wl',
      name: 'fwd',
      ports: [9361],
      probe: 'health',
      caHostPath: '/tmp/ca.pem',
      resignConfigHostPath: '/tmp/x/resign.json',
    });
    expect(args).toContain('/tmp/x/resign.json:/cdkl-forwarder/resign.json:ro');
    const script = args[args.indexOf('-e') + 1]!;
    expect(script).toContain('function startResigner(');
    expect(args.slice(args.indexOf('-e') + 2)).toEqual([
      '9361',
      'health',
      '/cdkl-forwarder/ca.pem',
      '/cdkl-forwarder/resign.json',
    ]);
    const argvWithoutScript = args.filter((_, i) => i !== args.indexOf('-e') + 1);
    expect(argvWithoutScript.join(' ')).not.toMatch(/EMULATOR|secret|PRIVATE|BEGIN/);
  });

  it('a non-loopback emulator: no TCP port, and the namespace-owner layout takes the sidecar too', () => {
    const args = buildNamespaceOwnerForwarderDockerArgs({
      name: 'fwd',
      namespace: { network: 'net' },
      ports: [],
      probe: 'tcp',
      resignConfigHostPath: '/tmp/x/resign.json',
    });
    expect(args.slice(args.indexOf('-e') + 2)).toEqual(['-', 'tcp', '-', '/cdkl-forwarder/resign.json']);
  });

  it('without the sidecar the forwarder argv is unchanged', () => {
    const args = buildLoopbackForwarderDockerArgs({
      workloadContainer: 'wl',
      name: 'fwd',
      ports: [9297],
      probe: 'tcp',
    });
    expect(args[args.indexOf('-e') + 1]).not.toContain('startResigner(cfgPath)');
    expect(args.slice(args.indexOf('-e') + 2)).toEqual(['9297', 'tcp']);
  });
});
