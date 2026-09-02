import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Policy-free scanning primitives shared by the repo-wide AWS SDK client
 * construction audits (`tests/unit/cli/sts-client-profile-audit.test.ts`,
 * issue #245, and `tests/unit/utils/aws-proxy-client-audit.test.ts`, issue
 * #634). Each audit keeps its own POLICY (which constructions are in its
 * population, what exempts one); these helpers only answer the mechanical
 * questions — what counts as a `new X(...)` construction, what its argument
 * text is, and how to neutralize strings/comments so neither question is
 * fooled by prose. Extracted verbatim from the STS audit so the two audits
 * cannot drift on the parsing layer.
 */

/** Recursively collect every `*.ts` file under `dir` (excluding `.d.ts`). */
export function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const s = statSync(abs);
    if (s.isDirectory()) {
      out.push(...collectTsFiles(abs));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Blank the CONTENT of every string literal and comment, preserving length and
 * newlines, so paren balancing below cannot be thrown off by a bracket inside a
 * string. Without this, `new STSClient({ ua: '(' })` runs the argument scan to
 * EOF and any later `buildStsClientConfig(` in the file exempts it — the same
 * "a nearby mention satisfies the check" failure these audits exist to prevent.
 */
export function blankLiterals(source: string): string {
  const out = source.split('');
  let i = 0;
  const blankUntil = (end: number) => {
    for (let k = i; k < end && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      blankUntil(end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blankUntil(stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let k = i + 1;
      while (k < source.length) {
        if (source[k] === '\\') k += 2;
        else if (source[k] === ch) break;
        else k++;
      }
      i += 1;
      blankUntil(k);
      i = Math.min(k + 1, source.length);
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * The balanced `(...)` argument text starting at `open` (an index of `(`), or
 * `null` when the parens never balance — an unbalanced construction is reported
 * as an offender rather than silently swallowing the rest of the file.
 */
export function argumentText(source: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Walk one `new …(` expression from the `new` keyword and report the class it
 * constructs plus the index of its argument `(`. Parsed rather than
 * regex-matched so every prefix spelling resolves to the same name: a plain
 * `new STSClient(`, a member `new sts.STSClient(`, and the parenthesised
 * `new (await import('@aws-sdk/client-sts')).STSClient(` — the last of which a
 * `(?:[\w$]+\.)*` prefix regex still let through (probed 2026-08-20).
 */
export function constructionAt(
  code: string,
  newIndex: number
): { name: string; argOpen: number } | null {
  let i = newIndex + 'new'.length;
  let name = '';
  const skipSpace = () => {
    while (i < code.length && /\s/.test(code[i]!)) i++;
  };
  const skipBalanced = () => {
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          return true;
        }
      }
    }
    return false;
  };
  skipSpace();
  while (i < code.length) {
    if (code[i] === '(') {
      // An argument list once a name has been read; otherwise a parenthesised
      // constructor expression such as `(await import('...'))`.
      if (name) return { name, argOpen: i };
      if (!skipBalanced()) return null;
      skipSpace();
      continue;
    }
    if (/[\w$]/.test(code[i]!)) {
      let j = i;
      while (j < code.length && /[\w$]/.test(code[j]!)) j++;
      name = code.slice(i, j);
      i = j;
      skipSpace();
      continue;
    }
    if (code[i] === '.') {
      i++;
      name = '';
      skipSpace();
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Whether the contiguous `//` comment block directly above `lineNo`
 * (1-based, scanning up to six lines up) carries `marker` — the audits'
 * explicit, reasoned opt-out shape.
 */
export function hasOptOutMarker(lines: string[], lineNo: number, marker: string): boolean {
  for (let k = lineNo - 2; k >= 0 && k >= lineNo - 7; k--) {
    const prev = (lines[k] ?? '').trim();
    if (prev.length === 0) break;
    if (!prev.startsWith('//')) break;
    if (prev.includes(marker)) return true;
  }
  return false;
}
