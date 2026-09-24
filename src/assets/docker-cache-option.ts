import type { DockerCacheOption } from '../types/assets.js';

/**
 * Render a `cacheFrom` / `cacheTo` entry as the single `--cache-from` /
 * `--cache-to` value BuildKit parses: `type=<t>,<k>=<v>,...`, unquoted.
 *
 * Its own module because two readers need the SAME string: the argv builder in
 * `docker-build.ts`, and the passthrough warnings, which judge the rendered
 * flag rather than the struct (a `params` value can smuggle a `,src=` that the
 * struct never shows).
 */
export function cacheOptionToFlag(option: DockerCacheOption): string {
  let flag = `type=${option.type}`;
  if (option.params) {
    for (const [k, v] of Object.entries(option.params)) {
      flag += `,${k}=${v}`;
    }
  }
  return flag;
}
