import { describe, expect, test } from 'bun:test'
import { generateRunId, isRunIdShape } from '../run-id.ts'
import { boundPlanContent, isPlanContent, MAX_PLAN_CHARS } from './plan.ts'

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

describe('boundPlanContent', () => {
	test('content at the cap passes through untouched', () => {
		const content = 'a'.repeat(MAX_PLAN_CHARS)
		expect(boundPlanContent(content, MAX_PLAN_CHARS)).toEqual({ content, truncated: false, totalChars: MAX_PLAN_CHARS })
	})

	test('content one char over the cap is truncated with the marker and the total size', () => {
		const content = `${'a'.repeat(MAX_PLAN_CHARS)}b`
		const bounded = boundPlanContent(content, MAX_PLAN_CHARS)
		expect(bounded.truncated).toBe(true)
		expect(bounded.totalChars).toBe(MAX_PLAN_CHARS + 1)
		expect(bounded.content).toContain('a'.repeat(MAX_PLAN_CHARS))
		expect(bounded.content.endsWith('[truncated: 1 chars removed]')).toBe(true)
	})

	test('short content passes through with the full size reported', () => {
		expect(boundPlanContent('# Plan', MAX_PLAN_CHARS)).toEqual({ content: '# Plan', truncated: false, totalChars: 6 })
	})
})

describe('isPlanContent', () => {
	test('accepts non-empty strings and rejects empty or non-string arguments', () => {
		expect(isPlanContent('# Plan')).toBe(true)
		expect(isPlanContent('')).toBe(false)
		expect(isPlanContent(undefined)).toBe(false)
		expect(isPlanContent(42)).toBe(false)
	})
})
