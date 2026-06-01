import { describe, it, expect } from 'vite-plus/test';
import {
  isLocalCdkAssetImage,
  describePinnedImageUri,
  listPinnedTargets,
} from '../../../src/local/image-pin-detector.js';
import type { ResolvedEcsService } from '../../../src/local/ecs-service-resolver.js';
import type { ResolvedEcsContainer, ResolvedEcsImage } from '../../../src/local/ecs-task-resolver.js';

/**
 * Issue #234 — minimal fake `ResolvedEcsService` shaped just enough
 * for the image-pin detector to read `task.containers[i].image` and
 * `task.containers[i].essential`. The actual `ResolvedEcsService`
 * interface is wide; we don't need 90% of it for this helper.
 */
function fakeService(containers: Array<Partial<ResolvedEcsContainer>>): ResolvedEcsService {
  return {
    task: {
      containers: containers.map(
        (c, i) =>
          ({
            name: c.name ?? `c${i}`,
            essential: c.essential ?? false,
            image: c.image ?? ({ kind: 'cdk-asset' } as ResolvedEcsImage),
            environment: {},
            sensitiveEnvKeys: [],
            secrets: [],
            portMappings: [],
            mountPoints: [],
            dependsOn: [],
            links: [],
            ulimits: [],
            warnings: [],
          }) as ResolvedEcsContainer
      ),
      // The detector only reads `task.containers`; the rest is unused.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('isLocalCdkAssetImage (issue #234)', () => {
  it('returns true for a CDK-asset essential container', () => {
    const service = fakeService([{ essential: true, image: { kind: 'cdk-asset', assetHash: 'h' } }]);
    expect(isLocalCdkAssetImage(service)).toBe(true);
  });

  it('returns false for an ECR-pinned essential container (`--from-cfn-stack` typical)', () => {
    const service = fakeService([
      {
        essential: true,
        image: {
          kind: 'ecr',
          uri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:4.5.1',
          account: '123456789012',
          region: 'us-east-1',
        },
      },
    ]);
    expect(isLocalCdkAssetImage(service)).toBe(false);
  });

  it('returns false for a public-registry pin', () => {
    const service = fakeService([
      { essential: true, image: { kind: 'public', uri: 'nginx:latest' } },
    ]);
    expect(isLocalCdkAssetImage(service)).toBe(false);
  });

  it('picks the FIRST essential when multiple containers are present (sidecar after main)', () => {
    // First container is a non-essential sidecar with a CDK asset; main
    // (essential, ECR pin) is second. The detector should classify the
    // service on the essential main, not the sidecar.
    const service = fakeService([
      { essential: false, image: { kind: 'cdk-asset', assetHash: 'sidecar' } },
      {
        essential: true,
        image: {
          kind: 'ecr',
          uri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/main:tag',
          account: '111111111111',
          region: 'us-east-1',
        },
      },
    ]);
    expect(isLocalCdkAssetImage(service)).toBe(false);
  });

  it('falls back to the first container when nothing is marked essential', () => {
    const service = fakeService([
      { essential: false, image: { kind: 'cdk-asset', assetHash: 'h' } },
      {
        essential: false,
        image: { kind: 'ecr', uri: 'x', account: 'a', region: 'r' },
      },
    ]);
    expect(isLocalCdkAssetImage(service)).toBe(true);
  });

  it('returns false when the service has no containers (degenerate)', () => {
    const service = fakeService([]);
    expect(isLocalCdkAssetImage(service)).toBe(false);
  });
});

describe('describePinnedImageUri (issue #234)', () => {
  it('returns the full ECR URI for an ECR-pinned essential container', () => {
    const service = fakeService([
      {
        essential: true,
        image: {
          kind: 'ecr',
          uri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:4.5.1',
          account: '123456789012',
          region: 'us-east-1',
        },
      },
    ]);
    expect(describePinnedImageUri(service)).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:4.5.1'
    );
  });

  it('returns the literal URI for a public-registry pin', () => {
    const service = fakeService([
      { essential: true, image: { kind: 'public', uri: 'public.ecr.aws/foo/bar:1.2.3' } },
    ]);
    expect(describePinnedImageUri(service)).toBe('public.ecr.aws/foo/bar:1.2.3');
  });

  it('returns undefined for a local CDK-asset image (warn does not fire)', () => {
    const service = fakeService([{ essential: true, image: { kind: 'cdk-asset', assetHash: 'h' } }]);
    expect(describePinnedImageUri(service)).toBeUndefined();
  });

  it('returns undefined when the service has no containers (degenerate)', () => {
    const service = fakeService([]);
    expect(describePinnedImageUri(service)).toBeUndefined();
  });
});

describe('listPinnedTargets (issue #242 / N1 dedupe)', () => {
  function ecrService(uri: string): ResolvedEcsService {
    return fakeService([
      {
        essential: true,
        image: { kind: 'ecr', uri, account: '000000000000', region: 'us-east-1' },
      },
    ]);
  }
  function assetService(): ResolvedEcsService {
    return fakeService([{ essential: true, image: { kind: 'cdk-asset', assetHash: 'h' } }]);
  }
  function publicService(uri: string): ResolvedEcsService {
    return fakeService([{ essential: true, image: { kind: 'public', uri } }]);
  }

  it('returns one entry per pinned target with the URI label preserved', () => {
    const out = listPinnedTargets([
      { target: 'StackA/AppService', service: ecrService('111.dkr.ecr.us-east-1.amazonaws.com/a:1') },
      { target: 'StackA/AuthService', service: ecrService('111.dkr.ecr.us-east-1.amazonaws.com/b:2') },
    ]);
    expect(out).toEqual([
      { target: 'StackA/AppService', label: '111.dkr.ecr.us-east-1.amazonaws.com/a:1' },
      { target: 'StackA/AuthService', label: '111.dkr.ecr.us-east-1.amazonaws.com/b:2' },
    ]);
  });

  it('filters out CDK-asset targets (only pinned targets surface)', () => {
    const out = listPinnedTargets([
      { target: 'StackA/AssetSvc', service: assetService() },
      { target: 'StackA/AssetSvc2', service: assetService() },
    ]);
    expect(out).toEqual([]);
  });

  it('handles a mixed set: pinned + asset interleaved', () => {
    const out = listPinnedTargets([
      { target: 'AppSvc', service: assetService() },
      { target: 'AuthSvc', service: ecrService('111.dkr.ecr.us-east-1.amazonaws.com/auth:1') },
      { target: 'WebSvc', service: assetService() },
      { target: 'BgSvc', service: publicService('nginx:latest') },
    ]);
    expect(out).toEqual([
      { target: 'AuthSvc', label: '111.dkr.ecr.us-east-1.amazonaws.com/auth:1' },
      { target: 'BgSvc', label: 'nginx:latest' },
    ]);
  });

  it('returns [] for an empty iterable (no booted services on the controller)', () => {
    expect(listPinnedTargets([])).toEqual([]);
  });

  it('preserves caller-supplied iteration order across pinned entries', () => {
    const order: Array<{ target: string; service: ResolvedEcsService }> = [
      { target: 'Z', service: ecrService('e.com/z:1') },
      { target: 'A', service: ecrService('e.com/a:1') },
      { target: 'M', service: ecrService('e.com/m:1') },
    ];
    expect(listPinnedTargets(order).map((e) => e.target)).toEqual(['Z', 'A', 'M']);
  });

  it('omits the `label` property when the service has no containers (degenerate)', () => {
    // No containers => describePinnedImageUri returns undefined, but the
    // target is still NOT a local CDK asset (no image at all), so it
    // surfaces as a pinned-target entry sans label. The WARN loop falls
    // back to "a deployed registry" prose when label is undefined.
    const empty = fakeService([]);
    expect(listPinnedTargets([{ target: 'Empty', service: empty }])).toEqual([
      { target: 'Empty' },
    ]);
  });
});
