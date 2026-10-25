import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { describeStacks, selectTargetStack } from '../cli/stack-matcher.js';
import { parseTarget, type ParsedTarget } from './lambda-resolver.js';
import { getEmbedConfig } from './embed-config.js';
import { displayIdent, displayStackName } from '../utils/ident-display.js';

/** `AWS::Lambda::WebFunction` — the function (a name and its revisions). */
export const WEB_FUNCTION_TYPE = 'AWS::Lambda::WebFunction';
/** `AWS::Lambda::WebFunctionRevision` — one immutable code + config build. */
export const WEB_FUNCTION_REVISION_TYPE = 'AWS::Lambda::WebFunctionRevision';
/** `AWS::Lambda::WebFunctionEndpoint` — the URL that routes to weighted revisions. */
export const WEB_FUNCTION_ENDPOINT_TYPE = 'AWS::Lambda::WebFunctionEndpoint';

const WEB_TYPES = [WEB_FUNCTION_ENDPOINT_TYPE, WEB_FUNCTION_TYPE, WEB_FUNCTION_REVISION_TYPE];

/** A web function target could not be resolved; the message names the next step. */
export class WebFunctionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFunctionResolutionError';
    Object.setPrototypeOf(this, WebFunctionResolutionError.prototype);
  }
}

/** One `RevisionWeights` entry of an endpoint, mapped back to the template. */
export interface WebFunctionRevisionWeight {
  /** The revision logical id the entry's `RevisionId` points at, when it is one in this template. */
  revisionLogicalId: string | undefined;
  /** The entry's weight (0 when absent or not a number). */
  weight: number;
}

/** The endpoint a served revision was chosen through, kept for the fidelity warnings. */
export interface ResolvedWebFunctionEndpoint {
  logicalId: string;
  /** `EndpointType` when a literal string (e.g. `HomeRegion`). */
  endpointType: string | undefined;
  /** `AuthType` when a literal string (e.g. `ApplicationManaged`). */
  authType: string | undefined;
  /** Every `RevisionWeights` entry, in template order. */
  weights: WebFunctionRevisionWeight[];
}

/** How the served revision was chosen — surfaced in the boot log. */
export type WebFunctionRevisionSelection =
  | 'target-revision'
  | 'revision-flag'
  | 'endpoint-weight'
  | 'only-revision';

/** A resolved `start-web-function` target: the ONE revision to serve. */
export interface ResolvedWebFunction {
  stack: StackInfo;
  /** The `AWS::Lambda::WebFunction` logical id, when the revision links to one in this stack. */
  functionLogicalId: string | undefined;
  /**
   * The function name the container sees (`AWS_LAMBDA_FUNCTION_NAME`): the
   * function's literal `FunctionName`, else its logical id, else the revision's.
   */
  functionName: string;
  revisionLogicalId: string;
  revision: TemplateResource;
  /** The endpoint the revision was chosen through (or the function's only endpoint). */
  endpoint: ResolvedWebFunctionEndpoint | undefined;
  selection: WebFunctionRevisionSelection;
}

/**
 * Resolve a `cdkl start-web-function <target>` argument to the one revision to
 * serve. `target` may name a `WebFunctionEndpoint`, a `WebFunction` or a
 * `WebFunctionRevision`, as a stack-qualified logical id, a construct path, or
 * a bare logical id in a single-stack app — the same forms (and the same
 * stack-selection rule) as every other command.
 *
 * Revision choice, in order: `revisionFlag` (`--revision <logicalId>`) when
 * set; a revision target itself; an endpoint's highest-weight `RevisionWeights`
 * entry (the first listed on a tie); a function's ONLY revision; a function's
 * ONLY endpoint. Anything else is ambiguous and fails listing the revisions.
 */
export function resolveWebFunctionTarget(
  target: string,
  stacks: StackInfo[],
  revisionFlag?: string
): ResolvedWebFunction {
  if (stacks.length === 0) {
    throw new WebFunctionResolutionError('No stacks found in the synthesized assembly.');
  }
  const parsed = parseTarget(target);
  const stack = pickStack(parsed, stacks, target);
  const resources = stack.template.Resources ?? {};
  const { logicalId, resource } = matchWebResource(parsed, target, stack, resources);

  const functions = logicalIdsOfType(resources, WEB_FUNCTION_TYPE);
  const linked = (value: unknown): string | undefined =>
    linkedFunctionLogicalId(value, resources, functions);

  let functionLogicalId: string | undefined;
  let endpoint: ResolvedWebFunctionEndpoint | undefined;
  let revisionLogicalId: string | undefined;
  let selection: WebFunctionRevisionSelection | undefined;

  if (resource.Type === WEB_FUNCTION_REVISION_TYPE) {
    functionLogicalId = linked(resource.Properties?.['FunctionName']);
    revisionLogicalId = logicalId;
    selection = 'target-revision';
  } else if (resource.Type === WEB_FUNCTION_ENDPOINT_TYPE) {
    functionLogicalId = linked(resource.Properties?.['FunctionName']);
    endpoint = readEndpoint(logicalId, resource, resources);
  } else {
    functionLogicalId = logicalId;
  }

  const revisionsOfFunction = (): string[] =>
    functionLogicalId === undefined
      ? []
      : logicalIdsOfType(resources, WEB_FUNCTION_REVISION_TYPE).filter(
          (id) => linked(resources[id]?.Properties?.['FunctionName']) === functionLogicalId
        );
  const endpointsOfFunction = (): string[] =>
    functionLogicalId === undefined
      ? []
      : logicalIdsOfType(resources, WEB_FUNCTION_ENDPOINT_TYPE).filter(
          (id) => linked(resources[id]?.Properties?.['FunctionName']) === functionLogicalId
        );

  if (revisionFlag !== undefined) {
    const flagged = resources[revisionFlag];
    if (!flagged || flagged.Type !== WEB_FUNCTION_REVISION_TYPE) {
      throw new WebFunctionResolutionError(
        `--revision ${displayIdent(revisionFlag)} is not an ${WEB_FUNCTION_REVISION_TYPE} logical id in ` +
          `${displayStackName(stack.stackName)}. ${describeRevisions(revisionsOfFunction(), stack)}`
      );
    }
    const owner = linked(flagged.Properties?.['FunctionName']);
    if (functionLogicalId !== undefined && owner !== functionLogicalId) {
      throw new WebFunctionResolutionError(
        `--revision ${displayIdent(revisionFlag)} belongs to a different web function than ` +
          `${displayIdent(logicalId)}. ${describeRevisions(revisionsOfFunction(), stack)}`
      );
    }
    functionLogicalId ??= owner;
    revisionLogicalId = revisionFlag;
    selection = 'revision-flag';
  }

  if (revisionLogicalId === undefined && endpoint !== undefined) {
    revisionLogicalId = pickHighestWeight(endpoint);
    if (revisionLogicalId !== undefined) selection = 'endpoint-weight';
  }

  if (revisionLogicalId === undefined) {
    const revisions = revisionsOfFunction();
    if (revisions.length === 1) {
      revisionLogicalId = revisions[0];
      selection = 'only-revision';
    } else if (endpoint === undefined && revisions.length > 1) {
      // A function with several revisions: its ONE endpoint decides, as in the cloud.
      const endpoints = endpointsOfFunction();
      if (endpoints.length === 1) {
        endpoint = readEndpoint(endpoints[0]!, resources[endpoints[0]!]!, resources);
        revisionLogicalId = pickHighestWeight(endpoint);
        if (revisionLogicalId !== undefined) selection = 'endpoint-weight';
      }
    }
    if (revisionLogicalId === undefined) {
      throw new WebFunctionResolutionError(
        revisions.length === 0
          ? `${displayIdent(logicalId)} in ${displayStackName(stack.stackName)} resolves to no ` +
              `${WEB_FUNCTION_REVISION_TYPE} in this template, so there is no code to serve. ` +
              `Target the revision itself, or pass --revision <logicalId>.`
          : `${displayIdent(logicalId)} has ${revisions.length} revisions and no single endpoint ` +
              `that picks one. Pass --revision <logicalId>, or target one of the function's ` +
              `endpoints. ${describeRevisions(revisions, stack)}`
      );
    }
  }

  // The served revision's endpoint, for the fidelity warnings, when one targets it.
  if (endpoint === undefined) {
    const endpoints = endpointsOfFunction().map((id) =>
      readEndpoint(id, resources[id]!, resources)
    );
    const routing = endpoints.filter((e) =>
      e.weights.some((w) => w.revisionLogicalId === revisionLogicalId)
    );
    if (routing.length === 1) endpoint = routing[0];
  }

  const fnResource = functionLogicalId !== undefined ? resources[functionLogicalId] : undefined;
  const fnName = fnResource?.Properties?.['FunctionName'];
  return {
    stack,
    functionLogicalId,
    functionName:
      typeof fnName === 'string' && fnName.length > 0
        ? fnName
        : (functionLogicalId ?? revisionLogicalId),
    revisionLogicalId,
    revision: resources[revisionLogicalId]!,
    endpoint,
    selection: selection ?? 'only-revision',
  };
}

function pickStack(parsed: ParsedTarget, stacks: StackInfo[], target: string): StackInfo {
  const selection = selectTargetStack(parsed, target, stacks);
  switch (selection.kind) {
    case 'found':
      return selection.stack;
    case 'no-prefix':
      throw new WebFunctionResolutionError(
        `Multiple stacks in app, target ${displayIdent(parsed.pathOrId)} is missing a stack prefix. ` +
          `Use StackName:<logicalId> or StackName/... (path form). Available stacks: ${describeStacks(stacks)}.`
      );
    case 'not-found':
      throw new WebFunctionResolutionError(
        `Stack ${displayStackName(selection.pattern)} not found. Available stacks: ${describeStacks(stacks)}.`
      );
    case 'ambiguous':
      throw new WebFunctionResolutionError(
        `Stack pattern ${displayStackName(selection.pattern)} matched ${selection.matched.length} stacks: ` +
          `${describeStacks(selection.matched)}. Use a more specific pattern, or the stack's display path.`
      );
  }
}

/**
 * Resolve a parsed target to ONE web resource. A path can cover several (a
 * construct holding a function, its revisions and its endpoint): the most
 * specific serving resource wins — an endpoint, else the function, else a
 * revision — and two of the same kind are ambiguous.
 */
function matchWebResource(
  parsed: ParsedTarget,
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): { logicalId: string; resource: TemplateResource } {
  if (parsed.isPath) {
    const matches = resolveCdkPathToLogicalIds(
      parsed.pathOrId,
      buildCdkPathIndex(stack.template)
    ).filter(({ logicalId }) => WEB_TYPES.includes(resources[logicalId]?.Type ?? ''));
    for (const type of WEB_TYPES) {
      const ofType = matches.filter(({ logicalId }) => resources[logicalId]!.Type === type);
      if (ofType.length === 1) {
        const id = ofType[0]!.logicalId;
        return { logicalId: id, resource: resources[id]! };
      }
      if (ofType.length > 1) {
        throw new WebFunctionResolutionError(
          `Target ${displayStackName(target)} matches ${ofType.length} ${type} resources: ` +
            `${ofType.map((m) => displayIdent(m.logicalId)).join(', ')}. Refine the path or use the ` +
            `StackName:<logicalId> form.`
        );
      }
    }
    throw notFoundError(target, stack, resources);
  }
  const resource = resources[parsed.pathOrId];
  if (!resource) throw notFoundError(target, stack, resources);
  if (!WEB_TYPES.includes(resource.Type)) {
    throw new WebFunctionResolutionError(
      `Resource ${displayIdent(parsed.pathOrId)} in ${displayStackName(stack.stackName)} is ` +
        `${displayIdent(resource.Type)}, not a Lambda web function. ` +
        `${getEmbedConfig().cliName} start-web-function serves ${WEB_TYPES.join(' / ')} targets.`
    );
  }
  return { logicalId: parsed.pathOrId, resource };
}

function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): WebFunctionResolutionError {
  const available = WEB_TYPES.flatMap((t) => logicalIdsOfType(resources, t));
  const hint =
    available.length > 0
      ? `Web function resources in ${displayStackName(stack.stackName)}: ` +
        `${available.map((id) => displayIdent(id)).join(', ')}.`
      : `No ${WEB_FUNCTION_TYPE} resources found in ${displayStackName(stack.stackName)}.`;
  return new WebFunctionResolutionError(`Target ${displayStackName(target)} not found. ${hint}`);
}

function logicalIdsOfType(resources: Record<string, TemplateResource>, type: string): string[] {
  return Object.keys(resources).filter((id) => resources[id]?.Type === type);
}

/**
 * The `AWS::Lambda::WebFunction` a revision's / endpoint's `FunctionName`
 * points at: a `Ref` / `Fn::GetAtt` to one, or a literal equal to one's literal
 * `FunctionName`.
 */
function linkedFunctionLogicalId(
  value: unknown,
  resources: Record<string, TemplateResource>,
  functions: string[]
): string | undefined {
  const ref = referencedLogicalId(value);
  if (ref !== undefined) return functions.includes(ref) ? ref : undefined;
  if (typeof value !== 'string') return undefined;
  const byName = functions.filter((id) => resources[id]?.Properties?.['FunctionName'] === value);
  return byName.length === 1 ? byName[0] : undefined;
}

/** The logical id a `Ref` / `Fn::GetAtt` (array or dotted-string form) names. */
function referencedLogicalId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj['Ref'] === 'string') return obj['Ref'];
  const getAtt = obj['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
  if (typeof getAtt === 'string') return getAtt.split('.')[0];
  return undefined;
}

function readEndpoint(
  logicalId: string,
  resource: TemplateResource,
  resources: Record<string, TemplateResource>
): ResolvedWebFunctionEndpoint {
  const props = resource.Properties ?? {};
  const rawWeights = props['RevisionWeights'];
  const weights: WebFunctionRevisionWeight[] = [];
  if (Array.isArray(rawWeights)) {
    for (const entry of rawWeights) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const ref = referencedLogicalId(e['RevisionId']);
      weights.push({
        revisionLogicalId:
          ref !== undefined && resources[ref]?.Type === WEB_FUNCTION_REVISION_TYPE
            ? ref
            : undefined,
        weight: typeof e['Weight'] === 'number' ? e['Weight'] : 0,
      });
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    logicalId,
    endpointType: str(props['EndpointType']),
    authType: str(props['AuthType']),
    weights,
  };
}

/** The highest-weight entry that names a revision in this template; first listed on a tie. */
function pickHighestWeight(endpoint: ResolvedWebFunctionEndpoint): string | undefined {
  let best: WebFunctionRevisionWeight | undefined;
  for (const w of endpoint.weights) {
    if (w.revisionLogicalId === undefined) continue;
    if (best === undefined || w.weight > best.weight) best = w;
  }
  return best?.revisionLogicalId;
}

function describeRevisions(revisions: string[], stack: StackInfo): string {
  return revisions.length > 0
    ? `Revisions: ${revisions.map((id) => displayIdent(id)).join(', ')}.`
    : `No ${WEB_FUNCTION_REVISION_TYPE} linked to it in ${displayStackName(stack.stackName)}.`;
}
