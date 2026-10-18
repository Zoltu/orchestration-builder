import { isObject } from '../guards.js'
import { readEventIndex } from './values.js'
import { readUsage } from './turns.js'
import type { TurnUsage } from './turns.js'

// The outcome a tool result reports, as the transcript renders it: the result kind when the serialization names one, and a one-line summary.
export interface TranscriptOutcome {
	kind: string | null
	summary: string
}

// One of a turn's new messages as the transcript renders it. Assistant messages never render (their content and calls are the previous turn's response section), so a message is a user/system prose message or a tool result with its parsed outcome.
export interface TranscriptMessage {
	role: string
	content: string
	// Tool messages only.
	outcome: TranscriptOutcome | null
	// An assistant message's raw wire-shaped calls, carried so the slice walk can pair them with the tool results that answer them.
	tool_calls?: TranscriptToolCall[]
}

// One tool call of the assistant's response: the call's identity, its raw arguments text, and the outcome of the tool result that answered it — null when no answered result is in the loaded window.
export interface TranscriptToolCall {
	id: string
	name: string
	argumentsText: string
	outcome: TranscriptOutcome | null
}

// The response half of a turn's body: the model's reasoning and content prose plus its parsed tool calls.
export interface TranscriptResponse {
	reasoning: string
	content: string
	toolCalls: TranscriptToolCall[]
}

// One turn's `llm_call` body: the new-message slice and the response (null when the standard logging level dropped the bodies).
interface TranscriptBody {
	sent: TranscriptMessage[]
	received: TranscriptResponse | null
}

// The outcome pairing one turn's slice walk produced: the outcome per answered call id and, per tool-message position, the id of the call it answers.
interface SliceOutcomeWalk {
	byId: Map<string, TranscriptOutcome | null>
	answeredBy: Map<number, string>
}

// One turn of the transcript. `opening` carries the hoisted conversation opening (the first turn's leading system/user messages); `messages` the turn's remaining new messages in order; `received` the response (null for an in-flight turn and for a turn whose bodies the standard logging level dropped).
export interface TranscriptTurn {
	kind: 'completed' | 'in_flight'
	turnNumber: number
	eventIndex: number
	role: string
	roleId: string
	// The full request's message count, for the wire expander's collapsed summary.
	messageCount: number | null
	timestamp: string | null
	usage: TurnUsage | null
	finishReason: string | null
	bodyLevel: 'full' | 'standard' | null
	opening: TranscriptMessage[]
	messages: TranscriptMessage[]
	received: TranscriptResponse | null
}

const SUMMARY_MAX_CHARS = 240

function capSummary(text: string): string {
	if (text.length <= SUMMARY_MAX_CHARS) return text
	return `${text.slice(0, SUMMARY_MAX_CHARS)}\u2026`
}

// Parses a JSON text, or undefined when it is not valid JSON. Tool results and tool-call arguments are serialized JSON, but the conversation-length truncation can cut one mid-string; parse failure is an expected shape, not an exceptional one.
function parseJsonOrUndefined(text: string): unknown {
	if (text === '') return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

// One-line JSON form of a parsed value, falling back to its String form when it is not serializable so the summary never throws.
function compactValue(value: unknown): string {
	try {
		return capSummary(JSON.stringify(value))
	} catch {
		return capSummary(String(value))
	}
}

// The loaded events indexed by log position, so each turn entry can read its own `llm_call` payload in one pass. Non-record payloads index as null and read as body-less.
function payloadIndex(logEvents: unknown[]): Map<number, Record<string, unknown> | null> {
	const byIndex = new Map<number, Record<string, unknown> | null>()
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const index = readEventIndex(event['index'])
		if (index === null) continue
		byIndex.set(index, isObject(event['payload']) ? event['payload'] : null)
	}
	return byIndex
}

// The validated sent slice of an `llm_call` payload: each message as the transcript renders it — role, content, the parsed outcome of tool results, and the raw tool calls assistant messages carry. Null when the payload carries no slice.
function sentSliceOf(payload: Record<string, unknown> | null): TranscriptMessage[] | null {
	if (payload === null) return null
	if (!Array.isArray(payload['sent'])) return null
	const messages: TranscriptMessage[] = []
	for (const raw of payload['sent']) {
		if (!isObject(raw)) continue
		const role = typeof raw['role'] === 'string' && raw['role'] !== '' ? raw['role'] : null
		if (role === null) continue
		const content = typeof raw['content'] === 'string' ? raw['content'] : ''
		const message: TranscriptMessage = { role, content, outcome: null }
		if (role === 'tool') {
			message.outcome = outcomeOfToolContent(content)
		} else if (role === 'assistant' && Array.isArray(raw['tool_calls'])) {
			message.tool_calls = toolCallsOf(raw['tool_calls'])
		}
		messages.push(message)
	}
	return messages
}

// The validated received response of an `llm_call` payload, or null when the payload carries none. Only the fields the transcript renders are kept.
function receivedOf(payload: Record<string, unknown> | null): TranscriptResponse | null {
	if (payload === null) return null
	const received = payload['received']
	if (!isObject(received)) return null
	const rawToolCalls = received['toolCalls']
	return {
		reasoning: typeof received['reasoning'] === 'string' ? received['reasoning'] : '',
		content: typeof received['content'] === 'string' ? received['content'] : '',
		toolCalls: Array.isArray(rawToolCalls) ? toolCallsOf(rawToolCalls) : [],
	}
}

// The validated tool calls of an assistant message (`tool_calls`, the wire shape) or a received response (`toolCalls`, the shaped shape) — both carry `id` and `function.name`/`function.arguments`.
function toolCallsOf(rawCalls: unknown[]): TranscriptToolCall[] {
	const calls: TranscriptToolCall[] = []
	for (const rawCall of rawCalls) {
		if (!isObject(rawCall)) continue
		const fn = rawCall['function']
		if (!isObject(fn)) continue
		calls.push({
			id: typeof rawCall['id'] === 'string' ? rawCall['id'] : '',
			name: typeof fn['name'] === 'string' ? fn['name'] : '',
			argumentsText: typeof fn['arguments'] === 'string' ? fn['arguments'] : '',
			outcome: null,
		})
	}
	return calls
}

// The outcome a tool-result message reports: success results are the bare data JSON, errors the `{ kind, message, details }` envelope. Non-JSON text reads as an unknown kind with the raw text.
function outcomeOfToolContent(content: string): TranscriptOutcome {
	const parsed = parseJsonOrUndefined(content)
	if (parsed === undefined) return { kind: null, summary: capSummary(content) }
	if (isObject(parsed) && typeof parsed['kind'] === 'string' && parsed['kind'] !== 'success' && typeof parsed['message'] === 'string' && parsed['message'] !== '') {
		return { kind: parsed['kind'], summary: capSummary(parsed['message']) }
	}
	if (isObject(parsed) && typeof parsed['summary'] === 'string' && parsed['summary'] !== '') return { kind: 'success', summary: capSummary(parsed['summary']) }
	return { kind: 'success', summary: compactValue(parsed) }
}

// Walks one turn's sent slice pairing each assistant message's tool calls with the tool messages that answer them positionally.
function sliceOutcomeWalk(sent: TranscriptMessage[]): SliceOutcomeWalk {
	const byId = new Map<string, TranscriptOutcome | null>()
	const answeredBy = new Map<number, string>()
	const pending: TranscriptToolCall[] = []
	for (let position = 0; position < sent.length; position++) {
		const message = sent[position]
		if (message === undefined) continue
		if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) pending.push(call)
			continue
		}
		if (message.role !== 'tool') continue
		const call = pending.shift()
		if (call === undefined) continue
		answeredBy.set(position, call.id)
		byId.set(call.id, message.outcome)
	}
	return { byId, answeredBy }
}

// The call ids the previous turn's response rendered inline, or null when there is no previous turn in the document or its response was not rendered.
function renderedCallIds(previousBody: TranscriptBody | null): Set<string> | null {
	if (previousBody === null || previousBody.received === null) return null
	const ids = new Set<string>()
	for (const call of previousBody.received.toolCalls) ids.add(call.id)
	return ids
}

// The conversation opening: the leading run of system/user messages at the head of the scoped instance's first turn's slice. The run stops at the first assistant or tool message.
function leadingOpening(sent: TranscriptMessage[]): TranscriptMessage[] {
	const opening: TranscriptMessage[] = []
	for (const message of sent) {
		if (message.role !== 'system' && message.role !== 'user') break
		opening.push(message)
	}
	return opening
}

// The scoped instance's transcript: its turn entries stitched into one continuous document. Each completed turn's body comes from the `llm_call` payload the loaded events hold at the entry's event index; an in-flight turn carries no body at all.
export function deriveTranscriptTurns(entries: unknown, logEvents: unknown): TranscriptTurn[] {
	if (!Array.isArray(entries)) return []
	const events: unknown[] = Array.isArray(logEvents) ? logEvents : []
	const payloads = payloadIndex(events)
	const bodies: (TranscriptBody | null)[] = []
	const walks: (SliceOutcomeWalk | null)[] = []
	for (const entry of entries) {
		if (!isObject(entry) || entry['levelHint'] !== 'full') {
			bodies.push(null)
			walks.push(null)
			continue
		}
		const eventIndex = readEventIndex(entry['eventIndex'])
		if (eventIndex === null) {
			bodies.push(null)
			walks.push(null)
			continue
		}
		const payload = payloads.get(eventIndex) ?? null
		const sent = sentSliceOf(payload)
		const body = sent !== null ? { sent, received: receivedOf(payload) } : null
		bodies.push(body)
		walks.push(body !== null ? sliceOutcomeWalk(body.sent) : null)
	}
	const turns: TranscriptTurn[] = []
	for (let position = 0; position < entries.length; position++) {
		const entry = entries[position]
		if (!isObject(entry)) continue
		const body = bodies[position] ?? null
		const opening: TranscriptMessage[] = []
		const messages: TranscriptMessage[] = []
		let received: TranscriptResponse | null = null
		if (body !== null) {
			const walk = walks[position] ?? null
			const previousCallIds = renderedCallIds(bodies[position - 1] ?? null)
			let startFrom = 0
			if (position === 0) {
				for (const message of leadingOpening(body.sent)) opening.push(message)
				startFrom = opening.length
			}
			for (let index = startFrom; index < body.sent.length; index++) {
				const message = body.sent[index]
				if (message === undefined) continue
				if (message.role === 'assistant') continue
				if (message.role === 'tool' && previousCallIds !== null && walk !== null) {
					const answered = walk.answeredBy.get(index)
					if (answered !== undefined && previousCallIds.has(answered)) continue
				}
				messages.push(message)
			}
			const nextWalk = position + 1 < walks.length ? walks[position + 1] ?? null : null
			const ownReceived = body.received
			if (ownReceived !== null) {
				received = {
					reasoning: ownReceived.reasoning,
					content: ownReceived.content,
					toolCalls: ownReceived.toolCalls.map((call) => ({ ...call, outcome: nextWalk !== null && nextWalk.byId.has(call.id) ? nextWalk.byId.get(call.id) ?? null : null })),
				}
			}
		}
		const levelHint = entry['levelHint']
		turns.push({
			kind: entry['kind'] === 'in_flight' ? 'in_flight' : 'completed',
			turnNumber: typeof entry['turnNumber'] === 'number' ? entry['turnNumber'] : 0,
			eventIndex: typeof entry['eventIndex'] === 'number' ? entry['eventIndex'] : 0,
			role: typeof entry['role'] === 'string' ? entry['role'] : '',
			roleId: typeof entry['roleId'] === 'string' ? entry['roleId'] : '',
			messageCount: typeof entry['messageCount'] === 'number' && Number.isInteger(entry['messageCount']) && entry['messageCount'] >= 0 ? entry['messageCount'] : null,
			timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null,
			usage: readUsage(entry['usage']),
			finishReason: typeof entry['finishReason'] === 'string' && entry['finishReason'] !== '' ? entry['finishReason'] : null,
			bodyLevel: levelHint === 'full' || levelHint === 'standard' ? levelHint : null,
			opening,
			messages,
			received,
		})
	}
	return turns
}
