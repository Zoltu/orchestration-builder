import { describe, expect, test } from 'bun:test'
import { createTerminatePausedRun } from '../executor/run-submission.js'
import type { LogEvent } from '../executor/types.js'
import { parseLogEvents } from '../run-log/parse.js'
import { buildThreadJournalFromLog, parseThreadJournal, planThreadJournalAppend, serializeThreadJournalCursorLine } from './journal.js'
import type { ThreadJournalLogStat } from './journal.js'
import { createThreadJournalStore } from './journal-store.js'

const RUN = 'run-20260101-000000'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:01:00.000Z'
const T2 = '2026-01-01T00:02:00.000Z'

function event(type: string, payload: unknown, timestamp: string): LogEvent {
	return { timestamp, type, payload }
}

function roleStart(timestamp: string): LogEvent {
	return event('role_start', { role: 'main', roleId: 'main-0-1', depth: 0, task: 'task' }, timestamp)
}

function roleFinished(timestamp: string): LogEvent {
	return event('role_finished', { role: 'main', roleId: 'main-0-1', depth: 0, status: 'success', summary: 'done' }, timestamp)
}

function ask(timestamp: string): LogEvent {
	return event('ask_human', { id: 'q1', question: 'why?' }, timestamp)
}

function answer(timestamp: string): LogEvent {
	return event('human_answer', { id: 'q1', answer: 'because' }, timestamp)
}

function logText(events: readonly LogEvent[]): string {
	return `${events.map((item) => JSON.stringify(item)).join('\n')}\n`
}

function stat(text: string, mtimeMs = 1): ThreadJournalLogStat {
	return { size: Buffer.byteLength(text, 'utf8'), mtimeMs }
}

function cursorFor(text: string, mtimeMs = 1): { logSize: number, logMtimeMs: number } {
	const value = stat(text, mtimeMs)
	return { logSize: value.size, logMtimeMs: value.mtimeMs }
}

function meta(status: string): string {
	return JSON.stringify({ runId: RUN, task: 'task', status, startTime: T0, ...(status === 'running' ? {} : { endTime: T1 }) })
}

interface HarnessState {
	journalText: string | null
	metaText: string | null
	logText: string | null
	logStat: ThreadJournalLogStat | null
}

interface Harness {
	store: ReturnType<typeof createThreadJournalStore>
	state: HarnessState
	writes: string[]
	appends: string[]
	logReadCount: () => number
}

function createHarness(options: { journalText?: string, metaText?: string, logText?: string, logStat?: ThreadJournalLogStat | null } = {}): Harness {
	const text = options.logText ?? null
	const state: HarnessState = {
		journalText: options.journalText ?? null,
		metaText: options.metaText ?? null,
		logText: text,
		logStat: options.logStat !== undefined ? options.logStat : text === null ? null : stat(text),
	}
	const writes: string[] = []
	const appends: string[] = []
	let logReadCount = 0
	const store = createThreadJournalStore({
		readThreadJournalText: () => state.journalText,
		writeThreadJournalText: (_runId, journalText) => {
			state.journalText = journalText
			writes.push(journalText)
		},
		appendThreadJournalCursor: (_runId, logStat) => {
			state.journalText = `${state.journalText ?? ''}${serializeThreadJournalCursorLine(logStat)}`
			appends.push(state.journalText)
		},
		readLogText: () => {
			logReadCount++
			return state.logText ?? ''
		},
		readLogStat: () => state.logStat,
		readRunMetaText: () => state.metaText,
	})
	return { store, state, writes, appends, logReadCount: () => logReadCount }
}

describe('createThreadJournalStore read', () => {
	test('rebuilds and writes a missing journal for a terminal run', () => {
		const text = logText([roleStart(T0), ask(T1), answer(T2), roleFinished(T2)])
		const harness = createHarness({ metaText: meta('success'), logText: text })
		const result = harness.store.read(RUN)
		expect(result?.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer', 'role_finished'])
		expect(result?.complete).toBe(true)
		expect(harness.writes.length).toBe(1)
		expect(harness.logReadCount()).toBe(1)
		const parsed = parseThreadJournal(harness.state.journalText ?? '')
		expect(parsed.valid).toBe(true)
		expect(parsed.lastCursor).toEqual(cursorFor(text))
	})

	test('rebuilds a stale terminal journal from the full log', () => {
		const oldLog = logText([roleStart(T0)])
		const newLog = logText([roleStart(T0), ask(T1), answer(T2)])
		const staleJournal = buildThreadJournalFromLog(oldLog, stat(oldLog, 1))
		const harness = createHarness({ journalText: staleJournal, metaText: meta('success'), logText: newLog, logStat: stat(newLog, 2) })
		const result = harness.store.read(RUN)
		expect(result?.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer'])
		expect(result?.complete).toBe(true)
		expect(harness.writes.length).toBe(1)
		expect(harness.logReadCount()).toBe(1)
	})

	test('rebuilds on a same-size log rewrite detected through the cursor mtime', () => {
		const oldLog = logText([roleStart(T0), event('plan_modification', { message: 'old plan', aborted: [] }, T1)])
		const newLog = logText([roleStart(T0), event('plan_modification', { message: 'new plan', aborted: [] }, T1)])
		expect(Buffer.byteLength(oldLog, 'utf8')).toBe(Buffer.byteLength(newLog, 'utf8'))
		const journal = buildThreadJournalFromLog(oldLog, stat(oldLog, 1))
		const harness = createHarness({ journalText: journal, metaText: meta('success'), logText: newLog, logStat: stat(newLog, 2) })
		const result = harness.store.read(RUN)
		expect(result?.complete).toBe(true)
		expect(result?.events.some((item) => JSON.stringify(item.payload).includes('new plan'))).toBe(true)
		expect(harness.writes.length).toBe(1)
		expect(harness.logReadCount()).toBe(1)
	})

	test('returns a current journal without reading the log', () => {
		const text = logText([roleStart(T0), ask(T1), answer(T2)])
		const journal = buildThreadJournalFromLog(text, stat(text))
		const harness = createHarness({ journalText: journal, metaText: meta('success'), logText: text })
		const result = harness.store.read(RUN)
		expect(result?.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer'])
		expect(result?.complete).toBe(true)
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
	})

	test('does not read or write the log for a missing running journal with bytes', () => {
		const harness = createHarness({ metaText: meta('running'), logText: logText([roleStart(T0), ask(T1)]) })
		expect(harness.store.read(RUN)).toEqual({ events: [], complete: false })
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
	})

	test('treats an empty running log with no journal as complete', () => {
		const harness = createHarness({ metaText: meta('running'), logText: '' })
		expect(harness.store.read(RUN)).toEqual({ events: [], complete: true })
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
	})

	test('treats an absent running log with no journal as complete', () => {
		const harness = createHarness({ metaText: meta('running') })
		expect(harness.store.read(RUN)).toEqual({ events: [], complete: true })
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
	})

	test('does not rebuild a running run: a stale journal returns its existing events as complete', () => {
		const oldLog = logText([roleStart(T0), ask(T1)])
		const newLog = logText([roleStart(T0), ask(T1), answer(T2)])
		const staleJournal = buildThreadJournalFromLog(oldLog, stat(oldLog, 1))
		const harness = createHarness({ journalText: staleJournal, metaText: meta('running'), logText: newLog, logStat: stat(newLog, 2) })
		const result = harness.store.read(RUN)
		expect(result?.events.map((item) => item.type)).toEqual(['role_start', 'ask_human'])
		expect(result?.complete).toBe(true)
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
	})

	test('does not return untrusted events for a corrupt running journal', () => {
		const harness = createHarness({ journalText: 'not a journal\n', metaText: meta('running'), logText: logText([roleStart(T0), ask(T1)]) })
		expect(harness.store.read(RUN)).toEqual({ events: [], complete: false })
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
	})

	test('rebuilds a corrupt terminal journal', () => {
		const text = logText([roleStart(T0), ask(T1), answer(T2)])
		const harness = createHarness({ journalText: 'not a journal\n', metaText: meta('success'), logText: text })
		const result = harness.store.read(RUN)
		expect(result?.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer'])
		expect(result?.complete).toBe(true)
		expect(harness.writes.length).toBe(1)
		expect(parseThreadJournal(harness.state.journalText ?? '').valid).toBe(true)
	})

	test('rebuilds a torn terminal journal instead of treating it as current', () => {
		const text = logText([roleStart(T0), ask(T1), answer(T2)])
		const journal = `${buildThreadJournalFromLog(text, stat(text))}{"type":"thread_cursor","logSize":`
		const harness = createHarness({ journalText: journal, metaText: meta('success'), logText: text })
		const result = harness.store.read(RUN)
		expect(result?.complete).toBe(true)
		expect(result?.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer'])
		expect(harness.writes.length).toBe(1)
		expect(parseThreadJournal(harness.state.journalText ?? '').tornTail).toBe(false)
	})

	test('does not trust a torn running journal', () => {
		const text = logText([roleStart(T0), ask(T1)])
		const journal = `${buildThreadJournalFromLog(text, stat(text))}{"type":"thread_cursor","logSize":`
		const harness = createHarness({ journalText: journal, metaText: meta('running'), logText: text })
		expect(harness.store.read(RUN)).toEqual({ events: [], complete: false })
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
		expect(parseThreadJournal(harness.state.journalText ?? '').tornTail).toBe(true)
	})

	test('a missing log and journal is not complete', () => {
		const harness = createHarness({ metaText: meta('success') })
		expect(harness.store.read(RUN)).toEqual({ events: [], complete: false })
		expect(harness.writes.length).toBe(0)
	})

	test('returns null for an unknown run', () => {
		const harness = createHarness()
		expect(harness.store.read(RUN)).toBeNull()
	})
})

describe('createThreadJournalStore ensure', () => {
	test('rebuilds a missing or stale journal when the log exists', () => {
		const text = logText([roleStart(T0), ask(T1), answer(T2)])
		const harness = createHarness({ metaText: meta('running'), logText: text })
		harness.store.ensure(RUN)
		expect(harness.writes.length).toBe(1)
		expect(parseThreadJournal(harness.state.journalText ?? '').lastCursor).toEqual(cursorFor(text))
		harness.store.ensure(RUN)
		expect(harness.writes.length).toBe(1)
	})

	test('rebuilds a corrupt journal', () => {
		const text = logText([roleStart(T0), ask(T1)])
		const harness = createHarness({ journalText: 'corrupt\n', metaText: meta('running'), logText: text })
		harness.store.ensure(RUN)
		expect(harness.writes.length).toBe(1)
		expect(parseThreadJournal(harness.state.journalText ?? '').valid).toBe(true)
	})

	test('rebuilds a stale journal', () => {
		const oldLog = logText([roleStart(T0)])
		const newLog = logText([roleStart(T0), ask(T1), answer(T2)])
		const staleJournal = buildThreadJournalFromLog(oldLog, stat(oldLog, 1))
		const harness = createHarness({ journalText: staleJournal, metaText: meta('running'), logText: newLog, logStat: stat(newLog, 2) })
		harness.store.ensure(RUN)
		expect(harness.writes.length).toBe(1)
		const parsed = parseThreadJournal(harness.state.journalText ?? '')
		expect(parsed.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer'])
		expect(parsed.lastCursor).toEqual(cursorFor(newLog, 2))
	})

	test('rebuilds a torn journal tail', () => {
		const text = logText([roleStart(T0), ask(T1), answer(T2)])
		const journal = `${buildThreadJournalFromLog(text, stat(text))}{"type":"thread_cursor","logSize":`
		const harness = createHarness({ journalText: journal, metaText: meta('success'), logText: text })
		harness.store.ensure(RUN)
		expect(harness.writes.length).toBe(1)
		const parsed = parseThreadJournal(harness.state.journalText ?? '')
		expect(parsed.valid).toBe(true)
		expect(parsed.tornTail).toBe(false)
		expect(parsed.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer'])
	})

	test('is a no-op for a fresh run whose log is absent', () => {
		const harness = createHarness({ metaText: meta('running') })
		harness.store.ensure(RUN)
		expect(harness.writes.length).toBe(0)
		expect(harness.logReadCount()).toBe(0)
	})
})

describe('createThreadJournalStore finalize', () => {
	test('appends a cursor to a valid journal without rewriting it', () => {
		const oldLog = logText([roleStart(T0)])
		const newLog = logText([roleStart(T0), ask(T1)])
		const journal = buildThreadJournalFromLog(oldLog, stat(oldLog, 1))
		const harness = createHarness({ journalText: journal, metaText: meta('success'), logText: newLog, logStat: stat(newLog, 2) })
		harness.store.finalize(RUN)
		expect(harness.writes.length).toBe(0)
		expect(harness.appends.length).toBe(1)
		expect(harness.state.journalText?.startsWith(journal)).toBe(true)
		const parsed = parseThreadJournal(harness.state.journalText ?? '')
		expect(parsed.valid).toBe(true)
		expect(parsed.lastCursor).toEqual(cursorFor(newLog, 2))
		expect(harness.logReadCount()).toBe(0)
	})

	test('rebuilds a torn journal tail instead of appending after it', () => {
		const text = logText([roleStart(T0), ask(T1), answer(T2)])
		const journal = `${buildThreadJournalFromLog(text, stat(text))}{"type":"thread_cursor","logSize":`
		const harness = createHarness({ journalText: journal, metaText: meta('success'), logText: text })
		harness.store.finalize(RUN)
		expect(harness.writes.length).toBe(1)
		expect(harness.appends.length).toBe(0)
		const parsed = parseThreadJournal(harness.state.journalText ?? '')
		expect(parsed.valid).toBe(true)
		expect(parsed.tornTail).toBe(false)
		expect(parsed.events.map((item) => item.type)).toEqual(['role_start', 'ask_human', 'human_answer'])
	})

	test('rebuilds when the log was rewritten at the same size', () => {
		const oldLog = logText([roleStart(T0), event('plan_modification', { message: 'old plan', aborted: [] }, T1)])
		const newLog = logText([roleStart(T0), event('plan_modification', { message: 'new plan', aborted: [] }, T1)])
		expect(Buffer.byteLength(oldLog, 'utf8')).toBe(Buffer.byteLength(newLog, 'utf8'))
		const journal = buildThreadJournalFromLog(oldLog, stat(oldLog, 1))
		const harness = createHarness({ journalText: journal, metaText: meta('success'), logText: newLog, logStat: stat(newLog, 2) })
		harness.store.finalize(RUN)
		expect(harness.writes.length).toBe(1)
		expect(harness.appends.length).toBe(0)
		expect(harness.state.journalText).toContain('new plan')
		expect(harness.state.journalText).not.toContain('old plan')
	})

	test('rebuilds a missing journal instead of appending', () => {
		const text = logText([roleStart(T0)])
		const harness = createHarness({ metaText: meta('success'), logText: text })
		harness.store.finalize(RUN)
		expect(harness.writes.length).toBe(1)
		expect(harness.appends.length).toBe(0)
		expect(parseThreadJournal(harness.state.journalText ?? '').lastCursor).toEqual(cursorFor(text))
	})

	test('rebuilds a corrupt journal instead of appending', () => {
		const text = logText([roleStart(T0), ask(T1)])
		const harness = createHarness({ journalText: 'corrupt\n', metaText: meta('success'), logText: text })
		harness.store.finalize(RUN)
		expect(harness.writes.length).toBe(1)
		expect(harness.appends.length).toBe(0)
		expect(parseThreadJournal(harness.state.journalText ?? '').valid).toBe(true)
	})

	test('is a no-op when the log is absent', () => {
		const harness = createHarness({ metaText: meta('success'), journalText: 'corrupt\n' })
		harness.store.finalize(RUN)
		expect(harness.writes.length).toBe(0)
		expect(harness.appends.length).toBe(0)
	})
})

describe('out-of-band termination', () => {
	function appendToHarness(harness: Harness, event: LogEvent): void {
		harness.state.logText = `${harness.state.logText ?? ''}${JSON.stringify(event)}\n`
		harness.state.logStat = stat(harness.state.logText, 2)
		const journalText = harness.state.journalText
		const tail = journalText === null
			? { exists: false, endsWithNewline: false }
			: { exists: true, endsWithNewline: journalText.endsWith('\n') }
		const plan = planThreadJournalAppend(tail, () => harness.state.logText ?? '', harness.state.logStat, event)
		if (plan.kind === 'none') return
		if (plan.kind === 'rewrite') {
			harness.state.journalText = plan.text
			return
		}
		harness.state.journalText = `${harness.state.journalText ?? ''}${plan.text}`
	}

	test('ensures before termination journaling so the complete thread is readable', () => {
		for (const journalState of ['missing', 'stale'] as const) {
			const baseLog = logText([roleStart(T0), ask(T1)])
			const staleJournal = buildThreadJournalFromLog(logText([roleStart(T0)]), stat(logText([roleStart(T0)])))
			const harness = createHarness({
				metaText: meta('needs_clarification'),
				logText: baseLog,
				...(journalState === 'stale' ? { journalText: staleJournal } : {}),
			})
			const terminate = createTerminatePausedRun({
				readRunMetaById: () => harness.state.metaText,
				readRunLogEvents: () => parseLogEvents(harness.state.logText ?? ''),
				writeMetaFor: () => (runMeta) => {
					harness.state.metaText = JSON.stringify(runMeta)
				},
				deleteCheckpointFor: () => () => {},
				appendLogFor: (runId) => {
					harness.store.ensure(runId)
					return (event) => appendToHarness(harness, event)
				},
				clearPausedRun: () => {},
				notifyStateChanged: () => {},
			})
			expect(terminate(RUN).ok).toBe(true)
			const result = harness.store.read(RUN)
			expect(result?.complete).toBe(true)
			const types = result?.events.map((item) => item.type) ?? []
			expect(types).toContain('ask_human')
			expect(types).toContain('run_terminated')
			expect(parseThreadJournal(harness.state.journalText ?? '').valid).toBe(true)
		}
	})
})
