/**
 * go-to-k/cdk-local#917: under --aws-emulator, unless a "real-aws" exception
 * names ECR, a docker pull / build runs with a per-run DOCKER_CONFIG holding no
 * credential for any ECR host, so the host's credential helper never answers
 * a request to real ECR. Outside the flag, and with ECR excepted, the host's
 * own docker config is used unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dockerRegistryEnv,
  hostDockerConfigDir,
  isEcrRegistryConfigKey,
  resetDockerRegistryConfigForTest,
  stripEcrCredentials,
} from '../../../src/utils/docker-registry-config.js';
import { runDockerForeground, runDockerStreaming } from '../../../src/utils/docker-cmd.js';
import { setAwsEmulatorServiceRouting, setAwsEndpointOverride } from '../../../src/utils/aws-proxy.js';

const ECR = '123456789012.dkr.ecr.us-east-1.amazonaws.com';
const EMU = { endpoint: 'https://127.0.0.1:9403', credentials: { accessKeyId: 'EMUKEY', secretAccessKey: 'x'.repeat(40) } };

describe('isEcrRegistryConfigKey', () => {
  it.each([
    ECR,
    `https://${ECR}`,
    `https://${ECR}/v2/`,
    `${ECR}:443`,
    '123456789012.DKR.ECR.us-east-1.amazonaws.com',
    '123456789012.dkr.ecr-fips.us-gov-west-1.amazonaws.com',
    '123456789012.dkr-ecr.us-east-1.on.aws',
    '123456789012.dkr-ecr-fips.us-east-1.on.aws',
    '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn',
    // A look-alike loses its credential too: withholding is the safe side.
    '123456789012.dkr.ecr.us-east-1.example.com',
  ])('matches %s', (key) => {
    expect(isEcrRegistryConfigKey(key)).toBe(true);
  });

  it.each([
    'https://index.docker.io/v1/',
    'public.ecr.aws',
    'ghcr.io',
    'registry.example.com',
    'mydkr.ecr.example.com',
  ])('leaves %s alone', (key) => {
    expect(isEcrRegistryConfigKey(key)).toBe(false);
  });
});

describe('stripEcrCredentials', () => {
  it('drops every ECR credential source and keeps the rest of the config', () => {
    const out = stripEcrCredentials({
      auths: {
        [ECR]: {},
        [`https://${ECR.replace('123456789012', '210987654321')}`]: { auth: 'ZWNyOnRva2Vu' },
        'https://index.docker.io/v1/': {},
        'ghcr.io': { auth: 'Z2g6dG9r' },
      },
      credsStore: 'desktop',
      credHelpers: { [ECR]: 'ecr-login', 'gcr.io': 'gcloud' },
      currentContext: 'desktop-linux',
      proxies: { default: { httpProxy: 'http://proxy:3128' } },
      cliPluginsExtraDirs: ['/opt/plugins'],
    });
    expect(out).toEqual({
      auths: { 'https://index.docker.io/v1/': {}, 'ghcr.io': { auth: 'Z2g6dG9r' } },
      // The store keeps serving the non-ECR logins it holds, host by host.
      credHelpers: { 'https://index.docker.io/v1/': 'desktop', 'gcr.io': 'gcloud' },
      currentContext: 'desktop-linux',
      proxies: { default: { httpProxy: 'http://proxy:3128' } },
      cliPluginsExtraDirs: ['/opt/plugins'],
    });
  });

  it('removes a global credsStore even when no auths entry remains to map it to', () => {
    expect(stripEcrCredentials({ credsStore: 'ecr-login', currentContext: 'x' })).toEqual({
      currentContext: 'x',
    });
  });

  it('tolerates malformed credential sections', () => {
    expect(stripEcrCredentials({ auths: 'nope', credHelpers: ['x'], credsStore: 7 })).toEqual({
      auths: {},
    });
  });
});

describe('hostDockerConfigDir', () => {
  it('honors DOCKER_CONFIG and falls back to ~/.docker', () => {
    expect(hostDockerConfigDir({ DOCKER_CONFIG: '/x/cfg' })).toBe('/x/cfg');
    expect(hostDockerConfigDir({ DOCKER_CONFIG: '' })).toMatch(/[/\\]\.docker$/);
    expect(hostDockerConfigDir({})).toMatch(/[/\\]\.docker$/);
  });
});

describe('dockerRegistryEnv / runDocker* under --aws-emulator', () => {
  let root: string;
  let hostDir: string;
  const savedConfig = process.env['DOCKER_CONFIG'];
  const savedCdkDocker = process.env['CDK_DOCKER'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cdkl-917-'));
    hostDir = join(root, 'host');
    mkdirSync(join(hostDir, 'contexts'), { recursive: true });
    mkdirSync(join(hostDir, 'cli-plugins'), { recursive: true });
    writeFileSync(
      join(hostDir, 'config.json'),
      JSON.stringify({
        auths: { [ECR]: {}, 'https://index.docker.io/v1/': {} },
        credsStore: 'desktop',
        credHelpers: { [ECR]: 'ecr-login' },
        currentContext: 'desktop-linux',
      })
    );
    process.env['DOCKER_CONFIG'] = hostDir;
    // A fake docker client that prints the config it was given.
    const fake = join(root, 'fake-docker');
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$DOCKER_CONFIG"\n');
    chmodSync(fake, 0o755);
    process.env['CDK_DOCKER'] = fake;
  });

  afterEach(() => {
    resetDockerRegistryConfigForTest();
    setAwsEmulatorServiceRouting(undefined);
    setAwsEndpointOverride(undefined);
    if (savedConfig === undefined) delete process.env['DOCKER_CONFIG'];
    else process.env['DOCKER_CONFIG'] = savedConfig;
    if (savedCdkDocker === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = savedCdkDocker;
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the host config outside --aws-emulator', async () => {
    expect(dockerRegistryEnv()).toEqual({ DOCKER_CONFIG: hostDir });
    const { stdout } = await runDockerStreaming(['pull', `${ECR}/r:t`]);
    expect(stdout.trim()).toBe(hostDir);
  });

  it('gives full --aws-emulator mode a per-run config with no ECR credential', async () => {
    setAwsEndpointOverride(EMU);
    const dir = dockerRegistryEnv()['DOCKER_CONFIG']!;
    expect(dir).not.toBe(hostDir);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))).toEqual({
      auths: { 'https://index.docker.io/v1/': {} },
      credHelpers: { 'https://index.docker.io/v1/': 'desktop' },
      currentContext: 'desktop-linux',
    });
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The daemon stays reachable: the context store and the plugins are linked.
    expect(lstatSync(join(dir, 'contexts')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, 'contexts'))).toBe(join(hostDir, 'contexts'));
    expect(readlinkSync(join(dir, 'cli-plugins'))).toBe(join(hostDir, 'cli-plugins'));
    // `buildx` is absent on this host, so it is not linked.
    expect(existsSync(join(dir, 'buildx'))).toBe(false);
    // One directory per process.
    expect(dockerRegistryEnv()['DOCKER_CONFIG']).toBe(dir);

    // Every runDocker* spawn gets it by default.
    const { stdout } = await runDockerStreaming(['build', '.']);
    expect(stdout.trim()).toBe(dir);
  });

  it('routes by the workload: an ECR exception keeps the host config, others get the stripped one', async () => {
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: EMU,
      envOverrides: { Parameters: {}, web: { AWS_ENDPOINT_URL_ECR: 'real-aws' } },
    });
    expect(dockerRegistryEnv({ containerName: 'web' })).toEqual({ DOCKER_CONFIG: hostDir });
    const stripped = dockerRegistryEnv({ containerName: 'worker' })['DOCKER_CONFIG']!;
    expect(stripped).not.toBe(hostDir);
    // Without a workload, `Parameters` decides: not excepted, so stripped.
    expect(dockerRegistryEnv()['DOCKER_CONFIG']).toBe(stripped);
    // A caller's explicit env wins over the default.
    const { stdout } = await runDockerStreaming(['pull', `${ECR}/r:t`], {
      env: dockerRegistryEnv({ containerName: 'web' }),
    });
    expect(stdout.trim()).toBe(hostDir);
  });

  it('keeps the host config when Parameters excepts ECR', async () => {
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: EMU,
      envOverrides: { Parameters: { AWS_ENDPOINT_URL_ECR: 'real-aws' } },
    });
    expect(dockerRegistryEnv()).toEqual({ DOCKER_CONFIG: hostDir });
    await expect(runDockerForeground(['pull', `${ECR}/r:t`])).resolves.toBeUndefined();
  });

  it('writes an empty config when the host has none', () => {
    rmSync(join(hostDir, 'config.json'));
    setAwsEndpointOverride(EMU);
    const dir = dockerRegistryEnv()['DOCKER_CONFIG']!;
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))).toEqual({});
  });
});
