import { describe, it, expect } from 'vite-plus/test';
import { defineOwnKey } from '../../../src/utils/own-keys.js';

describe('defineOwnKey (issue #769)', () => {
  it('writes __proto__ as an own, ordinary data property', () => {
    const target: Record<string, string> = {};
    defineOwnKey(target, '__proto__', 'v');
    expect(Object.hasOwn(target, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(target, '__proto__')).toEqual({
      value: 'v',
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(Object.keys(target)).toEqual(['__proto__']);
    expect(JSON.stringify(target)).toBe('{"__proto__":"v"}');
  });

  it('never replaces the prototype when the value is an object', () => {
    const target: Record<string, unknown> = {};
    defineOwnKey(target, '__proto__', { polluted: true });
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect((target as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('overwrites an existing key and keeps insertion order', () => {
    const target: Record<string, string> = { A: '1', B: '2' };
    defineOwnKey(target, 'A', '3');
    expect(target).toEqual({ A: '3', B: '2' });
    expect(Object.keys(target)).toEqual(['A', 'B']);
    delete target['A'];
    expect(Object.hasOwn(target, 'A')).toBe(false);
  });
});
