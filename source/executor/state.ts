import type { RecentToolCall } from './role-inspection.js'
import type { Message } from './types.js'

export type ProtectedPrefixLength = 2 | 4

export interface RoleState {
	history: Message[]
	lastPromptTokens: number
	recentCompactionPromptTokens: Array<number>
	recentToolCalls: RecentToolCall[]
	toolCallCount: number
	generatedTokens: number
	// Consecutive endpoint rejections for context size, reset on the first successful call. Bounds the compact-and-retry loop so a role whose request cannot be made to fit finishes with an error instead of retrying forever.
	contextExceededAttempts: number
	// The counts at which the last loop check fired; the next check fires when a count passes its watermark plus the (effort-scaled) threshold.
	loopCheckToolCallWatermark: number
	loopCheckTokenWatermark: number
	// The request message count of the role's last logged llm_call: the conversation index the next llm_call's sent list starts from, so each event carries only the messages added since the previous one instead of the whole conversation (the delta protocol in docs/reference.md "Log events"). Undefined when there is no valid baseline — no llm_call logged yet, or a context edit or compaction rewrote the history out from under it — which makes the next emission a full snapshot.
	logSentBaseline?: number
	// The opening messages this role's history must never lose: 2 for the system prompt and current task, 4 when the entry role was seeded with the prior run's operator task and terminal result as reference turns. Carried explicitly because a continuation-shaped history is indistinguishable by roles alone from a seeded child conversation or an ordinary turn sequence. Absent on legacy checkpoints: recovery normalizes to 4 when the restored history has the exact continuation shape and 2 otherwise, erring toward protecting the prior reference turns.
	protectedPrefixLength?: ProtectedPrefixLength
	// Context-pressure handoff state, one-shot per role instance: set to 'pending' when reported usage crosses the threshold, flipped to 'sent' when the notice is appended at the next turn boundary, and never re-armed after that — the notice asks the role to write its handoff brief and finish.
	contextPressureNotice?: 'pending' | 'sent'
	// Set when a context-window rejection must be answered by the context handler: the rejection is detected mid-turn (in handleLlmResult), but a handler can only run at the safe point, so the rejection details park here until the next loop top. Cleared once the handler (or the naive fallback) has run.
	contextCompactionPending?: { promptTokens: number; contextWindow: number }
}
