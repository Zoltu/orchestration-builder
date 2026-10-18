import type { LogEvent, RunMeta } from '../../executor/types.js'
import { usageOf } from '../payload.js'

export interface TokenUsage {
	promptTokens: number
	cachedPromptTokens: number
	completionTokens: number
	totalTokens: number
}

export interface Budgets {
	// The settled span from meta.startTime to meta.endTime, or null while the run is still in progress (no stored end). A live figure is the client's to compute from startTime and its own clock, so this payload stays a pure function of stored data.
	elapsedSeconds: number | null
	toolCalls: number
	tokensUsed: number | null
	tokenBreakdown: TokenUsage | null
}

export function deriveBudgets(logEvents: LogEvent[], meta: RunMeta | null): Budgets {
	// The settled span is the only elapsed a pure function of stored data can report; a run without an endTime is still in progress, and its live elapsed is the client's to compute from startTime and its own clock. The log's first event is deliberately not a fallback for a missing startTime: meta.startTime is the run's declared start, and a log-derived start would drift from it.
	let elapsedSeconds: number | null = null
	if (meta !== null && meta.endTime !== undefined) {
		const startMs = Date.parse(meta.startTime)
		const endMs = Date.parse(meta.endTime)
		if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) elapsedSeconds = Math.max(0, Math.round((endMs - startMs) / 1000))
	}

	let toolCalls = 0
	let sawUsage = false
	let promptSum = 0
	let cachedSum = 0
	let completionSum = 0
	let totalSum = 0
	for (const event of logEvents) {
		if (event.type === 'tool_call') toolCalls++
		// llm_retry and summarizer_llm_call carry the same usage shape as llm_call and are real spend: the retry's discarded attempts were billed before the successful attempt replaced them, and the summarizer is a service-level call against the run's model (docs/reference.md "Log events"). A payload without a usable usage object contributes nothing.
		if (event.type !== 'llm_call' && event.type !== 'llm_retry' && event.type !== 'summarizer_llm_call') continue
		const usage = usageOf(event.payload)
		if (usage !== null) {
			sawUsage = true
			promptSum += usage.promptTokens
			cachedSum += usage.cachedPromptTokens
			completionSum += usage.completionTokens
			totalSum += usage.totalTokens
		}
	}

	return {
		elapsedSeconds,
		toolCalls,
		tokensUsed: sawUsage ? totalSum : null,
		tokenBreakdown: sawUsage ? { promptTokens: promptSum, cachedPromptTokens: cachedSum, completionTokens: completionSum, totalTokens: totalSum } : null,
	}
}
