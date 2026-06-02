/**
 * Per-target run-option descriptors for `cdkl studio` (issue #301 slice 2).
 *
 * Each runnable target kind exposes a small set of per-run options the UI
 * renders as controls (in the composer) and the server turns into child
 * CLI args. This descriptor table is the SINGLE source of truth: the
 * embedded UI reads it (serialized into the page) to render the right
 * control per option, and {@link buildPerRunArgs} reads the same table to
 * build + validate the argv fragment appended to the spawned child. Adding
 * an option = one entry here; the UI and the arg builder both pick it up.
 *
 * These are PER-TARGET / PER-RUN options (vary per invoke / serve), as
 * opposed to the session-global flags (`--from-cfn-stack` / `--assume-role`)
 * which live on `cdkl studio` itself (see `studio-child-args.ts`).
 *
 * Values flow from the browser as `Record<flag, value>` keyed by the
 * option's `flag`. studio spawns children WITHOUT a shell (argv array), so
 * each value is a discrete argv element — there is no shell-injection
 * surface; the child command still does its own deep validation.
 */

import type { StudioTargetKind } from './studio-events.js';

/** A boolean flag — rendered as a checkbox; emits the bare flag when true. */
export interface BooleanOptionSpec {
  flag: string;
  kind: 'boolean';
  label: string;
  help?: string;
}

/** A single-value flag — rendered as an input; emits `flag <value>`. */
export interface ScalarOptionSpec {
  flag: string;
  kind: 'scalar';
  label: string;
  placeholder?: string;
  /** `'number'` renders a numeric input; defaults to text. */
  inputType?: 'text' | 'number';
  /**
   * Only show / emit this option when the named boolean flag is on. The gate
   * boolean MUST appear earlier in the same kind's array — the UI renders
   * specs in order and wires the gate from the already-rendered checkbox.
   */
  showWhen?: string;
  help?: string;
}

/**
 * A repeatable `left<sep>right` flag (e.g. `--host-port 80=8080`) — rendered
 * as an add-row list of paired inputs; emits one `flag left<sep>right` per
 * non-empty row.
 */
export interface RepeatPairOptionSpec {
  flag: string;
  kind: 'repeat-pair';
  label: string;
  sep: string;
  leftPlaceholder: string;
  rightPlaceholder: string;
  help?: string;
}

/**
 * A key/value env-var editor (rendered like an add-row pair list). Unlike
 * `repeat-pair`, this does NOT emit a repeated flag — `--env-vars` takes a
 * FILE path, so the rows are materialized server-side into a SAM-shape JSON
 * temp file passed as `--env-vars <tempfile>` (see {@link resolveEnvVars}).
 */
export interface EnvKvOptionSpec {
  flag: string;
  kind: 'env-kv';
  label: string;
  /** Display-only separator between key and value (e.g. `=`). */
  sep: string;
  leftPlaceholder: string;
  rightPlaceholder: string;
  help?: string;
}

export type OptionSpec =
  | BooleanOptionSpec
  | ScalarOptionSpec
  | RepeatPairOptionSpec
  | EnvKvOptionSpec;

/** A `repeat-pair` row value as the UI posts it. */
export interface PairValue {
  left: string;
  right: string;
}

/** Per-run option values keyed by option `flag`, as the UI posts them. */
export type OptionValues = Record<string, boolean | string | PairValue[]>;

/**
 * The per-kind option table. Kinds absent here (or with an empty list) have
 * no per-run options — the UI shows just the primary control (the event
 * composer for `lambda`, a bare Start for a serve).
 */
export const OPTION_SPECS: Partial<Record<StudioTargetKind, OptionSpec[]>> = {
  lambda: [
    {
      flag: '--env-vars',
      kind: 'env-kv',
      label: 'Env vars',
      sep: '=',
      leftPlaceholder: 'KEY',
      rightPlaceholder: 'value',
      help: 'Overlay container env vars — add KEY=VALUE rows or paste a JSON object.',
    },
  ],
  alb: [
    { flag: '--tls', kind: 'boolean', label: 'TLS (terminate HTTPS locally)' },
    {
      flag: '--tls-cert',
      kind: 'scalar',
      label: 'TLS cert',
      placeholder: './cert.pem',
      showWhen: '--tls',
    },
    {
      flag: '--tls-key',
      kind: 'scalar',
      label: 'TLS key',
      placeholder: './key.pem',
      showWhen: '--tls',
    },
    {
      flag: '--lb-port',
      kind: 'repeat-pair',
      label: 'Listener port remap',
      sep: '=',
      leftPlaceholder: 'listenerPort',
      rightPlaceholder: 'hostPort',
    },
    {
      flag: '--bearer-token',
      kind: 'scalar',
      label: 'Bearer token',
      placeholder: 'eyJ...',
      help: 'Default JWT injected for authenticate-cognito / authenticate-oidc actions.',
    },
    { flag: '--no-verify-auth', kind: 'boolean', label: 'Disable auth guard' },
  ],
  ecs: [
    {
      flag: '--max-tasks',
      kind: 'scalar',
      label: 'Max replicas',
      placeholder: '1',
      inputType: 'number',
    },
    {
      flag: '--host-port',
      kind: 'repeat-pair',
      label: 'Container port publish',
      sep: '=',
      leftPlaceholder: 'containerPort',
      rightPlaceholder: 'hostPort',
    },
  ],
};

/** True when `value` is a non-empty trimmed string. */
function nonEmptyStr(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Build the per-run argv fragment for a target `kind` from the UI-posted
 * option `values`, validating each value against {@link OPTION_SPECS}.
 *
 * Throws on an unknown flag (a value keyed to an option the kind does not
 * declare) or a type mismatch (e.g. a string where a boolean is expected) so
 * a malformed UI / curl body fails loudly rather than spawning a child with
 * a bogus arg. A `scalar` with `showWhen` is dropped unless its gate boolean
 * is on. Empty / blank values are omitted.
 */
export function buildPerRunArgs(
  kind: StudioTargetKind,
  values: OptionValues | undefined
): string[] {
  if (values === undefined) return [];
  const specs = OPTION_SPECS[kind] ?? [];
  const byFlag = new Map(specs.map((s) => [s.flag, s]));

  for (const flag of Object.keys(values)) {
    if (!byFlag.has(flag)) {
      throw new Error(`Unknown option '${flag}' for target kind '${kind}'.`);
    }
  }

  const args: string[] = [];
  for (const spec of specs) {
    const value = values[spec.flag];
    if (value === undefined) continue;

    if (spec.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`Option '${spec.flag}' must be a boolean.`);
      }
      if (value) args.push(spec.flag);
      continue;
    }

    if (spec.kind === 'scalar') {
      if (value !== '' && typeof value !== 'string') {
        throw new Error(`Option '${spec.flag}' must be a string.`);
      }
      // A showWhen-gated scalar is only emitted when its gate boolean is on.
      if (spec.showWhen && values[spec.showWhen] !== true) continue;
      if (nonEmptyStr(value)) args.push(spec.flag, value.trim());
      continue;
    }

    if (spec.kind === 'env-kv') {
      // env-kv emits NO direct arg — `--env-vars` takes a file, so the value
      // is materialized into a temp file by the caller (see resolveEnvVars).
      // Validate only that the value is a KV-row array or a JSON string.
      if (!Array.isArray(value) && typeof value !== 'string') {
        throw new Error(`Option '${spec.flag}' must be KEY/VALUE rows or a JSON string.`);
      }
      continue;
    }

    // repeat-pair
    if (!Array.isArray(value)) {
      throw new Error(`Option '${spec.flag}' must be an array of { left, right } rows.`);
    }
    for (const row of value) {
      if (typeof row !== 'object' || row === null) {
        throw new Error(`Option '${spec.flag}' rows must be objects.`);
      }
      const { left, right } = row as PairValue;
      // Skip blank rows; require BOTH sides when a row is partially filled.
      if (!nonEmptyStr(left) && !nonEmptyStr(right)) continue;
      if (!nonEmptyStr(left) || !nonEmptyStr(right)) {
        throw new Error(
          `Option '${spec.flag}' rows need both sides (got '${left}${spec.sep}${right}').`
        );
      }
      args.push(spec.flag, `${left.trim()}${spec.sep}${right.trim()}`);
    }
  }
  return args;
}

/**
 * Materialize the `env-kv` option for a target `kind` into the SAM-shape
 * object `--env-vars` expects (one level of nesting). The caller writes the
 * returned object to a temp JSON file and passes `--env-vars <file>` to the
 * child. Returns `undefined` when there is no env-kv option / no values.
 *
 * Two input forms (both produced by the UI's KV / JSON toggle):
 * - **KV rows** (`PairValue[]`) -> a flat `{KEY: value}` map wrapped as
 *   `{ Parameters: {...} }` (the SAM global scope — applies to the target).
 * - **JSON string** -> parsed; a full SAM-shape object (a `Parameters` key or
 *   any nested-object value) is used as-is, while a flat `{KEY: "value"}`
 *   object is wrapped in `{ Parameters: {...} }`.
 *
 * Throws on malformed JSON / a non-object so a bad value fails as a clean
 * boundary error rather than writing garbage to the temp file.
 */
export function resolveEnvVars(
  kind: StudioTargetKind,
  values: OptionValues | undefined
): Record<string, unknown> | undefined {
  if (values === undefined) return undefined;
  const spec = (OPTION_SPECS[kind] ?? []).find((s) => s.kind === 'env-kv');
  if (!spec) return undefined;
  const value = values[spec.flag];
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    const flat: Record<string, string> = {};
    for (const row of value) {
      const { left, right } = (row ?? {}) as PairValue;
      if (nonEmptyStr(left)) flat[left.trim()] = typeof right === 'string' ? right : '';
    }
    return Object.keys(flat).length > 0 ? { Parameters: flat } : undefined;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Env vars JSON is not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Env vars JSON must be a JSON object.');
    }
    const obj = parsed as Record<string, unknown>;
    // A full SAM-shape object (a `Parameters` key, or any nested-object value
    // keyed by logical id) is used verbatim; a flat string map is wrapped.
    // This relies on env VALUES being strings — an object value can only be a
    // per-logical-id env map (a flat map with an object value is malformed for
    // `--env-vars` either way), so "has an object value" reliably means SAM.
    const isSamShape =
      'Parameters' in obj || Object.values(obj).some((v) => typeof v === 'object' && v !== null);
    return isSamShape ? obj : { Parameters: obj };
  }

  throw new Error(`Option '${spec.flag}' must be KEY/VALUE rows or a JSON object string.`);
}
