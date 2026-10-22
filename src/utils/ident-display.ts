/**
 * Render an assembly-chosen IDENTIFIER — a logical id, a stack name, a
 * construct path, a container / function name, an image tag — into cdk-local's
 * own prose (go-to-k/cdk-local#761).
 *
 * A port of the host's `displayIdent` / `displayStackName`
 * (`src/utils/display-safe.ts` in go-to-k/cdkd, go-to-k/cdkd#3617 /
 * go-to-k/cdkd#3658), so a message cdkd embeds from cdk-local renders an
 * identifier exactly as cdkd's own messages do. A LEAF module: it imports
 * nothing from cdk-local (only `node:crypto`, for the cut digest).
 *
 * Why an identifier does not share {@link displayUntrustedValue}'s path
 * renderer (`assembly-path.ts`): an identifier has a KNOWN ASCII charset, so a
 * positive printable-ASCII allowlist renders every legitimate value
 * byte-identically and leaves no residual (no invisible formatter, no bidi
 * mark, no lookalike letter), and its legitimate length is CloudFormation's
 * 255-character logical-id cap rather than a path's. The path renderer keeps
 * non-ASCII letters because a real path can carry them; an identifier cannot.
 *
 * The caller writes NO quotes around the result: a plain value prints bare
 * (unchanged from before), and any value that could forge a boundary prints as
 * ONE JSON string literal.
 */

import { createHash } from 'node:crypto';

/**
 * Stand-in for a value with nothing renderable left after sanitization, so two
 * messages cannot disagree about what "unrenderable" looks like.
 */
export const UNRENDERABLE = '<unrenderable>';

/**
 * The DEFAULT longest an identifier can legitimately be: CloudFormation's cap
 * on a logical id, the longest of the identifier shapes rendered by default (a
 * stack name is at most 128, an ECS container name 255, a resource type
 * `64::64::64::MODULE`). A longer value is cut there.
 */
export const IDENT_MAX_CODE_POINTS = 255;

/**
 * The cap for a stack name or a CONSTRUCT PATH, whose legitimate length is not
 * bounded by 255: a construct path nests without a fixed bound, and the host's
 * nested-stack record names grow one `~` segment per level. The same figure as
 * the host's `STACK_REF_MAX_CODE_POINTS`, so a value renders identically on
 * both sides of the embed: a 128-character stack name plus four `~` +
 * 255-character segments.
 */
export const STACK_REF_MAX_CODE_POINTS = 128 + 4 * (1 + IDENT_MAX_CODE_POINTS);

/**
 * How many hex characters of the withheld tail's SHA-256 a cut prints: 128
 * bits, since both values a cut could collapse are planted (no legitimate
 * identifier reaches the cap) and a short prefix falls to a birthday search.
 */
const CUT_DIGEST_HEX_CHARS = 32;

/**
 * The characters a value may carry and still render WITHOUT a boundary: those
 * of a logical id, a resource type, a stack name, a construct path, an image
 * reference or an ARN. No space, bracket or quote, so a value matching it
 * cannot plant a `(type)` / `-- reason` annotation of the surrounding line.
 * `,` stays in (an IAM role name allows it); a value joined into a `', '`
 * list passes `listMember`, which makes a `,` take the boundary too.
 */
const PLAIN_IDENT = /^[A-Za-z0-9:_@./+=,~-]+$/;

/**
 * The raw text a value renders as, before any sanitization. ABSENT means
 * nothing to display (never the word `undefined`), and a value whose
 * `toString` throws falls back rather than taking the whole message with it.
 */
function toDisplayText(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    // eslint-disable-next-line typescript/no-base-to-string -- any value may arrive; `[object Object]` is an acceptable rendering of a non-string.
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return UNRENDERABLE;
    }
  }
}

/**
 * Render an untrusted identifier. Three rules, in this order:
 *
 * 1. Every character outside printable ASCII becomes a space and the result is
 *    trimmed; nothing left renders as {@link UNRENDERABLE}.
 * 2. A value longer than `opts.maxCodePoints` (default
 *    {@link IDENT_MAX_CODE_POINTS}) is CUT there, with
 *    ` [cut: N more characters withheld, tail sha256:<hex>]` appended, bounding
 *    the payload a planted value can put on the line while two cut values
 *    sharing the kept prefix and length still render apart.
 * 3. The value prints BARE only when rule 1 was the identity on it AND what is
 *    left is plain ({@link PLAIN_IDENT}); otherwise it prints as a JSON string
 *    literal, so its boundary is visible and an embedded `"` cannot fake the
 *    closing quote. The identity half is not redundant: rule 1 TRIMS, so a
 *    value padded with a space or a control character would otherwise test as
 *    plain and print byte-identically to the genuine one.
 *
 * The input is stringified ONCE, so a non-deterministic `toString` cannot make
 * the sanitized and raw readings disagree. NOT for a value that is USED rather
 * than shown (a lookup key, a docker argument), and NOT for free-form text.
 */
export function displayIdent(
  value: unknown,
  opts?: { maxCodePoints?: number; listMember?: boolean }
): string {
  const raw = toDisplayText(value);
  if (raw === '') return UNRENDERABLE;
  const clean = raw.replace(/[^ -~]/g, ' ').trim();
  if (!clean) return UNRENDERABLE;
  // Floor the cap at 1; a non-finite one takes the default rather than
  // meaning "no cap".
  const requested = opts?.maxCodePoints ?? IDENT_MAX_CODE_POINTS;
  const cap = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : IDENT_MAX_CODE_POINTS;
  // `clean` is printable ASCII, so `.length` counts characters.
  const truncated = clean.length > cap;
  const text = truncated ? clean.slice(0, cap) : clean;
  const altered = clean !== raw;
  const plain = PLAIN_IDENT.test(text) && !(opts?.listMember === true && text.includes(','));
  const shown = !altered && plain ? text : JSON.stringify(text);
  if (!truncated) return shown;
  const tail = clean.slice(cap);
  const digest = createHash('sha256').update(tail).digest('hex').slice(0, CUT_DIGEST_HEX_CHARS);
  return `${shown} [cut: ${tail.length} more characters withheld, tail sha256:${digest}]`;
}

/**
 * {@link displayIdent} for a STACK NAME or a CONSTRUCT PATH: the same rule with
 * the longer cap their grammar legitimately needs
 * ({@link STACK_REF_MAX_CODE_POINTS}). The caller writes NO quotes.
 */
export function displayStackName(value: unknown): string {
  return displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}

/**
 * Every control character other than `\n` / `\t` (C0, DEL, C1 — `\r` and ESC
 * included), the Unicode line / paragraph separators, and the bidi overrides
 * and isolates.
 */
const OUTPUT_UNSAFE =
  // eslint-disable-next-line no-control-regex -- the control characters are exactly what is escaped.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Render a TOOL'S OWN OUTPUT (docker's stderr) for a message, keeping it
 * multi-line: every character of {@link OUTPUT_UNSAFE} becomes its `\uXXXX`
 * escape, while `\n` and `\t` pass through. A `RUN` step of an assembly-chosen
 * Dockerfile writes into that stream, so without this a `\x1b[2K\r` in it
 * erases and rewrites the line cdk-local printed. Not a boundary: the output
 * is meant to read as the tool's text, which is why it is not quoted.
 */
export function displayToolOutput(text: string): string {
  return text.replace(OUTPUT_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
