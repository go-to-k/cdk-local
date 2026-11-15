import type { StackInfo } from '../synthesis/assembly-reader.js';
import { registeredStack } from '../synthesis/nested-stacks.js';
import type { TemplateResource } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import { displayIdent, displayStackName } from '../utils/ident-display.js';
import type { LocalStateProvider } from './local-state-provider.js';
import {
  isCustomResourceType,
  isSecretAttributeName,
  isSecretValuedAttribute,
} from './secret-attributes.js';
import type { ResolvedSsmParameters } from './ssm-parameter-resolver.js';
import { substituteAgainstStateAsync, type SubstitutionContext } from './state-resolver.js';

/**
 * State-source support for a CDK nested stack's `StackInfo`
 * (`expandNestedStacks`, go-to-k/cdk-local#986).
 *
 * A nested template reads a parent value through a template PARAMETER: CDK
 * puts `{ Ref: ParentBucket }` in the parent's `AWS::CloudFormation::Stack`
 * `Parameters`, and the child's environment says `{ Ref: referencetoParentBucketRef }`.
 * The child's own state record knows nothing of that value, so
 * {@link withNestedStackParameters} resolves each parameter against the
 * PARENT's state (recursively, for a parent that is itself nested) and adds
 * the values to what `resolveTemplateSsmParameters` returns, which is where
 * every command already reads its template parameters from.
 */

/**
 * The `AWS::CloudFormation::Stack` logical IDs from the top-level stack down
 * to `stack`, and that top-level stack. Empty for a top-level stack.
 */
export function nestedStackChain(
  stack: StackInfo,
  lookup: (stackName: string) => StackInfo | undefined
): { root: string; path: string[] } {
  const path: string[] = [];
  let current: StackInfo | undefined = stack;
  let root = stack.stackName;
  while (current?.nestedStack) {
    path.unshift(current.nestedStack.logicalId);
    root = current.nestedStack.parentStackName;
    current = lookup(root);
  }
  return { root, path };
}

/**
 * Whether a parent value would carry a secret into the child's parameter:
 * a credential-looking or secret-valued attribute, any custom-resource
 * attribute (a handler may return a secret), a nested stack's output, an
 * AppSync API key, or a dynamic reference. The value is still resolved; it
 * is only kept off the `docker run` argv, as such a value is everywhere else.
 */
function carriesSecret(value: unknown, resources: Record<string, TemplateResource>): boolean {
  if (typeof value === 'string') return value.includes('{{resolve:');
  if (Array.isArray(value)) return value.some((v) => carriesSecret(v, resources));
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    const [target, ...rest] = Array.isArray(getAtt)
      ? (getAtt as unknown[])
      : typeof getAtt === 'string'
        ? getAtt.split('.')
        : [];
    if (typeof target !== 'string') return true;
    const attribute = rest.map(String).join('.');
    const type = resources[target]?.Type;
    if (
      isSecretAttributeName(attribute) ||
      isSecretValuedAttribute(type, attribute) ||
      isCustomResourceType(type) ||
      type === 'AWS::CloudFormation::Stack'
    ) {
      return true;
    }
  }
  const ref = obj['Ref'];
  if (typeof ref === 'string' && resources[ref]?.Type === 'AWS::AppSync::ApiKey') return true;
  return Object.values(obj).some((v) => carriesSecret(v, resources));
}

/**
 * Resolve `stack`'s nested-stack parameters against its parent's state.
 * A parameter that does not resolve is left out with one warning naming it,
 * so the env var reading it is dropped with the usual message.
 */
export async function resolveNestedStackParameters(
  stack: StackInfo,
  parent: StackInfo,
  parentProvider: LocalStateProvider
): Promise<ResolvedSsmParameters> {
  const origin = stack.nestedStack;
  const out: ResolvedSsmParameters = { values: {}, secureStringLogicalIds: [] };
  if (!origin || Object.keys(origin.parameters).length === 0) return out;
  const loaded = await parentProvider.load(parent.stackName, parent.region);
  if (!loaded) return out;
  const context: SubstitutionContext = {
    resources: loaded.resources,
    consumerRegion: loaded.region,
  };
  let sensitiveParent = new Set<string>();
  if (parentProvider.resolveTemplateSsmParameters) {
    const parentParams = await parentProvider.resolveTemplateSsmParameters(parent.template);
    if (Object.keys(parentParams.values).length > 0) context.parameters = parentParams.values;
    sensitiveParent = new Set(parentParams.secureStringLogicalIds);
    if (sensitiveParent.size > 0) context.sensitiveParameters = sensitiveParent;
  }
  const parentResources = parent.template.Resources ?? {};
  const unresolved: string[] = [];
  for (const [name, value] of Object.entries(origin.parameters)) {
    let consumedSensitive = false;
    context.onSensitiveParameterConsumed = () => {
      consumedSensitive = true;
    };
    const result = await substituteAgainstStateAsync(value, context);
    if (result.kind !== 'literal') {
      unresolved.push(name);
      continue;
    }
    out.values[name] = String(result.value);
    if (consumedSensitive || carriesSecret(value, parentResources)) {
      out.secureStringLogicalIds.push(name);
    }
  }
  if (unresolved.length > 0) {
    getLogger().warn(
      `${parentProvider.label}: nested stack ${displayStackName(stack.displayName)} gets ` +
        `${unresolved.map((n) => displayIdent(n, { listMember: true })).join(', ')} from ` +
        `${displayStackName(parent.stackName)}, which ${unresolved.length === 1 ? 'does' : 'do'} not ` +
        'resolve from its deployed state; an environment variable reading one is dropped.'
    );
  }
  return out;
}

/**
 * Make `provider` (built for the nested `stack`) also answer the nested
 * stack's parameters from `resolveTemplateSsmParameters`. `parentProvider`
 * builds a provider for the parent stack; it is created on first use and
 * disposed with `provider`.
 */
export function withNestedStackParameters(
  provider: LocalStateProvider,
  stack: StackInfo,
  parent: StackInfo,
  parentProvider: () => LocalStateProvider | undefined
): LocalStateProvider {
  const own = provider.resolveTemplateSsmParameters?.bind(provider);
  const dispose = provider.dispose.bind(provider);
  let parentInstance: LocalStateProvider | undefined;
  let nestedParams: Promise<ResolvedSsmParameters> | undefined;
  provider.resolveTemplateSsmParameters = async (template) => {
    const ownResult = own
      ? await own(template)
      : { values: {}, secureStringLogicalIds: [] as string[] };
    // The nested stack's own template (a `--watch` reload re-registers it).
    if (template !== stack.template && template !== registeredStack(stack.stackName)?.template) {
      return ownResult;
    }
    nestedParams ??= (async () => {
      parentInstance ??= parentProvider();
      if (!parentInstance) return { values: {}, secureStringLogicalIds: [] };
      return resolveNestedStackParameters(stack, parent, parentInstance);
    })();
    const nested = await nestedParams;
    return {
      // A value the child resolved itself (an SSM-typed parameter of its own)
      // wins over one handed down; CDK never declares both for one name.
      values: { ...nested.values, ...ownResult.values },
      secureStringLogicalIds: [
        ...new Set([...nested.secureStringLogicalIds, ...ownResult.secureStringLogicalIds]),
      ],
    };
  };
  provider.dispose = () => {
    parentInstance?.dispose();
    dispose();
  };
  return provider;
}
