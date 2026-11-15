/**
 * The ECS cross-stack post-pass's side of the producer-secret check
 * (go-to-k/cdkd#6339): read a resolver's OPTIONAL judged variants
 * (`resolveImportJudged` / `resolveGetStackOutputJudged`) and word what the
 * post-pass does with a judged value. A resolver that carries them (cdkd's
 * `--from-state` one, cdk-local's own `--from-cfn-stack` one) says, per call,
 * whether the value holds a secret of the producer it was read from; one that
 * does not is served exactly as before.
 *
 * The post-pass's three effects mirror cdkd's (`src/local/ecs-task-resolver/
 * cross-stack.ts` there): a judged value is refused in a `Command` /
 * `EntryPoint` / health-check element, passed value-less (`-e KEY`) in
 * `Environment`, and dropped as a `Secrets` `ValueFrom`.
 */
import { getEmbedConfig } from './embed-config.js';
import type {
  CrossStackResolver,
  CrossStackSecretVerdict,
  JudgedCrossStackValue,
  SubstitutionContext,
} from './state-resolver.js';

/** The value cdkd-shaped state records in place of a `NoEcho` value. */
const SECRET_MASK = '***';

/** A verdict, with why it could not be judged when it says so. */
export interface CrossStackJudgement {
  verdict: CrossStackSecretVerdict;
  detail?: string | undefined;
}

/** The judged variants a resolver carries, when it carries both. */
export interface CrossStackSecretCheck {
  resolveImportJudged(exportName: string): Promise<JudgedCrossStackValue>;
  resolveGetStackOutputJudged(
    producerStack: string,
    producerRegion: string,
    outputName: string
  ): Promise<JudgedCrossStackValue>;
}

/**
 * The judged variants `resolver` carries, bound to it, or `undefined` when it
 * lacks either one (an older or third-party resolver: served as before).
 */
export function crossStackSecretCheckOf(
  resolver: CrossStackResolver | undefined
): CrossStackSecretCheck | undefined {
  if (
    resolver === undefined ||
    typeof resolver.resolveImportJudged !== 'function' ||
    typeof resolver.resolveGetStackOutputJudged !== 'function'
  ) {
    return undefined;
  }
  // Called as methods of `resolver`, which may read `this`.
  const r = resolver as CrossStackResolver & CrossStackSecretCheck;
  return {
    resolveImportJudged: (exportName) => r.resolveImportJudged(exportName),
    resolveGetStackOutputJudged: (stack, region, output) =>
      r.resolveGetStackOutputJudged(stack, region, output),
  };
}

/**
 * `a` or `b`, whichever weighs more: `secret` over the fail-closed verdicts,
 * else the first seen. One element can read several cross-stack values.
 */
export function strongerJudgement(
  a: CrossStackJudgement | undefined,
  b: CrossStackJudgement | undefined
): CrossStackJudgement | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (b.verdict === 'secret' && a.verdict !== 'secret') return b;
  return a;
}

/**
 * The judgement of one returned value, or `undefined` when it carries none. A
 * verdict this version does not know (a newer host's) fails closed as
 * `unreadable`: the contract crosses repositories.
 */
export function judgementOf(judged: JudgedCrossStackValue): CrossStackJudgement | undefined {
  const { verdict, detail } = judged;
  if (verdict === undefined) return undefined;
  if (verdict === 'secret') return { verdict };
  const known = verdict === 'unreadable' || verdict === 'stale' ? verdict : 'unreadable';
  return typeof detail === 'string' ? { verdict: known, detail } : { verdict: known };
}

/** Why the value is withheld, as a clause after "resolved a cross-stack value". */
function judgedClause(judgement: CrossStackJudgement): string {
  const bin = getEmbedConfig().binaryName;
  if (judgement.verdict === 'secret') return 'holding a secret of the producer stack';
  if (judgement.verdict === 'stale') {
    return `the producer stack no longer exports, so ${bin} could not check it for secrets`;
  }
  return judgement.detail !== undefined
    ? `${bin} could not check for secrets (${judgement.detail})`
    : `whose producer stack ${bin} could not read to check it for secrets`;
}

/** The argv refusal for a value with `judgement`. */
export function crossStackSecretArgvReason(judgement: CrossStackJudgement): string {
  return (
    `resolved a cross-stack value ${judgedClause(judgement)}, which ` +
    `${getEmbedConfig().binaryName} will not put on the docker run command line; ` +
    'pass the value through Environment instead'
  );
}

/** Why a `Secrets` `ValueFrom` resolving to a value with `judgement` is dropped. */
export function crossStackSecretValueFromReason(judgement: CrossStackJudgement): string {
  if (judgement.verdict === 'secret') {
    return (
      'ValueFrom resolved a cross-stack value holding a secret of the producer stack, ' +
      'rather than naming a Secrets Manager secret or an SSM parameter'
    );
  }
  return `ValueFrom resolved a cross-stack value ${judgedClause(judgement)}`;
}

/** What {@link watchResolved} saw the cross-stack resolver return. */
export interface ResolvedSeen {
  /** A value that is the secret mask. */
  masked: boolean;
  /** The producer-secret verdict on the values read, `secret` over the fail-closed ones. */
  producerSecret: CrossStackJudgement | undefined;
}

/**
 * `context` with its cross-stack resolver noting each value it answers that
 * is the secret mask, or that `secrets` (the resolver's judged variants, when
 * it carries them) says holds a producer stack's secret or could not be
 * checked (go-to-k/cdkd#6339). A producer value recorded as the mask can be
 * joined into a longer string (`--token=***`), which the argv check's
 * whole-value test cannot see (issue #967); so can a producer's secret.
 */
export function watchResolved(
  context: SubstitutionContext,
  secrets: CrossStackSecretCheck | undefined
): { context: SubstitutionContext; seen: ResolvedSeen } {
  const seen: ResolvedSeen = { masked: false, producerSecret: undefined };
  const inner = context.crossStackResolver;
  if (!inner) return { context, seen };
  const watch = (judged: JudgedCrossStackValue): string | undefined => {
    const { value } = judged;
    if (value === undefined) return value;
    if (value === SECRET_MASK) seen.masked = true;
    seen.producerSecret = strongerJudgement(seen.producerSecret, judgementOf(judged));
    return value;
  };
  // The judged variants when the resolver carries them: each call's verdict is
  // its own producer's, never another call's for an equal value.
  const resolver: CrossStackResolver = secrets
    ? {
        resolveImport: async (exportName) => watch(await secrets.resolveImportJudged(exportName)),
        resolveGetStackOutput: async (stack, region, output) =>
          watch(await secrets.resolveGetStackOutputJudged(stack, region, output)),
      }
    : {
        resolveImport: async (exportName) =>
          watch({ value: await inner.resolveImport(exportName) }),
        resolveGetStackOutput: async (stack, region, output) =>
          watch({ value: await inner.resolveGetStackOutput(stack, region, output) }),
      };
  return { context: { ...context, crossStackResolver: resolver }, seen };
}
