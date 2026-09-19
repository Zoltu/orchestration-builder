import { describe, expect, test } from 'bun:test'

import type { ExecutorConfig } from './types.js'
import { checkGlobalBudgets, checkRoleBudgets } from './budgets.ts'

const config: ExecutorConfig = {
	maxAgentDepth: 8,
	defaultToolTimeoutSeconds: 30,
	maxCompactionAttempts: 5,
}

describe('checkRoleBudgets', () => {
	test('returns null when no compaction has occurred', () => {
		expect(checkRoleBudgets([], config)).toBeNull()
	})

	test('returns null while compaction is reducing tokens', () => {
		expect(checkRoleBudgets([1000, 900, 800, 700], config)).toBeNull()
	})

	test('returns null when the compaction history is shorter than the threshold', () => {
		// A short history never trips the check regardless of whether the last step reduced tokens.
		expect(checkRoleBudgets([1000, 1000, 1000, 1000, 1000], config)).toBeNull()
	})

	test('returns compaction_failed when the last two compactions show no reduction past the threshold', () => {
		const result = checkRoleBudgets([1000, 900, 800, 800, 800, 800], config)
		expect(result?.kind).toBe('compaction_failed')
	})

	test('does not flag when the final compaction reduced tokens even if an earlier pair did not', () => {
		expect(checkRoleBudgets([1000, 900, 900, 900, 900, 800], config)).toBeNull()
	})
})

describe('checkGlobalBudgets', () => {
	test('returns null when depth equals maxAgentDepth', () => {
		expect(checkGlobalBudgets(config.maxAgentDepth, config)).toBeNull()
	})

	test('returns tool_budget_exceeded when depth exceeds maxAgentDepth', () => {
		const result = checkGlobalBudgets(config.maxAgentDepth + 1, config)
		expect(result?.kind).toBe('tool_budget_exceeded')
	})

	test('returns null at depth 0', () => {
		expect(checkGlobalBudgets(0, config)).toBeNull()
	})
})
