/**
 * go-to-k/cdk-local#946: the single-asset fallback of
 * `getDockerImageBySourceHash` must only take a URI that points at that
 * asset's own destination repository. A literal ECR URI or a
 * `DockerImageCode.fromEcr` repository is a different image: returning the
 * stack's one Docker asset for it ran ANOTHER function's code (and skipped
 * the `--aws-emulator` real-ECR refusal).
 */
import { describe, expect, it } from 'vite-plus/test';
import { getDockerImageBySourceHash } from '../../../src/assets/asset-manifest-loader.js';
import type { AssetManifest } from '../../../src/types/assets.js';

const HASH = 'e310e4da7f3bdb22c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const ASSET_REPO = 'cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}';

function manifest(repositoryName = ASSET_REPO, hashes: string[] = [HASH]): AssetManifest {
  return {
    version: '36.0.0',
    files: {},
    dockerImages: Object.fromEntries(
      hashes.map((h) => [
        h,
        {
          displayName: `img-${h.slice(0, 4)}`,
          source: { directory: `asset.${h}` },
          destinations: {
            'current_account-current_region': {
              repositoryName,
              imageTag: h,
            },
          },
        },
      ])
    ),
  } as unknown as AssetManifest;
}

const ASSET_URI_BODY =
  '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}';

describe('getDockerImageBySourceHash', () => {
  it('matches the asset by the hash tail of the CDK asset URI', () => {
    expect(getDockerImageBySourceHash(manifest(), `${ASSET_URI_BODY}:${HASH}`)?.hash).toBe(HASH);
  });

  it('falls back to the single asset for a digest pin on the asset repository', () => {
    const uri = `${ASSET_URI_BODY}@sha256:${'a'.repeat(64)}`;
    expect(getDockerImageBySourceHash(manifest(), uri)?.hash).toBe(HASH);
  });

  it('falls back to the single asset for a custom tag on the asset repository (resolved pseudo parameters)', () => {
    const uri =
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-east-1:custom';
    expect(getDockerImageBySourceHash(manifest(), uri)?.hash).toBe(HASH);
  });

  it('falls back when the manifest carries a concrete account/region and the URI still has placeholders', () => {
    const m = manifest('cdk-hnb659fds-container-assets-123456789012-us-east-1');
    expect(getDockerImageBySourceHash(m, `${ASSET_URI_BODY}:custom`)?.hash).toBe(HASH);
  });

  it.each([
    ['a literal ECR URI', '123456789012.dkr.ecr.us-east-1.amazonaws.com/some-repo:latest'],
    ['a literal ECR digest pin', `123456789012.dkr.ecr.us-east-1.amazonaws.com/some-repo@sha256:${'b'.repeat(64)}`],
    ['a fromEcr Fn::Sub URI', '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/my-repo:v1'],
    ['a same-stack repository reference', '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/${MyRepo}:latest'],
    ['a public image', 'public.ecr.aws/lambda/nodejs:22'],
    ['a bare Docker Hub name', 'node:22'],
  ])('does NOT return the single asset for %s', (_label, uri) => {
    expect(getDockerImageBySourceHash(manifest(), uri)).toBeUndefined();
  });

  it('does not fall back with two assets and no hash match', () => {
    const m = manifest(ASSET_REPO, [HASH, 'f'.repeat(64)]);
    expect(getDockerImageBySourceHash(m, `${ASSET_URI_BODY}:custom`)).toBeUndefined();
  });
});
