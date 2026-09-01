/**
 * Ambient declaration for `proxy-from-env` 2.x, which ships no bundled
 * types (`package.json` has no `types` field and the tarball carries no
 * `.d.ts`). Only the surface cdk-local uses is declared.
 */
declare module 'proxy-from-env' {
  /**
   * The proxy URL the standard proxy environment
   * (`<proto>_proxy` / `ALL_PROXY`, lowercase winning, with `NO_PROXY`
   * exemptions) selects for `url`, or the empty string when the request
   * should go direct.
   */
  export function getProxyForUrl(url: string | URL): string;
}
