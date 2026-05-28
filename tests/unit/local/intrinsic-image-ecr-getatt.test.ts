import { describe, it, expect } from 'vite-plus/test';
import {
  tryResolveImageFnJoin,
  type ImageResolutionContext,
} from '../../../src/local/intrinsic-image.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const REPO = 'BackendRepoABC123';

// The canonical CDK 2.x `ContainerImage.fromEcrRepository(repo, 'latest')`
// Image shape: the account + region are extracted by Fn::Select over
// Fn::Split(":", <repo Arn GetAtt>); the repo name is a Ref; the tag is a
// literal.
function canonicalImage(): unknown {
  const arnSplit = {
    'Fn::Split': [':', { 'Fn::GetAtt': [REPO, 'Arn'] }],
  };
  return {
    'Fn::Join': [
      '',
      [
        { 'Fn::Select': [4, arnSplit] }, // account
        '.dkr.ecr.',
        { 'Fn::Select': [3, arnSplit] }, // region
        '.',
        { Ref: 'AWS::URLSuffix' },
        '/',
        { Ref: REPO },
        ':latest',
      ],
    ],
  };
}

const resources: Record<string, TemplateResource> = {
  [REPO]: { Type: 'AWS::ECR::Repository', Properties: {} } as unknown as TemplateResource,
};

function repoState(attributes?: Record<string, unknown>): Record<string, ResourceState> {
  return {
    [REPO]: {
      physicalId: 'my-backend-repo',
      resourceType: 'AWS::ECR::Repository',
      properties: {},
      ...(attributes && { attributes }),
    },
  };
}

const pseudo = {
  accountId: '123456789012',
  region: 'ap-northeast-1',
  partition: 'aws',
  urlSuffix: 'amazonaws.com',
};

describe('tryResolveImageFnJoin — ECR GetAtt Arn under --from-cfn-stack', () => {
  it('synthesizes the repo Arn (no recorded attributes) so the canonical join resolves', () => {
    const ctx: ImageResolutionContext = { pseudoParameters: pseudo, stateResources: repoState() };
    const out = tryResolveImageFnJoin(canonicalImage(), resources, ctx);
    expect(out).toEqual({
      kind: 'resolved',
      uri: '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-backend-repo:latest',
    });
  });

  it('prefers a recorded Arn attribute over the synthesized one', () => {
    const ctx: ImageResolutionContext = {
      pseudoParameters: pseudo,
      stateResources: repoState({ Arn: 'arn:aws:ecr:us-west-2:999988887777:repository/other' }),
    };
    const out = tryResolveImageFnJoin(canonicalImage(), resources, ctx);
    // account/region come from the recorded Arn; the repo name still comes
    // from the Ref (physicalId).
    expect(out).toEqual({
      kind: 'resolved',
      uri: '999988887777.dkr.ecr.us-west-2.amazonaws.com/my-backend-repo:latest',
    });
  });

  it('returns needs-state when the repo is referenced but no state was supplied', () => {
    const out = tryResolveImageFnJoin(canonicalImage(), resources, { pseudoParameters: pseudo });
    expect(out).toEqual({ kind: 'needs-state', repoLogicalId: REPO });
  });

  it('cannot synthesize the Arn without an accountId, so the join is unsupported', () => {
    const ctx: ImageResolutionContext = {
      pseudoParameters: { region: 'ap-northeast-1', partition: 'aws', urlSuffix: 'amazonaws.com' },
      stateResources: repoState(),
    };
    const out = tryResolveImageFnJoin(canonicalImage(), resources, ctx);
    expect(out).toEqual({
      kind: 'unsupported-join',
      reason: 'one or more Fn::Join elements could not be resolved',
    });
  });

  it('synthesizes RepositoryUri for the GetAtt RepositoryUri shape', () => {
    const image = {
      'Fn::Join': ['', [{ 'Fn::GetAtt': [REPO, 'RepositoryUri'] }, ':latest']],
    };
    const ctx: ImageResolutionContext = { pseudoParameters: pseudo, stateResources: repoState() };
    const out = tryResolveImageFnJoin(image, resources, ctx);
    expect(out).toEqual({
      kind: 'resolved',
      uri: '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-backend-repo:latest',
    });
  });
});
