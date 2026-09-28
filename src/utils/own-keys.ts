/**
 * Write `key` as an OWN, ordinary data property of `target`.
 *
 * Plain assignment (`target[key] = value`) on an object literal routes the
 * key `__proto__` through `Object.prototype`'s `__proto__` accessor: a string
 * value is silently ignored and an object value REPLACES the target's
 * prototype. For maps keyed by user-supplied names (env vars, secrets) that
 * means a variable literally named `__proto__` vanishes without a warning
 * (issue #769). `Object.defineProperty` never consults the accessor, so the
 * key lands as an own property like any other.
 *
 * The descriptor matches what an ordinary assignment creates (writable,
 * enumerable, configurable), so `Object.keys` / `Object.entries` / spread /
 * `JSON.stringify` / `delete` treat the key exactly like its siblings.
 *
 * Readers of such a map must test membership with `Object.hasOwn`, never
 * `in` or a bare `map[key] !== undefined`: both see the inherited
 * `__proto__` accessor on a map that does not carry the key.
 */
export function defineOwnKey<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
