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
  logMixedModeForWorkload,
  effectiveLoopbackPorts,
  loopbackForwarderPlan,
  resetWorkloadAwsWiringForTest,
  resetAwsEmulatorStateSourceHintForTest,
  resolveWorkloadAwsWiring,
  setActiveWorkloadAwsWiring,
  sweepStaleResignDirs,
  takeAwsEmulatorStateSourceHint,
  STALE_RESIGN_DIR_AGE_MS,
} = await import('../../../src/local/workload-aws-wiring.js');
const { findRealAwsExceptions, MIXED_MODE_RESIGN_PORT } = await import(
  '../../../src/local/aws-emulator-mixed-mode.js'
);
const {
  getAwsEmulatorServiceRouting,
  getAwsEndpointOverride,
  isAwsServiceRoutedToEmulator,
  setAwsEndpointOverride,
} = await import('../../../src/utils/aws-proxy.js');
const { createMixedModeTlsMaterials } = await import('../../../src/local/mixed-mode-tls.js');
const { getLogger } = await import('../../../src/utils/logger.js');
const { buildLoopbackForwarderDockerArgs, buildNamespaceOwnerForwarderDockerArgs } = await import(
  '../../../src/local/loopback-forwarder.js'
);
const { MIXED_MODE_RESIGN_BODY_CAP_BYTES } = await import('../../../src/local/emulator-resign-sidecar.js');

const EMU_CA = createMixedModeTlsMaterials().caCertPem;
const EMU_KEY = { accessKeyId: 'EMULATOR0123456789AB', secretAccessKey: 'A'.repeat(40) };
const REAL = { AWS_ACCESS_KEY_ID: 'AKIAREAL', AWS_SECRET_ACCESS_KEY: 'real-secret', AWS_SESSION_TOKEN: 'real-tok' };
const EXCEPTIONS = findRealAwsExceptions({
  Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' },
  'Stack/Fn': { AWS_ENDPOINT_URL_STS: 'real-aws' },
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
    realAwsExceptions: EXCEPTIONS,
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
  it('is forward mode with the sidecar as the global endpoint, its config and a two-CA trust bundle', async () => {
    const w = await mixed();
    try {
      expect(w.mode).toBe('forward');
      expect(w.emulatorCredentials).toBeUndefined();
      expect(w.scrubEnvKeys).toEqual([]);
      expect(w.mixed).toMatchObject({
        realServices: ['SECRETS_MANAGER', 'STS'],
        emulatorCredentials: EMU_KEY,
        resignPort: MIXED_MODE_RESIGN_PORT,
        resignEndpoint: `https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`,
        emulatorClientOverride: { endpoint: 'https://127.0.0.1:9361', credentials: EMU_KEY },
      });
      expect(w.loopbackPorts).toEqual([9361, MIXED_MODE_RESIGN_PORT]);
      expect(w.sidecar).toEqual({
        port: MIXED_MODE_RESIGN_PORT,
        endpoint: `https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`,
        upstream: w.mixed!.emulatorEndpoint,
        configHostPath: w.mixed!.resignConfigHostPath,
        passthrough: false,
      });
      // A host-built mixed wiring without `sidecar` still gets its sidecar from `mixed`.
      expect(loopbackForwarderPlan({ ...w, sidecar: undefined }, [9361, MIXED_MODE_RESIGN_PORT])).toEqual({
        ports: [9361],
        resignConfigHostPath: w.mixed!.resignConfigHostPath,
      });
      expect(w.probeHealth).toBe(true);
      for (const k of CA_TRUST_ENV_KEYS) expect(w.env[k]).toBe('/cdk-local-aws/ca-bundle.pem');
      expect(w.env['AWS_ENDPOINT_URL']).toBe(`https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`);

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

  it('--ca-bundle is trusted NEXT TO the run ca.pem, never instead of it', async () => {
    writeEmulatorRun(9364);
    const extra = createMixedModeTlsMaterials().caCertPem;
    const extraPath = path.join(home, 'corp.pem');
    writeFileSync(extraPath, extra);
    const probe = vi.fn(async () => undefined);
    const w = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9364',
      realAwsExceptions: EXCEPTIONS,
      caBundle: extraPath,
      homeDir: home,
      env: {},
      probeHealth: probe,
    });
    // The host-side probe trusts the run's own CA, not the --ca-bundle.
    expect(probe).toHaveBeenCalledWith('https://127.0.0.1:9364', path.join(home, '.aws', 'emulator', '9364', 'ca.pem'));
    try {
      const cfg = JSON.parse(readFileSync(w.mixed!.resignConfigHostPath, 'utf8'));
      expect(cfg.upstreamCaPem).toContain(EMU_CA.trim());
      expect(cfg.upstreamCaPem).toContain(extra.trim());
      const bundle = readFileSync(w.caHostPath!, 'utf8');
      expect(bundle).toContain(EMU_CA.trim());
      expect(bundle).toContain(extra.trim());
    } finally {
      w.dispose();
    }
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

  it('does not forward host endpoint overrides (a host AWS_ENDPOINT_URL_<SERVICE> would take that service around the emulator)', async () => {
    const w = await mixed(9361, true, {
      AWS_ENDPOINT_URL: 'https://127.0.0.1:9361',
      AWS_ENDPOINT_URL_SQS: 'https://127.0.0.1:9361',
    });
    try {
      expect(Object.keys(w.env).filter((k) => k.startsWith('AWS_ENDPOINT_URL'))).toEqual(['AWS_ENDPOINT_URL']);
      expect(w.env['AWS_ENDPOINT_URL']).toBe(`https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`);
    } finally {
      w.dispose();
    }
  });

  it('without exceptions, --aws-emulator stays full emulator mode (emulator keys only)', async () => {
    writeEmulatorRun(9363);
    const w = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9363',
      realAwsExceptions: [],
      homeDir: home,
      env: {},
      probeHealth: healthy,
    });
    try {
      expect(w.mode).toBe('emulator');
      expect(w.mixed).toBeUndefined();
      const env = applyWorkloadAwsWiringToEnv({ ...REAL, AWS_REGION: 'us-east-1' }, w);
      expect(env['AWS_ACCESS_KEY_ID']).toBe(EMU_KEY.accessKeyId);
      expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
      expect(env['AWS_ENDPOINT_URL']).toBe('https://127.0.0.1:9363');
    } finally {
      w.dispose();
    }
  });
});

describe('applyWorkloadAwsWiringToEnv — mixed mode', () => {
  const SIDECAR = `https://127.0.0.1:${MIXED_MODE_RESIGN_PORT}`;

  it('one exception: the global endpoint is the sidecar, only that service gets its real endpoint, the real identity stays', async () => {
    const w = await mixed();
    try {
      const env = applyWorkloadAwsWiringToEnv(
        { ...REAL, AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws', AWS_REGION: 'eu-west-1' },
        w
      );
      expect(env['AWS_ENDPOINT_URL']).toBe(SIDECAR);
      expect(env['AWS_ENDPOINT_URL_SECRETS_MANAGER']).toBe(
        'https://secretsmanager.eu-west-1.amazonaws.com'
      );
      // Every other service has no variable of its own: the global one (the sidecar) wins.
      expect(Object.keys(env).filter((k) => k.startsWith('AWS_ENDPOINT_URL_'))).toEqual([
        'AWS_ENDPOINT_URL_SECRETS_MANAGER',
      ]);
      expect(env).toMatchObject(REAL);
      expect(env['AWS_EC2_METADATA_DISABLED']).toBe('true');
      expect(env['AWS_DISABLE_HOST_PREFIX_INJECTION']).toBe('true');
      expect(env['SSL_CERT_FILE']).toBe('/cdk-local-aws/ca-bundle.pem');
      expect(env['AWS_DEFAULT_REGION']).toBe('eu-west-1');
      // A container without credentials gets the host default chain, as in forward mode.
      const chain = applyWorkloadAwsWiringToEnv(
        { AWS_ENDPOINT_URL_STS: 'real-aws', AWS_REGION: 'us-east-1' },
        w,
        { accessKeyId: 'AKIACHAIN', secretAccessKey: 's' }
      );
      expect(chain['AWS_ACCESS_KEY_ID']).toBe('AKIACHAIN');
      expect(chain['AWS_ENDPOINT_URL_STS']).toBe('https://sts.us-east-1.amazonaws.com');
    } finally {
      w.dispose();
    }
  });

  it('a workload whose env keeps no exception gets the emulator keys only, never the real identity', async () => {
    const w = await mixed();
    try {
      const env = applyWorkloadAwsWiringToEnv(
        { ...REAL, AWS_PROFILE: 'prod', AWS_ROLE_ARN: 'arn:aws:iam::1:role/r', AWS_REGION: 'us-east-1' },
        w,
        { accessKeyId: 'AKIACHAIN', secretAccessKey: 's' }
      );
      expect(env['AWS_ACCESS_KEY_ID']).toBe(EMU_KEY.accessKeyId);
      expect(env['AWS_SECRET_ACCESS_KEY']).toBe(EMU_KEY.secretAccessKey);
      expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
      expect(env['AWS_PROFILE']).toBeUndefined();
      expect(env['AWS_ROLE_ARN']).toBeUndefined();
      expect(env['AWS_ENDPOINT_URL']).toBe(SIDECAR);
      expect(JSON.stringify(env)).not.toContain('AKIAREAL');
    } finally {
      w.dispose();
    }
  });

  it('a literal URL is passed through as-is, never re-signed, and signed with the real identity', async () => {
    const w = await mixed();
    try {
      const env = applyWorkloadAwsWiringToEnv(
        {
          ...REAL,
          AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws',
          AWS_ENDPOINT_URL_SQS: 'https://sqs.example.test',
          AWS_REGION: 'us-east-1',
        },
        w
      );
      expect(env['AWS_ENDPOINT_URL_SQS']).toBe('https://sqs.example.test');
      expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIAREAL');
      expect(effectiveLoopbackPorts(env, w)).toEqual([9361, MIXED_MODE_RESIGN_PORT]);
    } finally {
      w.dispose();
    }
  });

  it("names the real endpoint from the env's region, else the host's, and refuses without one", async () => {
    const w = await mixed(9361, true, { AWS_REGION: 'ap-northeast-1' });
    try {
      expect(
        applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_SSM: 'real-aws' }, w)['AWS_ENDPOINT_URL_SSM']
      ).toBe('https://ssm.ap-northeast-1.amazonaws.com');
      expect(
        applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_SSM: 'real-aws', AWS_DEFAULT_REGION: 'us-west-2' }, w)[
          'AWS_ENDPOINT_URL_SSM'
        ]
      ).toBe('https://ssm.us-west-2.amazonaws.com');
    } finally {
      w.dispose();
    }
    const noRegion = await mixed(9365);
    try {
      expect(() => applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_SSM: 'real-aws' }, noRegion)).toThrow(
        /needs the workload's region/
      );
      // A global service outside its signing region cannot be signed right.
      expect(() =>
        applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_IAM: 'real-aws', AWS_REGION: 'eu-west-1' }, noRegion)
      ).toThrow(/accepts only requests signed for us-east-1/);
    } finally {
      noRegion.dispose();
    }
  });

  it('without --aws-emulator "real-aws" is dropped (a no-op), on a service variable and on the bare one', async () => {
    const forward = await resolveWorkloadAwsWiring({ env: {}, homeDir: home });
    const env = applyWorkloadAwsWiringToEnv(
      { ...REAL, AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws', AWS_ENDPOINT_URL: 'real-aws', TABLE_NAME: 't' },
      forward
    );
    expect(env).toEqual({ ...REAL, TABLE_NAME: 't' });
  });

  it('refuses "real-aws" under --aws-emulator without mixed-mode wiring, and the old sentinel anywhere', async () => {
    writeEmulatorRun(9366);
    const full = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9366',
      homeDir: home,
      env: {},
      probeHealth: healthy,
    });
    try {
      expect(() => applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_STS: 'real-aws' }, full)).toThrow(
        /under --aws-emulator without mixed-mode wiring/
      );
      expect(() => applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_STS: 'aws-emulator' }, full)).toThrow(
        /no longer supported/
      );
    } finally {
      full.dispose();
    }
    const forward = await resolveWorkloadAwsWiring({ env: {}, homeDir: home });
    expect(() =>
      applyWorkloadAwsWiringToEnv({ AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' }, forward)
    ).toThrow(/no longer supported/);
  });

  it('every workload uses the sidecar: effectiveLoopbackPorts adds the emulator port and the plan splits them', async () => {
    const w = await mixed();
    try {
      const wired = applyWorkloadAwsWiringToEnv({ AWS_REGION: 'us-east-1' }, w);
      const ports = effectiveLoopbackPorts(wired, w);
      expect(ports).toEqual([9361, MIXED_MODE_RESIGN_PORT]);
      expect(loopbackForwarderPlan(w, ports)).toEqual({
        ports: [9361],
        resignConfigHostPath: w.mixed!.resignConfigHostPath,
      });
      // A container env that replaced the global endpoint with a literal needs only the TCP forwarder.
      const literal = effectiveLoopbackPorts({ AWS_ENDPOINT_URL: 'https://127.0.0.1:9361' }, w);
      expect(loopbackForwarderPlan(w, literal)).toEqual({ ports: [9361] });
    } finally {
      w.dispose();
    }
  });
});

describe('activateWorkloadAwsWiring — exceptions in --env-vars', () => {
  function envFile(content: unknown): string {
    const f = path.join(home, 'env.json');
    writeFileSync(f, JSON.stringify(content));
    return f;
  }

  it('without --aws-emulator a "real-aws" file is accepted and changes nothing', async () => {
    const f = envFile({
      Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws', AWS_ENDPOINT_URL: 'real-aws' },
    });
    const w = await activateWorkloadAwsWiring({ envVars: f });
    expect(w.mode).toBe('forward');
    expect(w.mixed).toBeUndefined();
    expect(getAwsEmulatorServiceRouting()).toBeUndefined();
  });

  it('refuses the old "aws-emulator" sentinel with or without the flag', async () => {
    const f = envFile({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'aws-emulator' } });
    await expect(activateWorkloadAwsWiring({ envVars: f })).rejects.toThrow(/no longer supported/);
    await expect(
      activateWorkloadAwsWiring({ envVars: f, awsEmulator: 'https://127.0.0.1:1' })
    ).rejects.toThrow(/no longer supported/);
  });

  it('a file without exceptions changes nothing', async () => {
    const f = envFile({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'https://example.com' } });
    const w = await activateWorkloadAwsWiring({ envVars: f });
    expect(w.mixed).toBeUndefined();
  });

  it("routes cdk-local's own clients per service in mixed mode: everything but the exceptions reads the emulator", async () => {
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
      const file = {
        Parameters: { AWS_ENDPOINT_URL_SECRETS_MANAGER: 'real-aws' },
        Fn: { AWS_ENDPOINT_URL_STS: 'real-aws' },
      };
      const f = envFile(file);
      const info = vi.spyOn(getLogger(), 'info');
      const w = await activateWorkloadAwsWiring({ envVars: f, awsEmulator: `https://127.0.0.1:${port}` });
      expect(w.mixed?.realServices).toEqual(['SECRETS_MANAGER', 'STS']);
      // The startup line names where each exception is marked, never claiming
      // a per-resource one for every workload (go-to-k/cdk-local#949).
      const banner = info.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Mixed mode:'))!;
      expect(banner).toContain(
        ': SECRETS_MANAGER under Parameters (every workload); STS under Fn. A workload with no exception gets ' +
          "AWS Emulator's keys only."
      );
      // A single-workload command prints its own target's exceptions only.
      info.mockClear();
      await activateWorkloadAwsWiring({ envVars: f, awsEmulator: `https://127.0.0.1:${port}`, singleWorkload: true });
      expect(info.mock.calls.some((c) => String(c[0]).startsWith('Mixed mode:'))).toBe(false);
      logMixedModeForWorkload({ logicalId: 'Other' }, 'Lambda Stack/Other');
      logMixedModeForWorkload({ logicalId: 'Fn' }, 'Lambda Stack/Fn');
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines[lines.length - 2]).toMatch(
        /^Mixed mode: every AWS call of Lambda Stack\/Other goes to AWS Emulator at \S+ \(signed with its keys\) except SECRETS_MANAGER, which go to real AWS/
      );
      expect(lines[lines.length - 1]).toMatch(/except SECRETS_MANAGER, STS, which go to real AWS/);
      // A workload with no exception at all.
      const g = path.join(home, 'env-pyfn.json');
      writeFileSync(g, JSON.stringify({ 'Stack/PyFn': { AWS_ENDPOINT_URL_S3: 'real-aws' } }));
      await activateWorkloadAwsWiring({ envVars: g, awsEmulator: `https://127.0.0.1:${port}`, singleWorkload: true });
      logMixedModeForWorkload({ logicalId: 'NodeFn', cdkPath: 'Stack/NodeFn/Resource' }, 'Lambda Stack/NodeFn');
      expect(String(info.mock.calls.at(-1)![0])).toMatch(
        /^Mixed mode: Lambda Stack\/NodeFn keeps no "real-aws" exception in --env-vars, so every AWS call it makes goes to AWS Emulator at \S+, with its keys only\.$/
      );
      info.mockRestore();
      await activateWorkloadAwsWiring({ envVars: f, awsEmulator: `https://127.0.0.1:${port}` });
      // No process-wide override: each client picks its side per service.
      expect(getAwsEndpointOverride()).toBeUndefined();
      expect(getAwsEmulatorServiceRouting()).toEqual({
        realServices: ['SECRETS_MANAGER', 'STS'],
        override: w.mixed!.emulatorClientOverride,
        // The parsed file, so a call made for one workload routes by its own exceptions (#902).
        envOverrides: file,
      });
      expect(isAwsServiceRoutedToEmulator('DYNAMODB')).toBe(true);
      expect(isAwsServiceRoutedToEmulator('SECRETS_MANAGER')).toBe(false);
      // A per-section exception routes only that workload's calls real.
      expect(isAwsServiceRoutedToEmulator('STS')).toBe(true);
      expect(isAwsServiceRoutedToEmulator('STS', { logicalId: 'Fn' })).toBe(false);
      // A later run without exceptions clears it.
      await activateWorkloadAwsWiring({});
      expect(getAwsEmulatorServiceRouting()).toBeUndefined();
    } finally {
      process.env['HOME'] = savedHome;
      await new Promise((r) => server.close(r));
    }
  });
});

describe('takeAwsEmulatorStateSourceHint (Plan A)', () => {
  it('answers once under --aws-emulator, naming the state-source flags and --env-vars; never without it', async () => {
    resetAwsEmulatorStateSourceHintForTest();
    expect(takeAwsEmulatorStateSourceHint()).toBeUndefined();
    writeEmulatorRun(9367);
    const w = await resolveWorkloadAwsWiring({
      awsEmulator: 'https://127.0.0.1:9367',
      homeDir: home,
      env: {},
      probeHealth: healthy,
    });
    setActiveWorkloadAwsWiring(w);
    const hint = takeAwsEmulatorStateSourceHint();
    expect(hint).toMatch(/--from-state \(the stack deployed into AWS Emulator with that host's own deploy\)/);
    expect(hint).toMatch(/--from-cfn-stack \(the stack deployed into AWS Emulator with `cdk deploy`\)/);
    expect(hint).toMatch(/--env-vars/);
    expect(takeAwsEmulatorStateSourceHint()).toBeUndefined();
    resetAwsEmulatorStateSourceHintForTest();
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

describe('sweepStaleResignDirs (a SIGKILLed run left its keys behind)', () => {
  it('removes only this user\'s old resign dirs whose owner process is gone', async () => {
    const { spawnSync } = await import('node:child_process');
    const { utimesSync } = await import('node:fs');
    // A pid that existed and is now gone.
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!;
    const root = mkdtempSync(path.join(tmpdir(), 'sweep-'));
    const old = (Date.now() - STALE_RESIGN_DIR_AGE_MS - 60_000) / 1000;
    const make = (name: string, pid: number | undefined, age: 'old' | 'new'): string => {
      const d = path.join(root, name);
      mkdirSync(d);
      writeFileSync(path.join(d, 'resign.json'), '{}');
      if (pid !== undefined) writeFileSync(path.join(d, 'owner.pid'), String(pid));
      if (age === 'old') utimesSync(d, old, old);
      return d;
    };
    try {
      const stale = make('cdk-local-resign-dead', deadPid, 'old');
      const live = make('cdk-local-resign-live', process.pid, 'old');
      const fresh = make('cdk-local-resign-fresh', deadPid, 'new');
      const noPid = make('cdk-local-resign-nopid', undefined, 'old');
      const other = make('other-tool-resign-x', deadPid, 'old');
      expect(sweepStaleResignDirs(Date.now(), root)).toEqual([stale]);
      expect(existsSync(stale)).toBe(false);
      for (const kept of [live, fresh, noPid, other]) expect(existsSync(kept)).toBe(true);
      // Nothing to read: no throw.
      expect(sweepStaleResignDirs(Date.now(), path.join(root, 'missing'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the mixed wiring records its owner pid next to the config', async () => {
    const w = await mixed(9365);
    try {
      const pidFile = path.join(path.dirname(w.mixed!.resignConfigHostPath), 'owner.pid');
      expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
      expect(statSync(pidFile).mode & 0o777).toBe(0o600);
    } finally {
      w.dispose();
    }
  });
});
