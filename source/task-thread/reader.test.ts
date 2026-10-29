import { describe, expect, test } from 'bun:test'
import type { QueueItemView } from '../executor/queue/model.js'
import type { LogEvent, RunMeta } from '../executor/types.js'
import { TASK_THREAD_MAX_ENTRIES, TASK_THREAD_MAX_LINEAGE_RUNS, isTaskThreadResponse } from './model.js'
import type { TaskIdentity, TaskThreadEntry } from './model.js'
import { createTaskThreadCoreReader, createTaskThreadReader } from './reader.js'
import { TASK_SUMMARY_FORMAT_VERSION } from './summary.js'
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

function roleStart(task: string, timestamp = T0): LogEvent {
	return { timestamp, type: 'role_start', payload: { role: 'main', roleId: 'main-0-1', depth: 0, task } }
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

interface ReaderHarness {
	reader: ReturnType<typeof createTaskThreadReader>
	core: ReturnType<typeof createTaskThreadCoreReader>
	peekCalls: Array<{ runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[] }>
	logReads: Map<string, number>
	logReadOffsets: Array<{ runId: string, offset: number }>
}

function createHarness(options: {
	metas?: Map<string, string>
	logs?: Map<string, string>
	queueItems?: readonly QueueItemView[]
	peek?: (runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[]) => TaskThreadSummarySnapshot
} = {}): ReaderHarness {
	const metas = options.metas ?? new Map<string, string>()
	const logs = options.logs ?? new Map<string, string>()
	const queueItems = options.queueItems ?? []
	const peekCalls: Array<{ runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[] }> = []
	const logReads = new Map<string, number>()
	const logReadOffsets: Array<{ runId: string, offset: number }> = []
	const core = createTaskThreadCoreReader({
		readRunMetaTextById: (runId) => metas.get(runId) ?? null,
		readRunLogTextFromById: (runId, offset) => {
			logReads.set(runId, (logReads.get(runId) ?? 0) + 1)
			logReadOffsets.push({ runId, offset })
			const text = logs.get(runId) ?? ''
			return Buffer.from(text, 'utf8').subarray(offset).toString('utf8')
		},
		readRunSnapshotStats: (runId) => {
			const meta = metas.get(runId)
			const log = logs.get(runId)
			return {
				meta: meta === undefined ? null : { size: meta.length, mtimeMs: 1 },
				log: log === undefined || log === '' ? null : { size: log.length, mtimeMs: 1 },
			}
		},
		readQueueItems: () => queueItems,
	})
	const reader = createTaskThreadReader({
		readTaskThreadCore: core,
		peekSummary: (runId, identity, entries) => {
			peekCalls.push({ runId, identity, entries })
			return options.peek === undefined ? { state: 'none', summary: null } : options.peek(runId, identity, entries)
		},
	})
	return { reader, core, peekCalls, logReads, logReadOffsets }
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

	test('bounds the response entries', () => {
		const events: string[] = [logLine(roleStart('Fix the parser'))]
		for (let index = 1; index <= TASK_THREAD_MAX_ENTRIES + 20; index++) {
			events.push(logLine({ timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`, type: 'plan_modification', payload: { message: `plan ${index}`, aborted: [] } }))
		}
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, events.join('\n')]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.entries.length).toBeLessThanOrEqual(TASK_THREAD_MAX_ENTRIES)
		expect(response.truncated.entries).toBe(true)
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

	test('caches parsed run sources and reads only the appended tail', () => {
		const metas = new Map([[RUN_A, metaText(RUN_A)]])
		const logs = new Map([[RUN_A, logLine(roleStart('Cached task'))]])
		const harness = createHarness({ metas, logs })
		expect(harness.reader(RUN_A)).not.toBeNull()
		expect(harness.logReads.get(RUN_A)).toBe(1)
		expect(harness.logReadOffsets).toEqual([{ runId: RUN_A, offset: 0 }])
		expect(harness.reader(RUN_A)).not.toBeNull()
		expect(harness.logReads.get(RUN_A)).toBe(1)
		expect(harness.core(RUN_A)).not.toBeNull()
		expect(harness.logReads.get(RUN_A)).toBe(1)
		const original = logs.get(RUN_A) ?? ''
		logs.set(RUN_A, [
			original,
			logLine({ timestamp: T1, type: 'plan_modification', payload: { message: 'new plan', aborted: [] } }),
		].join('\n'))
		const appended = harness.reader(RUN_A)
		if (appended === null) throw new Error('expected appended response')
		expect(harness.logReads.get(RUN_A)).toBe(2)
		expect(harness.logReadOffsets[1]).toEqual({ runId: RUN_A, offset: Buffer.byteLength(original, 'utf8') })
		expect(appended.entries.some((entry) => entry.text === 'new plan')).toBe(true)
	})

	test('falls back to a full parse on log rewrite', () => {
		const metas = new Map([[RUN_A, metaText(RUN_A)]])
		const logs = new Map([[RUN_A, [logLine(roleStart('Original task')), logLine({ timestamp: T1, type: 'plan_modification', payload: { message: 'old plan', aborted: [] } })].join('\n')]])
		const harness = createHarness({ metas, logs })
		expect(harness.reader(RUN_A)).not.toBeNull()
		logs.set(RUN_A, logLine(roleStart('Rewritten task')))
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected rewritten response')
		expect(harness.logReadOffsets[harness.logReadOffsets.length - 1]).toEqual({ runId: RUN_A, offset: 0 })
		expect(response.entries.some((entry) => entry.text === 'old plan')).toBe(false)
	})

	test('marks entries truncated when the relevant-event cache cap is hit', () => {
		const events = [logLine(roleStart('Capped task'))]
		for (let index = 1; index <= 30; index++) {
			events.push(logLine({ timestamp: T1, type: 'plan_modification', payload: { message: `plan ${index} ${'x'.repeat(10_000)}`, aborted: [] } }))
		}
		const harness = createHarness({ metas: new Map([[RUN_A, metaText(RUN_A)]]), logs: new Map([[RUN_A, events.join('\n')]]) })
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected capped response')
		expect(response.truncated.entries).toBe(true)
		expect(response.identity.lineage.resumeCountComplete).toBe(false)
		expect(response.entries.length).toBeLessThan(31)
	})

	test('derives a log-only task when the current meta is malformed', () => {
		const harness = createHarness({
			metas: new Map([[RUN_A, '{not json']]),
			logs: new Map([[RUN_A, logLine(roleStart('Recovered task'))]]),
		})
		const response = harness.reader(RUN_A)
		if (response === null) throw new Error('expected a response')
		expect(response.identity.status).toBe('unknown')
		expect(response.identity.currentTask?.text).toBe('Recovered task')
	})
})
