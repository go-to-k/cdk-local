import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

// The REAL SDK default chain (no provider mock): a credentials file written
// after a miss must be seen once the miss TTL has passed, so the SDK's
// process-wide shared-file cache must not pin the first (empty) read.
const { HOST_DEFAULT_CREDENTIALS_MISS_TTL_MS, resetWorkloadAwsWiringForTest, resolveHostDefaultCredentials } =
  await import('../../../src/local/workload-aws-wiring.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'chain-retry-'));
  resetWorkloadAwsWiringForTest();
  for (const k of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CREDENTIAL_EXPIRATION',
  ]) {
    vi.stubEnv(k, undefined);
  }
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', path.join(dir, 'credentials'));
  vi.stubEnv('AWS_CONFIG_FILE', path.join(dir, 'config'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetWorkloadAwsWiringForTest();
  rmSync(dir, { recursive: true, force: true });
});

it('picks up a credentials file written after a miss, once the miss TTL has passed', async () => {
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(5_000_000);
  await expect(resolveHostDefaultCredentials()).resolves.toBeUndefined();
  writeFileSync(
    path.join(dir, 'credentials'),
    '[default]\naws_access_key_id = AKIALATERLOGIN\naws_secret_access_key = later\n'
  );
  now.mockReturnValue(5_000_000 + HOST_DEFAULT_CREDENTIALS_MISS_TTL_MS);
  await expect(resolveHostDefaultCredentials()).resolves.toMatchObject({
    accessKeyId: 'AKIALATERLOGIN',
    secretAccessKey: 'later',
  });
});
