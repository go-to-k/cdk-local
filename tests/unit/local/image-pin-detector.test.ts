import { describe, it, expect } from 'vite-plus/test';
import {
  isLocalCdkAssetImage,
  describePinnedImageUri,
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
