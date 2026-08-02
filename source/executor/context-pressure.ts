// The proactive context-pressure mechanism fires while requests still succeed. Every successful LLM call stores the endpoint-reported prompt token count; when it crosses the configured fraction of the effective budget, the engine appends a one-shot notice asking the role to write a handoff brief and finish with a context_handoff card, so a fresh instance continues from the brief instead of the role hitting the wall and the platform pruning its history blindly (the reactive backstop in engine.ts). The proactive path reads reported usage only — the char estimator stays confined to the post-rejection backstop.

// Applied when executor.contextPressureThreshold is unset.
export const DEFAULT_CONTEXT_PRESSURE_THRESHOLD = 0.8

export interface ContextPressureTracker {
	// The minimum endpoint-reported promptTokens across the run's context-window rejections, shared per run so one role's wall-hit tightens every role's threshold. Undefined until the first rejection that reports a count; only ever tightens.
	learnedCeiling?: number
}

// The optional initial ceiling is the resume path: a restarted run re-seeds the tracker from its checkpoint so the tightened threshold learned before the restart still applies.
export function createContextPressureTracker(initialCeiling?: number): ContextPressureTracker {
	return initialCeiling !== undefined ? { learnedCeiling: initialCeiling } : {}
}

// A rejection carrying a reported promptTokens > 0 is ground truth that the effective budget lies below that number; the ceiling moves down to the lowest such report. A rejection without a reported count carries no information and is ignored.
export function recordContextRejection(tracker: ContextPressureTracker, reportedPromptTokens: number): void {
	if (reportedPromptTokens <= 0) return
	if (tracker.learnedCeiling === undefined || reportedPromptTokens < tracker.learnedCeiling) {
		tracker.learnedCeiling = reportedPromptTokens
	}
}

// The share of the context window a prompt may actually occupy: the window minus the reserved completion budget (llama-server rejects when prompt ≥ n_ctx − n_predict), further tightened by the learned ceiling once any role has hit the wall.
export function effectiveContextBudget(contextWindow: number, reservedCompletionTokens: number, learnedCeiling: number | undefined): number {
	const staticBudget = contextWindow - reservedCompletionTokens
	if (learnedCeiling === undefined) return staticBudget
	return Math.min(staticBudget, learnedCeiling)
}
