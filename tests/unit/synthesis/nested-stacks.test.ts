import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandNestedStacks,
  nestedTemplatePaths,
  registeredStack,
  resetNestedStackRegistry,
  rootStackName,
  topLevelStacks,
  withNestedDescendants,
  withNestedStacks,
} from '../../../src/synthesis/nested-stacks.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CdkAppSynthesizer } from '../../../src/synthesis/synthesizer.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function nestedResource(cdkPath: string, assetPath: string, parameters?: Record<string, unknown>) {
  return {
    Type: 'AWS::CloudFormation::Stack',
    Properties: { ...(parameters && { Parameters: parameters }) },
    Metadata: { 'aws:cdk:path': cdkPath, 'aws:asset:path': assetPath },
  };
}

describe('nested-stacks', () => {
  let dir: string;
  beforeEach(() => {
    resetNestedStackRegistry();
    dir = mkdtempSync(join(tmpdir(), 'cdkl-nested-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeTemplate(name: string, template: CloudFormationTemplate): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(template));
    return p;
  }

  function parent(
    template: CloudFormationTemplate,
    extra: Record<string, unknown> = {}
  ): StackInfo & Record<string, unknown> {
    return {
      stackName: 'App',
      displayName: 'App',
      artifactId: 'App',
      template,
      assetManifestPath: join(dir, 'App.assets.json'),
      assetOutdir: dir,
      region: 'us-east-1',
      account: '123456789012',
      dependencyNames: [],
      ...extra,
    };
  }

  const innerResource = () =>
    nestedResource('App/Inner.NestedStack/Inner.NestedStackResource', 'AppInner.nested.template.json', {
      P1: { Ref: 'Q' },
    });

  describe('expandNestedStacks', () => {
    it('expands both copies of a Stage deployed twice, each child under its own parent', () => {
      writeTemplate('AppInner.nested.template.json', { Resources: {} });
      const beta = parent({ Resources: { InnerNS: innerResource() } }, { displayName: 'Beta/App' });
      const prod = parent({ Resources: { InnerNS: innerResource() } }, { displayName: 'Prod/App' });
      const out = expandNestedStacks([beta, prod]);
      expect(out).toHaveLength(4);
      // Same physical names on both sides; selection must still follow the object.
      expect(out[1]!.stackName).toBe(out[3]!.stackName);
      expect(withNestedDescendants([prod], out)).toEqual([prod, out[3]]);
      expect(withNestedDescendants([beta], out)).toEqual([beta, out[1]]);
    });

    it('expands a nested stack next to the manifest and inherits host fields', () => {
      writeTemplate('AppInner.nested.template.json', { Resources: { Fn: { Type: 'AWS::Lambda::Function' } } });
      const app = parent({ Resources: { InnerNS: innerResource() } }, {
        messages: ['m'],
        nestedTemplates: undefined,
      });
      const out = expandNestedStacks([app]);
      expect(out).toHaveLength(2);
      const child = out[1] as StackInfo & Record<string, unknown>;
      expect(child.stackName).toBe('App~InnerNS');
      expect(child.displayName).toBe('App/Inner');
      expect(child.template.Resources?.['Fn']?.Type).toBe('AWS::Lambda::Function');
      expect(child.nestedStack).toEqual({
        parentStackName: 'App',
        rootStackName: 'App',
        logicalId: 'InnerNS',
        parameters: { P1: { Ref: 'Q' } },
      });
      expect(child.assetManifestPath).toBe(app.assetManifestPath);
      expect(child.assetOutdir).toBe(dir);
      expect(child.region).toBe('us-east-1');
      expect(child.account).toBe('123456789012');
      expect(child['messages']).toEqual(['m']);
      expect(child.nestedTemplates).toBeUndefined();
    });

    it('does not pass the host nestedTemplates down to the child', () => {
      writeTemplate('AppInner.nested.template.json', { Resources: {} });
      const app = parent(
        { Resources: { InnerNS: innerResource() } },
        { nestedTemplates: { InnerNS: join(dir, 'AppInner.nested.template.json') } }
      );
      const out = expandNestedStacks([app]);
      expect(out).toHaveLength(2);
      expect(out[1]!.nestedTemplates).toBeUndefined();
    });

    it('expands a depth-2 grandchild keeping the root name', () => {
      writeTemplate('AppInner.nested.template.json', {
        Resources: {
          DeeperNS: nestedResource(
            'App/Inner/Deeper.NestedStack/Deeper.NestedStackResource',
            'AppInnerDeeper.nested.template.json'
          ),
        },
      });
      writeTemplate('AppInnerDeeper.nested.template.json', { Resources: {} });
      const out = expandNestedStacks([parent({ Resources: { InnerNS: innerResource() } })]);
      expect(out.map((s) => s.stackName)).toEqual(['App', 'App~InnerNS', 'App~InnerNS~DeeperNS']);
      const grand = out[2]!;
      expect(grand.displayName).toBe('App/Inner/Deeper');
      expect(grand.nestedStack).toMatchObject({
        parentStackName: 'App~InnerNS',
        rootStackName: 'App',
        logicalId: 'DeeperNS',
      });
    });

    it('uses a host-supplied absolute nestedTemplates path at depth 0 (no assetManifestPath)', () => {
      const p = writeTemplate('custom.json', { Resources: { X: { Type: 'AWS::SQS::Queue' } } });
      const app = parent(
        { Resources: { InnerNS: innerResource() } },
        { nestedTemplates: { InnerNS: p } }
      );
      delete (app as { assetManifestPath?: string }).assetManifestPath;
      const out = expandNestedStacks([app]);
      expect(out).toHaveLength(2);
      expect(out[1]!.template.Resources?.['X']?.Type).toBe('AWS::SQS::Queue');
    });

    it('does not expand without assetManifestPath and nestedTemplates', () => {
      const app = parent({ Resources: { InnerNS: innerResource() } });
      delete (app as { assetManifestPath?: string }).assetManifestPath;
      expect(expandNestedStacks([app])).toHaveLength(1);
    });

    it('refuses an absolute aws:asset:path', () => {
      const app = parent({
        Resources: { InnerNS: nestedResource('App/Inner.NestedStack/Inner.NestedStackResource', '/etc/x.json') },
      });
      expect(() => expandNestedStacks([app])).toThrow(/absolute/);
    });

    it('refuses an aws:asset:path escaping the assembly dir', () => {
      const app = parent({
        Resources: { InnerNS: nestedResource('App/Inner.NestedStack/Inner.NestedStackResource', '../x') },
      });
      expect(() => expandNestedStacks([app])).toThrow();
    });

    it('is idempotent', () => {
      writeTemplate('AppInner.nested.template.json', { Resources: {} });
      const once = expandNestedStacks([parent({ Resources: { InnerNS: innerResource() } })]);
      expect(once).toHaveLength(2);
      expect(expandNestedStacks(once)).toHaveLength(2);
    });

    it('registers the child (registeredStack)', () => {
      writeTemplate('AppInner.nested.template.json', { Resources: {} });
      expect(registeredStack('App~InnerNS')).toBeUndefined();
      expandNestedStacks([parent({ Resources: { InnerNS: innerResource() } })]);
      expect(registeredStack('App~InnerNS')?.displayName).toBe('App/Inner');
      expect(registeredStack('App')).toBeDefined();
    });

    it('falls back to <parent>/<logicalId> when aws:cdk:path has no NestedStack shape', () => {
      writeTemplate('AppInner.nested.template.json', { Resources: {} });
      const app = parent({
        Resources: { InnerNS: { ...innerResource(), Metadata: { 'aws:asset:path': 'AppInner.nested.template.json' } } },
      });
      expect(expandNestedStacks([app])[1]!.displayName).toBe('App/InnerNS');
    });
  });

  describe('nestedTemplatePaths', () => {
    it('maps logical ids to contained absolute paths', () => {
      const paths = nestedTemplatePaths({ Resources: { InnerNS: innerResource() } }, dir, 'App');
      expect(paths['InnerNS']).toBe(join(dir, 'AppInner.nested.template.json'));
    });
  });

  describe('helpers', () => {
    const top = { stackName: 'App' };
    const child = {
      stackName: 'App~I',
      nestedStack: { parentStackName: 'App', rootStackName: 'App', logicalId: 'I', parameters: {} },
    };
    const grand = {
      stackName: 'App~I~J',
      nestedStack: { parentStackName: 'App~I', rootStackName: 'App', logicalId: 'J', parameters: {} },
    };
    const other = { stackName: 'Other' };
    const all = [top, child, grand, other];

    it('topLevelStacks drops nested', () => {
      expect(topLevelStacks(all)).toEqual([top, other]);
    });
    it('withNestedDescendants adds transitive descendants in order', () => {
      expect(withNestedDescendants([top], all)).toEqual([top, child, grand]);
      expect(withNestedDescendants([child], all)).toEqual([child, grand]);
      expect(withNestedDescendants([other], all)).toEqual([other]);
    });
    it('rootStackName', () => {
      expect(rootStackName(top)).toBe('App');
      expect(rootStackName(grand)).toBe('App');
    });
  });

  describe('withNestedStacks', () => {
    it('hands the host checkSelectedStacks root names, deduped', async () => {
      writeTemplate('AppInner.nested.template.json', { Resources: {} });
      const check = vi.fn();
      const inner: CdkAppSynthesizer = {
        synthesize: async () => ({
          stacks: [parent({ Resources: { InnerNS: innerResource() } })],
          checkSelectedStacks: check,
        }),
      } as unknown as CdkAppSynthesizer;
      const result = await withNestedStacks(inner).synthesize({} as never);
      expect(result.stacks.map((s) => s.stackName)).toEqual(['App', 'App~InnerNS']);
      result.checkSelectedStacks!(['App~InnerNS', 'App', 'Unknown']);
      expect(check).toHaveBeenCalledWith(['App', 'Unknown']);
    });

    it('leaves checkSelectedStacks unset when the host has none', async () => {
      const inner = { synthesize: async () => ({ stacks: [] }) } as unknown as CdkAppSynthesizer;
      const result = await withNestedStacks(inner).synthesize({} as never);
      expect(result.checkSelectedStacks).toBeUndefined();
    });
  });
});
