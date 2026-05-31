import { describe, it, expect } from 'vite-plus/test';
import {
  deriveServiceDisplayName,
  extractServiceProperties,
} from '../../../src/local/ecs-service-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

/**
 * Issue #227 review fix — `deriveServiceDisplayName` resolves the
 * per-replica `[svc=<name> r=<i> c=<container>] ` log-prefix name in a
 * three-tier order so an L2 (`FargateService` /
 * `ApplicationLoadBalancedFargateService`) without an explicit
 * `serviceName` does NOT surface the hash-suffixed logical id
 * (`BackendApi5F9D8C32`) in every foreground line. The reviewer
 * called this out as the most user-visible bug in PR #231; this
 * test locks every branch so a future regression breaks loudly.
 */
describe('deriveServiceDisplayName', () => {
  it('returns the explicit CFn ServiceName when set (tier 1 wins over everything)', () => {
    // Explicit `serviceName: "Backend"` on the L2 construct surfaces
    // as `ServiceName: "Backend"` in the synthesized CFn template.
    // That MUST win, regardless of the cdk-path or logicalId.
    const out = deriveServiceDisplayName(
      'Backend',
      'BackendApi5F9D8C32',
      { 'aws:cdk:path': 'AppStack/Whatever/Resource' }
    );
    expect(out).toBe('Backend');
  });

  it('strips trailing CDK-internal segments (/Service, /Resource, /Default) from the cdk-path tail', () => {
    // Typical L2 path shape: `AppStack/BackendApi/Service` — the
    // user wrote `new FargateService(this, "BackendApi", ...)`, so
    // the clean display name is `BackendApi`. /Resource and /Default
    // are the same idea for other construct shapes.
    expect(
      deriveServiceDisplayName(undefined, 'BackendApi5F9D8C32', {
        'aws:cdk:path': 'AppStack/BackendApi/Service',
      })
    ).toBe('BackendApi');
    expect(
      deriveServiceDisplayName(undefined, 'BackendApi5F9D8C32', {
        'aws:cdk:path': 'AppStack/BackendApi/Resource',
      })
    ).toBe('BackendApi');
    expect(
      deriveServiceDisplayName(undefined, 'BackendApi5F9D8C32', {
        'aws:cdk:path': 'AppStack/BackendApi/Default',
      })
    ).toBe('BackendApi');
  });

  it('strips MULTIPLE trailing CDK-internal segments (e.g. /Service/Resource)', () => {
    // `ApplicationLoadBalancedFargateService` synthesizes a deeper
    // path that ends in `.../Service/Resource`. Walk back through
    // both trailing segments so the display name is still the
    // user-authored construct id.
    expect(
      deriveServiceDisplayName(undefined, 'BackendApi5F9D8C32', {
        'aws:cdk:path': 'AppStack/BackendApi/Service/Resource',
      })
    ).toBe('BackendApi');
  });

  it('returns the construct id when the cdk-path ends in the construct id itself (no internal suffix)', () => {
    // Hand-rolled L1 / Cfn construct path may end at the construct
    // id with no /Service or /Resource segment. Use the tail as-is.
    expect(
      deriveServiceDisplayName(undefined, 'BackendApi5F9D8C32', {
        'aws:cdk:path': 'AppStack/BackendApi',
      })
    ).toBe('BackendApi');
  });

  it('falls back to the serviceLogicalId when there is NO ServiceName AND NO Metadata cdk-path (synthetic / hand-rolled CFn)', () => {
    // Bare CFn template with no Metadata block — synthesized by
    // hand-rolled CDK or a third-party tool. The pre-existing
    // behavior of using the logical id is preserved.
    expect(deriveServiceDisplayName(undefined, 'BackendApi', undefined)).toBe('BackendApi');
    expect(deriveServiceDisplayName(undefined, 'BackendApi', {})).toBe('BackendApi');
    expect(deriveServiceDisplayName(undefined, 'BackendApi', { 'aws:cdk:path': '' })).toBe(
      'BackendApi'
    );
  });

  it('ignores non-string ServiceName (Ref / Fn::Sub intrinsics) and falls back to the next tier', () => {
    // CFn allows intrinsic shapes (Ref / Fn::Sub) for ServiceName.
    // The resolver does NOT try to evaluate them — fall through to
    // tier 2 / 3. Mirrors the existing parseServiceName behavior
    // for invalid shapes.
    expect(
      deriveServiceDisplayName({ Ref: 'WhoKnows' }, 'BackendApi5F9D8C32', {
        'aws:cdk:path': 'AppStack/BackendApi/Service',
      })
    ).toBe('BackendApi');
  });
});

/**
 * Site-level integration: `extractServiceProperties` populates
 * `serviceDisplayName` on the resolved descriptor so the runner can
 * read it as-is without re-walking Metadata. Locks the three branches
 * through the public resolver API too (so a refactor that moves the
 * derivation OUT of extractServiceProperties surfaces here).
 */
describe('extractServiceProperties populates serviceDisplayName', () => {
  function stackWithService(opts: {
    serviceName?: string;
    cdkPath?: string;
  }): { stack: StackInfo; resource: TemplateResource } {
    const taskDef: TemplateResource = {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: 'web',
        NetworkMode: 'awsvpc',
        ContainerDefinitions: [
          { Name: 'web', Image: 'public.ecr.aws/docker/library/nginx:1.27' },
        ],
      },
    };
    const props: Record<string, unknown> = {
      TaskDefinition: { Ref: 'WebTaskDef' },
      DesiredCount: 1,
    };
    if (opts.serviceName !== undefined) props['ServiceName'] = opts.serviceName;
    const service: TemplateResource = {
      Type: 'AWS::ECS::Service',
      Properties: props,
    };
    if (opts.cdkPath !== undefined) {
      service.Metadata = { 'aws:cdk:path': opts.cdkPath };
    }
    const stack = {
      stackName: 'S',
      template: {
        Resources: {
          WebTaskDef: taskDef,
          BackendApi5F9D8C32: service,
        },
      },
    } as unknown as StackInfo;
    return { stack, resource: service };
  }

  it('explicit ServiceName wins over cdk-path', () => {
    const { stack, resource } = stackWithService({
      serviceName: 'BackendExplicit',
      cdkPath: 'S/BackendApi/Service',
    });
    const out = extractServiceProperties(stack, 'BackendApi5F9D8C32', resource, [stack]);
    expect(out.serviceDisplayName).toBe('BackendExplicit');
    expect(out.serviceName).toBe('BackendExplicit');
  });

  it('falls through to cdk-path when no explicit ServiceName', () => {
    const { stack, resource } = stackWithService({ cdkPath: 'S/BackendApi/Service' });
    const out = extractServiceProperties(stack, 'BackendApi5F9D8C32', resource, [stack]);
    expect(out.serviceDisplayName).toBe('BackendApi');
    // serviceName preserves the OLD behavior (hash-suffixed logicalId).
    expect(out.serviceName).toBe('BackendApi5F9D8C32');
  });

  it('falls through to logicalId when neither is available', () => {
    const { stack, resource } = stackWithService({});
    const out = extractServiceProperties(stack, 'BackendApi5F9D8C32', resource, [stack]);
    expect(out.serviceDisplayName).toBe('BackendApi5F9D8C32');
    expect(out.serviceName).toBe('BackendApi5F9D8C32');
  });
});
