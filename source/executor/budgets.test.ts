import { describe, expect, test } from 'bun:test'

import type { ExecutorConfig } from '../shared/types.js'
import { checkGlobalBudgets, checkRoleBudgets, type GlobalBudgetState, type RoleBudgetState } from './budgets.ts'

const config: ExecutorConfig = {
	maxAgentDepth: 8,
	maxToolCallsPerRole: 50,
	maxTokensPerRole: 60000,
	maxRunTimeSeconds: 300,
	defaultToolTimeoutSeconds: 30,
	maxRepeatedToolCalls: 3,
	maxCompactionAttempts: 5,
}

function emptyRoleState(): RoleBudgetState {
	return {
		toolCalls: 0,
		promptTokens: 0,
		completionTokens: 0,
		recentToolCalls: [],
		recentCompactionPromptTokens: [],
	}
}

function globalState(overrides: Partial<GlobalBudgetState> = {}): GlobalBudgetState {
	return { startMs: Date.now() - 1000, depth: 0, ...overrides }
}

describe('checkRoleBudgets', () => {
	test('returns null for an empty state under all limits', () => {
		expect(checkRoleBudgets(emptyRoleState(), config)).toBeNull()
	})

	test('returns null when toolCalls equals maxToolCallsPerRole', () => {
		const state: RoleBudgetState = { ...emptyRoleState(), toolCalls: 50 }
		expect(checkRoleBudgets(state, config)).toBeNull()
	})

	test('returns tool_budget_exceeded when toolCalls exceeds maxToolCallsPerRole', () => {
		const state: RoleBudgetState = { ...emptyRoleState(), toolCalls: 51 }
		const result = checkRoleBudgets(state, config)
		expect(result?.kind).toBe('tool_budget_exceeded')
	})

	test('honors role-level maxToolCalls override', () => {
		const state: RoleBudgetState = { ...emptyRoleState(), toolCalls: 11 }
		const result = checkRoleBudgets(state, config, { maxToolCalls: 10 })
		expect(result?.kind).toBe('tool_budget_exceeded')
	})

	test('returns null when total tokens equal maxTokensPerRole', () => {
		const state: RoleBudgetState = { ...emptyRoleState(), promptTokens: 30000, completionTokens: 30000 }
		expect(checkRoleBudgets(state, config)).toBeNull()
	})

	test('returns token_budget_exceeded when total tokens exceed maxTokensPerRole', () => {
		const state: RoleBudgetState = { ...emptyRoleState(), promptTokens: 50000, completionTokens: 20000 }
		const result = checkRoleBudgets(state, config)
		expect(result?.kind).toBe('token_budget_exceeded')
	})

	test('honors role-level maxTokens override', () => {
		const state: RoleBudgetState = { ...emptyRoleState(), promptTokens: 100, completionTokens: 100 }
		const result = checkRoleBudgets(state, config, { maxTokens: 100 })
		expect(result?.kind).toBe('token_budget_exceeded')
	})

	test('does not flag repeated tool calls when count is at threshold', () => {
		const recent = [
			{ name: 'finish', argsHash: 'h1' },
			{ name: 'finish', argsHash: 'h1' },
			{ name: 'finish', argsHash: 'h1' },
		]
		const state: RoleBudgetState = { ...emptyRoleState(), recentToolCalls: recent }
		expect(checkRoleBudgets(state, config)).toBeNull()
	})

	test('flags loop_detected when same tool+args appear more than maxRepeatedToolCalls times', () => {
		const recent = [
			{ name: 'finish', argsHash: 'h1' },
			{ name: 'finish', argsHash: 'h1' },
			{ name: 'finish', argsHash: 'h1' },
			{ name: 'finish', argsHash: 'h1' },
		]
		const state: RoleBudgetState = { ...emptyRoleState(), recentToolCalls: recent }
		const result = checkRoleBudgets(state, config)
		expect(result?.kind).toBe('loop_detected')
	})

	test('does not flag loop when args hashes differ', () => {
		const recent = [
			{ name: 'finish', argsHash: 'h1' },
			{ name: 'finish', argsHash: 'h2' },
			{ name: 'finish', argsHash: 'h3' },
			{ name: 'finish', argsHash: 'h4' },
		]
		const state: RoleBudgetState = { ...emptyRoleState(), recentToolCalls: recent }
		expect(checkRoleBudgets(state, config)).toBeNull()
	})

	test('does not flag compaction when reductions occur', () => {
		const state: RoleBudgetState = {
			...emptyRoleState(),
			recentCompactionPromptTokens: [1000, 900, 800, 900, 800, 700],
		}
		expect(checkRoleBudgets(state, config)).toBeNull()
	})

	test('flags compaction_failed when last two compactions show no reduction and threshold exceeded', () => {
		const state: RoleBudgetState = {
			...emptyRoleState(),
			recentCompactionPromptTokens: [1000, 900, 800, 800, 800, 800],
		}
		const result = checkRoleBudgets(state, config)
		expect(result?.kind).toBe('compaction_failed')
	})
})

describe('checkGlobalBudgets', () => {
	test('returns null for a fresh state', () => {
		expect(checkGlobalBudgets(globalState(), config)).toBeNull()
	})

	test('returns timeout when wall-clock budget is exceeded', () => {
		const startMs = Date.now() - (config.maxRunTimeSeconds * 1000 + 1000)
		const result = checkGlobalBudgets(globalState({ startMs }), config)
		expect(result?.kind).toBe('timeout')
	})

	test('returns null when depth equals maxAgentDepth', () => {
		const result = checkGlobalBudgets(globalState({ depth: config.maxAgentDepth }), config)
		expect(result).toBeNull()
	})

	test('returns tool_budget_exceeded when depth exceeds maxAgentDepth', () => {
		const result = checkGlobalBudgets(globalState({ depth: config.maxAgentDepth + 1 }), config)
		expect(result?.kind).toBe('tool_budget_exceeded')
	})
})