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
