import { describe, expect, test } from 'bun:test'
import { deriveVersion, stableSerialize, type VersionInput } from './version.ts'

describe('stableSerialize', () => {
	test('serializes primitives and null', () => {
		expect(stableSerialize('x')).toBe('"x"')
		expect(stableSerialize(7)).toBe('7')
		expect(stableSerialize(true)).toBe('true')
		expect(stableSerialize(null)).toBe('null')
	})

	test('sorts object keys so insertion order does not matter', () => {
		const first: VersionInput = { b: 1, a: 2 }
		const second: VersionInput = { a: 2, b: 1 }
		expect(stableSerialize(first)).toBe(stableSerialize(second))
		expect(stableSerialize(first)).toBe('{"a":2,"b":1}')
	})

	test('preserves array order', () => {
		expect(stableSerialize([1, 2, 3])).toBe('[1,2,3]')
		expect(stableSerialize([3, 2, 1])).toBe('[3,2,1]')
	})

	test('recurses into nested objects and arrays', () => {
		const value: VersionInput = { outer: { z: [true, null], a: 'x' } }
		expect(stableSerialize(value)).toBe('{"outer":{"a":"x","z":[true,null]}}')
	})

	test('throws on an undefined value rather than skipping it', () => {
		expect(() => stableSerialize(undefined)).toThrow()
	})

	test('throws on non-finite numbers rather than collapsing them to null', () => {
		expect(() => stableSerialize(Number.NaN)).toThrow()
		expect(() => stableSerialize(Number.POSITIVE_INFINITY)).toThrow()
		expect(() => stableSerialize(Number.NEGATIVE_INFINITY)).toThrow()
		expect(() => stableSerialize({ nested: [Number.NaN] })).toThrow()
	})
})

describe('deriveVersion', () => {
	test('is deterministic for the same input', () => {
		const input: Record<string, VersionInput> = { runId: 'run-1', interruptPending: false }
		expect(deriveVersion(input)).toBe(deriveVersion(input))
	})

	test('is independent of object key insertion order', () => {
		const first: Record<string, VersionInput> = { runId: 'run-1', plan: null, checkpointExists: false }
		const second: Record<string, VersionInput> = { checkpointExists: false, runId: 'run-1', plan: null }
		expect(deriveVersion(first)).toBe(deriveVersion(second))
	})

	test('returns a fixed-size lowercase hex token', () => {
		expect(deriveVersion({ runId: 'run-1' })).toMatch(/^[0-9a-f]{64}$/)
	})

	test('changes when any field of a representative run-view input changes', () => {
		const base: Record<string, VersionInput> = {
			runId: 'run-1',
			snapshotStats: { meta: { size: 10, mtimeMs: 1 }, log: { size: 20, mtimeMs: 2 } },
			plan: '# Plan',
			checkpointExists: false,
			interruptPending: false,
		}
		const baseline = deriveVersion(base)
		const variants: Array<Record<string, VersionInput>> = [
			{ ...base, runId: 'run-2' },
			{ ...base, snapshotStats: { meta: { size: 11, mtimeMs: 1 }, log: { size: 20, mtimeMs: 2 } } },
			{ ...base, snapshotStats: { meta: { size: 10, mtimeMs: 1 }, log: { size: 20, mtimeMs: 3 } } },
			{ ...base, snapshotStats: { meta: null, log: { size: 20, mtimeMs: 2 } } },
			{ ...base, plan: '# Different' },
			{ ...base, plan: null },
			{ ...base, checkpointExists: true },
			{ ...base, interruptPending: true },
		]
		for (const variant of variants) expect(deriveVersion(variant)).not.toBe(baseline)
	})

	test('changes when any field of a representative flow input changes', () => {
		const base: Record<string, VersionInput> = {
			runId: 'run-1',
			operationId: null,
			snapshotStats: { meta: { size: 10, mtimeMs: 1 }, log: { size: 20, mtimeMs: 2 } },
		}
		const baseline = deriveVersion(base)
		const variants: Array<Record<string, VersionInput>> = [
			{ ...base, runId: 'run-2' },
			{ ...base, operationId: 'op-1' },
			{ ...base, snapshotStats: { meta: { size: 11, mtimeMs: 1 }, log: { size: 20, mtimeMs: 2 } } },
			{ ...base, snapshotStats: { meta: { size: 10, mtimeMs: 1 }, log: { size: 20, mtimeMs: 3 } } },
		]
		for (const variant of variants) expect(deriveVersion(variant)).not.toBe(baseline)
		expect(deriveVersion({ ...base, operationId: 'op-1' })).not.toBe(deriveVersion({ ...base, operationId: 'op-2' }))
	})

	test('array order is part of the version', () => {
		expect(deriveVersion({ runs: [1, 2] })).not.toBe(deriveVersion({ runs: [2, 1] }))
	})

	test('nested objects are hashed structurally, not by identity', () => {
		expect(deriveVersion({ a: { b: { c: 1 } } })).toBe(deriveVersion({ a: { b: { c: 1 } } }))
		expect(deriveVersion({ a: { b: { c: 1 } } })).not.toBe(deriveVersion({ a: { b: { c: 2 } } }))
	})
})
