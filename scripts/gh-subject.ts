/**
 * The SUBJECT a CI convention check runs against: the text a GitHub event
 * carries, already decoded.
 *
 * ## Why this type exists at all
 *
 * `scripts/check-gh-body-english.ts` is its only consumer today. The type is
 * separate anyway because the SHAPE is the workflow's contract with the
 * checker, and a second convention check over the same surface should extend
 * this rather than invent its own document.
 *
 * ## Where the text comes from, and why not from the event payload
 *
 * The payload is available, but `.github/workflows/pr-inherit-issue-labels.yml`
 * established the pattern this follows: PR- and issue-controlled text is
 * fetched SERVER-SIDE with `gh ... --json` and handed to the checker as a file,
 * never interpolated into a shell command with `${{ github.event... }}`. A body
 * containing `"; rm -rf ...` is then just bytes in a JSON document. The
 * workflow builds this shape with `gh` + `jq`; the checker only ever
 * `JSON.parse`s it.
 *
 * ## CRLF
 *
 * GitHub returns issue and PR bodies with `\r\n` line endings. The hooks never
 * saw that -- their input was a local file or a heredoc, both LF -- and a
 * ported check can be LINE-anchored (the `Severity:` scan is line-wise because
 * `grep` is). Normalising here rather than in each check keeps them from
 * drifting on it.
 */

/** Which GitHub object the text came from. Decides which fields are scanned. */
export type SubjectKind = 'issue' | 'issue_comment' | 'pull_request';

export interface Subject {
  kind: SubjectKind;
  /** Issue or PR number. Used only for reporting and for the comment target. */
  number: number;
  /** Absent on `issue_comment` -- a comment has no title. */
  title?: string;
  body: string;
  /** Current label names. No check reads them today; the workflow supplies
   * them because the document is the contract, not the current consumer. */
  labels: string[];
  /** Optional html_url, for the report line only. */
  url?: string;
}

/** GitHub sends `body: null` for an empty body; `?? ''` is not cosmetic. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
}

/**
 * Parse the subject document the workflow builds.
 *
 * Deliberately TOTAL: every field has a defined fallback, because a missing
 * field must not make a check crash and thereby report nothing. "The check
 * silently found nothing" is the failure mode these ports exist to avoid, so an
 * unparseable document throws (loud) while a well-formed document with a null
 * body yields an empty string, which is checked and is clean.
 */
export function parseSubject(json: string): Subject {
  const raw: unknown = JSON.parse(json);
  if (raw === null || typeof raw !== 'object') {
    throw new Error('subject document is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'issue' && kind !== 'issue_comment' && kind !== 'pull_request') {
    throw new Error(`subject.kind must be issue | issue_comment | pull_request, got ${String(kind)}`);
  }
  const labels = Array.isArray(o.labels)
    ? o.labels.filter((l): l is string => typeof l === 'string')
    : [];
  const subject: Subject = {
    kind,
    number: typeof o.number === 'number' ? o.number : 0,
    body: text(o.body),
    labels,
  };
  // A comment has no title, and a check must not invent one: giving it a title
  // field it would then have to remember not to scan is how that rule gets
  // lost.
  if (kind !== 'issue_comment' && typeof o.title === 'string') {
    subject.title = text(o.title);
  }
  if (typeof o.url === 'string') subject.url = o.url;
  return subject;
}
