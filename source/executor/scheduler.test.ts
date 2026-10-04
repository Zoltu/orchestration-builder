import { describe, expect, test } from 'bun:test'
import { COLLISION_RETRY_DELAY_MS, createTaskScheduler, MAX_COLLISION_RETRIES, type QueuedRunSubmission, type SubmitQueuedRun, type TaskSchedulerDependencies } from './scheduler.ts'
import type { QueueItem, RunListEntry, TaskQueue } from './task-queue.ts'
import type { ReadTaskQueue, WriteTaskQueue } from './persistence.ts'
import type { RunMeta } from './types.js'
import type { SubmitResult } from './run-submission.ts'

// A plain-object queue store standing in for the filesystem leaves: reads return the current queue, writes replace it and are recorded in order so tests can assert the exact write sequence (the dispatching marker, the settlement mapping, the runId fill).
function fakeQueueStore(initial: QueueItem[] = []): { readQueue: ReadTaskQueue; writeQueue: WriteTaskQueue; writes: TaskQueue[]; items: () => QueueItem[]; readCount: () => number } {
	let current: TaskQueue = { items: [...initial] }
	let reads = 0
	const writes: TaskQueue[] = []
	return {
		readQueue: () => {
			reads += 1
			return current
		},
		writeQueue: (queue) => {
			current = queue
			writes.push(queue)
		},
		writes,
		items: () => current.items,
		readCount: () => reads,
	}
}

// A fake submitRun recording every call, returning scripted SubmitResults in order.
function fakeSubmit(scripted: SubmitResult[]): { submitRun: SubmitQueuedRun; calls: QueuedRunSubmission[] } {
	const calls: QueuedRunSubmission[] = []
	const submitRun: SubmitQueuedRun = (submission) => {
		calls.push(submission)
		const next = scripted.shift()
		if (next === undefined) throw new Error('the scripted submit results are exhausted')
		return next
	}
	return { calls, submitRun }
}

function waitingItem(overrides: Partial<QueueItem> = {}): QueueItem {
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
function fakeMetaReader(metas: Record<string, RunMeta>): TaskSchedulerDependencies['readRunMetaById'] {
	return (runId) => {
		const meta = metas[runId]
		return meta === undefined ? null : JSON.stringify(meta)
	}
}

function fakeRunList(): { listRunIds: TaskSchedulerDependencies['listRunIds']; readRunListSummary: TaskSchedulerDependencies['readRunListSummary']; runs: RunListEntry[] } {
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

function fakeSleep(): { sleep: TaskSchedulerDependencies['sleep']; delays: number[] } {
	const delays: number[] = []
	return { sleep: async (ms) => { delays.push(ms) }, delays }
}

const NOW = '2026-01-01T03:00:00.000Z'

function schedulerOver(store: ReturnType<typeof fakeQueueStore>, submit: ReturnType<typeof fakeSubmit>, metas: Record<string, RunMeta> = {}, runList: ReturnType<typeof fakeRunList> = fakeRunList(), hasActiveRun: () => boolean = () => false): { tick: () => Promise<void>; onRunSettled: (meta: RunMeta) => Promise<void>; observeShutdown: () => void } {
	const sleep = fakeSleep()
	const scheduler = createTaskScheduler({
		readQueue: store.readQueue,
		writeQueue: store.writeQueue,
		readRunMetaById: fakeMetaReader(metas),
		listRunIds: runList.listRunIds,
		readRunListSummary: runList.readRunListSummary,
		submitRun: submit.submitRun,
		hasActiveRun,
		sleep: sleep.sleep,
		now: () => NOW,
	})
	return { tick: () => scheduler.tick(), onRunSettled: (meta) => scheduler.onRunSettled(meta), observeShutdown: () => scheduler.observeShutdown() }
}

function requireItem(items: QueueItem[], id: string): QueueItem {
	const item = items.find((candidate) => candidate.id === id)
	if (item === undefined) throw new Error(`expected queue item ${id}`)
	return item
}

describe('createTaskScheduler tick — dispatch', () => {
	test('dispatch-on-idle: the head waiting item is dispatched, marker first, runId filled on acceptance', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { tick } = schedulerOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(1)
		expect(submit.calls[0]?.task).toBe('fix the parser bug')
		expect(store.writes.length).toBe(2)
		const marker = requireItem(store.writes[0]?.items ?? [], 'item-1')
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
		const { tick } = schedulerOver(store, submit, {
			'run-20260101-010000': meta({ status: 'running' }),
		})

		await tick()

		expect(submit.calls.length).toBe(0)
		expect(store.writes.length).toBe(0)
	})

	test('the dispatching marker is restored to waiting in the same cycle when the slot is busy', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: false, error: 'run_in_progress' }])
		const { tick } = schedulerOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(1)
		expect(store.writes.length).toBe(2)
		const marker = requireItem(store.writes[0]?.items ?? [], 'item-1')
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
		const { tick } = schedulerOver(store, submit)
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
		const scripted: SubmitResult[] = []
		for (let attempt = 0; attempt <= MAX_COLLISION_RETRIES; attempt++) scripted.push({ ok: false, error: 'run_id_collision' })
		const submit = fakeSubmit(scripted)
		const { tick } = schedulerOver(store, submit)

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
		const scheduler = createTaskScheduler({
			readQueue: store.readQueue,
			writeQueue: store.writeQueue,
			readRunMetaById: fakeMetaReader({}),
			listRunIds: runList.listRunIds,
			readRunListSummary: runList.readRunListSummary,
			submitRun: submit.submitRun,
			hasActiveRun: () => false,
			sleep: sleep.sleep,
			now: () => NOW,
		})

		await scheduler.tick()

		expect(sleep.delays).toEqual([COLLISION_RETRY_DELAY_MS])
		expect(COLLISION_RETRY_DELAY_MS).toBeGreaterThan(1000)
	})
})

describe('createTaskScheduler tick — submission threading', () => {
	test('the item\u2019s effort and logLevel overrides thread into the submission; a plain item carries none', async () => {
		const store = fakeQueueStore([
			waitingItem({ id: 'overridden', effort: 'thorough', logLevel: 'standard' }),
		])
		const submit = fakeSubmit([
			{ ok: true, runId: 'run-20260101-010000' },
			{ ok: true, runId: 'run-20260101-010001' },
		])
		const { tick } = schedulerOver(store, submit)

		await tick()

		expect(submit.calls[0]?.effort).toBe('thorough')
		expect(submit.calls[0]?.logLevel).toBe('standard')

		const plainStore = fakeQueueStore([waitingItem()])
		const plainScheduler = schedulerOver(plainStore, fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }]))
		await plainScheduler.tick()
		expect(submit.calls[1]?.effort).toBeUndefined()
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
		const scheduler = createTaskScheduler({
			readQueue: store.readQueue,
			writeQueue: store.writeQueue,
			readRunMetaById: fakeMetaReader({}),
			listRunIds: runList.listRunIds,
			readRunListSummary: runList.readRunListSummary,
			submitRun: submit.submitRun,
			hasActiveRun: () => false,
			sleep: sleep.sleep,
			now: () => NOW,
		})

		await scheduler.tick()

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
		const { tick } = schedulerOver(store, submit, {
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
		const { tick } = schedulerOver(store, submit, {
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

describe('createTaskScheduler tick — boot repair', () => {
	test('an active item whose run meta is terminal settles from that meta before the dispatch', async () => {
		const store = fakeQueueStore([
			waitingItem({ id: 'stale', status: 'active', runId: 'run-20260101-010000' }),
			waitingItem({ id: 'next' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010001' }])
		const { tick } = schedulerOver(store, submit, {
			'run-20260101-010000': meta({ result: { status: 'success', summary: 'fixed it' }, endTime: '2026-01-01T00:40:00.000Z' }),
		})

		await tick()

		const settled = requireItem(store.items(), 'stale')
		expect(settled.status).toBe('done')
		expect(settled.resultSummary).toBe('fixed it')
		expect(settled.settledAt).toBe('2026-01-01T00:40:00.000Z')
		// The repair write precedes the next item's dispatching marker.
		expect(requireItem(store.writes[0]?.items ?? [], 'stale').status).toBe('done')
		expect(submit.calls[0]?.task).toBe('fix the parser bug')
	})

	test('an active item with no runId binds to the boot-resumed run on an exact task match', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active' }),
		])
		const submit = fakeSubmit([])
		const runList = fakeRunList()
		runList.runs.push({ runId: 'run-20260101-010000', task: 'fix the parser bug', status: 'running', endTime: null, summary: null })
		const { tick } = schedulerOver(store, submit, {
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
		const { tick } = schedulerOver(store, submit, {
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
		const { tick } = schedulerOver(store, submit)

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
		const { tick } = schedulerOver(store, submit, {
			'run-20260101-010000': meta({ status: 'running' }),
		}, runList)

		await tick()

		expect(store.items()[0]).toBe(original)
		expect(store.writes.length).toBe(0)
		expect(submit.calls.length).toBe(0)
	})

	test('the boot tick with a resumed run holding the slot is a true no-op: no marker write, no submit probe', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([])
		const { tick } = schedulerOver(store, submit, {}, fakeRunList(), () => true)

		await tick()

		expect(store.writes.length).toBe(0)
		expect(submit.calls.length).toBe(0)
		expect(requireItem(store.items(), 'item-1').status).toBe('waiting')
	})

	test('the boot tick with a resumed run holding the slot restores the head item to waiting', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: false, error: 'run_in_progress' }])
		const { tick } = schedulerOver(store, submit)

		await tick()

		expect(submit.calls.length).toBe(1)
		expect(requireItem(store.items(), 'item-1').status).toBe('waiting')
	})
})

describe('createTaskScheduler onRunSettled', () => {
	test('error mapping: a failed run marks its item error and the settlement tick dispatches the next item', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000' }),
			waitingItem({ id: 'next' }),
		])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010001' }])
		const { onRunSettled } = schedulerOver(store, submit, {
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
		expect(requireItem(store.writes[0]?.items ?? [], 'item-1').status).toBe('error')
		expect(requireItem(store.writes[1]?.items ?? [], 'next').status).toBe('active')
	})

	test('a re-park re-points the lineage from the original parked run to the attempt that just re-parked', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000', continuesFrom: 'run-20260101-003000' }),
		])
		const submit = fakeSubmit([])
		const { onRunSettled } = schedulerOver(store, submit, {
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
		// Nothing else is waiting, so no dispatch followed the park.
		expect(submit.calls.length).toBe(0)
	})

	test('a settlement of a run the queue does not know writes no mapping but still ticks', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([{ ok: true, runId: 'run-20260101-010000' }])
		const { onRunSettled } = schedulerOver(store, submit)

		await onRunSettled(meta({ runId: 'run-20260101-999999' }))

		// No mapping write for the unknown run; the tick itself dispatched the head item (marker + fill).
		expect(store.writes.length).toBe(2)
		expect(submit.calls.length).toBe(1)
	})
})

describe('createTaskScheduler shutdown gate', () => {
	test('after the shutdown signal a settled item still maps but no new run starts', async () => {
		const store = fakeQueueStore([
			waitingItem({ status: 'active', runId: 'run-20260101-010000' }),
			waitingItem({ id: 'next' }),
		])
		const submit = fakeSubmit([])
		const { onRunSettled, observeShutdown } = schedulerOver(store, submit)

		observeShutdown()
		await onRunSettled(meta({ result: { status: 'success', summary: 'done in the drain' } }))

		const settled = requireItem(store.items(), 'item-1')
		expect(settled.status).toBe('done')
		expect(submit.calls.length).toBe(0)
	})

	test('a tick after the shutdown signal dispatches nothing', async () => {
		const store = fakeQueueStore([waitingItem()])
		const submit = fakeSubmit([])
		const { tick, observeShutdown } = schedulerOver(store, submit)

		observeShutdown()
		await tick()

		expect(submit.calls.length).toBe(0)
		expect(store.writes.length).toBe(0)
	})
})
