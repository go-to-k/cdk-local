import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  allowSecretsOnArgvEnvName,
  finchSecretArgvRefusal,
  isFinchVmClient,
  resetFinchArgvWarningsForTest,
  warnFinchArgvExposure,
} from '../../../src/utils/docker-cmd.js';
import { resetEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import { getLogger } from '../../../src/utils/logger.js';
import { displayUntrustedValue } from '../../../src/utils/assembly-path.js';

// Issue #749: finch on macOS / Windows rewrites a value-less `-e KEY` into
// `-e KEY=<value>` on the limactl argv, so the value-less form is not a
// guarantee there.
const CONTAINER = { label: 'Container', name: 'app' };
const OPT_IN_KEYS = ['CDKL_ALLOW_SECRETS_ON_ARGV', 'CDKD_ALLOW_SECRETS_ON_ARGV'] as const;

describe('finch VM argv exposure (issue #749)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const saved: Record<string, string | undefined> = {};

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: p });
  }

  beforeEach(() => {
    for (const k of ['CDK_DOCKER', ...OPT_IN_KEYS]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetEmbedConfig();
    resetFinchArgvWarningsForTest();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEmbedConfig();
    vi.restoreAllMocks();
  });

  it.each([
    ['finch', 'darwin', true],
    ['/opt/homebrew/bin/finch', 'darwin', true],
    ['Finch', 'darwin', true],
    ['C:\\Program Files\\Finch\\bin\\finch.exe', 'win32', true],
    ['FINCH.EXE', 'win32', true],
    ['finch', 'win32', true],
    // finch on Linux passes the argv to nerdctl unchanged.
    ['finch', 'linux', false],
    ['/usr/local/bin/finch', 'linux', false],
    // Other clients resolve the bare `-e KEY` themselves.
    ['docker', 'darwin', false],
    ['podman', 'darwin', false],
    ['nerdctl', 'darwin', false],
    ['docker', 'win32', false],
    // Documented limit: another basename is not recognised.
    ['/usr/local/bin/finch-wrapper', 'darwin', false],
    ['nerdctl.lima', 'darwin', false],
  ] as const)('isFinchVmClient(%j, %s) is %s', (cmd, platform, expected) => {
    expect(isFinchVmClient(cmd, platform)).toBe(expected);
  });

  it('isFinchVmClient defaults to the CDK_DOCKER binary and the running platform', () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = '/opt/homebrew/bin/finch';
    expect(isFinchVmClient()).toBe(true);
    delete process.env['CDK_DOCKER'];
    expect(isFinchVmClient()).toBe(false);
    process.env['CDK_DOCKER'] = 'finch';
    setPlatform('linux');
    expect(isFinchVmClient()).toBe(false);
  });

  it('names the opt-in after the embed env prefix', () => {
    expect(allowSecretsOnArgvEnvName()).toBe('CDKL_ALLOW_SECRETS_ON_ARGV');
    setEmbedConfig({ envPrefix: 'CDKD' });
    expect(allowSecretsOnArgvEnvName()).toBe('CDKD_ALLOW_SECRETS_ON_ARGV');
  });

  it('refuses a template secret under finch on macOS, naming it and the opt-in', () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    const msg = finchSecretArgvRefusal(['DB_PASSWORD', 'API_KEY'], {
      label: 'Container',
      name: 'app',
    });
    expect(msg).toBeDefined();
    expect(msg).toContain('Container app: refusing to forward secret(s) DB_PASSWORD, API_KEY');
    expect(msg).toContain('CDKL_ALLOW_SECRETS_ON_ARGV=1');
    expect(msg).toContain('limactl');
    expect(msg).toContain('while it stays set');
  });

  it("names the embedding host's opt-in in the refusal", () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    setEmbedConfig({ envPrefix: 'CDKD' });
    const msg = finchSecretArgvRefusal(['DB_PASSWORD'], CONTAINER)!;
    expect(msg).toContain('CDKD_ALLOW_SECRETS_ON_ARGV=1');
    expect(msg).not.toContain('CDKL_ALLOW_SECRETS_ON_ARGV');
  });

  it('names a repeated secret once', () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    const msg = finchSecretArgvRefusal(['DB_PASSWORD', 'DB_PASSWORD'], CONTAINER)!;
    expect(msg.match(/DB_PASSWORD/g)).toHaveLength(1);
  });

  it('refuses under finch on Windows too', () => {
    setPlatform('win32');
    process.env['CDK_DOCKER'] = 'finch.exe';
    expect(finchSecretArgvRefusal(['DB_PASSWORD'], CONTAINER)).toBeDefined();
  });

  // Issue #774: the subject name (an image or container name) and the secret
  // names are template-chosen, so they render as untrusted values: control
  // characters escaped inside a quoted boundary, the length capped.
  it('renders secret names and the subject name display-safe', () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    const names = ['EVIL\u001b[31mNAME', 'LINE\u2028SEP'];
    const msg = finchSecretArgvRefusal(names, { label: 'Container', name: 'a\nb' })!;
    expect(msg).not.toMatch(/[\u001b\n\u2028]/);
    expect(msg).toContain(
      `Container ${displayUntrustedValue('a\nb')}: refusing to forward secret(s) ` +
        names.map(displayUntrustedValue).join(', ')
    );
  });

  it('caps an over-long subject name', () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    const image = `registry.example/${'a'.repeat(5000)}:tag`;
    const msg = finchSecretArgvRefusal(['DB_PASSWORD'], {
      label: 'Container for image',
      name: image,
    })!;
    expect(msg).toContain(`Container for image ${displayUntrustedValue(image)}: refusing`);
    expect(msg.length).toBeLessThan(1500);
  });

  it('control: ordinary names render bare', () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    const msg = finchSecretArgvRefusal(['DB_PASSWORD'], {
      label: 'Container for image',
      name: 'public.ecr.aws/lambda/nodejs:20',
    })!;
    expect(msg).toContain(
      'Container for image public.ecr.aws/lambda/nodejs:20: refusing to forward secret(s) DB_PASSWORD '
    );
  });

  it.each([
    ['no secret names', [] as string[], 'darwin' as NodeJS.Platform, 'finch', undefined],
    ['finch on Linux', ['DB_PASSWORD'], 'linux' as NodeJS.Platform, 'finch', undefined],
    ['docker on macOS', ['DB_PASSWORD'], 'darwin' as NodeJS.Platform, 'docker', undefined],
    ['podman on macOS', ['DB_PASSWORD'], 'darwin' as NodeJS.Platform, 'podman', undefined],
    ['a finch wrapper on macOS', ['DB_PASSWORD'], 'darwin' as NodeJS.Platform, 'finch-wrap', undefined],
    ['opt-in 1', ['DB_PASSWORD'], 'darwin' as NodeJS.Platform, 'finch', '1'],
    ['opt-in TRUE', ['DB_PASSWORD'], 'darwin' as NodeJS.Platform, 'finch', 'TRUE'],
    ['opt-in " true "', ['DB_PASSWORD'], 'darwin' as NodeJS.Platform, 'finch', ' true '],
  ])('does not refuse: %s', (_label, names, platform, docker, optIn) => {
    setPlatform(platform);
    process.env['CDK_DOCKER'] = docker;
    if (optIn !== undefined) process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = optIn;
    expect(finchSecretArgvRefusal(names, CONTAINER)).toBeUndefined();
  });

  it.each(['0', 'false', 'yes', ''])('an opt-in value of %j does not opt in', (optIn) => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = optIn;
    expect(finchSecretArgvRefusal(['DB_PASSWORD'], CONTAINER)).toBeDefined();
  });

  it("does not honor another host's opt-in name", () => {
    setPlatform('darwin');
    process.env['CDK_DOCKER'] = 'finch';
    process.env['CDKD_ALLOW_SECRETS_ON_ARGV'] = '1';
    expect(finchSecretArgvRefusal(['DB_PASSWORD'], CONTAINER)).toBeDefined();
    setEmbedConfig({ envPrefix: 'CDKD' });
    expect(finchSecretArgvRefusal(['DB_PASSWORD'], CONTAINER)).toBeUndefined();
    // And the other way round: under the CDKD prefix, CDKL_* does not opt in.
    delete process.env['CDKD_ALLOW_SECRETS_ON_ARGV'];
    process.env['CDKL_ALLOW_SECRETS_ON_ARGV'] = '1';
    expect(finchSecretArgvRefusal(['DB_PASSWORD'], CONTAINER)).toBeDefined();
  });

  describe('warnFinchArgvExposure', () => {
    it('warns under finch on macOS naming the keys, once per key set', () => {
      setPlatform('darwin');
      process.env['CDK_DOCKER'] = 'finch';
      const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
      warnFinchArgvExposure(['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID']);
      warnFinchArgvExposure(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toContain('CDK_DOCKER=finch on macOS / Windows puts the values of');
      expect(msg).toContain('AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
      // A different key set warns again.
      warnFinchArgvExposure(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD']);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['finch', 'linux'],
      ['docker', 'darwin'],
    ] as const)('does not warn for %s on %s', (docker, platform) => {
      setPlatform(platform);
      process.env['CDK_DOCKER'] = docker;
      const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
      warnFinchArgvExposure(['AWS_SECRET_ACCESS_KEY']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('renders key names display-safe (issue #774)', () => {
      setPlatform('darwin');
      process.env['CDK_DOCKER'] = 'finch';
      const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
      const long = `K${'x'.repeat(5000)}`;
      warnFinchArgvExposure(['EVIL\u001b[31mKEY', long]);
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).not.toMatch(/\u001b/);
      expect(msg).toContain(displayUntrustedValue('EVIL\u001b[31mKEY'));
      expect(msg).toContain(displayUntrustedValue(long));
      expect(msg.length).toBeLessThan(1500);
    });

    it('does not warn for an empty key set', () => {
      setPlatform('darwin');
      process.env['CDK_DOCKER'] = 'finch';
      const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
      warnFinchArgvExposure([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
