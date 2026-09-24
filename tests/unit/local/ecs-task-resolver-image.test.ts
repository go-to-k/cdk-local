import { describe, it, expect } from 'vite-plus/test';
import {
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
  it('throws the generic --from-cfn-stack hint when no state context is supplied', () => {
    const stack = buildStack('App', buildEcsResources('MyRepo'));
    expect(() => resolveEcsTaskTarget('App:Task', [stack])).toThrow(EcsTaskResolutionError);
    expect(() => resolveEcsTaskTarget('App:Task', [stack])).toThrow(
      /references same-stack ECR repository 'MyRepo'/
    );
    expect(() => resolveEcsTaskTarget('App:Task', [stack])).toThrow(
      /pass --from-cfn-stack to load the deployed stack state/
    );
    // The original message used to be hardcoded to `cdkl run-task`,
    // but the resolver is shared by start-alb / start-service /
    // run-task, so the command name is dropped — only the binary
    // name remains.
    expect(() => resolveEcsTaskTarget('App:Task', [stack])).not.toThrow(/cdkl run-task/);
  });

  it('flips the remedy to "the state-source attempt failed: ..." when the context records a load failure', () => {
    const stack = buildStack('App', buildEcsResources('MyRepo'));
    const ctx = {
      stateLoadFailureMessage:
        "ListStackResources(dev-goto-Reco-App) failed: ValidationError HTTP 400: Stack with id dev-goto-Reco-App does not exist (region='ap-northeast-1')",
    };
    expect(() => resolveEcsTaskTarget('App:Task', [stack], ctx)).toThrow(
      /the state-source attempt failed: ListStackResources\(dev-goto-Reco-App\) failed:/
    );
    expect(() => resolveEcsTaskTarget('App:Task', [stack], ctx)).toThrow(
      /--from-cfn-stack <deployed-name>/
    );
    expect(() => resolveEcsTaskTarget('App:Task', [stack], ctx)).toThrow(/--region \/ --profile/);
    // Should NOT re-suggest passing --from-cfn-stack as the primary
    // remedy: the user already passed it.
    expect(() => resolveEcsTaskTarget('App:Task', [stack], ctx)).not.toThrow(
      /pass --from-cfn-stack to load the deployed stack state/
    );
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
