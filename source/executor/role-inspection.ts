import type { Message } from './types.js'

// The pure logic behind the agent-activity inspection tools: bounded, windowed, searchable access to a target role's history. Nothing here ever returns a full message's content or reasoning — a handler (e.g. the loop detector) investigates incrementally: index to see the shape, search to find candidates, window-read to confirm. This keeps a 256k-token conversation out of the handler's own context window.

export interface RoleMessageIndexEntry {
	index: number
	role: Message['role']
	contentChars: number
	reasoningChars: number
	toolCallCount: number
}

export function indexRoleMessages(history: Message[]): RoleMessageIndexEntry[] {
	const out: RoleMessageIndexEntry[] = []
	for (let i = 0; i < history.length; i++) {
		const message = history[i]
		if (message === undefined) continue
		out.push({
			index: i,
			role: message.role,
			contentChars: message.content.length,
			reasoningChars: message.reasoning === null || message.reasoning === undefined ? 0 : message.reasoning.length,
			toolCallCount: message.tool_calls?.length ?? 0,
		})
	}
	return out
}

// The hard bound on a single window read: end - start never exceeds this, regardless of the requested range.
export const MAX_WINDOW_CHARS = 8192

export type InspectionField = 'content' | 'reasoning'

export interface MessageWindow {
	index: number
	field: InspectionField
	start: number
	end: number
	totalChars: number
	text: string
}

export type MessageWindowResult = { ok: true; window: MessageWindow } | { ok: false; error: string }

function fieldText(message: Message, field: InspectionField): string {
	if (field === 'reasoning') return message.reasoning ?? ''
	return message.content
}

export function readMessageWindow(history: Message[], index: number, field: InspectionField, start: number, end: number): MessageWindowResult {
	const message = history[index]
	if (message === undefined) return { ok: false, error: `index ${index} is out of range (${history.length} messages)` }
	const text = fieldText(message, field)
	if (start < 0 || start > text.length) return { ok: false, error: `start ${start} is out of range (${text.length} chars)` }
	const clampedEnd = Math.min(end, text.length)
	if (clampedEnd < start) return { ok: false, error: `end ${end} precedes start ${start}` }
	const boundedEnd = Math.min(clampedEnd, start + MAX_WINDOW_CHARS)
	return {
		ok: true,
		window: {
			index,
			field,
			start,
			end: boundedEnd,
			totalChars: text.length,
			text: text.slice(start, boundedEnd),
		},
	}
}

// Chars of surrounding context on each side of a search match.
export const SEARCH_WINDOW_RADIUS = 128

// The hard bound on matches a single search returns, so a pathological pattern cannot blow up the handler's context.
export const MAX_SEARCH_MATCHES = 25

export interface RoleBlockMatch {
	messageIndex: number
	role: Message['role']
	field: InspectionField
	offset: number
	window: string
}

export type SearchRoleBlocksResult = { ok: true; matches: RoleBlockMatch[] } | { ok: false; error: string }

function matchWindow(text: string, offset: number, matchLength: number): string {
	const start = Math.max(0, offset - SEARCH_WINDOW_RADIUS)
	const end = Math.min(text.length, offset + matchLength + SEARCH_WINDOW_RADIUS)
	return text.slice(start, end)
}

export interface SearchRoleBlocksOptions {
	field?: InspectionField
	pattern: string
	kind: 'substring' | 'regex'
	maxMatches: number
}

export function searchRoleBlocks(history: Message[], options: SearchRoleBlocksOptions): SearchRoleBlocksResult {
	const cap = Math.min(options.maxMatches, MAX_SEARCH_MATCHES)
	let regex: RegExp | null = null
	if (options.kind === 'regex') {
		try {
			regex = new RegExp(options.pattern, 'g')
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : 'invalid regex' }
		}
	}
	const matches: RoleBlockMatch[] = []
	const fields: InspectionField[] = options.field === undefined ? ['content', 'reasoning'] : [options.field]
	for (let index = 0; index < history.length; index++) {
		const message = history[index]
		if (message === undefined) continue
		for (const field of fields) {
			const text = fieldText(message, field)
			if (text === '') continue
			if (regex !== null) {
				regex.lastIndex = 0
				let match = regex.exec(text)
				while (match !== null && matches.length < cap) {
					matches.push({ messageIndex: index, role: message.role, field, offset: match.index, window: matchWindow(text, match.index, match[0].length) })
					// A zero-width match leaves lastIndex unmoved; advance it or the loop never ends.
					if (regex.lastIndex === match.index) regex.lastIndex = match.index + 1
					match = regex.exec(text)
				}
			} else {
				let offset = text.indexOf(options.pattern)
				while (offset !== -1 && matches.length < cap) {
					matches.push({ messageIndex: index, role: message.role, field, offset, window: matchWindow(text, offset, options.pattern.length) })
					offset = text.indexOf(options.pattern, offset + options.pattern.length)
				}
			}
			if (matches.length >= cap) return { ok: true, matches }
		}
	}
	return { ok: true, matches }
}

// A compact identity for a tool call's arguments, so an inspector can tell consecutive identical calls apart from productive repetition (same tool, different args) without seeing the raw arguments.
export function hashArguments(text: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

export interface RecentToolCall {
	tool: string
	argsHash: string
	resultKind: string
}

// The bounded trace of recent tool calls kept per role instance for the recent_role_tool_calls inspection tool. Fifty entries covers any loop pattern a handler needs to see without growing unboundedly over a long run.
export const RECENT_TOOL_CALLS_LIMIT = 50
