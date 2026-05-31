import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type {
  ResolvedEcsContainer,
  ResolvedEcsTask,
} from '../../../src/local/ecs-task-resolver.js';

/**
 * Issue #238 (T2) — behavioral test for the per-container
 * `--image-override` short-circuit inside `prepareImages`.
 *
 * The boot path in `start-service` / `start-alb` builds an override tag
 * locally via `runImageOverrideBuilds`, then threads it into each
 * runner's `RunEcsTaskOptions.imageOverrideByContainer`. When that map
 * holds an entry for a container, the runner uses the local tag VERBATIM
 * and skips the pull / build path entirely — otherwise a `docker pull`
 * for a deterministic-local-only tag (which doesn't exist in any
 * registry) would fail at boot.
 *
 * Mocks the heavy boundaries (`docker-runner`, `docker-build`,
 * `ecr-puller`) so a non-override entry would call into them; the
 * override entry MUST NOT.
 */

const { pullImageMock, pullEcrImageMock, buildDockerImageMock } = vi.hoisted(() => ({
  pullImageMock: vi.fn(),
  pullEcrImageMock: vi.fn(),
  buildDockerImageMock: vi.fn(),
}));

vi.mock('../../../src/local/docker-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/docker-runner.js')>(
    '../../../src/local/docker-runner.js'
  );
  return {
    ...actual,
    pullImage: pullImageMock,
  };
});

vi.mock('../../../src/local/ecr-puller.js', () => ({
  pullEcrImage: pullEcrImageMock,
}));

vi.mock('../../../src/assets/docker-build.js', () => ({
  buildDockerImage: buildDockerImageMock,
}));

const { prepareImages } = await import('../../../src/local/ecs-task-runner.js');

function publicImageContainer(name: string, uri: string): ResolvedEcsContainer {
  return {
    name,
    image: { kind: 'public', uri },
    environment: {},
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

describe('ecs-task-runner prepareImages --image-override short-circuit (issue #238)', () => {
  beforeEach(() => {
    pullImageMock.mockReset();
    pullEcrImageMock.mockReset();
    buildDockerImageMock.mockReset();
    pullImageMock.mockResolvedValue(undefined);
  });

  it('uses the override tag verbatim and skips pullImage when the container has an override', async () => {
    const container = publicImageContainer(
      'app',
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:1.2.3'
    );
    const task = { containers: [container] } as unknown as ResolvedEcsTask;
    const out = new Map<string, string>();
    await prepareImages(task, out, {
      // Caller-supplied override map (the same shape the start-service
      // boot path threads through).
      imageOverrideByContainer: new Map([['app', 'cdkl-override-app-deadbeef:local']]),
      // Required-shape fields that aren't load-bearing for this branch.
      keepRunning: false,
      detach: false,
      skipPull: false,
    } as unknown as Parameters<typeof prepareImages>[2]);
    expect(out.get('app')).toBe('cdkl-override-app-deadbeef:local');
    expect(pullImageMock).not.toHaveBeenCalled();
    expect(pullEcrImageMock).not.toHaveBeenCalled();
    expect(buildDockerImageMock).not.toHaveBeenCalled();
  });

  it('falls through to pullImage (deployed URI) when no override entry is present for the container', async () => {
    const container = publicImageContainer(
      'sidecar',
      'public.ecr.aws/docker/library/busybox:latest'
    );
    const task = { containers: [container] } as unknown as ResolvedEcsTask;
    const out = new Map<string, string>();
    await prepareImages(task, out, {
      // Override map either empty or naming a DIFFERENT container —
      // both should fall through. Test the "different container"
      // case so we cover the per-container key lookup.
      imageOverrideByContainer: new Map([['app', 'cdkl-override-app-deadbeef:local']]),
      keepRunning: false,
      detach: false,
      skipPull: false,
    } as unknown as Parameters<typeof prepareImages>[2]);
    expect(pullImageMock).toHaveBeenCalledTimes(1);
    expect(pullImageMock.mock.calls[0]![0]).toBe(
      'public.ecr.aws/docker/library/busybox:latest'
    );
    expect(out.get('sidecar')).toBe('public.ecr.aws/docker/library/busybox:latest');
  });

  it('mixes override + fall-through across sibling containers in one task', async () => {
    // The override map can hold a subset of the task's containers; the
    // rest go through `prepareOneImage`'s pull/build path normally.
    const containers = [
      publicImageContainer('app', '123.dkr.ecr.us-east-1.amazonaws.com/app:1.0.0'),
      publicImageContainer('logs', 'public.ecr.aws/aws-observability/aws-otel-collector:latest'),
    ];
    const task = { containers } as unknown as ResolvedEcsTask;
    const out = new Map<string, string>();
    await prepareImages(task, out, {
      imageOverrideByContainer: new Map([['app', 'cdkl-override-app-cafef00d:local']]),
      keepRunning: false,
      detach: false,
      skipPull: false,
    } as unknown as Parameters<typeof prepareImages>[2]);
    expect(out.get('app')).toBe('cdkl-override-app-cafef00d:local');
    expect(out.get('logs')).toBe(
      'public.ecr.aws/aws-observability/aws-otel-collector:latest'
    );
    // pullImage called exactly once — for the sidecar, not the overridden app.
    expect(pullImageMock).toHaveBeenCalledTimes(1);
    expect(pullImageMock.mock.calls[0]![0]).toBe(
      'public.ecr.aws/aws-observability/aws-otel-collector:latest'
    );
  });
});
