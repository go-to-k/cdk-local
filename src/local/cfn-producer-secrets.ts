/**
 * Whether a value `--from-cfn-stack`'s cross-stack resolver serves for an
 * `Fn::ImportValue` holds a secret of the PRODUCER stack (go-to-k/cdkd#6339).
 *
 * The ECS post-pass keeps a judged value off the `docker run` argv
 * (`cross-stack-secret-check.ts`). cdkd judges from its own state; here the
 * producer is read from CloudFormation instead, in the region the exports were
 * listed in:
 *
 * - `ListExports` names the export's `ExportingStackId`;
 * - `ListStackResources` (paginated) of that stack and of every nested stack
 *   under it gives physical ids: an `AWS::AppSync::ApiKey`'s is its ARN, which
 *   ends in the key, so the key is a needle wherever it was exported from;
 * - `DescribeStacks` maps the export to its `OutputKey`, and `GetTemplate`
 *   gives that output's `Value`, which is traced: a `Ref` to a `NoEcho`
 *   parameter, or a `Fn::GetAtt` of an attribute that is (by type) or is named
 *   (by name) a secret, makes the output's value a needle; a
 *   `Fn::GetAtt <NestedStack>.Outputs.<Name>` is traced into the nested
 *   template, and an `Fn::ImportValue` into the stack that exports it
 *   (re-exports), transitively.
 *
 * Fail closed: a stack that cannot be read, a template that is not JSON, an
 * `Fn::ImportValue` whose name is computed, or a walk past the depth bound
 * makes the verdict `unreadable`; an export the producer no longer declares
 * is `stale`. Not judged (CloudFormation records no value to read):
 * a secret the producer received as a plain (not `NoEcho`) parameter, a key
 * the producer transforms (`Fn::Base64`, `Fn::Select` of `Fn::Split`), and a
 * `NoEcho` parameter passed into a nested stack (its `Parameters` are not
 * traced). Every `Fn::If` branch is traced: a conservative false positive.
 */
import {
  DescribeStacksCommand,
  GetTemplateCommand,
  type CloudFormationClient,
} from '@aws-sdk/client-cloudformation';
import { displayUntrustedValue } from '../utils/assembly-path.js';
import { describeAwsFailureForWarn } from './credential-error.js';
import type { CrossStackJudgement } from './cross-stack-secret-check.js';
import {
  isCustomResourceType,
  isSecretAttributeName,
  isSecretValuedAttribute,
} from './secret-attributes.js';

/** One `ListExports` entry. */
export interface CfnExportEntry {
  value: string;
  exportingStackId?: string | undefined;
}

/**
 * Shortest physical-id segment or TYPED secret matched INSIDE a longer value;
 * a shorter one only whole. cdkd's floor.
 */
const SEGMENT_SUBSTRING_FLOOR = 4;
/** Shortest value a NAME heuristic counts as a secret, matched whole. cdkd's floor. */
const NAMED_LEAF_EXACT_FLOOR = 8;
/** Shortest name-judged value matched INSIDE a longer served value. cdkd's floor. */
const NAMED_LEAF_FLOOR = 16;
/** A backstop on the nested and re-export walks, far past any real tree. cdkd's bound. */
const MAX_DEPTH = 32;
/**
 * A backstop on how many stacks one judgement walks (nested and re-export
 * sources together), so an endpoint listing thousands of nested stacks
 * cannot drive thousands of reads.
 */
const MAX_STACKS = 256;

/** An AppSync ARN, its resource path in group 1. */
const APPSYNC_ARN = /^arn:[^:]+:appsync:[^:]*:[^:]*:(.+)$/;
/** An ApiKey ARN's resource path, the key in group 2 (CloudFormation writes `apikeys/`). */
const APPSYNC_APIKEY_PATH = /^apis\/([^/|]+)\/apikeys?\/([^/|]+)$/;

/**
 * The segment of `physicalId` that is a bearer credential, or `undefined`
 * when the type declares none: an `AWS::AppSync::ApiKey`'s key (the ARN's
 * last segment, or the second half of `<apiId>|<keyId>`). An ApiKey id in
 * neither form is secret WHOLE. cdkd's `secretPhysicalIdSegment`.
 */
export function secretPhysicalIdSegment(
  resourceType: unknown,
  physicalId: unknown
): string | undefined {
  if (resourceType !== 'AWS::AppSync::ApiKey') return undefined;
  if (typeof physicalId !== 'string' || physicalId === '') return undefined;
  const parts = physicalId.split('|');
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') return parts[1];
  const arn = APPSYNC_ARN.exec(physicalId);
  const path = arn ? APPSYNC_APIKEY_PATH.exec(arn[1]!) : null;
  return path ? path[2] : physicalId;
}

/** Whether `value` is `needle`, or holds it and the needle reaches `floor`. */
function holds(value: string, needle: string, floor: number): boolean {
  return value === needle || (needle.length >= floor && value.includes(needle));
}

/** A value that is plaintext, not empty, the mask or a reference. */
const isPlaintext = (v: string): boolean => v !== '' && v !== '***' && !v.includes('{{resolve:');

/** What one export's producer tree says about the values it serves. */
interface Summary {
  segments: Set<string>;
  typed: Set<string>;
  named: Set<string>;
  /** Why something the verdict depends on could not be read (first one). */
  opaque: string | undefined;
  /** The producer no longer declares the export the value was served for. */
  stale: boolean;
}

/** Per-judgement walk state: each stack and export is walked once. */
interface Walk {
  summary: Summary;
  stacks: Set<string>;
  exports: Set<string>;
}

/** A read of one stack's part, memoized per judge. */
type Read<T> = { ok: T } | { error: string };

type StackResources = {
  LogicalResourceId?: string | undefined;
  PhysicalResourceId?: string | undefined;
  ResourceType?: string | undefined;
}[];
type StackOutputs = { OutputKey?: string; OutputValue?: string; ExportName?: string }[];
type Template = Record<string, unknown>;

/** The stack being traced: its id and template. */
interface TraceStack {
  stackId: string;
  template: Template;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Judges `Fn::ImportValue` values against their producer stacks. One per
 * resolver: every stack read is memoized, and so is each export's summary.
 */
export class CfnProducerSecretJudge {
  private readonly client: CloudFormationClient;
  private readonly listResources: (
    client: CloudFormationClient,
    stackId: string
  ) => Promise<StackResources>;
  private readonly exports: () => Promise<Map<string, CfnExportEntry> | undefined>;
  private readonly label: string;
  private readonly resourceReads = new Map<string, Promise<Read<StackResources>>>();
  private readonly outputReads = new Map<string, Promise<Read<StackOutputs>>>();
  private readonly templateReads = new Map<string, Promise<Read<Template>>>();
  private readonly summaries = new Map<string, Promise<Summary>>();

  public constructor(
    client: CloudFormationClient,
    exports: () => Promise<Map<string, CfnExportEntry> | undefined>,
    label: string,
    /** The paginated `ListStackResources` walk (`fetchAllStackResources`). */
    listResources: (client: CloudFormationClient, stackId: string) => Promise<StackResources>
  ) {
    this.client = client;
    this.listResources = listResources;
    this.exports = exports;
    this.label = label;
  }

  /** The verdict on `served`, the value `ListExports` gave for `exportName`. */
  public async judgeExport(
    exportName: string,
    served: string
  ): Promise<CrossStackJudgement | undefined> {
    let summary = this.summaries.get(exportName);
    if (summary === undefined) {
      summary = this.summarize(exportName);
      this.summaries.set(exportName, summary);
    }
    return verdictOf(await summary, served);
  }

  private async summarize(exportName: string): Promise<Summary> {
    const walk: Walk = {
      summary: {
        segments: new Set(),
        typed: new Set(),
        named: new Set(),
        opaque: undefined,
        stale: false,
      },
      stacks: new Set(),
      exports: new Set(),
    };
    await this.addExport(exportName, walk, 0, true);
    return walk.summary;
  }

  /** Mark the walk unjudgeable, keeping the first reason. */
  private static opaque(walk: Walk, why: string): void {
    walk.summary.opaque ??= why;
  }

  /** Walk export `name`: its producer's tree, and the output it serves. */
  private async addExport(name: string, walk: Walk, depth: number, top: boolean): Promise<void> {
    if (walk.exports.has(name)) return;
    walk.exports.add(name);
    const shownExport = displayUntrustedValue(name);
    if (depth > MAX_DEPTH) {
      CfnProducerSecretJudge.opaque(walk, `the re-exports go past the ${MAX_DEPTH}-level bound`);
      return;
    }
    const exports = await this.exports();
    const entry = exports?.get(name);
    if (entry === undefined) {
      CfnProducerSecretJudge.opaque(
        walk,
        `the producer re-exports ${shownExport}, which ListExports does not list`
      );
      return;
    }
    const stackId = entry.exportingStackId;
    if (stackId === undefined || stackId === '') {
      CfnProducerSecretJudge.opaque(
        walk,
        `ListExports names no exporting stack for ${shownExport}`
      );
      return;
    }
    const shownStack = displayUntrustedValue(stackId);
    await this.addTree(stackId, walk, depth);
    const outputs = await this.readOutputs(stackId);
    if ('error' in outputs) {
      CfnProducerSecretJudge.opaque(walk, outputs.error);
      return;
    }
    const output = outputs.ok.find((o) => o.ExportName === name);
    if (output?.OutputKey === undefined || output.OutputValue !== entry.value) {
      if (top) walk.summary.stale = true;
      else {
        CfnProducerSecretJudge.opaque(
          walk,
          `the producer re-exports ${shownExport}, which ${shownStack} no longer declares`
        );
      }
      return;
    }
    const template = await this.readTemplate(stackId);
    if ('error' in template) {
      CfnProducerSecretJudge.opaque(walk, template.error);
      return;
    }
    await this.traceOutput(
      { stackId, template: template.ok },
      output.OutputKey,
      output.OutputValue,
      walk,
      depth
    );
  }

  /** The physical-id needles of `stackId` and every nested stack under it. */
  private async addTree(stackId: string, walk: Walk, depth: number): Promise<void> {
    if (walk.stacks.has(stackId)) return;
    if (walk.stacks.size >= MAX_STACKS) {
      CfnProducerSecretJudge.opaque(walk, `the producer tree goes past ${MAX_STACKS} stacks`);
      return;
    }
    walk.stacks.add(stackId);
    const resources = await this.readResources(stackId);
    if ('error' in resources) {
      CfnProducerSecretJudge.opaque(walk, resources.error);
      return;
    }
    for (const r of resources.ok) {
      const segment = secretPhysicalIdSegment(r.ResourceType, r.PhysicalResourceId);
      if (segment !== undefined && isPlaintext(segment)) walk.summary.segments.add(segment);
      if (r.ResourceType === 'AWS::CloudFormation::Stack' && r.PhysicalResourceId) {
        if (depth + 1 > MAX_DEPTH) {
          CfnProducerSecretJudge.opaque(
            walk,
            `the nested stacks go past the ${MAX_DEPTH}-level bound`
          );
          continue;
        }
        await this.addTree(r.PhysicalResourceId, walk, depth + 1);
      }
    }
  }

  /** Trace output `key` of `stack`, whose deployed value is `value`. */
  private async traceOutput(
    stack: TraceStack,
    key: string,
    value: string,
    walk: Walk,
    depth: number
  ): Promise<void> {
    const outputs = stack.template['Outputs'];
    const def = isRecord(outputs) && Object.hasOwn(outputs, key) ? outputs[key] : undefined;
    if (!isRecord(def) || !Object.hasOwn(def, 'Value')) {
      CfnProducerSecretJudge.opaque(
        walk,
        `the template of ${displayUntrustedValue(stack.stackId)} declares no output ${displayUntrustedValue(key)}`
      );
      return;
    }
    await this.trace(def['Value'], stack, value, walk, depth, new Set());
  }

  /**
   * Walk an output's template `node`: each secret source it reads makes the
   * output's deployed `value` a needle. `shadowed` are `Fn::Sub` variable
   * names in scope, which a `${Name}` placeholder reads instead of a
   * parameter or resource.
   */
  private async trace(
    node: unknown,
    stack: TraceStack,
    value: string,
    walk: Walk,
    depth: number,
    shadowed: ReadonlySet<string>
  ): Promise<void> {
    if (Array.isArray(node)) {
      for (const item of node) await this.trace(item, stack, value, walk, depth, shadowed);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'Ref' && typeof child === 'string') {
        this.readRef(child, stack, value, walk);
      } else if (key === 'Fn::GetAtt') {
        const att = getAttOf(child);
        if (att === undefined) {
          CfnProducerSecretJudge.opaque(walk, 'an exported Fn::GetAtt is computed');
        } else {
          await this.readGetAtt(att[0], att[1], stack, value, walk, depth);
        }
      } else if (key === 'Fn::Sub') {
        const template = Array.isArray(child) ? child[0] : child;
        const vars = Array.isArray(child) && isRecord(child[1]) ? child[1] : {};
        const inScope = new Set([...shadowed, ...Object.keys(vars)]);
        if (typeof template === 'string') {
          for (const m of template.matchAll(/\$\{([^}!][^}]*)\}/g)) {
            const ref = m[1]!.trim();
            if (inScope.has(ref) || ref.startsWith('AWS::')) continue;
            const dot = ref.indexOf('.');
            if (dot > 0) {
              await this.readGetAtt(
                ref.slice(0, dot),
                ref.slice(dot + 1),
                stack,
                value,
                walk,
                depth
              );
            } else {
              this.readRef(ref, stack, value, walk);
            }
          }
        } else {
          await this.trace(template, stack, value, walk, depth, shadowed);
        }
        for (const v of Object.values(vars)) {
          await this.trace(v, stack, value, walk, depth, shadowed);
        }
        continue;
      } else if (key === 'Fn::ImportValue') {
        if (typeof child === 'string') await this.addExport(child, walk, depth + 1, false);
        else
          CfnProducerSecretJudge.opaque(
            walk,
            'the producer re-exports an Fn::ImportValue whose name is computed'
          );
        continue;
      }
      await this.trace(child, stack, value, walk, depth, shadowed);
    }
  }

  /** A `Ref` (or `${Name}`): a `NoEcho` parameter makes `value` a needle. */
  private readRef(name: string, stack: TraceStack, value: string, walk: Walk): void {
    const params = stack.template['Parameters'];
    const param = isRecord(params) && Object.hasOwn(params, name) ? params[name] : undefined;
    if (!isRecord(param)) return;
    const noEcho = param['NoEcho'];
    if ((noEcho === true || noEcho === 'true') && isPlaintext(value)) walk.summary.typed.add(value);
  }

  /** A `Fn::GetAtt`: a secret attribute makes `value` a needle; a nested output is traced. */
  private async readGetAtt(
    logicalId: string,
    attribute: string,
    stack: TraceStack,
    value: string,
    walk: Walk,
    depth: number
  ): Promise<void> {
    const resources = stack.template['Resources'];
    const res =
      isRecord(resources) && Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
    const type = isRecord(res) ? res['Type'] : undefined;
    // A nested stack's output is decided by tracing it, never by its name:
    // CDK names a re-exported reference `Outputs.<Path>DbSecret<hash>Ref`, an
    // ARN, which the name rule would call a secret (cdkd's #6333).
    if (type === 'AWS::CloudFormation::Stack' && attribute.startsWith('Outputs.')) {
      await this.traceNestedOutput(
        stack,
        logicalId,
        attribute.slice('Outputs.'.length),
        walk,
        depth
      );
      return;
    }
    if (!isPlaintext(value)) return;
    // A custom resource can return anything (an `AwsCustomResource` reading a
    // SecureString): the same class the same-stack argv rule refuses.
    if (isSecretValuedAttribute(type, attribute) || isCustomResourceType(type)) {
      walk.summary.typed.add(value);
    } else if (isSecretAttributeName(attribute) && value.length >= NAMED_LEAF_EXACT_FLOOR) {
      walk.summary.named.add(value);
    }
  }

  /** Trace output `key` of the nested stack `logicalId` of `stack`. */
  private async traceNestedOutput(
    stack: TraceStack,
    logicalId: string,
    key: string,
    walk: Walk,
    depth: number
  ): Promise<void> {
    const shownParent = displayUntrustedValue(stack.stackId);
    if (depth + 1 > MAX_DEPTH) {
      CfnProducerSecretJudge.opaque(walk, `the nested stacks go past the ${MAX_DEPTH}-level bound`);
      return;
    }
    const resources = await this.readResources(stack.stackId);
    if ('error' in resources) {
      CfnProducerSecretJudge.opaque(walk, resources.error);
      return;
    }
    const nestedId = resources.ok.find(
      (r) => r.LogicalResourceId === logicalId
    )?.PhysicalResourceId;
    if (!nestedId) {
      CfnProducerSecretJudge.opaque(
        walk,
        `${shownParent} lists no nested stack ${displayUntrustedValue(logicalId)}`
      );
      return;
    }
    const outputs = await this.readOutputs(nestedId);
    if ('error' in outputs) {
      CfnProducerSecretJudge.opaque(walk, outputs.error);
      return;
    }
    const output = outputs.ok.find((o) => o.OutputKey === key);
    const template = await this.readTemplate(nestedId);
    if ('error' in template) {
      CfnProducerSecretJudge.opaque(walk, template.error);
      return;
    }
    if (output?.OutputValue === undefined) {
      CfnProducerSecretJudge.opaque(
        walk,
        `the nested stack ${displayUntrustedValue(nestedId)} has no output ${displayUntrustedValue(key)}`
      );
      return;
    }
    await this.traceOutput(
      { stackId: nestedId, template: template.ok },
      key,
      output.OutputValue,
      walk,
      depth + 1
    );
  }

  /** Memoized read of `stackId`'s part, with the reason a failure is shown with. */
  private memo<T>(
    cache: Map<string, Promise<Read<T>>>,
    stackId: string,
    operation: string,
    read: () => Promise<T>
  ): Promise<Read<T>> {
    let got = cache.get(stackId);
    if (got === undefined) {
      got = Promise.resolve()
        .then(read)
        .then(
          (ok): Read<T> => ({ ok }),
          (err: unknown): Read<T> => {
            // Rendered ONCE: a modeled service exception's message is kept
            // (it names the missing permission or the throttle), anything
            // else is withheld to `debug` by the helper itself.
            const why =
              err instanceof UnjudgeableStackError
                ? err.message
                : describeAwsFailureForWarn(
                    err,
                    `${this.label}: CloudFormation ${operation}(${displayUntrustedValue(stackId)})`
                  );
            return { error: `${operation} of ${displayUntrustedValue(stackId)} failed: ${why}` };
          }
        );
      cache.set(stackId, got);
    }
    return got;
  }

  private readResources(stackId: string): Promise<Read<StackResources>> {
    return this.memo(this.resourceReads, stackId, 'ListStackResources', async () => {
      return this.listResources(this.client, stackId);
    });
  }

  private readOutputs(stackId: string): Promise<Read<StackOutputs>> {
    return this.memo(this.outputReads, stackId, 'DescribeStacks', async () => {
      const resp = await this.client.send(new DescribeStacksCommand({ StackName: stackId }));
      const stack = resp.Stacks?.[0];
      if (!stack) throw new UnjudgeableStackError('it returned no stack');
      return (stack.Outputs ?? []) as StackOutputs;
    });
  }

  private readTemplate(stackId: string): Promise<Read<Template>> {
    return this.memo(this.templateReads, stackId, 'GetTemplate', async () => {
      const resp = await this.client.send(new GetTemplateCommand({ StackName: stackId }));
      const body = resp.TemplateBody;
      let parsed: unknown;
      try {
        parsed = typeof body === 'string' ? JSON.parse(body) : undefined;
      } catch {
        parsed = undefined;
      }
      // A YAML template is not read: no YAML parser ships with the CLI.
      if (!isRecord(parsed)) throw new UnjudgeableStackError('the template is not a JSON object');
      return parsed;
    });
  }
}

/** A stack read that succeeded with nothing to judge; its message is shown. */
class UnjudgeableStackError extends Error {}

/** `[logicalId, attribute]` of a literal `Fn::GetAtt`, either form. */
function getAttOf(node: unknown): [string, string] | undefined {
  if (Array.isArray(node) && typeof node[0] === 'string' && typeof node[1] === 'string') {
    return [node[0], node[1]];
  }
  if (typeof node === 'string') {
    const dot = node.indexOf('.');
    if (dot > 0) return [node.slice(0, dot), node.slice(dot + 1)];
  }
  return undefined;
}

/** The verdict `summary` gives `served`. */
function verdictOf(summary: Summary, served: string): CrossStackJudgement | undefined {
  for (const s of summary.segments) {
    if (holds(served, s, SEGMENT_SUBSTRING_FLOOR)) return { verdict: 'secret' };
  }
  for (const t of summary.typed) {
    if (holds(served, t, SEGMENT_SUBSTRING_FLOOR)) return { verdict: 'secret' };
  }
  for (const n of summary.named) {
    if (holds(served, n, NAMED_LEAF_FLOOR)) return { verdict: 'secret' };
  }
  if (summary.opaque !== undefined) return { verdict: 'unreadable', detail: summary.opaque };
  if (summary.stale) return { verdict: 'stale' };
  return undefined;
}
