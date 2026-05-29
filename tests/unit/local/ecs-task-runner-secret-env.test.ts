import { describe, it, expect } from 'vite-plus/test';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// buildDockerRunArgs reads only a bounded subset of the container/task
// shapes (name/environment/image + the iterated collections), so a cast
// partial keeps the fixture small.
function minimalContainer(
  environment: Record<string, string>,
  sensitiveEnvKeys: string[] = []
): ResolvedEcsContainer {
  return {
    name: 'app',
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment,
    sensitiveEnvKeys,
    secrets: [],
    portMappings: [],
    mountPoints: [],
    dependsOn: [],
    links: [],
    essential: true,
    ulimits: [],
    warnings: [],
  } as unknown as ResolvedEcsContainer;
}

const task = { family: 'fam' } as unknown as ResolvedEcsTask;

describe('buildDockerRunArgs secret env routing', () => {
  it('routes resolved secret values through `-e KEY` pass-through, never argv', () => {
    const { args, sensitiveEnv } = buildDockerRunArgs({
      task,
      container: minimalContainer({ LOG_LEVEL: 'info' }),
      image: 'public.ecr.aws/docker/library/busybox:latest',
      network: 'net',
      volumeByName: new Map(),
      secrets: [{ name: 'DB_PASSWORD', value: 'p@ss-w0rd' }],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });

    // The secret is emitted as a value-less `-e DB_PASSWORD` pair...
    const i = args.indexOf('DB_PASSWORD');
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe('-e');
    // ...with NO inline `DB_PASSWORD=...` form, and the value never in argv.
    expect(args.some((a) => a.startsWith('DB_PASSWORD='))).toBe(false);
    expect(args.join(' ')).not.toContain('p@ss-w0rd');

    // Non-secret config keeps the inline form.
    expect(args).toContain('LOG_LEVEL=info');

    // The value is carried in the passthrough map (merged into the docker
    // process env at the run site), not in argv.
    expect(sensitiveEnv['DB_PASSWORD']).toBe('p@ss-w0rd');
    expect(sensitiveEnv['LOG_LEVEL']).toBeUndefined();
  });

  it('routes SecureString-backed env keys off the argv too (issue #99)', () => {
    const { args, sensitiveEnv } = buildDockerRunArgs({
      task,
      // API_KEY resolved to a decrypted SecureString SSM param — flagged on
      // the container so the runner keeps it off the `docker run` argv.
      container: minimalContainer({ LOG_LEVEL: 'info', API_KEY: 's3cr3t' }, ['API_KEY']),
      image: 'public.ecr.aws/docker/library/busybox:latest',
      network: 'net',
      volumeByName: new Map(),
      secrets: [],
      envOverrides: undefined,
      containerHost: '127.0.0.1',
      roleArn: undefined,
      platformOverride: undefined,
      region: undefined,
    });

    // API_KEY is the value-less `-e API_KEY` form; the secret never in argv.
    const i = args.indexOf('API_KEY');
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe('-e');
    expect(args.some((a) => a.startsWith('API_KEY='))).toBe(false);
    expect(args.join(' ')).not.toContain('s3cr3t');
    expect(sensitiveEnv['API_KEY']).toBe('s3cr3t');

    // Non-sensitive config still inline.
    expect(args).toContain('LOG_LEVEL=info');
    expect(sensitiveEnv['LOG_LEVEL']).toBeUndefined();
  });
});
