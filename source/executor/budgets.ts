import { createToolError } from './errors.js'
import type { ExecutorConfig, ToolResult } from './types.js'

export interface RoleBudgetState {
	recentCompactionPromptTokens: Array<number>
}

export interface GlobalBudgetState {
	depth: number
}

// The single per-role guard: terminate a context_manager that is not making progress compacting.
// The context window itself is guarded by the endpoint's context_budget_exceeded path; run termination is the deployment container's job.
export function checkRoleBudgets(state: RoleBudgetState, config: ExecutorConfig): ToolResult | null {
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

// The single global guard: unbounded agent recursion.
// A fixed wall-clock timeout is deliberately omitted: it is hardware-dependent (it fires on healthy slow-hardware runs or never fires on fast hardware); the container's own kill/timeout is the outer run-termination boundary.
export function checkGlobalBudgets(state: GlobalBudgetState, config: ExecutorConfig): ToolResult | null {
	if (state.depth > config.maxAgentDepth) {
		return createToolError('tool_budget_exceeded', `Exceeded agent depth of ${config.maxAgentDepth}`)
	}

	return null
}
