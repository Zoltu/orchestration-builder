import { describe, expect, test } from 'bun:test'
import { canonicalSerialize, isPlainObject } from '../static/ts/entity-diff/index.js'

describe('canonicalSerialize', () => {
	test('is independent of object key insertion order', () => {
		expect(canonicalSerialize({ b: 1, a: 2 })).toBe(canonicalSerialize({ a: 2, b: 1 }))
		expect(canonicalSerialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
	})

	test('preserves array order', () => {
		expect(canonicalSerialize([1, 2, 3])).toBe('[1,2,3]')
		expect(canonicalSerialize([1, 2, 3])).not.toBe(canonicalSerialize([3, 2, 1]))
	})

	test('serializes nested structures deterministically', () => {
		expect(canonicalSerialize({ outer: { z: [1, { y: true }], a: null } })).toBe('{"outer":{"a":null,"z":[1,{"y":true}]}}')
	})

	test('serializes primitives', () => {
		expect(canonicalSerialize(null)).toBe('null')
		expect(canonicalSerialize('a"b')).toBe('"a\\"b"')
		expect(canonicalSerialize(true)).toBe('true')
		expect(canonicalSerialize(false)).toBe('false')
		expect(canonicalSerialize(42)).toBe('42')
		expect(canonicalSerialize(-0)).toBe('0')
	})

	test('throws on undefined, non-finite numbers, functions, symbols, and bigints', () => {
		expect(() => canonicalSerialize(undefined)).toThrow()
		expect(() => canonicalSerialize(Number.NaN)).toThrow()
		expect(() => canonicalSerialize(Number.POSITIVE_INFINITY)).toThrow()
		expect(() => canonicalSerialize(Number.NEGATIVE_INFINITY)).toThrow()
		expect(() => canonicalSerialize(() => 1)).toThrow()
		expect(() => canonicalSerialize(Symbol('symbol'))).toThrow()
		expect(() => canonicalSerialize(10n)).toThrow()
	})

	test('throws on non-plain objects', () => {
		expect(() => canonicalSerialize(new Date(0))).toThrow()
		expect(() => canonicalSerialize(new Map())).toThrow()
		expect(() => canonicalSerialize(new Set())).toThrow()
		expect(() => canonicalSerialize(new (class Sample { value = 1 })())).toThrow()
	})

	test('round-trips plain data through JSON', () => {
		const value = { list: [1, 'two', false, null], nested: { b: 2, a: 1 } }
		expect(JSON.parse(canonicalSerialize(value))).toEqual(value)
	})

	test('is stable under a JSON encode/decode round trip for every accepted value', () => {
		const accepted: unknown[] = [
			null,
			true,
			false,
			0,
			-0,
			42,
			-1.5,
			'',
			'a"b',
			[],
			[1, 2, 3],
			['a', 'b', 'c'],
			{},
			{ a: 1 },
			{ list: [1, 'two', false, null], nested: { b: 2, a: 1 } },
			{ arr: [{ z: 1, a: [true, null] }, []] },
		]
		for (const value of accepted) {
			const encoded = canonicalSerialize(value)
			expect(canonicalSerialize(JSON.parse(encoded))).toBe(encoded)
		}
	})

	test('distinguishes an empty array from a sparse array', () => {
		expect(canonicalSerialize([])).toBe('[]')
		const sparse: unknown[] = []
		sparse.length = 1
		expect(() => canonicalSerialize(sparse)).toThrow()
	})

	test('throws on a sparse array at the top level and when nested', () => {
		const topLevel: unknown[] = [1]
		topLevel[3] = 4
		expect(() => canonicalSerialize(topLevel)).toThrow()
		const nested: unknown[] = [1]
		nested[2] = 3
		expect(() => canonicalSerialize({ items: nested })).toThrow()
	})

	test('throws on a nested unsupported value', () => {
		expect(() => canonicalSerialize({ a: undefined })).toThrow()
		expect(() => canonicalSerialize({ outer: { inner: Number.NaN } })).toThrow()
	})
})

describe('isPlainObject', () => {
	test('accepts object literals and prototype-less records', () => {
		expect(isPlainObject({})).toBe(true)
		expect(isPlainObject(Object.create(null))).toBe(true)
	})

	test('rejects primitives, null, arrays, and class instances', () => {
		expect(isPlainObject(null)).toBe(false)
		expect(isPlainObject(1)).toBe(false)
		expect(isPlainObject('text')).toBe(false)
		expect(isPlainObject([])).toBe(false)
		expect(isPlainObject(new Date(0))).toBe(false)
		expect(isPlainObject(new (class Sample {})())).toBe(false)
	})
})
