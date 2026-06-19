import { createToolError } from '../shared/errors.js'
import type { ExecutorConfig, RoleBudget, ToolResult } from '../shared/types.js'

export interface RoleBudgetState {
	toolCalls: number
	promptTokens: number
	completionTokens: number
	recentToolCalls: Array<{ name: string; argsHash: string }>
	recentCompactionPromptTokens: Array<number>
}

export interface GlobalBudgetState {
	startMs: number
	depth: number
}

export function checkRoleBudgets( state: RoleBudgetState, config: ExecutorConfig, roleConfig?: RoleBudget): ToolResult | null {
	const maxToolCalls = roleConfig?.maxToolCalls ?? config.maxToolCallsPerRole
	if (state.toolCalls > maxToolCalls) {
		return createToolError('tool_budget_exceeded', `Exceeded tool call budget of ${maxToolCalls}`)
	}

	const maxTokens = roleConfig?.maxTokens ?? config.maxTokensPerRole
	const totalTokens = state.promptTokens + state.completionTokens
	if (totalTokens > maxTokens) {
		return createToolError('token_budget_exceeded', `Exceeded token budget of ${maxTokens}`)
	}

	const lastToolCall = state.recentToolCalls[state.recentToolCalls.length - 1]
	if (lastToolCall !== undefined && state.recentToolCalls.length > config.maxRepeatedToolCalls) {
		let duplicates = 0
		for (const call of state.recentToolCalls) {
			if (call.name === lastToolCall.name && call.argsHash === lastToolCall.argsHash) {
				duplicates++
			}
		}
		if (duplicates > config.maxRepeatedToolCalls) {
			return createToolError('loop_detected', `Tool ${lastToolCall.name} called with same args ${duplicates} times`)
		}
	}

	if (state.recentCompactionPromptTokens.length > config.maxCompactionAttempts) {
		const len = state.recentCompactionPromptTokens.length
		const last = state.recentCompactionPromptTokens[len - 1]
		const prev = state.recentCompactionPromptTokens[len - 2]
		if (last !== undefined && prev !== undefined && last >= prev) {
			return createToolError('compaction_failed', 'Context compaction did not reduce tokens')
		}
	}

	return null
}

export function checkGlobalBudgets(state: GlobalBudgetState, config: ExecutorConfig): ToolResult | null {
	const elapsedMs = Date.now() - state.startMs
	if (elapsedMs > config.maxRunTimeSeconds * 1000) {
		return createToolError('timeout', `Exceeded wall-clock budget of ${config.maxRunTimeSeconds}s`)
	}

	if (state.depth > config.maxAgentDepth) {
		return createToolError('tool_budget_exceeded', `Exceeded agent depth of ${config.maxAgentDepth}`)
	}

	return null
}
