import { describe, it, expect } from 'vite-plus/test';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner.js';
import type { ResolvedEcsContainer, ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';

// buildDockerRunArgs reads only a bounded subset of the container/task
// shapes (name/environment/image + the iterated collections), so a cast
// partial keeps the fixture small.
function minimalContainer(environment: Record<string, string>): ResolvedEcsContainer {
  return {
    name: 'app',
    image: { kind: 'public', uri: 'public.ecr.aws/docker/library/busybox:latest' },
    environment,
    sensitiveEnvKeys: [],
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

function buildWithOverrides(
  environment: Record<string, string>,
  envOverrides: Record<string, Record<string, string | null> | undefined> | undefined
): string[] {
  const { args } = buildDockerRunArgs({
    task,
    container: minimalContainer(environment),
    image: 'public.ecr.aws/docker/library/busybox:latest',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    envOverrides,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: undefined,
  });
  return args;
}

// Returns the inline `-e KEY=VALUE` arg for a key, or undefined when the key
// was not passed to docker at all. (Non-sensitive env always lands as the
// single `KEY=VALUE` element; the bare-key `-e KEY` form is sensitive-only.)
function envFlagFor(args: string[], key: string): string | undefined {
  return args.find((a) => a.startsWith(`${key}=`));
}

describe('buildDockerRunArgs --env-vars overlay (ECS: start-service / start-alb / run-task)', () => {
  it('a null value in Parameters CLEARS a template env key (not "null", not empty)', () => {
    const args = buildWithOverrides(
      { LOG_LEVEL: 'info', FEATURE_FLAG: 'on' },
      { Parameters: { FEATURE_FLAG: null } }
    );

    // The cleared key is absent from docker's argv entirely — no `-e
    // FEATURE_FLAG=...` of any value, and crucially never the string "null".
    expect(envFlagFor(args, 'FEATURE_FLAG')).toBeUndefined();
    expect(args).not.toContain('FEATURE_FLAG=null');
    expect(args).not.toContain('FEATURE_FLAG=');
    expect(args.some((a) => a.startsWith('FEATURE_FLAG'))).toBe(false);

    // Untouched keys still pass through inline.
    expect(args).toContain('LOG_LEVEL=info');
  });

  it('a null value in a container-specific entry clears a template env key', () => {
    const args = buildWithOverrides(
      { LOG_LEVEL: 'info', SECRET_TOGGLE: 'on' },
      { app: { SECRET_TOGGLE: null } }
    );

    expect(envFlagFor(args, 'SECRET_TOGGLE')).toBeUndefined();
    expect(args).not.toContain('SECRET_TOGGLE=null');
    expect(args).toContain('LOG_LEVEL=info');
  });

  it('a non-null override value is applied (string-coerced), not cleared', () => {
    const args = buildWithOverrides(
      { LOG_LEVEL: 'info' },
      { Parameters: { LOG_LEVEL: 'debug', EXTRA: 'added' } }
    );

    expect(args).toContain('LOG_LEVEL=debug');
    expect(args).toContain('EXTRA=added');
  });

  it('the JSON string "null" is a literal value, NOT a clear directive', () => {
    // Only a real JSON null clears; the four-character string "null" is a
    // legitimate value a user might want, so it must survive verbatim.
    const args = buildWithOverrides({ MODE: 'real' }, { Parameters: { MODE: 'null' } });

    expect(args).toContain('MODE=null');
  });
});
