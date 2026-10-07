import type { LogEvent } from './types.js'

// The two wire names for how much payload detail a run's log.jsonl carries (see docs/reference.md "Logging level"). `full` writes every body; `standard` drops exactly two kinds of heavy body while every event type, count, and order stays unchanged. The strings are the contract on every wire (API bodies, settings.json, meta.json, checkpoints) and carry verbatim like the effort tiers do.
export type LogLevel = 'full' | 'standard'

// The run-level default applied when neither a per-run choice, the project setting, nor the deployment file fixes the level.
export const DEFAULT_LOG_LEVEL: LogLevel = 'full'

export function isLogLevel(value: unknown): value is LogLevel {
	return value === 'full' || value === 'standard'
}

// A local record check rather than the shared isObject: validation.ts's guards call isLogLevel from here, so importing the shared guard back would form a runtime module cycle. The filter is defensive anyway — a payload that is not a record passes through untouched.
function isRecordPayload(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LLM_CALL_KEPT_FIELDS: readonly string[] = ['role', 'roleId', 'messageCount', 'usage', 'finishReason']
const LLM_RETRY_KEPT_FIELDS: readonly string[] = ['role', 'roleId', 'discardedAttempts', 'usage']
// The summarizer's usage event is written by the service wiring outside the run's filter chokepoint, but it is listed here so its token fields are declared kept should it ever flow through the filter; its payload carries nothing else.
const SUMMARIZER_LLM_CALL_KEPT_FIELDS: readonly string[] = ['usage']
const TOOL_RESULT_KEPT_FIELDS: readonly string[] = ['role', 'tool', 'kind']

const KEPT_FIELDS_BY_EVENT_TYPE: Partial<Record<string, readonly string[]>> = {
	llm_call: LLM_CALL_KEPT_FIELDS,
	llm_retry: LLM_RETRY_KEPT_FIELDS,
	summarizer_llm_call: SUMMARIZER_LLM_CALL_KEPT_FIELDS,
	tool_result: TOOL_RESULT_KEPT_FIELDS,
}

// Copies only the listed top-level payload fields (present ones), leaving everything else behind.
function keepPayloadFields(payload: unknown, keptKeys: readonly string[]): Record<string, unknown> | null {
	if (!isRecordPayload(payload)) return null
	const kept: Record<string, unknown> = {}
	for (const key of keptKeys) {
		const value = payload[key]
		if (value !== undefined) kept[key] = value
	}
	return kept
}

// Returns the event unchanged for `full` (the same reference, so a `full` run's log is byte-identical to an unwrapped writer) and the slimmed clone for `standard`: on an `llm_call` the sent conversation and received response bodies are dropped (the identity and usage fields the flow view and budget derivations read are kept), on an `llm_retry` and a `summarizer_llm_call` the token-relevant fields are kept (those payloads carry nothing else), and on a `tool_result` the full un-truncated result body is dropped. Every other event type — and any event whose payload is not a record — passes through untouched, so event counts and order never change. The input event is never mutated.
export function applyLogLevel(event: LogEvent, level: LogLevel): LogEvent {
	if (level === 'full') return event
	const keptKeys = KEPT_FIELDS_BY_EVENT_TYPE[event.type]
	if (keptKeys === undefined) return event
	const payload = keepPayloadFields(event.payload, keptKeys)
	if (payload === null) return event
	return { ...event, payload }
}
