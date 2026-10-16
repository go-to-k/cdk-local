import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resetEmbedConfig, setEmbedConfig } from '../../../src/local/embed-config.js';
import { buildProxyClientConfig } from '../../../src/utils/aws-proxy.js';
import { buildStsClientConfig } from '../../../src/utils/profile-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';
import {
  SECOND_ASSUME_MESSAGE,
  applyWorkloadEnvCredentials,
  assumedRoleRecorded,
  readEnvCallerCredentials,
  recordAssumedRole,
  resetWorkloadIdentity,
  workloadClientConfig,
  workloadStsClientConfig,
} from '../../../src/utils/workload-identity.js';

const ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

const CALLER = {
  accessKeyId: 'AKIACALLER',
  secretAccessKey: 'callerSecret',
  sessionToken: 'callerToken',
};

describe('workload-identity', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    resetWorkloadIdentity();
    resetEmbedConfig();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetWorkloadIdentity();
    resetEmbedConfig();
    vi.restoreAllMocks();
  });

  describe("role mode (the default) is byte-identical", () => {
    it('workloadClientConfig equals buildProxyClientConfig without a proxy', () => {
      expect(workloadClientConfig()).toEqual(buildProxyClientConfig());
      expect(workloadClientConfig({ profile: 'p' })).toEqual(buildProxyClientConfig({ profile: 'p' }));
    });

    it('workloadClientConfig equals buildProxyClientConfig with a proxy env', () => {
      process.env['HTTPS_PROXY'] = 'http://proxy.example:3128';
      const w = workloadClientConfig();
      const b = buildProxyClientConfig();
      expect(Object.keys(w).sort()).toEqual(Object.keys(b).sort());
      expect(w.requestHandler).toBeDefined();
      expect(typeof w.credentials).toBe(typeof b.credentials);
    });

    it('stays byte-identical even after an assume is recorded', () => {
      recordAssumedRole(CALLER);
      expect(workloadClientConfig()).toEqual(buildProxyClientConfig());
      expect(workloadClientConfig()).not.toHaveProperty('credentials');
    });

    it('workloadStsClientConfig equals buildStsClientConfig', () => {
      expect(workloadStsClientConfig({ region: 'us-east-1', profile: 'p' })).toEqual(
        buildStsClientConfig({ region: 'us-east-1', profile: 'p' })
      );
      expect(workloadStsClientConfig({})).toEqual(buildStsClientConfig({}));
    });

    it("applyWorkloadEnvCredentials returns 'unchanged' and leaves the env untouched", () => {
      recordAssumedRole(CALLER);
      const env: Record<string, string | undefined> = {
        AWS_ACCESS_KEY_ID: 'AKIAROLE',
        AWS_SECRET_ACCESS_KEY: 'roleSecret',
        AWS_SESSION_TOKEN: 'roleToken',
      };
      const before = { ...env };
      expect(applyWorkloadEnvCredentials(env)).toBe('unchanged');
      expect(env).toEqual(before);
    });
  });

  describe("caller mode", () => {
    beforeEach(() => {
      setEmbedConfig({ workloadIdentity: 'caller' });
    });

    it('without a recorded assume, everything is unchanged', async () => {
      expect(workloadClientConfig()).toEqual(buildProxyClientConfig());
      const env: Record<string, string | undefined> = { AWS_ACCESS_KEY_ID: 'AKIAX' };
      expect(applyWorkloadEnvCredentials(env)).toBe('unchanged');
      expect(env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIAX' });
    });

    it('after recordAssumedRole(triple), workloadClientConfig resolves the caller triple', async () => {
      recordAssumedRole(CALLER);
      const cfg = workloadClientConfig();
      expect(typeof cfg.credentials).toBe('function');
      expect(await (cfg.credentials as () => Promise<unknown>)()).toEqual(CALLER);
      const sts = workloadStsClientConfig({ region: 'eu-west-1' });
      expect(sts.region).toBe('eu-west-1');
      expect(await (sts.credentials as () => Promise<unknown>)()).toEqual(CALLER);
    });

    it('omits sessionToken when the caller had none', async () => {
      recordAssumedRole({ accessKeyId: 'AKIAC', secretAccessKey: 's' });
      const creds = await (workloadClientConfig().credentials as () => Promise<unknown>)();
      expect(creds).toEqual({ accessKeyId: 'AKIAC', secretAccessKey: 's' });
    });

    it('injects no credentials when a profile is passed', () => {
      recordAssumedRole(CALLER);
      expect(workloadClientConfig({ profile: 'dev' })).not.toHaveProperty('credentials');
    });

    it('injects no credentials when AWS_PROFILE is set', () => {
      recordAssumedRole(CALLER);
      process.env['AWS_PROFILE'] = 'dev';
      expect(workloadClientConfig()).not.toHaveProperty('credentials');
    });

    it('after recordAssumedRole(undefined), credentials is the caller-chain provider', () => {
      recordAssumedRole(undefined);
      const cfg = workloadClientConfig();
      expect(typeof cfg.credentials).toBe('function');
      expect(buildProxyClientConfig()).not.toHaveProperty('credentials');
    });

    it('applyWorkloadEnvCredentials restores the caller triple', () => {
      recordAssumedRole(CALLER);
      const env: Record<string, string | undefined> = {
        AWS_ACCESS_KEY_ID: 'AKIAROLE',
        AWS_SECRET_ACCESS_KEY: 'roleSecret',
        AWS_SESSION_TOKEN: 'roleToken',
        AWS_REGION: 'us-east-1',
      };
      expect(applyWorkloadEnvCredentials(env)).toBe('restored');
      expect(env).toEqual({
        AWS_ACCESS_KEY_ID: CALLER.accessKeyId,
        AWS_SECRET_ACCESS_KEY: CALLER.secretAccessKey,
        AWS_SESSION_TOKEN: CALLER.sessionToken,
        AWS_REGION: 'us-east-1',
      });
    });

    it('restore deletes AWS_SESSION_TOKEN when the caller had none', () => {
      recordAssumedRole({ accessKeyId: 'AKIAC', secretAccessKey: 's' });
      const env: Record<string, string | undefined> = {
        AWS_ACCESS_KEY_ID: 'AKIAROLE',
        AWS_SECRET_ACCESS_KEY: 'roleSecret',
        AWS_SESSION_TOKEN: 'roleToken',
      };
      expect(applyWorkloadEnvCredentials(env)).toBe('restored');
      expect(env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIAC', AWS_SECRET_ACCESS_KEY: 's' });
      expect('AWS_SESSION_TOKEN' in env).toBe(false);
    });

    it('strips the triple and warns exactly once when the caller had no static triple', () => {
      const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
      recordAssumedRole(undefined);
      const first: Record<string, string | undefined> = {
        AWS_ACCESS_KEY_ID: 'AKIAROLE',
        AWS_SECRET_ACCESS_KEY: 'roleSecret',
        AWS_SESSION_TOKEN: 'roleToken',
        AWS_REGION: 'us-east-1',
      };
      expect(applyWorkloadEnvCredentials(first)).toBe('stripped');
      expect(first).toEqual({ AWS_REGION: 'us-east-1' });
      const second: Record<string, string | undefined> = { AWS_ACCESS_KEY_ID: 'AKIAROLE' };
      expect(applyWorkloadEnvCredentials(second)).toBe('stripped');
      expect(second).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('--profile');
    });
  });

  describe('recordAssumedRole', () => {
    it('is write-once', () => {
      recordAssumedRole(CALLER);
      expect(assumedRoleRecorded()).toBe(true);
      expect(() => recordAssumedRole(CALLER)).toThrow(SECOND_ASSUME_MESSAGE);
      expect(() => recordAssumedRole(undefined)).toThrow(SECOND_ASSUME_MESSAGE);
    });

    it('resetWorkloadIdentity clears the record', () => {
      recordAssumedRole(CALLER);
      resetWorkloadIdentity();
      expect(assumedRoleRecorded()).toBe(false);
      expect(() => recordAssumedRole(CALLER)).not.toThrow();
    });

    it('copies its input', async () => {
      setEmbedConfig({ workloadIdentity: 'caller' });
      const input = { ...CALLER };
      recordAssumedRole(input);
      input.accessKeyId = 'AKIAMUTATED';
      input.secretAccessKey = 'mutated';
      const creds = await (workloadClientConfig().credentials as () => Promise<unknown>)();
      expect(creds).toEqual(CALLER);
    });
  });

  describe('readEnvCallerCredentials', () => {
    it('reads a complete triple and ignores an incomplete one', () => {
      expect(readEnvCallerCredentials({})).toBeUndefined();
      expect(readEnvCallerCredentials({ AWS_ACCESS_KEY_ID: 'a' })).toBeUndefined();
      expect(
        readEnvCallerCredentials({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's' })
      ).toEqual({ accessKeyId: 'a', secretAccessKey: 's' });
      expect(
        readEnvCallerCredentials({
          AWS_ACCESS_KEY_ID: 'a',
          AWS_SECRET_ACCESS_KEY: 's',
          AWS_SESSION_TOKEN: 't',
        })
      ).toEqual({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' });
    });
  });
});
