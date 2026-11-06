import type { LogEvent } from '../executor/types.js'
import { isObject, safeJsonParse } from '../executor/validation.js'
import { parseLogEventLine } from '../run-log/parse.js'

const THREAD_JOURNAL_FORMAT_VERSION = 1 as const

export interface ThreadJournalLogStat {
	size: number
	mtimeMs: number
}

interface ThreadJournalEntry {
	sourceOffset: number
	event: LogEvent
}

export interface ThreadJournalCursor {
	logSize: number
	logMtimeMs: number
}

export interface ParsedThreadJournal {
	events: LogEvent[]
	lastCursor: ThreadJournalCursor | null
	valid: boolean
	tornTail: boolean
}

export interface ThreadJournalTailState {
	exists: boolean
	endsWithNewline: boolean
}

export type ThreadJournalAppendPlan =
	| { kind: 'none' }
	| { kind: 'append', text: string }
	| { kind: 'rewrite', text: string }

const THREAD_JOURNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
	'ask_human',
	'human_answer',
	'run_resumed',
	'interrupt',
	'interrupt_resolved',
	'plan_modification',
	'inquiry_dropped',
	'operator_notice',
	'provider_failure',
	'run_terminated',
	'run_paused',
])

function isNonNegativeIntegerValue(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isLogEventValue(value: unknown): value is LogEvent {
	if (!isObject(value)) return false
	if (typeof value.timestamp !== 'string') return false
	if (typeof value.type !== 'string') return false
	return true
}

function payloadDepth(payload: unknown): number | null {
	if (!isObject(payload)) return null
	const depth = payload['depth']
	return typeof depth === 'number' ? depth : null
}

function isThreadJournalEvent(event: LogEvent): boolean {
	if (event.type === 'role_start' || event.type === 'role_finished') return payloadDepth(event.payload) === 0
	return THREAD_JOURNAL_EVENT_TYPES.has(event.type)
}

// provider_failure is human-facing, but its payload carries the log-only raw provider body; the journal keeps only the fields the thread renders.
export function threadJournalEventOf(event: LogEvent): LogEvent | null {
	if (event.type === 'provider_failure') {
		const payload = isObject(event.payload) ? event.payload : {}
		const category = typeof payload['category'] === 'string' ? payload['category'] : null
		const message = typeof payload['message'] === 'string' ? payload['message'] : null
		return {
			timestamp: event.timestamp,
			type: event.type,
			payload: {
				...(category !== null ? { category } : {}),
				...(message !== null ? { message } : {}),
			},
		}
	}
	if (!isThreadJournalEvent(event)) return null
	return event
}

function isThreadJournalHeaderLine(value: unknown): boolean {
	if (!isObject(value)) return false
	return value['type'] === 'thread_journal' && value['version'] === THREAD_JOURNAL_FORMAT_VERSION
}

function isThreadJournalEventLineValue(value: unknown): value is { type: 'thread_event', sourceOffset: number, event: unknown } {
	if (!isObject(value)) return false
	if (value['type'] !== 'thread_event') return false
	return isNonNegativeIntegerValue(value['sourceOffset'])
}

function isThreadJournalCursorLineValue(value: unknown): value is { type: 'thread_cursor', logSize: number, logMtimeMs: number } {
	if (!isObject(value)) return false
	if (value['type'] !== 'thread_cursor') return false
	if (!isNonNegativeIntegerValue(value['logSize'])) return false
	return isNonNegativeFiniteNumber(value['logMtimeMs'])
}

function assertLogStat(logStat: ThreadJournalLogStat): void {
	if (!isNonNegativeIntegerValue(logStat.size)) throw new Error(`thread journal: log size must be a non-negative integer, received ${logStat.size}`)
	if (!isNonNegativeFiniteNumber(logStat.mtimeMs)) throw new Error(`thread journal: log mtime must be a non-negative finite number, received ${logStat.mtimeMs}`)
}

export function serializeThreadJournalHeaderLine(): string {
	return `${JSON.stringify({ type: 'thread_journal', version: THREAD_JOURNAL_FORMAT_VERSION })}\n`
}

function serializeThreadJournalEventLine(sourceOffset: number, event: LogEvent): string {
	if (!isNonNegativeIntegerValue(sourceOffset)) throw new Error(`thread journal: sourceOffset must be a non-negative integer, received ${sourceOffset}`)
	return `${JSON.stringify({ type: 'thread_event', sourceOffset, event })}\n`
}

export function serializeThreadJournalCursorLine(logStat: ThreadJournalLogStat): string {
	assertLogStat(logStat)
	return `${JSON.stringify({ type: 'thread_cursor', logSize: logStat.size, logMtimeMs: logStat.mtimeMs })}\n`
}

function serializeThreadJournal(entries: readonly ThreadJournalEntry[], logStat: ThreadJournalLogStat): string {
	const lines: string[] = [serializeThreadJournalHeaderLine()]
	for (const entry of entries) lines.push(serializeThreadJournalEventLine(entry.sourceOffset, entry.event))
	lines.push(serializeThreadJournalCursorLine(logStat))
	return lines.join('')
}

export function parseThreadJournal(text: string): ParsedThreadJournal {
	// Every complete line is newline-terminated; the final split segment is either the empty string after that newline or a torn write, and is always ignored.
	const tornTail = text !== '' && !text.endsWith('\n')
	const completeLines = text.split('\n').slice(0, -1)
	if (completeLines.length === 0) return { events: [], lastCursor: null, valid: false, tornTail }
	const header = safeJsonParse(completeLines[0] ?? '')
	if (!header.ok || !isThreadJournalHeaderLine(header.value)) return { events: [], lastCursor: null, valid: false, tornTail }
	const events: LogEvent[] = []
	const eventOffsets: number[] = []
	let lastCursor: ThreadJournalCursor | null = null
	let previousEventOffset = -1
	let lastLineWasCursor = false
	for (let index = 1; index < completeLines.length; index++) {
		const parsed = safeJsonParse(completeLines[index] ?? '')
		if (!parsed.ok) return { events, lastCursor, valid: false, tornTail }
		const line = parsed.value
		if (isThreadJournalCursorLineValue(line)) {
			if (lastCursor !== null && line.logSize < lastCursor.logSize) return { events, lastCursor, valid: false, tornTail }
			lastCursor = { logSize: line.logSize, logMtimeMs: line.logMtimeMs }
			lastLineWasCursor = true
			continue
		}
		if (isThreadJournalEventLineValue(line) && isLogEventValue(line.event)) {
			const event = threadJournalEventOf(line.event)
			if (event === null) return { events, lastCursor, valid: false, tornTail }
			if (line.sourceOffset < previousEventOffset) return { events, lastCursor, valid: false, tornTail }
			previousEventOffset = line.sourceOffset
			events.push(event)
			eventOffsets.push(line.sourceOffset)
			lastLineWasCursor = false
			continue
		}
		return { events, lastCursor, valid: false, tornTail }
	}
	// A cursor must close every complete journal; an event after the final cursor means the writer was interrupted before marking the event current.
	if (!lastLineWasCursor || lastCursor === null) return { events, lastCursor, valid: false, tornTail }
	if (eventOffsets.some((offset) => offset > lastCursor.logSize)) return { events, lastCursor, valid: false, tornTail }
	return { events, lastCursor, valid: true, tornTail }
}

export function buildThreadJournalFromLog(logText: string, logStat: ThreadJournalLogStat): string {
	const segments = logText.split('\n')
	let trailingCompleteLine: string | null = null
	if (logText.endsWith('\n')) {
		segments.pop()
	} else {
		const trailing = segments.pop() ?? ''
		if (trailing !== '' && parseLogEventLine(trailing) !== null) trailingCompleteLine = trailing
	}
	const entries: ThreadJournalEntry[] = []
	let byteOffset = 0
	for (const line of segments) {
		// The live writer records the log size after appending the event, so an event's source offset is its line's end offset (including the newline).
		byteOffset += Buffer.byteLength(line, 'utf8') + 1
		appendLogEvent(entries, line, byteOffset)
	}
	if (trailingCompleteLine !== null) {
		byteOffset += Buffer.byteLength(trailingCompleteLine, 'utf8')
		appendLogEvent(entries, trailingCompleteLine, byteOffset)
	}
	return serializeThreadJournal(entries, logStat)
}

// A torn tail must never be extended: the journal is rebuilt from the authoritative log (which already contains the just-appended event), so the event appears exactly once.
export function planThreadJournalAppend(tail: ThreadJournalTailState, readLogText: () => string, logStat: ThreadJournalLogStat, event: LogEvent): ThreadJournalAppendPlan {
	const journalEvent = threadJournalEventOf(event)
	if (journalEvent === null) return { kind: 'none' }
	if (tail.exists && !tail.endsWithNewline) return { kind: 'rewrite', text: buildThreadJournalFromLog(readLogText(), logStat) }
	const lines: string[] = tail.exists ? [] : [serializeThreadJournalHeaderLine()]
	lines.push(serializeThreadJournalEventLine(logStat.size, journalEvent))
	lines.push(serializeThreadJournalCursorLine(logStat))
	return { kind: 'append', text: lines.join('') }
}

function appendLogEvent(entries: ThreadJournalEntry[], line: string, endOffset: number): void {
	const event = parseLogEventLine(line)
	if (event === null) return
	const journalEvent = threadJournalEventOf(event)
	if (journalEvent === null) return
	entries.push({ sourceOffset: endOffset, event: journalEvent })
}
