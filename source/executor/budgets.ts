import { createToolError } from './errors.js'
import type { ExecutorConfig, ToolResult } from './types.js'

export interface RoleBudgetState {
	recentCompactionPromptTokens: Array<number>
}

export interface GlobalBudgetState {
	depth: number
}

// The single per-role guard: terminate a context_manager that is not making progress compacting.
// Tool-call counts, token totals, and consecutive-duplicate loop detection were removed: the first two were cumulative sums that fired on healthy long-horizon work long before the context window filled, and the third was a blunt pre-filter that could not distinguish productive repetition from a stuck loop.
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
// Wall-clock was removed because a fixed timeout is hardware-dependent (it fires on healthy slow-hardware runs or never fires on fast hardware); the container's own kill/timeout is the outer run-termination boundary.
export function checkGlobalBudgets(state: GlobalBudgetState, config: ExecutorConfig): ToolResult | null {
	if (state.depth > config.maxAgentDepth) {
		return createToolError('tool_budget_exceeded', `Exceeded agent depth of ${config.maxAgentDepth}`)
	}

	return null
}
