/**
 * go-to-k/cdk-local#746 — stacks under a `cdk.Stage` are enumerated, so every
 * target resolver must pick a Stage stack by its HIERARCHICAL display path
 * (`MyStage/Api`), never by the target's first `/`-segment (the Stage id).
 *
 * The rule is cdkd's (`stackForConstructPath`, go-to-k/cdkd#3953): a path-form
 * target's stack is the one whose display path (or physical name) followed by
 * `/` is the LONGEST prefix of the target; a head no stack path prefixes (a
 * wildcard) falls through to `matchStacks`; the colon form keeps the stack it
 * names. Every resolver below shares `selectTargetStack`, so each one gets a
 * case: a resolver that kept its own first-segment split would answer
 * "Stack 'MyStage' not found" for the same target.
 */
import { describe, expect, it } from 'vite-plus/test';
import { stackForConstructPath, stackForPathFormTarget } from '../../../src/cli/cdk-path.js';
import {
  candidateTargetStack,
  describeStack,
  globMatches,
  matchStacks,
  pathGlobMatches,
  selectTargetStack,
  stackMatchesPattern,
} from '../../../src/cli/stack-matcher.js';
import { parseTarget, resolveLambdaTarget } from '../../../src/local/lambda-resolver.js';
import { parseEcsTarget, resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import { resolveEcsServiceTarget } from '../../../src/local/ecs-service-resolver.js';
import {
  pickAgentCoreCandidateStack,
  resolveAgentCoreTarget,
} from '../../../src/local/agentcore-resolver.js';
import { resolveAlbTarget } from '../../../src/cli/commands/local-start-alb.js';
import { resolveCloudFrontTarget } from '../../../src/cli/commands/local-start-cloudfront.js';
import { resolveEcsServiceStack } from '../../../src/cli/commands/local-studio.js';
import {
  assertServedLogicalIdsUnambiguous,
  pickTargetStacks,
  resolveLambdaByLogicalId,
} from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

// One logical id per resource kind, IDENTICAL in every stack: a Stage's clones
// (Beta / Prod) always carry identical logical ids, because CDK hashes the
// path BELOW the stack. So the only thing telling the stacks apart is the
// stack the resolver picked — which every assertion reads back.
const FN = 'HandlerABC12345';
const TASK = 'TaskDef1234ABCD';
const SVC = 'Service1234ABCD';
const ALB = 'LB8A12904C';
const DIST = 'Dist1234ABCD';

function resources(stackPath: string, marker: string): Record<string, TemplateResource> {
  const at = (p: string) => ({ 'aws:cdk:path': `${stackPath}/${p}` });
  return {
    [FN]: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Code: { ZipFile: `exports.handler = async () => '${marker}';` },
        Environment: { Variables: { MARKER: marker } },
      },
      Metadata: at('Handler/Resource'),
    },
    [ALB]: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: { Type: 'application' },
      Metadata: at('LB/Resource'),
    },
    [DIST]: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {},
      Metadata: at('Dist/Resource'),
    },
  };
}

function stack(stackName: string, displayName: string, marker = stackName): StackInfo {
  return {
    stackName,
    displayName,
    artifactId: stackName,
    template: { Resources: resources(displayName, marker) },
    dependencyNames: [],
  } as StackInfo;
}

// A top-level stack, a Stage stack, a NESTED Stage pair whose paths share a
// prefix (`Api` / `ApiV2`), and a top-level stack displayed `Outer` that the
// nested Stage's paths also start with.
const TOP = stack('Top', 'Top');
const STAGE_API = stack('MyStage-Api', 'MyStage/Api');
const OUTER = stack('Outer', 'Outer');
const NESTED = stack('Outer-Inner-Api', 'Outer/Inner/Api');
const NESTED_V2 = stack('Outer-Inner-ApiV2', 'Outer/Inner/ApiV2');
const APP = [TOP, STAGE_API, OUTER, NESTED, NESTED_V2];

function markerOf(resolved: { stack: StackInfo }): string | undefined {
  const fn = resolved.stack.template.Resources[FN]!;
  const env = (fn.Properties as { Environment: { Variables: Record<string, string> } }).Environment;
  return env.Variables['MARKER'];
}

describe('stackForConstructPath (the shared rule, cdkd parity)', () => {
  it('picks the LONGEST display-path prefix, so a nested Stage beats a shorter stack path', () => {
    expect(stackForConstructPath('Outer/Inner/Api/Handler', APP)).toBe(NESTED);
    expect(stackForConstructPath('Outer/Handler', APP)).toBe(OUTER);
  });

  it('requires a `/` boundary: `Outer/Inner/Api` never claims `Outer/Inner/ApiV2/...`', () => {
    expect(stackForConstructPath('Outer/Inner/ApiV2/Handler', APP)).toBe(NESTED_V2);
  });

  it('falls back to the physical name, and a display path beats a physical name of equal length', () => {
    expect(stackForConstructPath('MyStage-Api/Handler', APP)).toBe(STAGE_API);
    const byName = { stackName: 'X/Y', displayName: 'Other' };
    const byDisplay = { stackName: 'Z', displayName: 'X/Y' };
    expect(stackForConstructPath('X/Y/Fn', [byName, byDisplay])).toBe(byDisplay);
    expect(stackForConstructPath('X/Y/Fn', [byDisplay, byName])).toBe(byDisplay);
  });

  it('returns undefined when no stack path prefixes the target', () => {
    expect(stackForConstructPath('My*/Handler', APP)).toBeUndefined();
  });

  it('applies to the PATH form only — the colon form keeps the stack it names', () => {
    const colon = parseTarget('Top:MyStage/Api/Handler');
    expect(stackForPathFormTarget(colon, 'Top:MyStage/Api/Handler', APP)).toBeUndefined();
    const path = parseTarget('MyStage/Api/Handler');
    expect(stackForPathFormTarget(path, 'MyStage/Api/Handler', APP)).toBe(STAGE_API);
  });
});

describe('matchStacks (cdkd parity: hierarchical id first, exact physical name second)', () => {
  it('matches a `/` pattern against the display path', () => {
    expect(matchStacks(APP, ['MyStage/Api'])).toEqual([STAGE_API]);
  });

  it('keeps `*` within one segment and lets `**` span segments', () => {
    expect(matchStacks(APP, ['*'])).toEqual([TOP, OUTER]);
    expect(matchStacks(APP, ['Outer/Inner/*'])).toEqual([NESTED, NESTED_V2]);
    expect(matchStacks(APP, ['**'])).toEqual(APP);
  });

  it('selects by EXACT physical name only when no display path matched', () => {
    expect(matchStacks(APP, ['MyStage-Api'])).toEqual([STAGE_API]);
    expect(matchStacks(APP, ['MyStage-*'])).toEqual([]);
    // A name that is one stack's id AND another's physical name selects the id.
    const byId = { stackName: 'Phys', displayName: 'Shared' };
    const byName = { stackName: 'Shared', displayName: 'Stage/Other' };
    expect(matchStacks([byId, byName], ['Shared'])).toEqual([byId]);
  });

  it('never collapses two stacks that share a physical name', () => {
    // One Stage deployed to two accounts under one explicit `stackName`.
    const beta = stack('Api', 'Beta/Api');
    const prod = stack('Api', 'Prod/Api');
    expect(matchStacks([beta, prod], ['Api'])).toEqual([beta, prod]);
    expect(matchStacks([beta, prod], ['*/Api'])).toEqual([beta, prod]);
  });

  it('treats every non-`*` character literally (never a RegExp)', () => {
    expect(globMatches('My.Stage*', 'MyXStage1')).toBe(false);
    expect(globMatches('My(Stage*', 'My(Stage1')).toBe(true);
    expect(globMatches('a*a', 'a')).toBe(false);
    expect(pathGlobMatches('**/Api', 'Outer/Inner/Api')).toBe(true);
    expect(pathGlobMatches('*/Api', 'Outer/Inner/Api')).toBe(false);
    expect(stackMatchesPattern(STAGE_API, 'MyStage-Api')).toBe(true);
  });

  it('describes a Stage stack by both names', () => {
    expect(describeStack(STAGE_API)).toBe('MyStage-Api (MyStage/Api)');
    expect(describeStack(TOP)).toBe('Top');
  });
});

describe('selectTargetStack / candidateTargetStack', () => {
  const sel = (t: string, stacks: StackInfo[] = APP) => selectTargetStack(parseTarget(t), t, stacks);

  it('counts a Stage stack toward "single-stack": top-level + Stage is multi-stack', () => {
    expect(sel('Handler', [TOP, STAGE_API])).toEqual({ kind: 'no-prefix' });
    expect(sel('Handler', [STAGE_API])).toEqual({ kind: 'found', stack: STAGE_API });
  });

  it('falls through to matchStacks for a wildcard head', () => {
    expect(sel('T*/Handler')).toEqual({ kind: 'found', stack: TOP });
    expect(sel('Nope*/Handler')).toEqual({ kind: 'not-found', pattern: 'Nope*' });
  });

  it('reports two Stage clones sharing a physical name as ambiguous, never first-match', () => {
    const beta = stack('Api', 'Beta/Api');
    const prod = stack('Api', 'Prod/Api');
    expect(sel(`Api:${FN}`, [beta, prod])).toEqual({
      kind: 'ambiguous',
      pattern: 'Api',
      matched: [beta, prod],
    });
    // The display path disambiguates.
    expect(sel('Prod/Api/Handler', [beta, prod])).toEqual({ kind: 'found', stack: prod });
  });

  it('candidateTargetStack is the same rule, undefined on any miss', () => {
    const t = 'MyStage/Api/Handler';
    expect(candidateTargetStack(parseEcsTarget(t), t, APP)).toBe(STAGE_API);
    expect(candidateTargetStack(parseEcsTarget('Handler'), 'Handler', APP)).toBeUndefined();
  });
});

describe('every target resolver picks the Stage stack by its display path', () => {
  it('invoke (resolveLambdaTarget): Stage, nested Stage, prefix-sharing sibling, top-level', () => {
    expect(markerOf(resolveLambdaTarget('MyStage/Api/Handler', APP))).toBe('MyStage-Api');
    expect(markerOf(resolveLambdaTarget('Outer/Inner/Api/Handler', APP))).toBe('Outer-Inner-Api');
    expect(markerOf(resolveLambdaTarget('Outer/Inner/ApiV2/Handler', APP))).toBe(
      'Outer-Inner-ApiV2'
    );
    expect(markerOf(resolveLambdaTarget('Outer/Handler', APP))).toBe('Outer');
    expect(markerOf(resolveLambdaTarget('Top/Handler', APP))).toBe('Top');
  });

  it('invoke: the colon form keeps the stack it names', () => {
    expect(markerOf(resolveLambdaTarget(`MyStage-Api:${FN}`, APP))).toBe('MyStage-Api');
  });

  it('invoke: a bare target in a top-level + Stage app is refused as multi-stack', () => {
    expect(() => resolveLambdaTarget(FN, [TOP, STAGE_API])).toThrow(
      /Multiple stacks in app.*Available stacks: Top, MyStage-Api \(MyStage\/Api\)/
    );
  });

  it('invoke: a physical name shared by two Stage clones is an ambiguity error naming both', () => {
    const beta = stack('Api', 'Beta/Api', 'beta');
    const prod = stack('Api', 'Prod/Api', 'prod');
    expect(() => resolveLambdaTarget(`Api:${FN}`, [beta, prod])).toThrow(
      /matched 2 stacks: Api \(Beta\/Api\), Api \(Prod\/Api\)/
    );
    expect(markerOf(resolveLambdaTarget('Prod/Api/Handler', [beta, prod]))).toBe('prod');
  });

  // The remaining resolvers' resources are deliberately incomplete (no task
  // definition / service / runtime at the path): the not-found message names
  // the stack the resolver PICKED, which is what these cases read. Before the
  // fix every one of them answered "Stack 'MyStage' not found" instead.
  it('run-task (resolveEcsTaskTarget)', () => {
    expect(() => resolveEcsTaskTarget('MyStage/Api/Handler', APP)).toThrow(
      /did not match any ECS task definition in MyStage-Api/
    );
    expect(() => resolveEcsTaskTarget(`Outer/Inner/ApiV2/${TASK}`, APP)).toThrow(
      /in Outer-Inner-ApiV2/
    );
  });

  it('start-service (resolveEcsServiceTarget)', () => {
    expect(() => resolveEcsServiceTarget(`MyStage/Api/${SVC}`, APP)).toThrow(
      /did not match any (ECS Service|resource) in MyStage-Api/
    );
  });

  it('invoke-agentcore / start-agentcore (resolveAgentCoreTarget + candidate)', () => {
    expect(() => resolveAgentCoreTarget('Outer/Inner/Api/Runtime', APP)).toThrow(
      /in Outer-Inner-Api\b/
    );
    expect(pickAgentCoreCandidateStack('Outer/Inner/Api/Runtime', APP)).toBe(NESTED);
  });

  it('start-alb (resolveAlbTarget)', () => {
    const { stack: picked, albLogicalId } = resolveAlbTarget('MyStage/Api/LB', APP);
    expect([picked, albLogicalId]).toEqual([STAGE_API, ALB]);
  });

  it('start-cloudfront (resolveCloudFrontTarget)', () => {
    const { stack: picked, logicalId } = resolveCloudFrontTarget('Outer/Inner/ApiV2/Dist', APP);
    expect([picked, logicalId]).toEqual([NESTED_V2, DIST]);
  });

  it('studio (resolveEcsServiceStack)', () => {
    expect(resolveEcsServiceStack('MyStage/Api/Service', APP)).toBe(STAGE_API);
    expect(resolveEcsServiceStack('Service', [TOP, STAGE_API])).toBeUndefined();
  });
});

describe('start-api over a union of stacks sharing logical ids (Stage clones)', () => {
  const beta = stack('Beta-Api', 'Beta/Api', 'beta');
  const prod = stack('Prod-Api', 'Prod/Api', 'prod');
  const route = (apiLogicalId: string) =>
    ({ route: { source: 'http-api', apiLogicalId, lambdaLogicalId: FN } }) as never;

  it('pickTargetStacks selects the stack object the target hint returned', () => {
    expect(pickTargetStacks([beta, prod], undefined, undefined, prod)).toEqual([prod]);
  });

  it('refuses a served union whose Lambda logical id two stacks declare, naming them', () => {
    const routes = [{ lambdaLogicalId: FN }] as never;
    expect(() => assertServedLogicalIdsUnambiguous([beta, prod], routes, [])).toThrow(
      /declared by 2 of the served stacks \(Beta-Api \(Beta\/Api\), Prod-Api \(Prod\/Api\)\)/
    );
    // One stack served: nothing to collide.
    expect(() => assertServedLogicalIdsUnambiguous([prod], routes, [])).not.toThrow();
  });

  it('refuses a served union whose API logical id two stacks declare', () => {
    expect(() => assertServedLogicalIdsUnambiguous([beta, prod], [], [route(ALB)])).toThrow(
      /Logical ID LB8A12904C is declared by 2/
    );
    expect(() => assertServedLogicalIdsUnambiguous([TOP, beta], [], [route('NotShared')])).not.toThrow();
  });

  it('resolveLambdaByLogicalId never takes the first stack that declares the id', () => {
    expect(() => resolveLambdaByLogicalId(FN, [beta, prod])).toThrow(/declared by 2 stacks/);
    expect(markerOf(resolveLambdaByLogicalId(FN, [prod]))).toBe('prod');
  });
});
