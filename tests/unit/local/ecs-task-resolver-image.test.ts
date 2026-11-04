import { describe, it, expect } from 'vite-plus/test';
import {
  assertEcsTaskImagesResolvable,
  resolveEcsTaskTarget,
  EcsTaskResolutionError,
} from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

/**
 * The canonical `Fn::Join` CDK 2.x synthesizes for
 * `ContainerImage.fromEcrRepository(repo, tag)`. The shape carries a
 * same-stack `Ref: <RepoLogicalId>` (load-bearing signal that the join
 * is an ECR image URI) plus `Fn::GetAtt: [<Repo>, 'Arn']`. Without a
 * state record cdk-local cannot substitute the repo's deployed physical
 * name, so the resolver returns `needs-state` and the consumer throws
 * with an actionable remedy hint.
 */
function canonicalFromEcrJoin(repoLogicalId: string, tag: string): unknown {
  return {
    'Fn::Join': [
      '',
      [
        {
          'Fn::Select': [
            4,
            { 'Fn::Split': [':', { 'Fn::GetAtt': [repoLogicalId, 'Arn'] }] },
          ],
        },
        '.dkr.ecr.',
        {
          'Fn::Select': [
            3,
            { 'Fn::Split': [':', { 'Fn::GetAtt': [repoLogicalId, 'Arn'] }] },
          ],
        },
        '.',
        { Ref: 'AWS::URLSuffix' },
        '/',
        { Ref: repoLogicalId },
        `:${tag}`,
      ],
    ],
  };
}

function buildStack(stackName: string, resources: Record<string, TemplateResource>): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template,
    dependencyNames: [],
    region: 'ap-northeast-1',
  };
}

function buildEcsResources(repoLogicalId: string): Record<string, TemplateResource> {
  return {
    [repoLogicalId]: { Type: 'AWS::ECR::Repository', Properties: {} },
    Task: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: 'demo',
        ContainerDefinitions: [
          {
            Name: 'App',
            Image: canonicalFromEcrJoin(repoLogicalId, 'latest'),
            Essential: true,
          },
        ],
      },
    },
  };
}

describe('resolveEcsTaskTarget — same-stack ECR Fn::Join needs deployed state', () => {
  /** Resolve, then refuse uncovered images the way every CLI path does. */
  function resolveAndAssert(
    stack: StackInfo,
    ctx?: Parameters<typeof resolveEcsTaskTarget>[2]
  ): () => void {
    return () => assertEcsTaskImagesResolvable(resolveEcsTaskTarget('App:Task', [stack], ctx));
  }

  it('throws the generic --from-cfn-stack hint when no state context is supplied', () => {
    const stack = buildStack('App', buildEcsResources('MyRepo'));
    expect(resolveAndAssert(stack)).toThrow(EcsTaskResolutionError);
    expect(resolveAndAssert(stack)).toThrow(/references same-stack ECR repository MyRepo/);
    expect(resolveAndAssert(stack)).toThrow(
      /pass --from-cfn-stack to load the deployed stack state/
    );
    // Issue #847 — the remedy names the override that can replace it.
    expect(resolveAndAssert(stack)).toThrow(/--image-override/);
    // The original message used to be hardcoded to `cdkl run-task`,
    // but the resolver is shared by start-alb / start-service /
    // run-task, so the command name is dropped — only the binary
    // name remains.
    expect(resolveAndAssert(stack)).not.toThrow(/cdkl run-task/);
  });

  it('flips the remedy to "the state-source attempt failed: ..." when the context records a load failure', () => {
    const stack = buildStack('App', buildEcsResources('MyRepo'));
    const ctx = {
      stateLoadFailureMessage:
        "ListStackResources(dev-goto-Reco-App) failed: ValidationError HTTP 400: Stack with id dev-goto-Reco-App does not exist (region='ap-northeast-1')",
    };
    expect(resolveAndAssert(stack, ctx)).toThrow(
      /the state-source attempt failed: ListStackResources\(dev-goto-Reco-App\) failed:/
    );
    expect(resolveAndAssert(stack, ctx)).toThrow(/--from-cfn-stack <deployed-name>/);
    expect(resolveAndAssert(stack, ctx)).toThrow(/--region \/ --profile/);
    // Should NOT re-suggest passing --from-cfn-stack as the primary
    // remedy: the user already passed it.
    expect(resolveAndAssert(stack, ctx)).not.toThrow(
      /pass --from-cfn-stack to load the deployed stack state/
    );
  });
});

// Issue #847 — a same-stack ECR image with no deployed state resolves to a
// `same-stack-ecr` pin (so `--image-override` can replace it) instead of
// throwing; `assertEcsTaskImagesResolvable` refuses only uncovered containers.
describe('resolveEcsTaskTarget — same-stack ECR image without state (issue #847)', () => {
  function stackWithImages(images: Array<[string, unknown]>): StackInfo {
    return buildStack('App', {
      MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      Task: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: 'demo',
          ContainerDefinitions: images.map(([Name, Image], i) => ({
            Name,
            Image,
            Essential: i === 0,
          })),
        },
      },
    });
  }

  it.each([
    ['the CDK fromEcrRepository Fn::Join', canonicalFromEcrJoin('MyRepo', 'v1')],
    [
      'an Fn::Sub ${Repo} placeholder',
      { 'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:v1' },
    ],
    ['an Fn::GetAtt RepositoryUri', { 'Fn::GetAtt': ['MyRepo', 'RepositoryUri'] }],
  ])('resolves %s to a same-stack-ecr pin naming the repository', (_shape, image) => {
    const task = resolveEcsTaskTarget('App:Task', [stackWithImages([['App', image]])], {
      pseudoParameters: { accountId: '111111111111', region: 'us-east-1' },
    });
    const resolved = task.containers[0]!.image;
    expect(resolved.kind).toBe('same-stack-ecr');
    expect(resolved.kind === 'same-stack-ecr' && resolved.repoLogicalId).toBe('MyRepo');
    expect(() => assertEcsTaskImagesResolvable(task)).toThrow(
      /Container App in task Task references same-stack ECR repository MyRepo/
    );
  });

  it('passes when every same-stack-ecr container is covered by an override', () => {
    const task = resolveEcsTaskTarget(
      'App:Task',
      [stackWithImages([['App', canonicalFromEcrJoin('MyRepo', 'v1')]])]
    );
    expect(() => assertEcsTaskImagesResolvable(task, new Map([['App', 'tag:local']]))).not.toThrow();
    expect(() => assertEcsTaskImagesResolvable(task, new Set(['App']))).not.toThrow();
  });

  it('still refuses an uncovered sibling container, naming only that one', () => {
    const task = resolveEcsTaskTarget(
      'App:Task',
      [
        stackWithImages([
          ['App', canonicalFromEcrJoin('MyRepo', 'v1')],
          ['Worker', canonicalFromEcrJoin('MyRepo', 'v2')],
        ]),
      ]
    );
    const err = (() => {
      try {
        assertEcsTaskImagesResolvable(task, new Set(['App']));
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(EcsTaskResolutionError);
    expect(err!.message).toContain('Container Worker');
    expect(err!.message).not.toContain('Container App');
  });

  it('a state-recorded RepositoryUri still resolves to a pullable ECR image', () => {
    const uri = '111111111111.dkr.ecr.us-east-1.amazonaws.com/my-repo';
    const task = resolveEcsTaskTarget(
      'App:Task',
      [stackWithImages([['App', { 'Fn::GetAtt': ['MyRepo', 'RepositoryUri'] }]])],
      {
        stateResources: {
          MyRepo: {
            physicalId: 'my-repo',
            resourceType: 'AWS::ECR::Repository',
            properties: {},
            attributes: { RepositoryUri: uri },
          },
        } as never,
      }
    );
    expect(task.containers[0]!.image).toStrictEqual({
      kind: 'ecr',
      uri,
      account: '111111111111',
      region: 'us-east-1',
    });
  });
});

describe('resolveEcsTaskTarget — ECR host forms and partitions (issue #760)', () => {
  const ACCT = '123456789012';
/** U+212A KELVIN SIGN: `toLowerCase` folds it onto ASCII `k`. */
const KELVIN = String.fromCodePoint(0x212a);

  function taskWithImage(image: unknown): Record<string, TemplateResource> {
    return {
      MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      Task: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: 'demo',
          ContainerDefinitions: [{ Name: 'App', Image: image, Essential: true }],
        },
      },
    };
  }

  function resolveImage(image: unknown, context?: Parameters<typeof resolveEcsTaskTarget>[2]) {
    const stack = buildStack('App', taskWithImage(image));
    return resolveEcsTaskTarget('App:Task', [stack], context).containers[0]!.image;
  }

  it.each([
    [`${ACCT}.dkr.ecr.us-east-1.amazonaws.com/r:t`, 'us-east-1'],
    [`${ACCT}.dkr.ecr-fips.us-east-1.amazonaws.com/r:t`, 'us-east-1'],
    [`${ACCT}.dkr-ecr.us-east-1.on.aws/r:t`, 'us-east-1'],
    [`${ACCT}.dkr-ecr-fips.us-west-2.on.aws/r:t`, 'us-west-2'],
    [`${ACCT}.dkr.ecr.us-iso-east-1.c2s.ic.gov/r:t`, 'us-iso-east-1'],
    [`${ACCT}.dkr.ecr.us-isob-east-1.sc2s.sgov.gov/r:t`, 'us-isob-east-1'],
    [`${ACCT}.dkr.ecr.eu-isoe-west-1.cloud.adc-e.uk/r:t`, 'eu-isoe-west-1'],
    [`${ACCT}.dkr.ecr.cn-north-1.amazonaws.com.cn/r:t`, 'cn-north-1'],
  ])('classifies the flat image %s as ECR', (uri, region) => {
    expect(resolveImage(uri)).toStrictEqual({ kind: 'ecr', uri, account: ACCT, region });
  });

  it.each([
    `${ACCT}.dkr-ecr.us-east-1.on.aws.evil.example/r:t`,
    `${ACCT}.dkr.ecr.us-east-1.example.com/r:t`,
    `${ACCT}.dkr.ecr.us-iso-east-1.amazonaws.com/r:t`,
    `${ACCT}.dkr.ecr-fips.us-${KELVIN}east-1.amazonaws.com/r:t`,
  ])('classifies the look-alike %s as a public image (no ECR login)', (uri) => {
    expect(resolveImage(uri)).toStrictEqual({ kind: 'public', uri });
  });

  it('classifies a state-resolved Fn::GetAtt RepositoryUri on the dual-stack host as ECR', () => {
    const uri = `${ACCT}.dkr-ecr.us-east-1.on.aws/my-repo`;
    const image = resolveImage(
      { 'Fn::GetAtt': ['MyRepo', 'RepositoryUri'] },
      {
        stateResources: {
          MyRepo: {
            physicalId: 'my-repo',
            resourceType: 'AWS::ECR::Repository',
            properties: {},
            attributes: { RepositoryUri: uri },
          },
        },
      }
    );
    expect(image).toStrictEqual({ kind: 'ecr', uri, account: ACCT, region: 'us-east-1' });
  });

  it('classifies a state-resolved Fn::GetAtt RepositoryUri on a look-alike host as public', () => {
    const uri = `${ACCT}.dkr-ecr.us-east-1.on.aws.evil.example/my-repo`;
    const image = resolveImage(
      { 'Fn::GetAtt': ['MyRepo', 'RepositoryUri'] },
      {
        stateResources: {
          MyRepo: {
            physicalId: 'my-repo',
            resourceType: 'AWS::ECR::Repository',
            properties: {},
            attributes: { RepositoryUri: uri },
          },
        },
      }
    );
    expect(image).toStrictEqual({ kind: 'public', uri });
  });
});
