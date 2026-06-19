import type { Message } from '../shared/types.js'

export interface TruncatedOutput {
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