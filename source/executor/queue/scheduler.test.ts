import { describe, expect, test } from 'bun:test'
import { createTaskQueue, type QueueItemView, type QueueView } from './index.ts'
import type { RunContinuation, RunMeta } from '../types.js'

type QueuedRunSubmitResult = { ok: true; runId: string } | { ok: false; error: 'run_in_progress' | 'run_id_collision' }

interface QueuedRunSubmission {
	task: string
	effort?: string
	involvement?: string
	logLevel?: string
	continuation?: RunContinuation
}

type SubmitQueuedRun = (submission: QueuedRunSubmission) => QueuedRunSubmitResult

interface RunListEntry {
	runId: string
	task: string | null
	status: RunMeta['status'] | 'unknown'
	endTime: string | null
	summary: string | null
}

function isQueueItemShape(value: unknown): value is QueueItemView {
	if (typeof value !== 'object' || value === null) return false
	if (!('id' in value) || typeof value.id !== 'string') return false
	if (!('task' in value) || typeof value.task !== 'string') return false
	if (!('status' in value) || typeof value.status !== 'string') return false
	if (!('queuedAt' in value) || typeof value.queuedAt !== 'string') return false
	return true
}

function isQueueShape(value: unknown): value is QueueView {
	if (typeof value !== 'object' || value === null) return false
	if (!('items' in value) || !Array.isArray(value.items)) return false
	return value.items.every(isQueueItemShape)
}

function parseQueueText(text: string | null): QueueView {
	if (text === null) return { items: [] }
	const parsed: unknown = JSON.parse(text)
	if (!isQueueShape(parsed)) throw new Error('the fake queue store holds a malformed queue')
	return parsed
}

// The text-only queue store standing in for the filesystem leaves: writes are recorded as text so tests can assert the exact write sequence and decoded views.
function fakeQueueStore(initial: QueueItemView[] = []): { store: { read: () => string | null; write: (contents: string) => void }; writes: string[]; items: () => readonly QueueItemView[]; written: () => QueueView[]; readCount: () => number } {
	let current: string | null = initial.length === 0 ? null : JSON.stringify({ items: initial })
	let reads = 0
	const writes: string[] = []
	return {
		store: {
			read: () => {
				reads += 1
				return current
			},
			write: (contents) => {
				current = contents
				writes.push(contents)
			},
		},
		writes,
		items: () => parseQueueText(current).items,
		written: () => writes.map((text) => parseQueueText(text)),
		readCount: () => reads,
	}
}

// A fake submitRun recording every call, returning scripted results in order.
function fakeSubmit(scripted: QueuedRunSubmitResult[]): { submitRun: SubmitQueuedRun; calls: QueuedRunSubmission[] } {
	const calls: QueuedRunSubmission[] = []
	const submitRun: SubmitQueuedRun = (submission) => {
		calls.push(submission)
		const next = scripted.shift()
		if (next === undefined) throw new Error('the scripted submit results are exhausted')
		return next
	}
	return { calls, submitRun }
}

function waitingItem(overrides: Partial<QueueItemView> = {}): QueueItemView {
	return {
		id: 'item-1',
		task: 'fix the parser bug',
		status: 'waiting',
		queuedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

function meta(overrides: Partial<RunMeta> = {}): RunMeta {
	return {
		runId: 'run-20260101-010000',
		task: 'fix the parser bug',
		status: 'success',
		startTime: '2026-01-01T00:30:00.000Z',
		endTime: '2026-01-01T00:40:00.000Z',
		...overrides,
	}
}

// Fake run-meta reader over an in-memory record; ids absent from the record read as null (no run directory).
function fakeMetaReader(metas: Record<string, RunMeta>): (runId: string) => string | null {
	return (runId) => {
		const meta = metas[runId]
		return meta === undefined ? null : JSON.stringify(meta)
	}
}

function fakeRunList(): { listRunIds: () => string[]; readRunListSummary: (runId: string) => RunListEntry; runs: RunListEntry[] } {
	const runs: RunListEntry[] = []
	return {
		listRunIds: () => runs.map((run) => run.runId),
		readRunListSummary: (runId) => {
			const run = runs.find((entry) => entry.runId === runId)
			if (run === undefined) throw new Error(`fake run list has no entry for ${runId}`)
			return run
		},
		runs,
	}
}

function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
	const delays: number[] = []
	return { sleep: async (ms) => { delays.push(ms) }, delays }
}

const NOW = '2026-01-01T03:00:00.000Z'
const MAX_COLLISION_RETRIES = 3
const COLLISION_RETRY_DELAY_MS = 1100

function queueOver(store: ReturnType<typeof fakeQueueStore>, submit: ReturnType<typeof fakeSubmit>, metas: Record<string, RunMeta> = {}, runList: ReturnType<typeof fakeRunList> = fakeRunList(), hasActiveRun: () => boolean = () => false): { tick: () => Promise<void>; onRunSettled: (meta: RunMeta) => Promise<void>; observeShutdown: () => void } {
	const sleep = fakeSleep()
	const taskQueue = createTaskQueue({
		queueStore: store.store,
		readRunMetaById: fakeMetaReader(metas),
		listRunIds: runList.listRunIds,
		readRunListSummary: runList.readRunListSummary,
		submitRun: submit.submitRun,
		hasActiveRun,
		sleep: sleep.sleep,
		now: () => NOW,
	})
	return { tick: () => taskQueue.tick(), onRunSettled: (meta) => taskQueue.onRunSettled(meta), observeShutdown: () => taskQueue.observeShutdown() }
}

function requireItem(items: readonly QueueItemView[], id: string): QueueItemView {
	const item = items.find((candidate) => candidate.id === id)
	if (item === undefined) throw new Error(`expected queue item ${id}`)
	return item
}

describe('createTaskQueue tick — dispatch', () => {
	test('dispatch-on-idle: the head waiting item is dispatched, marker first, runId filled on acceptance', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { tick } = queueOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(1)
		expect(submit.calls[0]?.task).toBe('fix the parser bug')
		expect(store.writes.length).toBe(2)
		const marker = requireItem(store.written()[0]?.items ?? [], 'item-1')
		expect(marker.status).toBe('active')
		expect(marker.runId).toBeUndefined()
		const dispatched = requireItem(store.items(), 'item-1')
		expect(dispatched.status).toBe('active')
		expect(dispatched.runId).toBe('run-20260101-010000')
	})

	test('no-op-when-busy: a queue with no waiting item submits nothing and writes nothing', async () => {
		const store = fakeQueueStore([
			waitingItem({ id: 'running', status: 'active', runId: 'run-20260101-010000' }),
			waitingItem({ id: 'finished', status: 'done', settledAt: '2026-01-01T01:00:00.000Z' }),
		])
		const submit = fakeSubmit([])
		const { tick } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'running' }),
		})

		await tick()

		expect(submit.calls.length).toBe(0)
		expect(store.writes.length).toBe(0)
	})

	test('the dispatching marker is restored to waiting in the same cycle when the slot is busy', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: false, error: 'run_in_progress' }])
		const { tick } = queueOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(1)
		expect(store.writes.length).toBe(2)
		const marker = requireItem(store.written()[0]?.items ?? [], 'item-1')
		expect(marker.status).toBe('active')
		expect(marker.runId).toBeUndefined()
		const restored = requireItem(store.items(), 'item-1')
		expect(restored.status).toBe('waiting')
		expect(restored.runId).toBeUndefined()
	})

	test('a collision retry sleeps past the one-second run-id resolution and re-reads the queue in a fresh cycle', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([
			{ ok: false, error: 'run_id_collision' },
			{ ok: false, error: 'run_id_collision' },
			{ ok: true, runId: 'run-20260101-010000' },
		])
		const { tick } = queueOver(store, submit)
		const readsBefore = store.readCount()

		await tick()

		expect(submit.calls.length).toBe(3)
		expect(store.readCount()).toBeGreaterThan(readsBefore + 1)
		const dispatched = requireItem(store.items(), 'item-1')
		expect(dispatched.status).toBe('active')
		expect(dispatched.runId).toBe('run-20260101-010000')
	})

	test('the collision retry delay is bounded and an exhausted budget releases the item to waiting', async () => {
		const store = fakeQueueStore([waitingItem()])
		const scripted: QueuedRunSubmitResult[] = []
		for (let attempt = 0; attempt <= MAX_COLLISION_RETRIES; attempt++) scripted.push({ ok: false, error: 'run_id_collision' })
		const submit = fakeSubmit(scripted)
		const { tick } = queueOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(MAX_COLLISION_RETRIES + 1)
		const released = requireItem(store.items(), 'item-1')
		expect(released.status).toBe('waiting')
		expect(released.runId).toBeUndefined()
	})

	test('the sleep delay passed to the injected sleep crosses the run-id second', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([
			{ ok: false, error: 'run_id_collision' },
			{ ok: true, runId: 'run-20260101-010000' },
		])
		const sleep = fakeSleep()
		const runList = fakeRunList()
		const taskQueue = createTaskQueue({
			queueStore: store.store,
			readRunMetaById: fakeMetaReader({}),
			listRunIds: runList.listRunIds,
			readRunListSummary: runList.readRunListSummary,
			submitRun: submit.submitRun,
			hasActiveRun: () => false,
			sleep: sleep.sleep,
			now: () => NOW,
		})

		await taskQueue.tick()

		expect(sleep.delays).toEqual([COLLISION_RETRY_DELAY_MS])
		expect(COLLISION_RETRY_DELAY_MS).toBeGreaterThan(1000)
	})
})

describe('createTaskQueue tick — submission threading', () => {
	test('the item\u2019s effort, involvement, and logLevel overrides thread into the submission; a plain item carries none', async () => {
		const store = fakeQueueStore([
			waitingItem({ id: 'overridden', effort: 'thorough', involvement: 'collaborative', logLevel: 'standard' }),
		])
		const submit = fakeSubmit([
			{ ok: true, runId: 'run-20260101-010000' },
			{ ok: true, runId: 'run-20260101-010001' },
		])
		const { tick } = queueOver(store, submit)

		await tick()

		expect(submit.calls[0]?.effort).toBe('thorough')
		expect(submit.calls[0]?.involvement).toBe('collaborative')
		expect(submit.calls[0]?.logLevel).toBe('standard')

		const plainStore = fakeQueueStore([waitingItem()])
		const plainQueue = queueOver(plainStore, fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }]))
		await plainQueue.tick()
		expect(submit.calls[1]?.effort).toBeUndefined()
		expect(submit.calls[1]?.involvement).toBeUndefined()
		expect(submit.calls[1]?.logLevel).toBeUndefined()
	})

	test('a first queue dispatch threads a briefing-only continuation with no runId, composing the task-text fallback for summary-less runs', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const runList = fakeRunList()
		runList.runs.push(
			{ runId: 'run-20251231-000000', task: 'before queueing', status: 'success', endTime: '2025-12-31T00:00:00.000Z', summary: 'before the item was queued' },
			{ runId: 'run-20260101-003000', task: 'add a footer', status: 'success', endTime: '2026-01-01T00:30:00.000Z', summary: null },
		)
		const sleep = fakeSleep()
		const taskQueue = createTaskQueue({
			queueStore: store.store,
			readRunMetaById: fakeMetaReader({}),
			listRunIds: runList.listRunIds,
			readRunListSummary: runList.readRunListSummary,
			submitRun: submit.submitRun,
			hasActiveRun: () => false,
			sleep: sleep.sleep,
			now: () => NOW,
		})

		await taskQueue.tick()

		const continuation = submit.calls[0]?.continuation
		expect(continuation).toBeDefined()
		if (continuation === undefined) return
		expect(continuation.runId).toBeUndefined()
		expect(continuation.briefing).toBeDefined()
		const briefing = continuation.briefing ?? []
		expect(briefing.some((line) => line.startsWith('Queued at 2026-01-01T00:00:00.000Z'))).toBe(true)
		expect(briefing).toContain('- run-20260101-003000: add a footer')
		expect(briefing.some((line) => line.includes('run-20251231-000000'))).toBe(false)
	})

	test('an answered item dispatches at the front as a continuation of its parked run, with the question and answer in the briefing', async () => {
		const store = fakeQueueStore([
			waitingItem({ continuesFrom: 'run-20260101-003000', question: 'which database?', answer: 'postgres' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { tick } = queueOver(store, submit, {
			'run-20260101-003000': meta({
				runId: 'run-20260101-003000',
				task: 'pick a database',
				status: 'needs_clarification',
				result: { status: 'needs_clarification', summary: 'waiting for an answer to: which database?' },
			}),
		})

		await tick()

		expect(submit.calls.length).toBe(1)
		const continuation = submit.calls[0]?.continuation
		expect(continuation).toBeDefined()
		if (continuation === undefined) return
		expect(continuation.runId).toBe('run-20260101-003000')
		expect(continuation.task).toBe('pick a database')
		expect(continuation.summary).toBe('waiting for an answer to: which database?')
		expect(continuation.briefing).toContain('Resuming from your question: which database?')
		expect(continuation.briefing).toContain('The operator answered: postgres')
	})

	test('an interrupted run\u2019s item re-dispatches with the lineage re-pointed at the interrupted run', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010001' }])
		const { tick } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'interrupted', error: { kind: 'interrupted', message: 'the service stopped' } }),
		})

		await tick()

		expect(submit.calls.length).toBe(1)
		const continuation = submit.calls[0]?.continuation
		expect(continuation?.runId).toBe('run-20260101-010000')
		expect(continuation?.summary).toBe('')
		const requeued = requireItem(store.items(), 'item-1')
		// The dispatching marker replaced the repaired item: waiting no more, with the runId filled on acceptance.
		expect(requeued.status).toBe('active')
		expect(requeued.runId).toBe('run-20260101-010001')
	})
})

describe('createTaskQueue tick — boot repair', () => {
	test('an active item whose run meta is terminal settles from that meta before the dispatch', async () => {
		const store = fakeQueueStore([
			waitingItem({ id: 'stale', status: 'active', runId: 'run-20260101-010000' }),
			waitingItem({ id: 'next' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010001' }])
		const { tick } = queueOver(store, submit, {
			'run-20260101-010000': meta({ result: { status: 'success', summary: 'fixed it' }, endTime: '2026-01-01T00:40:00.000Z' }),
		})

		await tick()

		const settled = requireItem(store.items(), 'stale')
		expect(settled.status).toBe('done')
		expect(settled.resultSummary).toBe('fixed it')
		expect(settled.settledAt).toBe('2026-01-01T00:40:00.000Z')
		// The repair write precedes the next item's dispatching marker.
		expect(requireItem(store.written()[0]?.items ?? [], 'stale').status).toBe('done')
		expect(submit.calls[0]?.task).toBe('fix the parser bug')
	})

	test('an active item with no runId binds to the boot-resumed run on an exact task match', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active' }),
		])
		const submit = fakeSubmit([])
		const runList = fakeRunList()
		runList.runs.push({ runId: 'run-20260101-010000', task: 'fix the parser bug', status: 'running', endTime: null, summary: null })
		const { tick } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'running' }),
		}, runList)

		await tick()

		const bound = requireItem(store.items(), 'item-1')
		expect(bound.status).toBe('active')
		expect(bound.runId).toBe('run-20260101-010000')
		expect(submit.calls.length).toBe(0)
	})

	test('an active item with no runId returns to waiting when the resumed run\u2019s task differs', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010001' }])
		const runList = fakeRunList()
		runList.runs.push({ runId: 'run-20260101-010000', task: 'a different task', status: 'running', endTime: null, summary: null })
		const { tick } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'running', task: 'a different task' }),
		}, runList)

		await tick()

		expect(requireItem(store.items(), 'item-1').status).toBe('active')
		expect(submit.calls.length).toBe(1)
	})

	test('an active item with no runId returns to waiting when no run was resumed', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010001' }])
		const { tick } = queueOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(1)
		expect(requireItem(store.items(), 'item-1').status).toBe('active')
	})

	test('an active item with a runId whose meta still reads running stays untouched', async () => {
		const original = waitingItem({ status: 'active', runId: 'run-20260101-010000' })
		const store = fakeQueueStore([original])
		const submit = fakeSubmit([])
		const runList = fakeRunList()
		runList.runs.push({ runId: 'run-20260101-010000', task: 'fix the parser bug', status: 'running', endTime: null, summary: null })
		const { tick } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'running' }),
		}, runList)

		await tick()

		const untouched = store.items()[0]
		expect(untouched?.status).toBe('active')
		expect(untouched?.runId).toBe('run-20260101-010000')
		expect(store.writes.length).toBe(0)
		expect(submit.calls.length).toBe(0)
	})

	test('an interrupted item returns to waiting with its lineage, question, and answer preserved', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000', continuesFrom: 'run-20260101-003000', question: 'which database?', answer: 'postgres' }),
		])
		const submit = fakeSubmit([])
		const { tick } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'interrupted', error: { kind: 'interrupted', message: 'the service stopped' } }),
		}, fakeRunList(), () => true)

		await tick()

		const released = requireItem(store.items(), 'item-1')
		expect(released.status).toBe('waiting')
		expect(released.runId).toBeUndefined()
		expect(released.continuesFrom).toBe('run-20260101-010000')
		expect(released.question).toBe('which database?')
		expect(released.answer).toBe('postgres')
		expect(submit.calls.length).toBe(0)
	})

	test('an active item whose run meta is unreadable (a phantom directory) releases to waiting', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000', question: 'which database?', answer: 'postgres' }),
		])
		const submit = fakeSubmit([])
		const { tick } = queueOver(store, submit, {}, fakeRunList(), () => true)

		await tick()

		const released = requireItem(store.items(), 'item-1')
		expect(released.status).toBe('waiting')
		expect(released.runId).toBeUndefined()
		expect(released.question).toBe('which database?')
		expect(released.answer).toBe('postgres')
		expect(store.writes.length).toBe(1)
		expect(submit.calls.length).toBe(0)
	})

	test('the boot tick with a resumed run holding the slot is a true no-op: no marker write, no submit probe', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([])
		const { tick } = queueOver(store, submit, {}, fakeRunList(), () => true)

		await tick()

		expect(store.writes.length).toBe(0)
		expect(submit.calls.length).toBe(0)
		expect(requireItem(store.items(), 'item-1').status).toBe('waiting')
	})

	test('the boot tick with a resumed run holding the slot restores the head item to waiting', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: false, error: 'run_in_progress' }])
		const { tick } = queueOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(1)
		expect(requireItem(store.items(), 'item-1').status).toBe('waiting')
	})
})

describe('createTaskQueue onRunSettled', () => {
	test('error mapping: a failed run marks its item error and the settlement tick dispatches the next item', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000' }),
			waitingItem({ id: 'next' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010001' }])
		const { onRunSettled } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'error', result: { status: 'error', summary: 'could not fix', error: { kind: 'loop_detected', message: 'the test suite hangs' } } }),
		})

		await onRunSettled(meta({ status: 'error', result: { status: 'error', summary: 'could not fix', error: { kind: 'loop_detected', message: 'the test suite hangs' } } }))

		const failed = requireItem(store.items(), 'item-1')
		expect(failed.status).toBe('error')
		expect(failed.resultSummary).toBe('could not fix')
		expect(failed.error).toBe('the test suite hangs')
		expect(failed.settledAt).toBe(NOW)
		expect(submit.calls.length).toBe(1)
		expect(submit.calls[0]?.task).toBe('fix the parser bug')
		// Park ordering: the mapping write precedes the settlement tick's dispatching marker.
		expect(requireItem(store.written()[0]?.items ?? [], 'item-1').status).toBe('error')
		expect(requireItem(store.written()[1]?.items ?? [], 'next').status).toBe('active')
	})

	test('success maps to done with the result summary', async () => {
		const store = fakeQueueStore([waitingItem({ status: 'active', runId: 'run-20260101-010000' })])
		const submit = fakeSubmit([])
		const { onRunSettled } = queueOver(store, submit)

		await onRunSettled(meta({ result: { status: 'success', summary: 'fixed it' } }))

		const settled = requireItem(store.items(), 'item-1')
		expect(settled.status).toBe('done')
		expect(settled.resultSummary).toBe('fixed it')
		expect(settled.settledAt).toBe(NOW)
	})

	test('a re-park re-points the lineage from the original parked run to the attempt that just re-parked', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000', continuesFrom: 'run-20260101-003000' }),
		])
		const submit = fakeSubmit([])
		const { onRunSettled } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'needs_clarification' }),
		})

		await onRunSettled(meta({
			status: 'needs_clarification',
			result: { status: 'needs_clarification', summary: 'waiting for an answer to: and the port?' },
		}))

		const parked = requireItem(store.items(), 'item-1')
		expect(parked.status).toBe('needs_input')
		expect(parked.question).toBe('and the port?')
		expect(parked.continuesFrom).toBe('run-20260101-010000')
		expect(parked.settledAt).toBeUndefined()
		// Nothing else is waiting, so no dispatch followed the park.
		expect(submit.calls.length).toBe(0)
	})

	test('an interrupted meta is never settled: the active item stays untouched and no mapping write happens', async () => {
		const store = fakeQueueStore([waitingItem({ status: 'active', runId: 'run-20260101-010000' })])
		const submit = fakeSubmit([])
		// The run's own meta still reads running, so the settlement tick's repair leaves the item alone and this isolates the settlement mapping's refusal.
		const { onRunSettled } = queueOver(store, submit, {
			'run-20260101-010000': meta({ status: 'running' }),
		}, fakeRunList(), () => true)

		await onRunSettled(meta({ status: 'interrupted', error: { kind: 'interrupted', message: 'the service stopped' } }))

		const untouched = requireItem(store.items(), 'item-1')
		expect(untouched.status).toBe('active')
		expect(untouched.runId).toBe('run-20260101-010000')
		expect(store.writes.length).toBe(0)
		expect(submit.calls.length).toBe(0)
	})

	test('a directly-finished needs_clarification summary is stored verbatim as the question', async () => {
		const store = fakeQueueStore([waitingItem({ status: 'active', runId: 'run-20260101-010000' })])
		const submit = fakeSubmit([])
		const { onRunSettled } = queueOver(store, submit)

		await onRunSettled(meta({ status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'I need a decision on the schema' } }))

		const parked = requireItem(store.items(), 'item-1')
		expect(parked.status).toBe('needs_input')
		expect(parked.question).toBe('I need a decision on the schema')
	})

	test('a settlement of a run the queue does not know writes no mapping but still ticks', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { onRunSettled } = queueOver(store, submit)

		await onRunSettled(meta({ runId: 'run-20260101-999999' }))

		// No mapping write for the unknown run; the tick itself dispatched the head item (marker + fill).
		expect(store.writes.length).toBe(2)
		expect(submit.calls.length).toBe(1)
	})
})

describe('createTaskQueue briefing', () => {
	test('always opens with the platform marker and the queued-at line, and ends with the standing instruction', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { tick } = queueOver(store, submit)

		await tick()

		const briefing = submit.calls[0]?.continuation?.briefing ?? []
		expect(briefing[0]).toBe('[Queued-task briefing — what happened while this task waited in the queue.]')
		expect(briefing[1]).toBe('Queued at 2026-01-01T00:00:00.000Z.')
		expect(briefing[briefing.length - 1]).toContain('The workspace may have changed since this task was queued')
	})

	test('lists runs completed since queuedAt, sorted, with the task-text fallback when the summary is null', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const runList = fakeRunList()
		runList.runs.push(
			{ runId: 'run-20260101-020000', task: 'add a footer', status: 'success', endTime: '2026-01-01T02:00:00.000Z', summary: null },
			{ runId: 'run-20260101-010000', task: 'fix the parser', status: 'success', endTime: '2026-01-01T01:00:00.000Z', summary: 'fixed the parser' },
			{ runId: 'run-20251231-000000', task: 'before queueing', status: 'success', endTime: '2025-12-31T00:00:00.000Z', summary: 'before the item was queued' },
			{ runId: 'run-20260101-030000', task: 'in flight', status: 'running', endTime: null, summary: null },
		)
		const { tick } = queueOver(store, submit, {}, runList)

		await tick()

		const briefing = submit.calls[0]?.continuation?.briefing ?? []
		expect(briefing.filter((line) => line.startsWith('- run-'))).toEqual([
			'- run-20260101-010000: fixed the parser',
			'- run-20260101-020000: add a footer',
		])
	})

	test('lists queue items cancelled while the item waited', async () => {
		const store = fakeQueueStore([
			waitingItem(),
			waitingItem({ id: 'cancelled-1', status: 'cancelled', settledAt: '2026-01-01T01:00:00.000Z' }),
			waitingItem({ id: 'cancelled-before', status: 'cancelled', settledAt: '2025-12-31T00:00:00.000Z' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { tick } = queueOver(store, submit)

		await tick()

		const briefing = submit.calls[0]?.continuation?.briefing ?? []
		expect(briefing.filter((line) => line.startsWith('- '))).toEqual(['- fix the parser bug'])
	})

	test('carries the question and the operator\u2019s answer on a needs_input resume', async () => {
		const store = fakeQueueStore([waitingItem({ question: 'which database?', answer: 'postgres' })])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { tick } = queueOver(store, submit)

		await tick()

		const briefing = submit.calls[0]?.continuation?.briefing ?? []
		expect(briefing).toContain('Resuming from your question: which database?')
		expect(briefing).toContain('The operator answered: postgres')
	})

	test('keeps only the most recent runs when the history exceeds the cap', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const runList = fakeRunList()
		for (let index = 0; index < 25; index++) {
			runList.runs.push({
				runId: `run-20260101-${String(index).padStart(6, '0')}`,
				task: `task ${index}`,
				status: 'success',
				endTime: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
				summary: `summary ${index}`,
			})
		}
		const { tick } = queueOver(store, submit, {}, runList)

		await tick()

		const runLines = (submit.calls[0]?.continuation?.briefing ?? []).filter((line) => line.startsWith('- run-'))
		expect(runLines.length).toBe(20)
		expect(runLines[0]).toContain('summary 5')
		expect(runLines[runLines.length - 1]).toContain('summary 24')
	})
})

describe('createTaskQueue shutdown gate', () => {
	test('after the shutdown signal a settled item still maps but no new run starts', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000' }),
			waitingItem({ id: 'next' }),
		])
		const submit = fakeSubmit([])
		const { onRunSettled, observeShutdown } = queueOver(store, submit)

		observeShutdown()
		await onRunSettled(meta({ result: { status: 'success', summary: 'done in the drain' } }))

		const settled = requireItem(store.items(), 'item-1')
		expect(settled.status).toBe('done')
		expect(submit.calls.length).toBe(0)
	})

	test('a tick after the shutdown signal dispatches nothing', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([])
		const { tick, observeShutdown } = queueOver(store, submit)

		observeShutdown()
		await tick()

		expect(submit.calls.length).toBe(0)
		expect(store.writes.length).toBe(0)
	})
})
