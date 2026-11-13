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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dockerRegistryEnv,
  hostDockerConfigDir,
  isEcrRegistryConfigKey,
  noImplicitEcrPullArgs,
  resetDockerRegistryConfigForTest,
  STALE_DOCKER_CONFIG_DIR_AGE_MS,
  sweepStaleDockerConfigDirs,
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
    'public.ecr.aws',
    'https://public.ecr.aws/v2/',
    // A look-alike loses its credential too: withholding is the safe side.
    '123456789012.dkr.ecr.us-east-1.example.com',
  ])('matches %s', (key) => {
    expect(isEcrRegistryConfigKey(key)).toBe(true);
  });

  it.each([
    'https://index.docker.io/v1/',
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
    expect(hostDockerConfigDir({ DOCKER_CONFIG: 'rel/cfg' })).toBe(join(process.cwd(), 'rel/cfg'));
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
    expect(dockerRegistryEnv()).toEqual({ DOCKER_CONFIG: hostDir, DOCKER_AUTH_CONFIG: undefined, REGISTRY_AUTH_FILE: undefined });
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
    // podman reads the same stripped file.
    expect(dockerRegistryEnv()['REGISTRY_AUTH_FILE']).toBe(join(dir, 'config.json'));
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
    expect(dockerRegistryEnv({ containerName: 'web' })).toEqual({ DOCKER_CONFIG: hostDir, DOCKER_AUTH_CONFIG: undefined, REGISTRY_AUTH_FILE: undefined });
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
    expect(dockerRegistryEnv()).toEqual({ DOCKER_CONFIG: hostDir, DOCKER_AUTH_CONFIG: undefined, REGISTRY_AUTH_FILE: undefined });
    await expect(runDockerForeground(['pull', `${ECR}/r:t`])).resolves.toBeUndefined();
  });

  it('strips ECR credentials from DOCKER_AUTH_CONFIG too, and drops a malformed one', () => {
    const saved = process.env['DOCKER_AUTH_CONFIG'];
    try {
      setAwsEndpointOverride(EMU);
      process.env['DOCKER_AUTH_CONFIG'] = JSON.stringify({
        auths: { [ECR]: { auth: 'ZWNyOnRvaw==' }, 'ghcr.io': { auth: 'Z2g6dG9r' } },
      });
      expect(JSON.parse(dockerRegistryEnv()['DOCKER_AUTH_CONFIG']!)).toEqual({
        auths: { 'ghcr.io': { auth: 'Z2g6dG9r' } },
      });
      process.env['DOCKER_AUTH_CONFIG'] = 'not json';
      const env = dockerRegistryEnv();
      expect('DOCKER_AUTH_CONFIG' in env && env['DOCKER_AUTH_CONFIG'] === undefined).toBe(true);
      delete process.env['DOCKER_AUTH_CONFIG'];
      expect('DOCKER_AUTH_CONFIG' in dockerRegistryEnv()).toBe(false);
      // Outside the flag, and for an ECR-excepted workload, the host value
      // passes unchanged, replacing the stripped default underneath.
      const hostAuth = JSON.stringify({ auths: { [ECR]: { auth: 'ZWNyOnRvaw==' } } });
      process.env['DOCKER_AUTH_CONFIG'] = hostAuth;
      setAwsEndpointOverride(undefined);
      expect(dockerRegistryEnv()['DOCKER_AUTH_CONFIG']).toBe(hostAuth);
      setAwsEmulatorServiceRouting({
        realServices: [],
        override: EMU,
        envOverrides: { Parameters: {}, web: { AWS_ENDPOINT_URL_ECR: 'real-aws' } },
      });
      expect(dockerRegistryEnv({ containerName: 'web' })['DOCKER_AUTH_CONFIG']).toBe(hostAuth);
      expect(dockerRegistryEnv()['DOCKER_AUTH_CONFIG']).not.toBe(hostAuth);
    } finally {
      if (saved === undefined) delete process.env['DOCKER_AUTH_CONFIG'];
      else process.env['DOCKER_AUTH_CONFIG'] = saved;
    }
  });

  it('re-creates the per-run directory when it was removed mid-run', () => {
    setAwsEndpointOverride(EMU);
    const first = dockerRegistryEnv()['DOCKER_CONFIG']!;
    rmSync(first, { recursive: true, force: true });
    const second = dockerRegistryEnv()['DOCKER_CONFIG']!;
    expect(second).not.toBe(first);
    expect(existsSync(join(second, 'config.json'))).toBe(true);
  });

  it('leaves DOCKER_CONFIG unset for an excepted workload when the host has none', async () => {
    delete process.env['DOCKER_CONFIG'];
    setAwsEmulatorServiceRouting({
      realServices: [],
      override: EMU,
      envOverrides: { Parameters: {}, web: { AWS_ENDPOINT_URL_ECR: 'real-aws' } },
    });
    const env = dockerRegistryEnv({ containerName: 'web' });
    expect('DOCKER_CONFIG' in env && env['DOCKER_CONFIG'] === undefined).toBe(true);
    // The explicit undefined removes the stripped default from the spawn env.
    const { stdout } = await runDockerStreaming(['pull', `${ECR}/r:t`], { env });
    expect(stdout.trim()).toBe('');
  });

  it('writes an empty config when the host has none', () => {
    rmSync(join(hostDir, 'config.json'));
    setAwsEndpointOverride(EMU);
    const dir = dockerRegistryEnv()['DOCKER_CONFIG']!;
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))).toEqual({});
  });
});

describe('noImplicitEcrPullArgs', () => {
  it.each([
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:v1',
    '123456789012.dkr-ecr.us-east-1.on.aws/app@sha256:abc',
    // A host parseEcrUri rejects still matches the loose test.
    '123456789012.dkr.ecr.xx-new-1.amazonaws.com/app:v1',
  ])('forbids a daemon re-pull of %s', (image) => {
    expect(noImplicitEcrPullArgs(image)).toEqual(['--pull', 'never']);
  });

  it.each(['public.ecr.aws/lambda/nodejs:20', 'busybox', 'ghcr.io/o/i:1', 'cdkl-invoke-abc'])(
    'leaves %s alone',
    (image) => {
      expect(noImplicitEcrPullArgs(image)).toEqual([]);
    }
  );
});

describe('sweepStaleDockerConfigDirs (a killed run left its config copy behind)', () => {
  it("removes only this user's old dirs whose owner process is gone, never following a link", async () => {
    const { spawnSync } = await import('node:child_process');
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!;
    const root = mkdtempSync(join(tmpdir(), 'sweep917-'));
    const target = mkdtempSync(join(tmpdir(), 'sweep917-target-'));
    writeFileSync(join(target, 'owner.pid'), String(deadPid));
    const old = (Date.now() - STALE_DOCKER_CONFIG_DIR_AGE_MS - 60_000) / 1000;
    const make = (name: string, pid: number | undefined, age: 'old' | 'new'): string => {
      const d = join(root, name);
      mkdirSync(d);
      writeFileSync(join(d, 'config.json'), '{}');
      // A link inside, as the real dir has: removed with the dir, not followed.
      symlinkSync(target, join(d, 'contexts'));
      if (pid !== undefined) writeFileSync(join(d, 'owner.pid'), String(pid));
      if (age === 'old') utimesSync(d, old, old);
      return d;
    };
    try {
      const stale = make('cdkl-docker-config-dead', deadPid, 'old');
      const live = make('cdkl-docker-config-live', process.pid, 'old');
      const fresh = make('cdkl-docker-config-fresh', deadPid, 'new');
      const noPid = make('cdkl-docker-config-nopid', undefined, 'old');
      const other = make('other-docker-config-x', deadPid, 'old');
      // A symlink planted under the prefix is skipped.
      const planted = join(root, 'cdkl-docker-config-link');
      symlinkSync(target, planted);
      expect(sweepStaleDockerConfigDirs(Date.now(), root)).toEqual([stale]);
      expect(existsSync(stale)).toBe(false);
      for (const kept of [live, fresh, noPid, other, planted, target]) {
        expect(existsSync(kept)).toBe(true);
      }
      expect(existsSync(join(target, 'owner.pid'))).toBe(true);
      expect(sweepStaleDockerConfigDirs(Date.now(), join(root, 'missing'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('the per-run dir records its owner pid', () => {
    const saved = process.env['DOCKER_CONFIG'];
    const host = mkdtempSync(join(tmpdir(), 'cdkl-917-host-'));
    process.env['DOCKER_CONFIG'] = host;
    try {
      setAwsEndpointOverride(EMU);
      const dir = dockerRegistryEnv()['DOCKER_CONFIG']!;
      expect(readFileSync(join(dir, 'owner.pid'), 'utf-8').trim()).toBe(String(process.pid));
    } finally {
      setAwsEndpointOverride(undefined);
      resetDockerRegistryConfigForTest();
      if (saved === undefined) delete process.env['DOCKER_CONFIG'];
      else process.env['DOCKER_CONFIG'] = saved;
      rmSync(host, { recursive: true, force: true });
    }
  });
});
