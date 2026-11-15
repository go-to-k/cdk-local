import type { StackInfo } from '../synthesis/assembly-reader.js';
import { parentStackOf, registeredStackForTemplate } from '../synthesis/nested-stacks.js';
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
import { deployedFillMayBeSecret } from './dynamic-reference-resolver.js';

/** How a state record spells a value it withheld (a NoEcho attribute). */
const STATE_SECRET_MASK = '***';

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
  // A `{{resolve:...}}` string is `deployedFillMayBeSecret`'s to judge.
  if (typeof value === 'string') return false;
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
    // A value the state records masked (a NoEcho custom-resource attribute)
    // is not the value; drop it like an unresolved one rather than hand the
    // mask down as if it were.
    if (result.value === STATE_SECRET_MASK) {
      unresolved.push(name);
      continue;
    }
    out.values[name] = String(result.value);
    if (
      consumedSensitive ||
      carriesSecret(value, parentResources) ||
      deployedFillMayBeSecret(value, parent.template)
    ) {
      out.secureStringLogicalIds.push(name);
    }
  }
  if (unresolved.length > 0) {
    getLogger().warn(
      `${parentProvider.label}: nested stack ${displayStackName(stack.stackName)} gets ` +
        `${unresolved.map((n) => displayIdent(n, { listMember: true })).join(', ')} from ` +
        `${displayStackName(parent.stackName)}, which ${unresolved.length === 1 ? 'does' : 'do'} not ` +
        "resolve from the parent's deployed state; an environment variable reading one is filled " +
        "from the deployed function's own environment when the state source can read it, else dropped."
    );
  }
  return out;
}

/**
 * Make `provider` (built for the nested stack `stackName`) also answer the
 * nested stack's parameters from `resolveTemplateSsmParameters`. The stack is
 * picked by the TEMPLATE the caller passes, so two clones sharing a physical
 * name stay apart and a `--watch` reload's new template gets its own values.
 * `parentProvider` builds a provider for a parent stack; one is created per
 * parent name on first use and disposed with `provider`.
 */
export function withNestedStackParameters(
  provider: LocalStateProvider,
  stackName: string,
  parentProvider: (parent: StackInfo) => LocalStateProvider | undefined
): LocalStateProvider {
  const own = provider.resolveTemplateSsmParameters?.bind(provider);
  const dispose = provider.dispose.bind(provider);
  const parentInstances = new Map<string, LocalStateProvider | undefined>();
  const nestedParams = new WeakMap<object, Promise<ResolvedSsmParameters>>();
  provider.resolveTemplateSsmParameters = async (template) => {
    const ownResult = own
      ? await own(template)
      : { values: {}, secureStringLogicalIds: [] as string[] };
    const stack = registeredStackForTemplate(stackName, template);
    const parent = stack ? parentStackOf(stack) : undefined;
    if (!stack?.nestedStack || !parent) return ownResult;
    let pending = nestedParams.get(template);
    if (!pending) {
      pending = (async () => {
        if (!parentInstances.has(parent.stackName)) {
          parentInstances.set(parent.stackName, parentProvider(parent));
        }
        const instance = parentInstances.get(parent.stackName);
        if (!instance) return { values: {}, secureStringLogicalIds: [] };
        return resolveNestedStackParameters(stack, parent, instance);
      })();
      nestedParams.set(template, pending);
    }
    const nested = await pending;
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
    for (const instance of parentInstances.values()) instance?.dispose();
    dispose();
  };
  return provider;
}
