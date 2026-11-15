import { readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { StackInfo } from './assembly-reader.js';
import type { CdkAppSynthesizer, SynthesisResult } from './synthesizer.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { renderAssemblyPathEscape, resolveAssemblyPath } from '../utils/assembly-path.js';
import { displayIdent, displayStackName } from '../utils/ident-display.js';

/**
 * CDK `NestedStack` support for every `local` command (go-to-k/cdk-local#986).
 *
 * A nested stack is an `AWS::CloudFormation::Stack` resource in its parent's
 * template; its own template is a separate `<id>.nested.template.json` file in
 * the assembly, named by the resource's `Metadata['aws:asset:path']`. The
 * target resolvers (`invoke`, `start-api`, `run-task`, `start-service`, ...)
 * each walk ONE `StackInfo.template`, so a function, API or task declared in a
 * nested stack was invisible to all of them.
 *
 * {@link expandNestedStacks} appends one `StackInfo` per nested stack, at any
 * depth, right after its parent. Each carries {@link StackInfo.nestedStack},
 * which ties it to the stack it was deployed under, so:
 *
 * - its `stackName` is `<parent stackName>~<logical id>`, the name the host's
 *   state record uses for the child (cdkd's convention). `--from-cfn-stack`
 *   resolves the physical nested stack through the parent instead
 *   (`resolveNestedCfnStackName`);
 * - its `displayName` is the nested stack's construct path
 *   (`MyStack/MyNested`), so a path-form target (`MyStack/MyNested/Fn`)
 *   selects it by the longest-prefix rule;
 * - asset manifest, asset outdir, region and account are the parent's: CDK
 *   publishes a nested stack's assets through its top-level stack.
 *
 * Stack COUNTING and stack PATTERNS keep meaning top-level stacks: a single
 * stack with a nested stack is still a single-stack app, and selecting a stack
 * selects its nested stacks too ({@link withNestedDescendants}).
 */

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/** The parent a nested-stack `StackInfo` was deployed under. */
export interface NestedStackOrigin {
  /** `stackName` of the IMMEDIATE parent (itself nested for depth > 1). */
  parentStackName: string;
  /** `stackName` of the top-level stack at the root of the chain. */
  rootStackName: string;
  /** Logical ID of the `AWS::CloudFormation::Stack` resource in the parent. */
  logicalId: string;
  /**
   * The parent's `Properties.Parameters` for this nested stack: how CDK passes
   * a parent value (`Ref` / `Fn::GetAtt` of a parent resource) into the child,
   * where the child reads it with a `Ref` to the parameter.
   */
  parameters: Record<string, unknown>;
}

/**
 * Absolute paths of the nested templates one level below `template`, keyed
 * by the `AWS::CloudFormation::Stack` logical ID. `manifestDir` is the
 * directory the template's manifest sits in, which CDK writes the nested
 * templates next to. A path that is absolute or leaves that directory is
 * refused: CDK never emits one.
 */
export function nestedTemplatePaths(
  template: CloudFormationTemplate,
  manifestDir: string,
  stackName: string
): Record<string, string> {
  const paths: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource?.Type !== NESTED_STACK_TYPE) continue;
    const assetPath = resource.Metadata?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    const subject = `Stack ${displayStackName(stackName)} nested stack ${displayIdent(logicalId)}`;
    if (
      isAbsolute(assetPath) ||
      /^[a-zA-Z]:[\\/]/.test(assetPath) ||
      assetPath.startsWith('\\\\')
    ) {
      throw new Error(
        `${subject} has an absolute Metadata['aws:asset:path']. CDK emits a path relative to ` +
          'the assembly directory for a nested template; refusing to load it.'
      );
    }
    const resolved = resolveAssemblyPath(manifestDir, assetPath);
    if (!resolved.contained) {
      throw new Error(
        `${subject}: ${renderAssemblyPathEscape(resolved, manifestDir, 'Refusing to load the nested template.')}`
      );
    }
    paths[logicalId] = resolved.path;
  }
  return paths;
}

/**
 * The nested stack's construct path, from the `aws:cdk:path` CDK gives its
 * `AWS::CloudFormation::Stack` resource (`MyStack/Inner.NestedStack/Inner.NestedStackResource`
 * → `MyStack/Inner`). Falls back to `<parent display path>/<logical id>`.
 */
function nestedDisplayName(parentDisplayName: string, logicalId: string, cdkPath: unknown): string {
  if (typeof cdkPath === 'string') {
    const match = /^(.+)\.NestedStack\/[^/]+\.NestedStackResource$/.exec(cdkPath);
    if (match) return match[1]!;
  }
  return `${parentDisplayName}/${logicalId}`;
}

function readNestedTemplate(path: string, subject: string): CloudFormationTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(
      `${subject}: cannot read its nested template: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${subject}: its nested template is not a JSON object.`);
  }
  const template = parsed as CloudFormationTemplate;
  if (typeof template.Resources !== 'object' || template.Resources === null) {
    return { ...template, Resources: {} };
  }
  return template;
}

/**
 * Append a `StackInfo` for every nested stack, at any depth, each right after
 * its parent, and register the result for the state-source factory
 * ({@link registeredStack}). A host that synthesizes on its own calls this on
 * its stacks before resolving a target. Idempotent: a list that already holds
 * a nested stack is returned as it is.
 */
export function expandNestedStacks<T extends StackInfo>(stacks: readonly T[]): T[] {
  // Already expanded (a host synthesizer that expands on its own).
  if (stacks.some((s) => s.nestedStack !== undefined)) {
    registerNestedStacks(stacks);
    return [...stacks];
  }
  const out: T[] = [];
  const visit = (stack: T, manifestDir: string | undefined, depth: number): void => {
    out.push(stack);
    if (manifestDir === undefined) return;
    // CDK nests at most a handful of levels; a cycle can only come from a
    // hand-edited assembly whose nested template names itself.
    if (depth > 32) {
      throw new Error(
        `Stack ${displayStackName(stack.stackName)}: nested stacks are more than 32 levels deep; ` +
          'refusing to load them (does a nested template reference itself?).'
      );
    }
    const paths =
      depth === 0 && stack.nestedTemplates !== undefined
        ? stack.nestedTemplates
        : nestedTemplatePaths(stack.template, manifestDir, stack.stackName);
    for (const [logicalId, path] of Object.entries(paths)) {
      const resource = stack.template.Resources?.[logicalId];
      if (resource?.Type !== NESTED_STACK_TYPE) continue;
      const stackName = `${stack.stackName}~${logicalId}`;
      const subject = `Stack ${displayStackName(stack.stackName)} nested stack ${displayIdent(logicalId)}`;
      const rawParameters = resource.Properties?.['Parameters'];
      // The parent's fields come first, so a host's own fields (cdkd's
      // synthesis `messages`, which record a nested construct's failed
      // context lookup on the top-level artifact) stay with the stack the
      // nested template was synthesized under.
      const { nestedTemplates: _parentNested, ...inherited } = stack;
      const child: T = {
        ...(inherited as T),
        stackName,
        displayName: nestedDisplayName(
          stack.displayName,
          logicalId,
          resource.Metadata?.['aws:cdk:path']
        ),
        artifactId: stack.artifactId,
        template: readNestedTemplate(path, subject),
        dependencyNames: stack.dependencyNames,
        ...(stack.assetManifestPath !== undefined && {
          assetManifestPath: stack.assetManifestPath,
        }),
        ...(stack.assetOutdir !== undefined && { assetOutdir: stack.assetOutdir }),
        ...(stack.region !== undefined && { region: stack.region }),
        ...(stack.account !== undefined && { account: stack.account }),
        nestedStack: {
          parentStackName: stack.stackName,
          rootStackName: stack.nestedStack?.rootStackName ?? stack.stackName,
          logicalId,
          parameters:
            typeof rawParameters === 'object' &&
            rawParameters !== null &&
            !Array.isArray(rawParameters)
              ? (rawParameters as Record<string, unknown>)
              : {},
        },
      };
      parentOf.set(child, stack);
      visit(child, dirname(path), depth + 1);
    }
  };
  for (const stack of stacks) {
    const manifestDir =
      stack.nestedTemplates !== undefined
        ? ''
        : stack.assetManifestPath !== undefined
          ? dirname(stack.assetManifestPath)
          : undefined;
    visit(stack, manifestDir, 0);
  }
  registerNestedStacks(out);
  return out;
}

/** The top-level stacks of an expanded list (what "one stack" counts). */
export function topLevelStacks<T extends { nestedStack?: NestedStackOrigin | undefined }>(
  stacks: readonly T[]
): T[] {
  return stacks.filter((s) => s.nestedStack === undefined);
}

/**
 * `selected` plus every nested stack below one of them, in `all`'s order:
 * selecting a stack selects what is deployed under it.
 */
export function withNestedDescendants<
  T extends { stackName: string; nestedStack?: NestedStackOrigin | undefined },
>(selected: readonly T[], all: readonly T[]): T[] {
  // By identity, not name: two stacks can share a physical name (one Stage
  // deployed to two accounts), and so can their nested stacks. A nested
  // `StackInfo` this module did not build (a library host's own) has no
  // identity link and is followed by its parent's name.
  const chosen = new Set<object>(selected);
  const chosenNames = new Set(selected.map((s) => s.stackName));
  for (const stack of all) {
    const parent = parentOf.get(stack);
    const isChild =
      parent !== undefined
        ? chosen.has(parent)
        : stack.nestedStack !== undefined && chosenNames.has(stack.nestedStack.parentStackName);
    if (isChild) {
      chosen.add(stack);
      chosenNames.add(stack.stackName);
    }
  }
  return all.filter((s) => chosen.has(s));
}

/** Each nested `StackInfo` {@link expandNestedStacks} built, to its parent. */
const parentOf = new WeakMap<object, object>();

/**
 * `stack`'s resources followed by those of the CDK nested stacks deployed
 * under it, for a not-found message's candidates; a logical ID a second
 * stack shares is listed as `<stackName>:<LogicalId>`.
 */
export function resourcesWithNestedStacks<
  T extends {
    stackName: string;
    nestedStack?: NestedStackOrigin | undefined;
    template: CloudFormationTemplate;
  },
>(stack: T, stacks: readonly T[]): CloudFormationTemplate['Resources'] {
  const merged = Object.create(null) as CloudFormationTemplate['Resources'];
  for (const s of withNestedDescendants([stack], stacks)) {
    for (const [logicalId, resource] of Object.entries(s.template.Resources ?? {})) {
      // Two nested stacks built from one construct share logical IDs: list the
      // later one in the `<nested stack>:<LogicalId>` form that selects it.
      merged[Object.hasOwn(merged, logicalId) ? `${s.stackName}:${logicalId}` : logicalId] =
        resource;
    }
  }
  return merged;
}

/**
 * The top-level stack name a stack belongs to: itself, or its nested chain's
 * root. A host's `checkSelectedStacks` knows only top-level stacks.
 */
export function rootStackName(stack: {
  stackName: string;
  nestedStack?: NestedStackOrigin | undefined;
}): string {
  return stack.nestedStack?.rootStackName ?? stack.stackName;
}

/**
 * Wrap a synthesizer so every synthesis it returns lists the nested stacks
 * ({@link expandNestedStacks}), and a host's `checkSelectedStacks` is handed
 * top-level names only.
 */
export function withNestedStacks(synthesizer: CdkAppSynthesizer): CdkAppSynthesizer {
  return {
    synthesize: async (opts) => {
      const result = await synthesizer.synthesize(opts);
      const stacks = expandNestedStacks(result.stacks);
      const check = result.checkSelectedStacks;
      const wrapped: SynthesisResult = { stacks };
      if (check) {
        wrapped.checkSelectedStacks = (names) => {
          const byName = new Map(stacks.map((s) => [s.stackName, s]));
          const roots = names.map((n) => {
            const s = byName.get(n);
            return s ? rootStackName(s) : n;
          });
          check([...new Set(roots)]);
        };
      }
      return wrapped;
    },
  };
}

/**
 * Nested stacks of the latest synthesis, by `stackName`. The state-source
 * factory receives a stack NAME, not its `StackInfo`, and needs the parent
 * chain to reach a nested stack's deployed state; every synthesis replaces
 * the registry's entries for the stacks it lists.
 */
const registry = new Map<string, StackInfo[]>();

export function registerNestedStacks(stacks: readonly StackInfo[]): void {
  const byName = new Map<string, StackInfo[]>();
  for (const stack of stacks) {
    const list = byName.get(stack.stackName);
    if (list) list.push(stack);
    else byName.set(stack.stackName, [stack]);
  }
  for (const [name, list] of byName) registry.set(name, list);
}

/**
 * The registered stack for `stackName` (top-level or nested), if any. Two
 * clones sharing a physical name (one Stage deployed to two accounts) list
 * the same templates, so the first serves a caller that needs only the
 * stack's SHAPE; {@link registeredStackForTemplate} tells them apart.
 */
export function registeredStack(stackName: string): StackInfo | undefined {
  return registry.get(stackName)?.[0];
}

/** The registered `stackName` stack whose template IS `template`. */
export function registeredStackForTemplate(
  stackName: string,
  template: unknown
): StackInfo | undefined {
  return registry.get(stackName)?.find((s) => s.template === template);
}

/** The stack `stack` is nested in: the one it was expanded from, else by name. */
export function parentStackOf(stack: StackInfo): StackInfo | undefined {
  const linked = parentOf.get(stack);
  if (linked) return linked as StackInfo;
  return stack.nestedStack ? registeredStack(stack.nestedStack.parentStackName) : undefined;
}

/**
 * For a nested stack's TEMPLATE (as a resolver holds it): the values its
 * parent passes in for the template's parameters, and the parent's template,
 * so a check on a child value can follow a `Ref` to one of those parameters
 * back to what the parent put there.
 */
export function nestedParameterSource(
  template: unknown
): { parameters: Record<string, unknown>; parentTemplate: CloudFormationTemplate } | undefined {
  for (const list of registry.values()) {
    const stack = list.find((s) => s.template === template && s.nestedStack !== undefined);
    if (!stack?.nestedStack) continue;
    const parent = parentStackOf(stack);
    if (!parent) return undefined;
    return { parameters: stack.nestedStack.parameters, parentTemplate: parent.template };
  }
  return undefined;
}

/** Test hook. */
export function resetNestedStackRegistry(): void {
  registry.clear();
}
