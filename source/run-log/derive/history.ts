import type { LogEvent } from '../../executor/types.js'
import { isObject } from '../../executor/validation.js'
import { stringField } from '../payload.js'

export interface QuestionHistoryEntry {
	id: string | null
	question: string
	context?: string
	askedAt: string
	answer?: string
	answeredAt?: string
}

export function deriveQuestionHistory(logEvents: LogEvent[]): QuestionHistoryEntry[] {
	const entries: QuestionHistoryEntry[] = []
	const indexById = new Map<string, number>()

	for (const event of logEvents) {
		const payload = event.payload
		if (!isObject(payload)) continue

		if (event.type === 'ask_human') {
			const question = stringField(payload, 'question')
			if (question === null) continue
			const id = stringField(payload, 'id')
			const context = stringField(payload, 'context')
			const entry: QuestionHistoryEntry = {
				id,
				question,
				askedAt: event.timestamp,
				...(context !== null ? { context } : {}),
			}
			const index = entries.length
			entries.push(entry)
			if (id !== null && !indexById.has(id)) indexById.set(id, index)
		} else if (event.type === 'human_answer') {
			const id = stringField(payload, 'id')
			if (id === null) continue
			const answer = stringField(payload, 'answer')
			if (answer === null) continue
			const index = indexById.get(id)
			if (index === undefined) continue
			const entry = entries[index]
			if (entry === undefined) continue
			entry.answer = answer
			entry.answeredAt = event.timestamp
		}
	}
	return entries
}

interface InterruptInquiryEntry {
	kind: 'inquiry'
	askedAt: string
	role: string | null
	message: string
	answer: string | null
	answeredAt: string | null
	// Set when the handler's resolution was not a clean answer (a failure or an empty summary), so the UI stops offering "waiting".
	ended: boolean
}

interface InterruptPlanModEntry {
	kind: 'plan_modification'
	askedAt: string
	message: string
	target: string | null
	targetRole: string | null
	aborted: string[]
}

export type InterruptHistoryEntry = InterruptInquiryEntry | InterruptPlanModEntry

// Pairs each operator inquiry with the handler's resolution: an inquiry-triggered interrupt opens an entry against the handler role, and the matching interrupt_resolved closes it — an 'answered' action with a non-empty summary sets the answer, anything else (a failure or an empty summary) marks the entry ended so the UI stops offering "waiting". Inquiries resolve strictly in arrival order (the executor handles them sequentially, never concurrently), so a single FIFO queue pairs each resolution with the oldest unanswered entry; a resolution with none waiting is skipped. Plan modifications have no reply to pair — their delivery and abort outcome are on the event itself.
export function deriveInterruptHistory(logEvents: LogEvent[]): InterruptHistoryEntry[] {
	const entries: InterruptHistoryEntry[] = []
	const unanswered: InterruptInquiryEntry[] = []

	for (const event of logEvents) {
		const payload = event.payload
		if (!isObject(payload)) continue

		if (event.type === 'interrupt' && stringField(payload, 'trigger') === 'inquiry') {
			const message = stringField(payload, 'message')
			if (message === null) continue
			const entry: InterruptInquiryEntry = { kind: 'inquiry', askedAt: event.timestamp, role: stringField(payload, 'handler'), message, answer: null, answeredAt: null, ended: false }
			entries.push(entry)
			unanswered.push(entry)
			continue
		}
		if (event.type === 'interrupt_resolved' && stringField(payload, 'trigger') === 'inquiry') {
			const entry = unanswered.shift()
			if (entry === undefined) continue
			const summary = stringField(payload, 'summary')
			if (stringField(payload, 'action') === 'answered' && summary !== null && summary !== '') {
				entry.answer = summary
				entry.answeredAt = event.timestamp
			} else {
				entry.ended = true
			}
			continue
		}
		if (event.type === 'plan_modification') {
			const message = stringField(payload, 'message')
			if (message === null) continue
			const abortedRaw = payload['aborted']
			const aborted = Array.isArray(abortedRaw) ? abortedRaw.filter((item): item is string => typeof item === 'string') : []
			entries.push({ kind: 'plan_modification', askedAt: event.timestamp, message, target: stringField(payload, 'target'), targetRole: stringField(payload, 'targetRole'), aborted })
			continue
		}
	}
	return entries
}
