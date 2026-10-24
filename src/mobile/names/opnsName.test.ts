import { describe, expect, test } from 'bun:test';
import { isOpnsType, opnsNameFrom, OPNS_NAME_MAX } from './opnsName';

describe('name NFTs', () => {
  test('type match ignores case and parameters', () => {
    expect(isOpnsType('application/op-ns')).toBe(true);
    expect(isOpnsType('Application/OP-NS; charset=utf-8')).toBe(true);
    expect(isOpnsType('text/plain')).toBe(false);
    expect(isOpnsType(undefined)).toBe(false);
  });
  test('extracts the name', () => {
    expect(opnsNameFrom('hello')).toBe('hello');
    expect(opnsNameFrom('  Hello-1\n')).toBe('hello-1');
  });
  test('rejects invalid content', () => {
    expect(opnsNameFrom('')).toBeNull();
    expect(opnsNameFrom(null)).toBeNull();
    expect(opnsNameFrom('<script>alert(1)</script>')).toBeNull();
    expect(opnsNameFrom('two words')).toBeNull();
    expect(opnsNameFrom('héllo')).toBeNull();
    expect(opnsNameFrom('a'.repeat(OPNS_NAME_MAX + 1))).toBeNull();
    expect(opnsNameFrom('a'.repeat(OPNS_NAME_MAX))).toBe('a'.repeat(OPNS_NAME_MAX));
  });
});
