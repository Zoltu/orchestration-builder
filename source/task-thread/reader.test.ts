import { describe, expect, test } from 'bun:test'
import type { QueueItemView } from '../executor/queue/model.js'
import type { LogEvent, RunMeta } from '../executor/types.js'
import { buildThreadJournalFromLog, serializeThreadJournalCursorLine } from './journal.js'
import { createThreadJournalStore } from './journal-store.js'
import { TASK_THREAD_MAX_LINEAGE_RUNS, isTaskThreadResponse } from './model.js'
import type { TaskIdentity, TaskThreadEntry, TaskThreadResponse } from './model.js'
import { createTaskThreadCoreReader, createTaskThreadReader } from './reader.js'
import { TASK_SUMMARY_FORMAT_VERSION, threadFingerprint } from './summary.js'
import type { TaskSummary } from './summary.js'
import type { TaskThreadSummarySnapshot } from './summarizer.js'

const RUN_A = 'run-20260101-000000'
const RUN_B = 'run-20260101-000100'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:01:00.000Z'

function runId(index: number): string {
	return `run-20260101-${String(index).padStart(6, '0')}`
}

function sampleMeta(runId: string, overrides: Partial<RunMeta> = {}): RunMeta {
	const status = overrides.status ?? 'success'
	const base: RunMeta = { runId, task: `task for ${runId}`, status, startTime: T0 }
	if (status !== 'running' && status !== 'suspended') base.endTime = T1
	return { ...base, ...overrides }
}

function metaText(runId: string, overrides: Partial<RunMeta> = {}): string {
	return JSON.stringify(sampleMeta(runId, overrides))
}

function logLine(event: LogEvent): string {
	return JSON.stringify(event)
}

function roleStart(task: string, timestamp = T0, depth = 0): LogEvent {
	return { timestamp, type: 'role_start', payload: { role: 'main', roleId: depth === 0 ? 'main-0-1' : 'child-1-2', depth, task } }
}

function roleFinished(timestamp: string, status: string, summary?: string): LogEvent {
	return { timestamp, type: 'role_finished', payload: { role: 'main', roleId: 'main-0-1', depth: 0, status, ...(summary !== undefined ? { summary } : {}) } }
}

function queueItem(id: string, overrides: Partial<QueueItemView> = {}): QueueItemView {
	return { id, task: 'queued task', status: 'waiting', queuedAt: T0, ...overrides }
}

function readySummary(runId: string, title = 'Ready title'): TaskSummary {
	return {
		formatVersion: TASK_SUMMARY_FORMAT_VERSION,
		runId,
		fingerprint: 'fingerprint',
		title,
		description: 'Ready description.',
		generatedAt: T0,
	}
}

function logStatFor(logText: string, mtimeMs = 1): { size: number, mtimeMs: number } {
	return { size: Buffer.byteLength(logText, 'utf8'), mtimeMs }
}

function journalFor(logText: string, mtimeMs = 1): string {
	return buildThreadJournalFromLog(logText, logStatFor(logText, mtimeMs))
}

interface ReaderHarness {
	reader: (runId: string, request?: { limit?: number, before?: string }) => TaskThreadResponse | null
	rawReader: ReturnType<typeof createTaskThreadReader>
	core: ReturnType<typeof createTaskThreadCoreReader>
	peekCalls: Array<{ runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[], fingerprint: string }>
	logReads: Map<string, number>
	journalWrites: () => number
	journals: Map<string, string>
}

function createHarness(options: {
	metas?: Map<string, string>
	logs?: Map<string, string>
	journals?: Map<string, string>
	queueItems?: readonly QueueItemView[]
	peek?: (runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[], fingerprint: string) => TaskThreadSummarySnapshot
} = {}): ReaderHarness {
	const metas = options.metas ?? new Map<string, string>()
	const logs = options.logs ?? new Map<string, string>()
	const journals = options.journals ?? new Map<string, string>()
	const queueItems = options.queueItems ?? []
	const peekCalls: Array<{ runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[], fingerprint: string }> = []
	const logReads = new Map<string, number>()
	const state = { journalWrites: 0 }
	const store = createThreadJournalStore({
		readThreadJournalText: (runId) => journals.get(runId) ?? null,
		writeThreadJournalText: (runId, text) => {
			journals.set(runId, text)
			state.journalWrites++
		},
		appendThreadJournalCursor: (runId, logStat) => {
			journals.set(runId, `${journals.get(runId) ?? ''}${serializeThreadJournalCursorLine(logStat)}`)
		},
		readLogText: (runId) => {
			logReads.set(runId, (logReads.get(runId) ?? 0) + 1)
			return logs.get(runId) ?? ''
		},
		readLogStat: (runId) => {
			const text = logs.get(runId)
			return text === undefined ? null : logStatFor(text)
		},
		readRunMetaText: (runId) => metas.get(runId) ?? null,
	})
	const core = createTaskThreadCoreReader({
		readRunMetaTextById: (runId) => metas.get(runId) ?? null,
		readThreadJournal: (runId) => store.read(runId),
		readQueueItems: () => queueItems,
	})
	const rawReader = createTaskThreadReader({
		readTaskThreadCore: core,
		peekSummary: (runId, identity, entries, fingerprint) => {
			peekCalls.push({ runId, identity, entries, fingerprint })
			return options.peek === undefined ? { state: 'none', summary: null } : options.peek(runId, identity, entries, fingerprint)
		},
	})
	const reader = (runId: string, request?: { limit?: number, before?: string }): TaskThreadResponse | null => {
		const result = rawReader(runId, request)
		if (result === null || isTaskThreadResponse(result)) return result
		throw new Error('unexpected invalid task-thread cursor')
	}
	return { reader, rawReader, core, peekCalls, logReads, journalWrites: () => state.journalWrites, journals }
}

describe('createTaskThreadReader', () => {
	test('returns null when the current run is unknown', () => {
		const harness = createHarness()
		expect(harness.reader(RUN_A)).toBeNull()
		expect(harness.peekCalls.length).toBe(0)
	})

	test('derives a single-run response and asks for the summary state without triggering generation', () => {
		const metas = new Map([[RUN_A, metaText(RUN_A, { result: { status: 'success', summary: 'done' } })]])
		const summary = readySummary(RUN_A)
		const harness = createHarness({
			metas,
			logs: new Map([[RUN_A, [logLine(roleStart('Fix the parser')), logLine(roleFinished(T1, 'success', 'done'))].join('\n')]]),
			peek: () => ({ state: 'ready', summary }),
		})
		const response = harness.reader(RUN_A)
		expect(response).not.toBeNull()
		if (response === null) throw new Error('expected a response')
		expect(isTaskThreadResponse(response)).toBe(true)
		expect(response.identity.runId).toBe(RUN_A)
		expect(response.summary?.title).toBe('Ready title')
		expect(response.summaryState).toBe('ready')
		expect(response.entries.some((entry) => entry.kind === 'task')).toBe(true)
		expect(harness.peekCalls.length).toBe(1)
		expect(harness.peekCalls[0]?.runId).toBe(RUN_A)
	})

	test('carries each lineage run its own effort and involvement', () => {
		const metas = new Map([
			[RUN_A, metaText(RUN_A, { effort: 'quick', involvement: 'autonomous' })],
			[RUN_B, metaText(RUN_B, { continuesFrom: RUN_A, effort: 'thorough', involvement: 'collaborative' })],
		])
		const harness = createHarness({
			metas,
			logs: new Map([[RUN_A, logLine(roleStart('Parent'))], [RUN_B, logLine(roleStart('Child'))]]),
		})
		const response = harness.reader(RUN_B)
		if (response === null) throw new Error('expected a response')
		expect(response.runs).toEqual([
			{ runId: RUN_A, effort: 'quick', involvement: 'autonomous' },
			{ runId: RUN_B, effort: 'thorough', involvement: 'collaborative' },
		])
	})

	test('reports null levels for a run whose meta omits them', () => {
		const metas = new Map([
			[RUN_A, metaText(RUN_A)],
			[RUN_B, metaText(RUN_B, { continuesFrom: RUN_A })],
		])
		const harness = createHarness({
			metas,
			logs: new Map([[RUN_A, logLine(roleStart('Parent'))], [RUN_B, logLine(roleStart('Child'))]]),
		})
		const response = harness.reader(RUN_B)
		if (response === null) throw new Error('expected a response')
		expect(response.runs).toEqual([
			{ runId: RUN_A, effort: null, involvement: null },
			{ runId: RUN_B, effort: null, involvement: null },
		])
	})

	test('walks a parent chain root-first and reports a missing parent', () => {
		const metas = new Map([[RUN_B, metaText(RUN_B, { continuesFrom: RUN_A })]])
		const harness = createHarness({
			metas,
			logs: new Map([[RUN_B, logLine(roleStart('Follow up'))]]),
		})
		const response = harness.reader(RUN_B)
		if (response === null) throw new Error('expected a response')
		expect(response.identity.originalTask?.runId).toBe(RUN_B)
		expect(response.identity.lineage.parentRunId).toBe(RUN_A)
		expect(response.identity.lineage.missingParentRunId).toBe(RUN_A)
		expect(response.identity.lineage.truncatedReason).toBe('missing_parent')
		expect(response.identity.lineage.complete).toBe(false)
		expect(response.truncated.lineage).toBe(true)
	})

	test('stops at a malformed parent meta', () => {
		const metas = new Map([[RUN_B, metaText(RUN_B, { continuesFrom: RUN_A })], [RUN_A, '{not json']])
		const harness = createHarness({ metas, logs: new Map([[RUN_B, logLine(roleStart('Follow up'))], [RUN_A, logLine(roleStart('Parent'))]]) })
		const response = harness.reader(RUN_B)
		if (response === null) throw new Error('expected a response')
		expect(response.identity.lineage.truncatedReason).toBe('missing_parent')
		expect(response.identity.lineage.missingParentRunId).toBe(RUN_A)
	})

	test('treats a parent meta with a foreign runId as missing', () => {
		const metas = new Map([
			[RUN_B, metaText(RUN_B, { continuesFrom: RUN_A })],
			[RUN_A, metaText(runId(999999))],
		])
		const harness = createHarness({ metas, logs: new Map([[RUN_B, logLine(roleStart('Follow up'))], [RUN_A, logLine(roleStart('Foreign parent'))]]) })
		const response = harness.reader(RUN_B)
		if (response === null) throw new Error('expected a response')
		expect(response.identity.lineage.truncatedReason).toBe('missing_parent')
		expect(response.identity.lineage.missingParentRunId).toBe(RUN_A)
		expect(response.identity.lineage.complete).toBe(false)
	})

	test('detects a cyclic parent chain', () => {
		const metas = new Map([
			[RUN_A, metaText(RUN_A, { continuesFrom: RUN_B })],
			[RUN_B, metaText(RUN_B, { continuesFrom: RUN_A })],
		])
		const harness = createHarness({ metas, logs: new Map([[RUN_A, logLine(roleStart('First'))], [RUN_B, logLine(roleStart('Second'))]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.identity.lineage.truncatedReason).toBe('cycle')
		expect(response.identity.lineage.complete).toBe(false)
	})

	test('caps a deep parent chain', () => {
		const metas = new Map<string, string>()
		const logs = new Map<string, string>()
		for (let index = 0; index <= TASK_THREAD_MAX_LINEAGE_RUNS; index++) {
			const id = runId(index + 1)
			const parent = index === 0 ? {} : { continuesFrom: runId(index) }
			metas.set(id, metaText(id, parent))
			logs.set(id, logLine(roleStart(`task ${index}`)))
		}
		const harness = createHarness({ metas, logs })
		const current = runId(TASK_THREAD_MAX_LINEAGE_RUNS + 1)
		const response = harness.reader(current)
		if (response === null) throw new Error('expected a response')
		expect(response.identity.lineage.truncatedReason).toBe('depth')
		expect(response.identity.lineage.complete).toBe(false)
		expect(response.truncated.lineage).toBe(true)
		expect(response.truncated.entries).toBe(false)
		expect(response.truncated.text).toBe(false)
	})

	test('passes through none, pending, ready, and failed summary states', () => {
		const states: TaskThreadSummarySnapshot[] = [
			{ state: 'none', summary: null },
			{ state: 'pending', summary: null },
			{ state: 'ready', summary: readySummary(RUN_A) },
			{ state: 'failed', summary: null },
		]
		for (const snapshot of states) {
			const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), peek: () => snapshot })
			const response = harness.reader(RUN_A)
			if (response === null) throw new Error('expected a response')
			expect(response.summaryState).toBe(snapshot.state)
			expect(response.summary).toEqual(snapshot.summary)
		}
	})

	test('uses queue fallbacks and carries the queue item id', () => {
		const metas = new Map([[RUN_A, metaText(RUN_A, { status: 'needs_clarification', result: { status: 'needs_clarification', summary: '' } })]])
		const harness = createHarness({
			metas,
			logs: new Map([[RUN_A, logLine(roleStart('Fix the parser'))]]),
			queueItems: [queueItem('item-1', { runId: RUN_A, status: 'needs_input', question: 'Which port?', suspendedAt: T1 })],
		})
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		const question = response.entries.find((entry) => entry.source === 'queue' && entry.kind === 'question')
		expect(question?.text).toBe('Which port?')
		expect(question?.queueItemId).toBe('item-1')
	})

	test('returns every journal entry without entry or text caps', () => {
		const events: LogEvent[] = [roleStart('Fix the parser')]
		for (let index = 1; index <= 320; index++) {
			events.push({ timestamp: T1, type: 'plan_modification', payload: { message: `plan ${index} ${'x'.repeat(5_000)}`, aborted: [] } })
		}
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, `${events.map(logLine).join('\n')}\n`]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.entries.length).toBeGreaterThan(300)
		expect(response.entries.some((entry) => entry.text.length > 4_000)).toBe(true)
		expect(response.truncated.entries).toBe(false)
		expect(response.truncated.text).toBe(false)
	})

	test('does not expose log payloads, reasoning, tool data, child turns, or provider detail', () => {
		const logs = [
			logLine(roleStart('root task')),
			logLine({ timestamp: T1, type: 'role_start', payload: { role: 'child', roleId: 'child-1-2', depth: 1, task: 'child secret task' } }),
			logLine({ timestamp: T1, type: 'llm_call', payload: { role: 'child', roleId: 'child-1-2', sent: [{ role: 'user', content: 'SECRET REASONING' }] } }),
			logLine({ timestamp: T1, type: 'tool_call', payload: { role: 'child', tool: 'read_file', arguments: 'SECRET TOOL ARGUMENTS' } }),
			logLine({ timestamp: T1, type: 'provider_failure', payload: { role: 'child', category: 'transient', message: 'provider down', detail: 'SECRET PROVIDER BODY' } }),
			logLine(roleFinished(T1, 'success', 'root done')),
		].join('\n')
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A, { result: { status: 'success', summary: 'root done' } })]]), logs: new Map([[RUN_A, logs]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		const serialized = JSON.stringify(response)
		expect(serialized).not.toContain('SECRET REASONING')
		expect(serialized).not.toContain('SECRET TOOL ARGUMENTS')
		expect(serialized).not.toContain('SECRET PROVIDER BODY')
		expect(serialized).not.toContain('child secret task')
	})

	test('does not read the audit log when the journal is current', () => {
		const logText = `${[logLine(roleStart('Cached task')), logLine({ timestamp: T1, type: 'plan_modification', payload: { message: 'new plan', aborted: [] } })].join('\n')}\n`
		const harness = createHarness({
			metas: new Map([[RUN_A, metaText(RUN_A)]]),
			logs: new Map([[RUN_A, logText]]),
			journals: new Map([[RUN_A, journalFor(logText)]]),
		})
		const first = harness.reader(RUN_A)
		if (first === null) throw new Error('expected a response')
		const second = harness.reader(RUN_A)
		if (second === null) throw new Error('expected a response')
		expect(harness.logReads.get(RUN_A)).toBeUndefined()
		expect(harness.journalWrites()).toBe(0)
		expect(second.entries.some((entry) => entry.text === 'new plan')).toBe(true)
	})

	test('rebuilds an old run without a journal on first read and then uses the journal', () => {
		const logText = `${[logLine(roleStart('Old task')), logLine({ timestamp: T1, type: 'ask_human', payload: { id: 'q1', question: 'Which port?' } }), logLine({ timestamp: T1, type: 'human_answer', payload: { id: 'q1', answer: '8080' } })].join('\n')}\n`
		const harness = createHarness({
			metas: new Map([[RUN_A, metaText(RUN_A)]]),
			logs: new Map([[RUN_A, logText]]),
		})
		const first = harness.reader(RUN_A)
		if (first === null) throw new Error('expected a response')
		expect(harness.logReads.get(RUN_A)).toBe(1)
		expect(harness.journalWrites()).toBe(1)
		expect(first.entries.some((entry) => entry.kind === 'question' && entry.text === 'Which port?')).toBe(true)
		const second = harness.reader(RUN_A)
		if (second === null) throw new Error('expected a response')
		expect(harness.logReads.get(RUN_A)).toBe(1)
		expect(harness.journalWrites()).toBe(1)
	})

	test('keeps an early question and answer surrounded by more than 200 child lifecycle events', () => {
		const events: LogEvent[] = [roleStart('Big task')]
		for (let index = 0; index < 110; index++) events.push({ timestamp: T0, type: 'role_start', payload: { role: 'child', roleId: `child-${index}`, depth: 1, task: `child ${index}` } })
		events.push({ timestamp: T1, type: 'ask_human', payload: { id: 'q1', question: 'Early question?' } })
		events.push({ timestamp: T1, type: 'human_answer', payload: { id: 'q1', answer: 'Early answer' } })
		for (let index = 0; index < 110; index++) events.push({ timestamp: T1, type: 'role_finished', payload: { role: 'child', roleId: `child-${index}`, depth: 1, status: 'success', summary: `child ${index}` } })
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, `${events.map(logLine).join('\n')}\n`]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		const question = response.entries.find((entry) => entry.kind === 'question')
		const answer = response.entries.find((entry) => entry.kind === 'answer')
		expect(question?.text).toBe('Early question?')
		expect(answer?.text).toBe('Early answer')
	})

	test('preserves full question and answer text', () => {
		const questionText = `Q ${'q'.repeat(6_000)}`
		const answerText = `A ${'a'.repeat(6_000)}`
		const logText = `${[logLine(roleStart('Full text')), logLine({ timestamp: T1, type: 'ask_human', payload: { id: 'q1', question: questionText } }), logLine({ timestamp: T1, type: 'human_answer', payload: { id: 'q1', answer: answerText } })].join('\n')}\n`
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, logText]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.entries.find((entry) => entry.kind === 'question')?.text).toBe(questionText)
		expect(response.entries.find((entry) => entry.kind === 'answer')?.text).toBe(answerText)
	})

	test('rebuilds a stale journal when the log has grown', () => {
		const original = `${[logLine(roleStart('Original task')), logLine({ timestamp: T1, type: 'plan_modification', payload: { message: 'old plan', aborted: [] } })].join('\n')}\n`
		const rewritten = `${[logLine(roleStart('Rewritten task')), logLine({ timestamp: T1, type: 'plan_modification', payload: { message: 'new plan', aborted: [] } }), logLine({ timestamp: T1, type: 'plan_modification', payload: { message: 'newer plan', aborted: [] } })].join('\n')}\n`
		const harness = createHarness({
			metas: new Map([[RUN_A, metaText(RUN_A)]]),
			logs: new Map([[RUN_A, rewritten]]),
			journals: new Map([[RUN_A, journalFor(original)]]),
		})
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.entries.some((entry) => entry.text === 'new plan')).toBe(true)
		expect(response.entries.some((entry) => entry.text === 'old plan')).toBe(false)
		expect(harness.logReads.get(RUN_A)).toBe(1)
	})

	test('derives a log-only task when the current meta is malformed', () => {
		const harness = createHarness({
			metas: new Map([[RUN_A, '{not json']]),
			logs: new Map([[RUN_A, `${logLine(roleStart('Recovered task'))}\n`]]),
		})
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.identity.status).toBe('unknown')
		expect(response.identity.currentTask?.text).toBe('Recovered task')
	})

	test('passes the complete journal entries to the summary peeker', () => {
		const events: LogEvent[] = [roleStart('Summary task')]
		for (let index = 0; index < 250; index++) {
			events.push({ timestamp: T1, type: 'plan_modification', payload: { message: `plan ${index}`, aborted: [] } })
		}
		events.push({ timestamp: T1, type: 'ask_human', payload: { id: 'q1', question: 'last question' } })
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, `${events.map(logLine).join('\n')}\n`]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		const peeked = harness.peekCalls[0]
		if (peeked === undefined) throw new Error('expected a peek call')
		expect(peeked.entries.length).toBe(response.entries.length)
		expect(peeked.entries.some((entry) => entry.kind === 'question' && entry.text === 'last question')).toBe(true)
	})

	test('pages the response while the summary peeker sees the full thread and every page shares its fingerprint', () => {
		const events: LogEvent[] = [roleStart('Paged task')]
		for (let index = 0; index < 620; index++) {
			events.push({ timestamp: T1, type: 'plan_modification', payload: { message: `plan ${index}`, aborted: [] } })
		}
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, `${events.map(logLine).join('\n')}\n`]]) })
		const newest = harness.reader(RUN_A, { limit: 100 })
		if (newest === null) throw new Error('expected a response')
		const core = harness.core(RUN_A)
		if (core === null) throw new Error('expected core entries')
		const peeked = harness.peekCalls[0]
		if (peeked === undefined) throw new Error('expected a peek call')
		const fullFingerprint = threadFingerprint(core.identity, core.entries)
		expect(newest.entries.length).toBe(101)
		expect(newest.entries[0]?.id).toBe(core.entries[0]?.id)
		expect(peeked.entries.length).toBe(core.entries.length)
		expect(peeked.entries.length).toBeGreaterThan(newest.entries.length)
		expect(peeked.fingerprint).toBe(newest.threadFingerprint)
		expect(newest.threadFingerprint).toBe(fullFingerprint)
		expect(newest.pagination.hasMoreOlder).toBe(true)
		const cursor = newest.pagination.nextCursor
		if (cursor === null) throw new Error('expected an older cursor')
		const older = harness.reader(RUN_A, { limit: 100, before: cursor })
		if (older === null) throw new Error('expected an older response')
		const olderPeeked = harness.peekCalls[1]
		if (olderPeeked === undefined) throw new Error('expected an older peek call')
		expect(olderPeeked.fingerprint).toBe(older.threadFingerprint)
		expect(older.threadFingerprint).toBe(fullFingerprint)
		expect(older.entries[0]?.id).toBe(core.entries[0]?.id)
		expect(older.pagination.nextCursor).not.toBe(cursor)
	})

	test('returns an explicit invalid-cursor result for an unknown before id', () => {
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, logLine(roleStart('Cursor task'))]]) })
		expect(harness.rawReader(RUN_A, { before: 'missing-entry' })).toEqual({ kind: 'invalid_cursor' })
		expect(harness.peekCalls.length).toBe(0)
	})

	test('accepts the pinned initial task as a cursor and returns only the initial task', () => {
		const events: LogEvent[] = [roleStart('Initial task')]
		for (let index = 0; index < 5; index++) events.push({ timestamp: T1, type: 'plan_modification', payload: { message: `plan ${index}`, aborted: [] } })
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, `${events.map(logLine).join('\n')}\n`]]) })
		const newest = harness.reader(RUN_A, { limit: 2 })
		if (newest === null) throw new Error('expected a response')
		const initial = newest.entries[0]
		if (initial === undefined) throw new Error('expected an initial entry')
		const initialPage = harness.reader(RUN_A, { limit: 2, before: initial.id })
		if (initialPage === null) throw new Error('expected an initial page')
		expect(initialPage.entries.map((entry) => entry.id)).toEqual([initial.id])
		expect(initialPage.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
	})

	test('the page fingerprint equals the summary artifact fingerprint', () => {
		const events: LogEvent[] = [roleStart('Artifact task')]
		for (let index = 0; index < 20; index++) events.push({ timestamp: T1, type: 'plan_modification', payload: { message: `plan ${index}`, aborted: [] } })
		const artifactFingerprints: string[] = []
		const harness = createHarness({
			metas: new Map([[RUN_A, metaText(RUN_A)]]),
			logs: new Map([[RUN_A, `${events.map(logLine).join('\n')}\n`]]),
			peek: (runId, _identity, _entries, fingerprint) => {
				artifactFingerprints.push(fingerprint)
				return { state: 'ready', summary: { ...readySummary(runId), fingerprint } }
			},
		})
		const response = harness.reader(RUN_A, { limit: 5 })
		if (response === null) throw new Error('expected a response')
		expect(artifactFingerprints[0]).toBe(response.threadFingerprint)
		expect(response.summary?.fingerprint).toBe(response.threadFingerprint)
	})

	test('reports an incomplete thread for a running run with a missing journal', () => {
		const logText = `${logLine(roleStart('Running task'))}\n`
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A, { status: 'running' })]]), logs: new Map([[RUN_A, logText]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.truncated.entries).toBe(true)
		expect(response.identity.lineage.resumeCountComplete).toBe(false)
		expect(harness.logReads.get(RUN_A)).toBeUndefined()
	})

	test('reports an incomplete thread for a running run with a corrupt journal', () => {
		const logText = `${logLine(roleStart('Running task'))}\n`
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A, { status: 'running' })]]), logs: new Map([[RUN_A, logText]]), journals: new Map([[RUN_A, 'corrupt\n']]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.truncated.entries).toBe(true)
		expect(response.identity.lineage.resumeCountComplete).toBe(false)
		expect(harness.journalWrites()).toBe(0)
		expect(harness.logReads.get(RUN_A)).toBeUndefined()
	})

	test('flags duplicate projected entry ids as truncated', () => {
		const logText = `${[logLine(roleStart('Duplicate ids')), logLine({ timestamp: T1, type: 'ask_human', payload: { id: 'q1', question: 'first?' } }), logLine({ timestamp: T1, type: 'ask_human', payload: { id: 'q1', question: 'second?' } })].join('\n')}\n`
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, logText]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.entries.filter((entry) => entry.kind === 'question').length).toBe(1)
		expect(response.truncated.entries).toBe(true)
	})
})
