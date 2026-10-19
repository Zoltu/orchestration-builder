import type { ProtectedPrefixLength } from '../state.js'
import type { Message } from '../types.js'

interface TruncatedOutput {
	text: string
	truncated: boolean
	removedChars: number
}

export function truncateToolOutput(text: string, maxChars: number): TruncatedOutput {
	if (maxChars <= 0) {
		return { text: '', truncated: text.length > 0, removedChars: text.length }
	}
	if (text.length <= maxChars) {
		return { text, truncated: false, removedChars: 0 }
	}
	const truncated = text.slice(0, maxChars)
	const removed = text.length - maxChars
	const marker = `[truncated: ${removed} chars removed]`
	return { text: `${truncated}\n${marker}`, truncated: true, removedChars: removed }
}

// The opening messages every role keeps by default: the system prompt and the current task. An entry role whose history also carries the prior run's reference turns persists 4 explicitly, so neither compaction nor edit_context has to infer the shape from message roles — a seeded child conversation (always prefix 2, even when its first turns look like a continuation by role) and an ordinary turn sequence stay fully editable.
export const DEFAULT_PROTECTED_PREFIX_LENGTH = 2 as const

// The exact four-message opening a continuation history has, including a non-empty synthesized result whose wire mapping cannot be dropped. Used only to validate a persisted prefix of 4 and to upgrade a checkpoint written before the explicit field existed; it is never used to infer protection during normal operation.
export function hasContinuationPrefixShape(history: Message[]): boolean {
	if (history.length < 4) return false
	if (history[0]?.role !== 'system') return false
	if (history[1]?.role !== 'user') return false
	const priorResult = history[2]
	if (priorResult?.role !== 'assistant') return false
	if (priorResult.content === '') return false
	if (priorResult.tool_calls !== undefined && priorResult.tool_calls.length > 0) return false
	return history[3]?.role === 'user'
}

export function stripReasoning(messages: Message[], startIndex?: number, endIndex?: number): Message[] {
	const start = startIndex ?? 0
	const end = endIndex ?? messages.length
	return messages.map((msg, i) => {
		if (i >= start && i < end && msg.reasoning !== undefined && msg.reasoning !== null) {
			return { ...msg, reasoning: null }
		}
		return msg
	})
}

export interface ContextCompactionOptions {
	contextWindow: number
	// The prompt tokens the endpoint reported for the rejected request, used to calibrate the chars-per-token ratio against this exact conversation. 0 when the endpoint did not report a count, falling back to the default ratio.
	promptTokens: number
	// Fraction of the context window the compacted history should estimate under, leaving headroom for estimator error and the completion reservation.
	targetFraction: number
	// The role state's explicit protected prefix: 2 for the system prompt and current task, 4 when the entry role was seeded with prior-run reference turns.
	protectedPrefixLength: ProtectedPrefixLength
}

export interface ContextCompactionReport {
	history: Message[]
	droppedMessages: number
	truncatedToolMessages: number
	// Messages whose reasoning the last-resort strip pass cleared (0 when the earlier steps already fit). The last assistant message's reasoning is never counted here because it is never stripped.
	strippedReasoningMessages: number
	estimatedPromptTokens: number
	// False when even the undeletable remainder (the protected prefix and the protected most-recent turn) estimates over the target — retrying cannot help.
	fits: boolean
}

const DEFAULT_CHARS_PER_TOKEN = 4
// Tool outputs surviving the drop pass are truncated to this many chars: big enough to keep the most recent turn usable, small enough that a few of them cannot refill the window.
const COMPACTION_KEPT_TOOL_CHARS = 2000

// The estimate counts reasoning chars because reasoning is replayed to the wire every turn (mapHistoryToResponsesInput emits a reasoning item for every assistant message that carries it) — ignoring it would under-count exactly the requests this compaction sizes.
function messageChars(message: Message): number {
	let chars = message.content.length
	if (message.reasoning !== undefined && message.reasoning !== null) chars += message.reasoning.length
	if (message.tool_calls !== undefined) {
		for (const call of message.tool_calls) {
			chars += call.function.name.length + call.function.arguments.length
		}
	}
	return chars
}

function totalChars(messages: Message[]): number {
	let chars = 0
	for (const message of messages) chars += messageChars(message)
	return chars
}

// The protected prefix (the system prompt, the current task, and any continuation reference turns) is never dropped, so blocks cover the prefix onward. An assistant message carrying tool_calls is grouped with the tool-result messages that answer it: dropping must take the whole group or none of it, because an assistant tool_call without its results (or an orphan tool message) is a malformed request on OpenAI-compatible endpoints.
interface HistoryBlock {
	start: number
	end: number
	chars: number
}

function segmentBlocks(messages: Message[], protectedPrefixLength: ProtectedPrefixLength): HistoryBlock[] {
	const blocks: HistoryBlock[] = []
	let index: number = protectedPrefixLength
	while (index < messages.length) {
		const message = messages[index]
		if (message === undefined) break
		let end = index + 1
		if (message.role !== 'tool') {
			while (end < messages.length && messages[end]?.role === 'tool') end++
		}
		let chars = 0
		for (let i = index; i < end; i++) {
			const blockMessage = messages[i]
			if (blockMessage !== undefined) chars += messageChars(blockMessage)
		}
		blocks.push({ start: index, end, chars })
		index = end
	}
	return blocks
}

// The automatic compaction backstop: drop the oldest turns after the explicit protected prefix, truncate oversized surviving tool results, then — only when the estimate still will not fit — strip reasoning from the oldest survivors after the prefix, never from the last assistant message. Reasoning is replayed to the wire every turn (see mapHistoryToResponsesInput), so stripping it rewrites what the model believes it decided; that cost is accepted only after dropping and truncating cannot fit, and shedding reasoning proactively remains the guild's deliberate choice via the edit_context strip_reasoning op.
export function compactHistoryForContextBudget(history: Message[], options: ContextCompactionOptions): ContextCompactionReport {
	const targetTokens = Math.floor(options.contextWindow * options.targetFraction)
	const charsPerToken = options.promptTokens > 0 ? totalChars(history) / options.promptTokens : DEFAULT_CHARS_PER_TOKEN
	const estimateTokens = (chars: number): number => Math.ceil(chars / charsPerToken)

	let droppedMessages = 0
	const prefix = options.protectedPrefixLength
	const blocks = segmentBlocks(history, prefix)
	const charsBeforeDrop = totalChars(history)
	let removedChars = 0
	let dropBoundary: number = prefix
	// The most recent block is never dropped: it is the turn the role is about to continue from.
	for (let blockIndex = 0; blockIndex < blocks.length - 1; blockIndex++) {
		if (estimateTokens(charsBeforeDrop - removedChars) <= targetTokens) break
		const block = blocks[blockIndex]
		if (block === undefined) break
		removedChars += block.chars
		droppedMessages += block.end - block.start
		dropBoundary = block.end
	}
	let compacted = dropBoundary > prefix ? history.slice(0, prefix).concat(history.slice(dropBoundary)) : history

	let truncatedToolMessages = 0
	while (estimateTokens(totalChars(compacted)) > targetTokens) {
		let longestIndex = -1
		let longestChars = 0
		for (let i = 0; i < compacted.length; i++) {
			const candidate = compacted[i]
			if (candidate === undefined || candidate.role !== 'tool') continue
			if (candidate.content.length > longestChars) {
				longestChars = candidate.content.length
				longestIndex = i
			}
		}
		if (longestIndex === -1 || longestChars <= COMPACTION_KEPT_TOOL_CHARS) break
		const longest = compacted[longestIndex]
		if (longest === undefined) break
		const truncated = truncateToolOutput(longest.content, COMPACTION_KEPT_TOOL_CHARS).text
		// The truncation marker can make a barely-over message longer, not shorter; without a progress check this loop would never terminate.
		if (truncated.length >= longest.content.length) break
		compacted = compacted.map((candidate, i) => (i === longestIndex ? { ...longest, content: truncated } : candidate))
		truncatedToolMessages++
	}

	// Last resort, reached only when dropping and truncating leave the estimate over target: strip reasoning oldest-first from the messages after the protected prefix, one message at a time, until the estimate fits or every strippable message is exhausted. The protected prefix keeps its reasoning, and the last assistant message keeps its reasoning — it is the decision the role is about to continue from.
	let strippedReasoningMessages = 0
	let lastAssistantIndex = -1
	for (let i = compacted.length - 1; i >= 0; i--) {
		if (compacted[i]?.role === 'assistant') {
			lastAssistantIndex = i
			break
		}
	}
	let stripIndex = prefix
	while (estimateTokens(totalChars(compacted)) > targetTokens && stripIndex < compacted.length) {
		const candidate = compacted[stripIndex]
		if (stripIndex === lastAssistantIndex || candidate === undefined || candidate.reasoning === undefined || candidate.reasoning === null) {
			stripIndex++
			continue
		}
		compacted = stripReasoning(compacted, stripIndex, stripIndex + 1)
		strippedReasoningMessages++
		stripIndex++
	}

	const estimatedPromptTokens = estimateTokens(totalChars(compacted))
	return {
		history: compacted,
		droppedMessages,
		truncatedToolMessages,
		strippedReasoningMessages,
		estimatedPromptTokens,
		fits: estimatedPromptTokens <= targetTokens,
	}
}
