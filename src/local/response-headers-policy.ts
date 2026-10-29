/**
 * The non-CORS half of a CloudFront `AWS::CloudFront::ResponseHeadersPolicy`:
 * `SecurityHeadersConfig`, `CustomHeadersConfig` and `RemoveHeadersConfig`.
 * (The `CorsConfig` half lives in cors-handler, shared with `start-api`.)
 *
 * `start-cloudfront` resolves one per cache behavior and applies it to every
 * response it sends to the viewer, as CloudFront does at the edge:
 *
 * - `RemoveHeadersConfig` runs first, so a header the policy both removes and
 *   adds is still sent (with the policy's value).
 * - Each security / custom header carries `Override`: `true` replaces the
 *   origin's header, `false` adds the header only when the origin did not
 *   send one.
 *
 * `ServerTimingHeadersConfig` is not reproduced: its metrics describe the
 * CloudFront edge and cache layers, which do not exist locally.
 */

import type { CloudFormationTemplate } from '../types/resource.js';
import { pickRhpRefLogicalId } from './cors-handler.js';

/** One header the policy sets on the viewer response. */
export interface PolicyHeader {
  name: string;
  value: string;
  /** `true` replaces an origin header of the same name; `false` keeps it. */
  override: boolean;
}

/** The resolved non-CORS headers of a response headers policy. */
export interface ResponseHeadersPolicyHeaders {
  /** Header names removed from the response before {@link set} is applied. */
  remove: string[];
  set: PolicyHeader[];
}

/** Minimal response surface the policy writes to (Node's `ServerResponse` satisfies it). */
export interface HeaderWritable {
  hasHeader(name: string): boolean;
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): void;
}

/**
 * Resolve a cache behavior's `ResponseHeadersPolicyId` to the policy's
 * security, custom and remove headers. Returns undefined unless the value is a
 * `{ Ref: <logicalId> }` to a local `AWS::CloudFront::ResponseHeadersPolicy`
 * that declares at least one of them (an AWS-managed-policy id literal cannot
 * be read locally).
 */
export function resolveResponseHeadersPolicyHeaders(
  template: CloudFormationTemplate,
  responseHeadersPolicyId: unknown
): ResponseHeadersPolicyHeaders | undefined {
  const rhpId = pickRhpRefLogicalId(responseHeadersPolicyId);
  if (!rhpId) return undefined;
  const rhpResource = (template.Resources ?? {})[rhpId];
  if (!rhpResource || rhpResource.Type !== 'AWS::CloudFront::ResponseHeadersPolicy') {
    return undefined;
  }
  const rhpConfig = asRecord((rhpResource.Properties ?? {})['ResponseHeadersPolicyConfig']);
  if (!rhpConfig) return undefined;

  const set = [
    ...parseSecurityHeaders(asRecord(rhpConfig['SecurityHeadersConfig'])),
    ...parseCustomHeaders(asRecord(rhpConfig['CustomHeadersConfig'])),
  ];
  const remove = parseRemoveHeaders(asRecord(rhpConfig['RemoveHeadersConfig']));
  if (set.length === 0 && remove.length === 0) return undefined;
  return { remove, set };
}

/**
 * Apply the policy to a response whose headers are already set: remove the
 * policy's remove-list, then set each header, honoring its `Override`. A
 * header Node refuses (an invalid name or value) is skipped and reported
 * through `onInvalid`, so one bad entry does not drop the rest.
 */
export function applyResponseHeadersPolicyHeaders(
  res: HeaderWritable,
  policy: ResponseHeadersPolicyHeaders,
  onInvalid?: (name: string, err: unknown) => void
): void {
  for (const name of policy.remove) res.removeHeader(name);
  for (const header of policy.set) {
    if (!header.override && res.hasHeader(header.name)) continue;
    try {
      res.setHeader(header.name, header.value);
    } catch (err) {
      onInvalid?.(header.name, err);
    }
  }
}

function parseSecurityHeaders(config: Record<string, unknown> | undefined): PolicyHeader[] {
  if (!config) return [];
  const out: PolicyHeader[] = [];

  const hsts = asRecord(config['StrictTransportSecurity']);
  const maxAge = hsts ? toNumber(hsts['AccessControlMaxAgeSec']) : undefined;
  if (hsts && maxAge !== undefined) {
    let value = `max-age=${maxAge}`;
    if (toBool(hsts['IncludeSubdomains'])) value += '; includeSubDomains';
    if (toBool(hsts['Preload'])) value += '; preload';
    out.push({ name: 'strict-transport-security', value, override: toBool(hsts['Override']) });
  }

  const csp = asRecord(config['ContentSecurityPolicy']);
  if (csp && typeof csp['ContentSecurityPolicy'] === 'string') {
    out.push({
      name: 'content-security-policy',
      value: csp['ContentSecurityPolicy'],
      override: toBool(csp['Override']),
    });
  }

  const cto = asRecord(config['ContentTypeOptions']);
  if (cto) {
    out.push({
      name: 'x-content-type-options',
      value: 'nosniff',
      override: toBool(cto['Override']),
    });
  }

  const frame = asRecord(config['FrameOptions']);
  if (frame && typeof frame['FrameOption'] === 'string') {
    out.push({
      name: 'x-frame-options',
      value: frame['FrameOption'],
      override: toBool(frame['Override']),
    });
  }

  const referrer = asRecord(config['ReferrerPolicy']);
  if (referrer && typeof referrer['ReferrerPolicy'] === 'string') {
    out.push({
      name: 'referrer-policy',
      value: referrer['ReferrerPolicy'],
      override: toBool(referrer['Override']),
    });
  }

  const xss = asRecord(config['XSSProtection']);
  if (xss && xss['Protection'] !== undefined) {
    let value = toBool(xss['Protection']) ? '1' : '0';
    if (value === '1') {
      if (toBool(xss['ModeBlock'])) value += '; mode=block';
      else if (typeof xss['ReportUri'] === 'string' && xss['ReportUri'] !== '') {
        value += `; report=${xss['ReportUri']}`;
      }
    }
    out.push({ name: 'x-xss-protection', value, override: toBool(xss['Override']) });
  }

  return out;
}

function parseCustomHeaders(config: Record<string, unknown> | undefined): PolicyHeader[] {
  const items = config?.['Items'];
  if (!Array.isArray(items)) return [];
  const out: PolicyHeader[] = [];
  for (const item of items) {
    const h = asRecord(item);
    if (!h || typeof h['Header'] !== 'string' || h['Header'] === '') continue;
    out.push({
      name: h['Header'].toLowerCase(),
      value: typeof h['Value'] === 'string' ? h['Value'] : '',
      override: toBool(h['Override']),
    });
  }
  return out;
}

function parseRemoveHeaders(config: Record<string, unknown> | undefined): string[] {
  const items = config?.['Items'];
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    const h = asRecord(item);
    if (h && typeof h['Header'] === 'string' && h['Header'] !== '') {
      out.push(h['Header'].toLowerCase());
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** CloudFormation booleans may arrive as `true` or `"true"`. */
function toBool(value: unknown): boolean {
  return value === true || value === 'true';
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
