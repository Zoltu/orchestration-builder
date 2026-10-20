import { describe, expect, test } from 'bun:test'
import { generateRunId, isRunIdShape } from './run-id.ts'

describe('isRunIdShape', () => {
	test('accepts the shape generateRunId produces', () => {
		expect(isRunIdShape('run-20260906-193016')).toBe(true)
		expect(isRunIdShape(generateRunId(new Date('2026-09-06T19:30:16Z')))).toBe(true)
	})

	test('rejects malformed, mistyped, and non-string values', () => {
		expect(isRunIdShape('run-20260906-19301')).toBe(false)
		expect(isRunIdShape('run-20260906-1930166')).toBe(false)
		expect(isRunIdShape('run-20260906_193016')).toBe(false)
		expect(isRunIdShape('run-2026-09-06')).toBe(false)
		expect(isRunIdShape('plan-20260906-193016')).toBe(false)
		expect(isRunIdShape('RUN-20260906-193016')).toBe(false)
		expect(isRunIdShape(' run-20260906-193016')).toBe(false)
		expect(isRunIdShape('run-20260906-193016 ')).toBe(false)
		expect(isRunIdShape('')).toBe(false)
		expect(isRunIdShape(20260906)).toBe(false)
		expect(isRunIdShape(undefined)).toBe(false)
	})
})
