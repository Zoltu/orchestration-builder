import { describe, expect, test } from 'bun:test'
import type { LogEvent } from '../executor/types.js'
import {
	buildThreadJournalFromLog,
	parseThreadJournal,
	planThreadJournalAppend,
	serializeThreadJournalCursorLine,
	serializeThreadJournalHeaderLine,
	threadJournalEventOf,
} from './journal.js'
import type { ThreadJournalLogStat } from './journal.js'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:01:00.000Z'
const T2 = '2026-01-01T00:02:00.000Z'

function stat(size: number, mtimeMs = 1_000): ThreadJournalLogStat {
	return { size, mtimeMs }
}

function event(type: string, payload: unknown, timestamp = T0): LogEvent {
	return { timestamp, type, payload }
}

function roleStart(depth: number, timestamp = T0): LogEvent {
	return event('role_start', { role: 'main', roleId: 'main-0-1', depth, task: 'task' }, timestamp)
}

function roleFinished(depth: number, timestamp = T1): LogEvent {
	return event('role_finished', { role: 'main', roleId: 'main-0-1', depth, status: 'success', summary: 'done' }, timestamp)
}

function logLine(logEvent: LogEvent): string {
	return JSON.stringify(logEvent)
}

function eventLine(sourceOffset: number, logEvent: LogEvent): string {
	return `${JSON.stringify({ type: 'thread_event', sourceOffset, event: logEvent })}\n`
}

function journalText(entries: readonly { sourceOffset: number, event: LogEvent }[], logStat: ThreadJournalLogStat): string {
	const lines = [serializeThreadJournalHeaderLine()]
	for (const entry of entries) lines.push(eventLine(entry.sourceOffset, entry.event))
	lines.push(serializeThreadJournalCursorLine(logStat))
	return lines.join('')
}

describe('threadJournalEventOf', () => {
	test('includes every human-facing event type and the root role lifecycle', () => {
		for (const type of ['ask_human', 'human_answer', 'run_resumed', 'interrupt', 'interrupt_resolved', 'plan_modification', 'inquiry_dropped', 'operator_notice', 'provider_failure', 'run_terminated', 'run_paused']) {
			expect(threadJournalEventOf(event(type, {}))?.type).toBe(type)
		}
		expect(threadJournalEventOf(roleStart(0))?.type).toBe('role_start')
		expect(threadJournalEventOf(roleFinished(0))?.type).toBe('role_finished')
	})

	test('excludes child role lifecycle and every non-human-facing event', () => {
		expect(threadJournalEventOf(roleStart(1))).toBeNull()
		expect(threadJournalEventOf(roleFinished(2))).toBeNull()
		expect(threadJournalEventOf(event('role_start', {}))).toBeNull()
		for (const type of ['llm_call', 'llm_retry', 'tool_call', 'tool_result', 'contract', 'effort_set', 'involvement_set', 'summarizer_llm_call']) {
			expect(threadJournalEventOf(event(type, {}))).toBeNull()
		}
	})

	test('sanitizes provider_failure to only its human-facing fields', () => {
		const providerFailure = event('provider_failure', { category: 'transient', message: 'provider down', detail: 'SECRET PROVIDER BODY', httpStatus: 503 }, T1)
		const sanitized = threadJournalEventOf(providerFailure)
		expect(sanitized?.payload).toEqual({ category: 'transient', message: 'provider down' })
		const text = journalText([{ sourceOffset: logLine(providerFailure).length + 1, event: sanitized ?? providerFailure }], stat(200))
		expect(text).not.toContain('SECRET PROVIDER BODY')
		expect(text).not.toContain('httpStatus')
	})
})

describe('parseThreadJournal', () => {
	const entries = [
		{ sourceOffset: 10, event: event('ask_human', { id: 'q1', question: 'why?' }, T0) },
		{ sourceOffset: 20, event: event('human_answer', { id: 'q1', answer: 'because' }, T1) },
	]
	const expectedEvents = entries.map((entry) => entry.event)

	test('parses the header, events, and last cursor', () => {
		const parsed = parseThreadJournal(journalText(entries, stat(30, 123)))
		expect(parsed.valid).toBe(true)
		expect(parsed.tornTail).toBe(false)
		expect(parsed.events).toEqual(expectedEvents)
		expect(parsed.lastCursor).toEqual({ logSize: 30, logMtimeMs: 123 })
	})

	test('ignores a torn final line and signals the torn tail', () => {
		const text = journalText(entries, stat(30)) + '{"type":"thread_event","sourceOffset":99'
		const parsed = parseThreadJournal(text)
		expect(parsed.valid).toBe(true)
		expect(parsed.tornTail).toBe(true)
		expect(parsed.events).toEqual(expectedEvents)
		expect(parsed.lastCursor?.logSize).toBe(30)
	})

	test('marks a malformed non-final line invalid and keeps the events before it', () => {
		const text = `${serializeThreadJournalHeaderLine()}not-json\n${eventLine(10, entries[0]?.event ?? event('ask_human', {}))}${serializeThreadJournalCursorLine(stat(20))}`
		const parsed = parseThreadJournal(text)
		expect(parsed.valid).toBe(false)
		expect(parsed.events).toEqual([])
	})

	test('rejects a missing or foreign header', () => {
		expect(parseThreadJournal('').valid).toBe(false)
		expect(parseThreadJournal('not-json\n').valid).toBe(false)
		expect(parseThreadJournal('{"type":"thread_journal","version":2}\n').valid).toBe(false)
	})

	test('rejects a journal whose final complete line is not a cursor', () => {
		const text = `${serializeThreadJournalHeaderLine()}${serializeThreadJournalCursorLine(stat(10))}${eventLine(10, expectedEvents[0] ?? event('ask_human', {}))}`
		expect(parseThreadJournal(text).valid).toBe(false)
	})

	test('rejects non-thread event types', () => {
		const text = `${serializeThreadJournalHeaderLine()}${eventLine(10, event('llm_call', { sent: [] }))}${serializeThreadJournalCursorLine(stat(10))}`
		expect(parseThreadJournal(text).valid).toBe(false)
	})

	test('rejects non-monotonic event offsets and offsets beyond the final cursor', () => {
		const nonMonotonic = `${serializeThreadJournalHeaderLine()}${eventLine(20, expectedEvents[0] ?? event('ask_human', {}))}${eventLine(10, expectedEvents[1] ?? event('human_answer', {}))}${serializeThreadJournalCursorLine(stat(30))}`
		expect(parseThreadJournal(nonMonotonic).valid).toBe(false)
		const beyondCursor = `${serializeThreadJournalHeaderLine()}${eventLine(50, expectedEvents[0] ?? event('ask_human', {}))}${serializeThreadJournalCursorLine(stat(20))}`
		expect(parseThreadJournal(beyondCursor).valid).toBe(false)
	})

	test('rejects non-monotonic cursor sizes', () => {
		const text = `${serializeThreadJournalHeaderLine()}${serializeThreadJournalCursorLine(stat(20))}${serializeThreadJournalCursorLine(stat(10))}`
		expect(parseThreadJournal(text).valid).toBe(false)
	})

	test('re-sanitizes a provider_failure event found in a journal file', () => {
		const providerFailure = event('provider_failure', { category: 'transient', message: 'provider down', detail: 'SECRET PROVIDER BODY' }, T1)
		const text = `${serializeThreadJournalHeaderLine()}${eventLine(10, providerFailure)}${serializeThreadJournalCursorLine(stat(10))}`
		const parsed = parseThreadJournal(text)
		expect(parsed.valid).toBe(true)
		expect(JSON.stringify(parsed.events)).not.toContain('SECRET PROVIDER BODY')
	})
})

describe('buildThreadJournalFromLog', () => {
	test('keeps human-facing events in log order with end offsets and the full log cursor', () => {
		const included = [
			roleStart(0, T0),
			event('ask_human', { id: 'q1', question: 'why?' }, T1),
			event('human_answer', { id: 'q1', answer: 'because' }, T2),
			roleFinished(0, T2),
		]
		const logEvents = [
			roleStart(0, T0),
			roleStart(1, T0),
			event('ask_human', { id: 'q1', question: 'why?' }, T1),
			event('llm_call', { role: 'child', sent: [] }, T1),
			event('human_answer', { id: 'q1', answer: 'because' }, T2),
			roleFinished(0, T2),
		]
		const logText = `${logEvents.map(logLine).join('\n')}\n`
		const logStat = stat(Buffer.byteLength(logText, 'utf8'), 42)
		const expectedEntries = []
		let offset = 0
		for (const logEvent of logEvents) {
			offset += Buffer.byteLength(logLine(logEvent), 'utf8') + 1
			const journalEvent = threadJournalEventOf(logEvent)
			if (journalEvent !== null) expectedEntries.push({ sourceOffset: offset, event: journalEvent })
		}
		const built = buildThreadJournalFromLog(logText, logStat)
		expect(built).toBe(journalText(expectedEntries, logStat))
		const parsed = parseThreadJournal(built)
		expect(parsed.valid).toBe(true)
		expect(parsed.events).toEqual(included)
		expect(parsed.lastCursor).toEqual({ logSize: logStat.size, logMtimeMs: logStat.mtimeMs })
		expect(buildThreadJournalFromLog(logText, logStat)).toBe(built)
	})

	test('computes source offsets in UTF-8 bytes', () => {
		const first = event('ask_human', { id: 'q1', question: 'café' }, T0)
		const second = event('human_answer', { id: 'q1', answer: 'naïve' }, T1)
		const logText = `${logLine(first)}\n${logLine(second)}\n`
		const built = buildThreadJournalFromLog(logText, stat(Buffer.byteLength(logText, 'utf8')))
		const firstEnd = Buffer.byteLength(logLine(first), 'utf8') + 1
		const secondEnd = firstEnd + Buffer.byteLength(logLine(second), 'utf8') + 1
		expect(built).toContain(`"sourceOffset":${firstEnd}`)
		expect(built).toContain(`"sourceOffset":${secondEnd}`)
	})

	test('includes a complete trailing log line without a newline', () => {
		const complete = event('ask_human', { id: 'q1', question: 'why?' }, T0)
		const trailing = event('human_answer', { id: 'q1', answer: 'because' }, T1)
		const logText = `${logLine(complete)}\n${logLine(trailing)}`
		const logStat = stat(Buffer.byteLength(logText, 'utf8'))
		const built = buildThreadJournalFromLog(logText, logStat)
		const parsed = parseThreadJournal(built)
		expect(parsed.valid).toBe(true)
		expect(parsed.events).toEqual([complete, trailing])
		expect(parsed.lastCursor).toEqual({ logSize: logStat.size, logMtimeMs: logStat.mtimeMs })
		expect(parseThreadJournal(buildThreadJournalFromLog(logText, logStat)).valid).toBe(true)
	})

	test('ignores a trailing partial log line and returns header plus cursor for an empty log', () => {
		const complete = event('ask_human', { id: 'q1', question: 'why?' }, T0)
		const torn = `${logLine(complete)}\n${JSON.stringify(event('human_answer', { id: 'q1', answer: 'bec' }, T1)).slice(0, 20)}`
		const parsed = parseThreadJournal(buildThreadJournalFromLog(torn, stat(Buffer.byteLength(torn, 'utf8'))))
		expect(parsed.valid).toBe(true)
		expect(parsed.events).toEqual([complete])
		const empty = buildThreadJournalFromLog('', stat(0))
		expect(empty).toBe(`${serializeThreadJournalHeaderLine()}${serializeThreadJournalCursorLine(stat(0))}`)
		expect(parseThreadJournal(empty).valid).toBe(true)
	})

	test('strips provider detail while rebuilding from the log', () => {
		const providerFailure = event('provider_failure', { category: 'transient', message: 'provider down', detail: 'SECRET PROVIDER BODY' }, T1)
		const logText = `${logLine(roleStart(0))}\n${logLine(providerFailure)}\n`
		const built = buildThreadJournalFromLog(logText, stat(Buffer.byteLength(logText, 'utf8')))
		expect(built).not.toContain('SECRET PROVIDER BODY')
		expect(built).toContain('"category":"transient"')
		expect(built).toContain('"message":"provider down"')
	})
})

describe('planThreadJournalAppend', () => {
	const ask = event('ask_human', { id: 'q1', question: 'why?' }, T0)
	const answer = event('human_answer', { id: 'q1', answer: 'because' }, T1)
	const terminated = event('run_terminated', { reason: 'operator', message: 'terminated' }, T2)

	test('appends normally to a journal ending in a newline', () => {
		const askEnd = Buffer.byteLength(logLine(ask), 'utf8') + 1
		const existing = journalText([{ sourceOffset: askEnd, event: ask }], stat(askEnd))
		const logText = `${logLine(ask)}\n${logLine(answer)}\n`
		const logStat = stat(Buffer.byteLength(logText, 'utf8'))
		const plan = planThreadJournalAppend({ exists: true, endsWithNewline: true }, () => logText, logStat, answer)
		expect(plan.kind).toBe('append')
		if (plan.kind !== 'append') throw new Error('expected an append plan')
		const parsed = parseThreadJournal(existing + plan.text)
		expect(parsed.valid).toBe(true)
		expect(parsed.tornTail).toBe(false)
		expect(parsed.events).toEqual([ask, answer])
	})

	test('creates the header when the journal is missing', () => {
		const logText = `${logLine(ask)}\n${logLine(answer)}\n`
		const logStat = stat(Buffer.byteLength(logText, 'utf8'))
		const plan = planThreadJournalAppend({ exists: false, endsWithNewline: false }, () => logText, logStat, answer)
		expect(plan.kind).toBe('append')
		if (plan.kind !== 'append') throw new Error('expected an append plan')
		const parsed = parseThreadJournal(plan.text)
		expect(parsed.valid).toBe(true)
		expect(parsed.events).toEqual([answer])
	})

	test('rewrites instead of appending after a torn cursor', () => {
		const logText = `${logLine(ask)}\n${logLine(answer)}\n`
		const logStat = stat(Buffer.byteLength(logText, 'utf8'))
		const plan = planThreadJournalAppend({ exists: true, endsWithNewline: false }, () => logText, logStat, answer)
		expect(plan.kind).toBe('rewrite')
		if (plan.kind !== 'rewrite') throw new Error('expected a rewrite plan')
		const parsed = parseThreadJournal(plan.text)
		expect(parsed.valid).toBe(true)
		expect(parsed.tornTail).toBe(false)
		expect(parsed.events).toEqual([ask, answer])
	})

	test('rewrites instead of appending after a torn event without duplicating it', () => {
		const logText = `${logLine(ask)}\n${logLine(terminated)}\n`
		const logStat = stat(Buffer.byteLength(logText, 'utf8'))
		const plan = planThreadJournalAppend({ exists: true, endsWithNewline: false }, () => logText, logStat, terminated)
		expect(plan.kind).toBe('rewrite')
		if (plan.kind !== 'rewrite') throw new Error('expected a rewrite plan')
		const parsed = parseThreadJournal(plan.text)
		expect(parsed.valid).toBe(true)
		expect(parsed.tornTail).toBe(false)
		expect(parsed.events).toEqual([ask, terminated])
		expect(plan.text.split('"type":"run_terminated"').length - 1).toBe(1)
	})
})
