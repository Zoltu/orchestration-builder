import { describe, expect, test } from 'bun:test'
import { createTaskQueue, type QueueItemView, type QueueView, type ResumeParkedRunResult } from './index.ts'
import { cancelWaitingItem, dispatchingItem, isQueueItem, pendingAnswerUndelivered, releaseToWaiting, toQueueItemView, type QueueItem } from './model.ts'
import type { ParkedAsk } from '../park-state.js'
import type { RunMeta } from '../types.js'

function item(overrides: Partial<QueueItemView> = {}): QueueItemView {
	return {
		id: 'item-1',
		task: 'fix the parser bug',
		status: 'waiting',
		queuedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

type QueuedRunSubmitResult = { ok: true; runId: string } | { ok: false; error: 'run_in_progress' | 'run_id_collision' }

interface QueueSeedItem extends QueueItemView {
	resumeRunId?: string
	resumeToolCallId?: string
}

interface QueuedRunSubmission {
	task: string
	effort?: string
	involvement?: string
	logLevel?: string
	continuation?: unknown
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

const NOW = '2026-01-01T03:00:00.000Z'

interface QueueStoreFake {
	store: { read: () => string | null; write: (contents: string) => void }
	writes: string[]
	items: () => readonly QueueItemView[]
	written: () => QueueView[]
}

function fakeQueueStore(initial: QueueSeedItem[] = []): QueueStoreFake {
	let current: string | null = initial.length === 0 ? null : JSON.stringify({ items: initial })
	const writes: string[] = []
	return {
		store: {
			read: () => current,
			write: (contents) => {
				current = contents
				writes.push(contents)
			},
		},
		writes,
		items: () => parseQueueText(current).items,
		written: () => writes.map((text) => parseQueueText(text)),
	}
}

interface QueueHarness {
	queue: ReturnType<typeof createTaskQueue>
	writes: string[]
	items: () => readonly QueueItemView[]
	written: () => QueueView[]
	submitCalls: QueuedRunSubmission[]
	resumeCalls: Array<{ runId: string; parkedAnswer: { question: string; answer: string; toolCallId: string } }>
}

function makeQueue(options: { initial?: QueueSeedItem[], submitResults?: QueuedRunSubmitResult[], hasActiveRun?: () => boolean, metas?: Record<string, RunMeta>, runs?: RunListEntry[], parkedAsks?: Record<string, ParkedAsk | null>, resumeResults?: ResumeParkedRunResult[] } = {}): QueueHarness {
	const store = fakeQueueStore(options.initial ?? [])
	const scripted = [...(options.submitResults ?? [])]
	const submitCalls: QueuedRunSubmission[] = []
	const submitRun: SubmitQueuedRun = (submission) => {
		submitCalls.push(submission)
		const next = scripted.shift()
		if (next === undefined) return { ok: false, error: 'run_in_progress' }
		return next
	}
	const runs = options.runs ?? []
	const resumeScript = [...(options.resumeResults ?? [])]
	const resumeCalls: Array<{ runId: string; parkedAnswer: { question: string; answer: string; toolCallId: string } }> = []
	const queue = createTaskQueue({
		queueStore: store.store,
		readRunMetaById: (runId) => {
			const meta = options.metas?.[runId]
			return meta === undefined ? null : JSON.stringify(meta)
		},
		listRunIds: () => runs.map((run) => run.runId),
		readRunListSummary: (runId) => {
			const run = runs.find((entry) => entry.runId === runId)
			if (run === undefined) throw new Error(`run list has no entry for ${runId}`)
			return run
		},
		readParkedAskById: (runId) => options.parkedAsks?.[runId] ?? null,
		resumeParkedRun: (runId, parkedAnswer) => {
			resumeCalls.push({ runId, parkedAnswer })
			return resumeScript.shift() ?? { ok: false, error: 'checkpoint_missing' }
		},
		submitRun,
		hasActiveRun: options.hasActiveRun ?? (() => false),
		sleep: async () => {},
		now: () => NOW,
	})
	return { queue, writes: store.writes, items: store.items, written: store.written, submitCalls, resumeCalls }
}

describe('enqueue', () => {
	const handles = { id: '8a3a2c1e-0000-4000-8000-000000000002', queuedAt: '2026-01-01T00:00:00.000Z' }

	test('builds a waiting item from a valid body, omitting absent optional fields', async () => {
		const harness = makeQueue({ hasActiveRun: () => true })
		const result = await harness.queue.enqueue({ task: 'fix the parser bug', effort: 'thorough' }, handles, 'tail')
		expect(result).toEqual({
			ok: true,
			item: {
				id: handles.id,
				task: 'fix the parser bug',
				effort: 'thorough',
				status: 'waiting',
				queuedAt: handles.queuedAt,
			},
		})
		expect(harness.writes.length).toBe(1)
		expect(harness.items()[0]?.task).toBe('fix the parser bug')
	})

	test('accepts involvement, logLevel, and continuesFrom when well-formed', async () => {
		const harness = makeQueue()
		const result = await harness.queue.enqueue({ task: 't', involvement: 'collaborative', logLevel: 'standard', continuesFrom: 'run-20260101-000000' }, handles, 'tail')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.involvement).toBe('collaborative')
			expect(result.item.logLevel).toBe('standard')
			expect(result.item.continuesFrom).toBe('run-20260101-000000')
		}
	})

	test('rejects a malformed body with a reason and writes nothing', async () => {
		const harness = makeQueue()
		expect((await harness.queue.enqueue('task', handles, 'tail')).ok).toBe(false)
		expect((await harness.queue.enqueue({}, handles, 'tail')).ok).toBe(false)
		expect((await harness.queue.enqueue({ task: '' }, handles, 'tail')).ok).toBe(false)
		expect((await harness.queue.enqueue({ task: 't', effort: 'extreme' }, handles, 'tail')).ok).toBe(false)
		expect((await harness.queue.enqueue({ task: 't', involvement: 'extreme' }, handles, 'tail')).ok).toBe(false)
		expect((await harness.queue.enqueue({ task: 't', logLevel: 'quiet' }, handles, 'tail')).ok).toBe(false)
		expect((await harness.queue.enqueue({ task: 't', continuesFrom: 'nope' }, handles, 'tail')).ok).toBe(false)
		expect(harness.writes.length).toBe(0)
	})

	test('places an item at the tail or the head of the file order', async () => {
		const first = item({ id: 'a' })
		const second = item({ id: 'b' })
		const tailHarness = makeQueue({ initial: [first], hasActiveRun: () => true })
		await tailHarness.queue.enqueue({ task: second.task }, { id: second.id, queuedAt: second.queuedAt }, 'tail')
		expect(tailHarness.items().map((entry) => entry.id)).toEqual(['a', 'b'])
		const headHarness = makeQueue({ initial: [first], hasActiveRun: () => true })
		await headHarness.queue.enqueue({ task: second.task }, { id: second.id, queuedAt: second.queuedAt }, 'head')
		expect(headHarness.items().map((entry) => entry.id)).toEqual(['b', 'a'])
	})
})

describe('submitNow', () => {
	const handles = { id: 'new-item', queuedAt: '2026-01-01T00:00:00.000Z' }

	test('enqueues at the head and dispatches through the crash-safe ordering: marker first, runId filled on acceptance', async () => {
		const harness = makeQueue({
			initial: [item({ id: 'ahead' })],
			submitResults: [
				{ ok: true, runId: 'run-20260101-010000' },
				{ ok: true, runId: 'run-20260101-010001' },
			],
		})
		const result = await harness.queue.submitNow({ task: 'new task' }, handles)
		expect(result).toEqual({ kind: 'dispatched', runId: 'run-20260101-010000' })
		expect(harness.items().map((entry) => entry.id)).toEqual(['new-item', 'ahead'])
		const marker = harness.written()[1]?.items.find((entry) => entry.id === 'new-item')
		expect(marker?.status).toBe('active')
		expect(marker?.runId).toBeUndefined()
		expect(harness.items()[0]?.runId).toBe('run-20260101-010000')
	})

	test('a busy service returns busy before enqueueing anything', async () => {
		const harness = makeQueue({ hasActiveRun: () => true })
		const result = await harness.queue.submitNow({ task: 'new task' }, handles)
		expect(result).toEqual({ kind: 'busy' })
		expect(harness.items()).toEqual([])
		expect(harness.writes.length).toBe(0)
	})

	test('rejects a malformed body as invalid without writing', async () => {
		const harness = makeQueue()
		const result = await harness.queue.submitNow({ task: '' }, handles)
		expect(result.kind).toBe('invalid')
		expect(harness.writes.length).toBe(0)
	})

	test('a collision that exhausts the retry budget removes the just-created head item', async () => {
		const harness = makeQueue({
			submitResults: [
				{ ok: false, error: 'run_id_collision' },
				{ ok: false, error: 'run_id_collision' },
				{ ok: false, error: 'run_id_collision' },
				{ ok: false, error: 'run_id_collision' },
			],
		})
		const result = await harness.queue.submitNow({ task: 'a colliding task' }, handles)
		expect(result).toEqual({ kind: 'collision' })
		expect(harness.items()).toEqual([])
	})

	test('a busy slot after the dispatch attempt keeps the restored item and reports busy', async () => {
		let activeChecks = 0
		const harness = makeQueue({
			submitResults: [{ ok: false, error: 'run_in_progress' }],
			// Free for the pre-check and the tick's check; busy by the post-dispatch check, as another request's run would make it.
			hasActiveRun: () => {
				activeChecks += 1
				return activeChecks > 2
			},
		})
		const result = await harness.queue.submitNow({ task: 'a task' }, handles)
		expect(result).toEqual({ kind: 'busy' })
		expect(harness.items().map((entry) => entry.id)).toEqual(['new-item'])
	})
})

describe('read model', () => {
	test('read and mutation results are cloned DTOs; mutating them cannot reach stored state', () => {
		const harness = makeQueue({ initial: [item()] })
		const snapshot = harness.queue.read()
		const target = snapshot.items[0]
		if (target === undefined) throw new Error('expected the seeded item')
		Object.assign(target, { task: 'tampered' })
		expect(harness.queue.read().items[0]?.task).toBe('fix the parser bug')

		const patched = harness.queue.patch('item-1', { task: 'edited' })
		if (!patched.ok) throw new Error('expected the patch to succeed')
		Object.assign(patched.item, { status: 'done' })
		expect(harness.items()[0]?.status).toBe('waiting')
	})
})

describe('patch', () => {
	test('moves a waiting item to a 0-based position within the waiting list', () => {
		const a = item({ id: 'a' })
		const b = item({ id: 'b' })
		const c = item({ id: 'c' })
		const harness = makeQueue({ initial: [a, b, c] })
		const result = harness.queue.patch('c', { position: 0 })
		expect(result.ok).toBe(true)
		if (result.ok) expect(harness.items().map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
	})

	test('positions index the waiting sublist only; non-waiting items keep their file positions', () => {
		const active = item({ id: 'active', status: 'active', runId: 'run-20260101-000000' })
		const a = item({ id: 'a' })
		const b = item({ id: 'b' })
		const done = item({ id: 'done', status: 'done', settledAt: '2026-01-01T01:00:00.000Z' })
		const harness = makeQueue({ initial: [active, a, done, b] })
		const result = harness.queue.patch('b', { position: 0 })
		expect(result.ok).toBe(true)
		if (result.ok) expect(harness.items().map((entry) => entry.id)).toEqual(['active', 'b', 'done', 'a'])
	})

	test('clamps out-of-range positions into the waiting list', () => {
		const a = item({ id: 'a' })
		const b = item({ id: 'b' })
		const under = makeQueue({ initial: [a, b] })
		under.queue.patch('b', { position: -3 })
		expect(under.items().map((entry) => entry.id)).toEqual(['b', 'a'])
		const over = makeQueue({ initial: [a, b] })
		over.queue.patch('a', { position: 99 })
		expect(over.items().map((entry) => entry.id)).toEqual(['b', 'a'])
	})

	test('edits task, effort, and involvement, carrying absent fields forward', () => {
		const target = item({ effort: 'quick', involvement: 'autonomous' })
		const harness = makeQueue({ initial: [item({ id: 'other' }), target] })
		const result = harness.queue.patch('item-1', { task: 'edited task', effort: 'thorough', involvement: 'collaborative' })
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.task).toBe('edited task')
			expect(result.item.effort).toBe('thorough')
			expect(result.item.involvement).toBe('collaborative')
		}
		expect(harness.items().map((entry) => entry.id)).toEqual(['other', 'item-1'])

		const partial = makeQueue({ initial: [target] })
		const partialResult = partial.queue.patch('item-1', { task: 'edited task' })
		expect(partialResult.ok).toBe(true)
		if (partialResult.ok) {
			expect(partialResult.item.effort).toBe('quick')
			expect(partialResult.item.involvement).toBe('autonomous')
		}
	})

	test('an empty patch validates the waiting item without writing', () => {
		const harness = makeQueue({ initial: [item()] })
		const result = harness.queue.patch('item-1', {})
		expect(result).toEqual({ ok: true, item: item() })
		expect(harness.writes.length).toBe(0)
	})

	test('rejects an unknown id and a non-waiting target', () => {
		const harness = makeQueue({ initial: [item({ status: 'active' })] })
		expect(harness.queue.patch('ghost', { task: 'x' })).toEqual({ ok: false, reason: 'not_found' })
		expect(harness.queue.patch('item-1', { task: 'x' })).toEqual({ ok: false, reason: 'forbidden_status' })
	})

	test('rejects field edits on a waiting item bound to a same-run answer resume, while position-only reorder still works', () => {
		const bound = {
			...item({ id: 'bound', question: 'which database?', answer: 'postgres', continuesFrom: 'run-20260101-010000' }),
			resumeRunId: 'run-20260101-010000',
			resumeToolCallId: 'ask_1',
		}
		const other = item({ id: 'other' })
		const harness = makeQueue({ initial: [bound, other] })

		expect(harness.queue.patch('bound', { task: 'edited' })).toEqual({ ok: false, reason: 'forbidden_status' })
		expect(harness.queue.patch('bound', { effort: 'quick' })).toEqual({ ok: false, reason: 'forbidden_status' })
		const reordered = harness.queue.patch('bound', { position: 0 })
		expect(reordered.ok).toBe(true)
		expect(harness.items().map((entry) => entry.id)).toEqual(['bound', 'other'])
	})
})

describe('cancel', () => {
	test('marks a waiting item cancelled with settledAt, keeping the operator-facing record', () => {
		const harness = makeQueue({ initial: [item({ question: 'q', answer: 'a' })] })
		const result = harness.queue.cancel('item-1', '2026-01-01T02:00:00.000Z')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.status).toBe('cancelled')
			expect(result.item.settledAt).toBe('2026-01-01T02:00:00.000Z')
			expect(result.item.question).toBe('q')
		}
		expect(harness.items().length).toBe(1)
	})

	test('rejects an unknown id and every non-waiting status, active and settled included', () => {
		const harness = makeQueue({
			initial: [
				item(),
				item({ id: 'active', status: 'active', runId: 'run-20260101-010000' }),
				item({ id: 'done', status: 'done', settledAt: '2026-01-01T01:00:00.000Z' }),
				item({ id: 'error', status: 'error', runId: 'run-20260101-010001', settledAt: '2026-01-01T01:00:00.000Z' }),
				item({ id: 'cancelled', status: 'cancelled', settledAt: '2026-01-01T01:00:00.000Z' }),
			],
		})
		expect(harness.queue.cancel('ghost', '2026-01-01T02:00:00.000Z')).toEqual({ ok: false, reason: 'not_found' })
		for (const id of ['active', 'done', 'error', 'cancelled']) {
			expect(harness.queue.cancel(id, '2026-01-01T02:00:00.000Z')).toEqual({ ok: false, reason: 'forbidden_status' })
		}
		expect(harness.writes.length).toBe(0)
	})
})

describe('requeue and reactivate', () => {
	test('returns an error item to waiting at the tail with the lineage re-pointed at the errored run', async () => {
		const errored = item({ status: 'error', runId: 'run-20260101-010000', settledAt: '2026-01-01T01:00:00.000Z', resultSummary: 'boom', error: 'it broke' })
		const other = item({ id: 'other' })
		const harness = makeQueue({ initial: [errored, other], hasActiveRun: () => true })
		const result = await harness.queue.requeue('item-1')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.status).toBe('waiting')
			expect(result.item.continuesFrom).toBe('run-20260101-010000')
			expect(result.item.runId).toBeUndefined()
			expect(result.item.resultSummary).toBeUndefined()
			expect(result.item.error).toBeUndefined()
			expect(result.item.settledAt).toBeUndefined()
		}
		expect(harness.items().map((entry) => entry.id)).toEqual(['other', 'item-1'])
	})

	test('rejects an unknown id and a non-error target', async () => {
		const harness = makeQueue({ initial: [item()] })
		expect(await harness.queue.requeue('ghost')).toEqual({ ok: false, reason: 'not_found' })
		expect(await harness.queue.requeue('item-1')).toEqual({ ok: false, reason: 'forbidden_status' })
	})

	test('re-activates the error item a resumed run belongs to, under the same run id, without carrying the settled outcome fields', async () => {
		const errored = item({ status: 'error', runId: 'run-20260101-010000', settledAt: '2026-01-01T01:00:00.000Z', resultSummary: 'boom', error: 'it broke', continuesFrom: 'run-20260101-000000' })
		const harness = makeQueue({ initial: [errored] })
		const result = harness.queue.reactivateErrorItem('run-20260101-010000')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.status).toBe('active')
			expect(result.item.runId).toBe('run-20260101-010000')
			expect(result.item.continuesFrom).toBe('run-20260101-000000')
			expect(result.item.resultSummary).toBeUndefined()
			expect(result.item.error).toBeUndefined()
			expect(result.item.settledAt).toBeUndefined()
		}
		// The re-activated item settles naturally at the resumed run's next terminal, exactly like any active item's.
		await harness.queue.onRunSettled(meta({ result: { status: 'success', summary: 'recovered' } }))
		expect(harness.items()[0]?.status).toBe('done')
		expect(harness.items()[0]?.resultSummary).toBe('recovered')
	})

	test('leaves the queue untouched when no error item names the resumed run', () => {
		const harness = makeQueue({ initial: [item({ status: 'error', runId: 'run-20260101-010000' })] })
		expect(harness.queue.reactivateErrorItem('run-19990101-000000')).toEqual({ ok: false, reason: 'not_found' })
		expect(harness.writes.length).toBe(0)
	})
})

describe('internal resume fields', () => {
	function storedItem(overrides: Partial<QueueItem> = {}): QueueItem {
		return {
			id: 'item-1',
			task: 'fix the parser bug',
			status: 'waiting',
			queuedAt: '2026-01-01T00:00:00.000Z',
			continuesFrom: 'run-20260101-010000',
			resumeRunId: 'run-20260101-010000',
			resumeToolCallId: 'ask_1',
			question: 'which database?',
			...overrides,
		}
	}

	test('validation accepts well-formed resume fields and rejects a bad run id or an empty tool call id', () => {
		expect(isQueueItem(storedItem())).toBe(true)
		expect(isQueueItem(storedItem({ resumeRunId: 'not-a-run-id', continuesFrom: 'not-a-run-id' }))).toBe(false)
		expect(isQueueItem(storedItem({ resumeToolCallId: '' }))).toBe(false)
		const malformed: unknown = { ...storedItem(), resumeToolCallId: 42 }
		expect(isQueueItem(malformed)).toBe(false)
	})

	test('validation binds the resume run to the lineage and pairs both resume pointers', () => {
		const missingLineage: unknown = { ...storedItem(), continuesFrom: undefined }
		expect(isQueueItem(missingLineage)).toBe(false)
		const mismatchedLineage: unknown = { ...storedItem(), continuesFrom: 'run-20260101-000000' }
		expect(isQueueItem(mismatchedLineage)).toBe(false)
		const withoutToolCall: unknown = { ...storedItem(), resumeToolCallId: undefined }
		expect(isQueueItem(withoutToolCall)).toBe(false)
		const withoutRun: unknown = { ...storedItem(), resumeRunId: undefined }
		expect(isQueueItem(withoutRun)).toBe(false)
	})

	test('pendingAnswerUndelivered requires a live checkpoint naming the same call and question', () => {
		const item = storedItem({ answer: 'postgres' })
		expect(pendingAnswerUndelivered(item, { roleId: 'main-0-1', toolCallId: 'ask_1', question: 'which database?' })).toBe(true)
		expect(pendingAnswerUndelivered(item, null)).toBe(false)
		expect(pendingAnswerUndelivered(item, { roleId: 'main-0-1', toolCallId: 'ask_1', question: 'a different question' })).toBe(false)
		expect(pendingAnswerUndelivered(item, { roleId: 'main-0-1', toolCallId: 'ask_2', question: 'which database?' })).toBe(false)
	})

	test('the view projection and lifecycle fields keep the pointers internal', () => {
		const item = storedItem({ continuesFrom: 'run-20260101-000000', question: 'which database?', answer: 'postgres' })
		const view: unknown = toQueueItemView(item)
		if (typeof view !== 'object' || view === null) throw new Error('expected a view')
		expect(Reflect.has(view, 'resumeRunId')).toBe(false)
		expect(Reflect.has(view, 'resumeToolCallId')).toBe(false)

		expect(releaseToWaiting(item).resumeToolCallId).toBe('ask_1')
		expect(dispatchingItem(item).resumeToolCallId).toBe('ask_1')
		const cancelled = cancelWaitingItem({ items: [item] }, item.id, '2026-01-01T01:00:00.000Z')
		if (!cancelled.ok) throw new Error('expected the cancel to succeed')
		expect(cancelled.item.resumeRunId).toBeUndefined()
		expect(cancelled.item.resumeToolCallId).toBeUndefined()
	})
})

describe('answer', () => {
	test('records the answer and moves a needs_input item to the front of the queue as waiting', async () => {
		const parked = item({ status: 'needs_input', runId: 'run-20260101-003000', continuesFrom: 'run-20260101-000000', question: 'which database?' })
		const other = item({ id: 'other' })
		const harness = makeQueue({ initial: [other, parked], hasActiveRun: () => true })
		const result = await harness.queue.answer('item-1', 'postgres')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.status).toBe('waiting')
			expect(result.item.answer).toBe('postgres')
			expect(result.item.question).toBe('which database?')
			expect(result.item.continuesFrom).toBe('run-20260101-000000')
			// The parked run's id is dropped: the lineage carries the resume, and a waiting item showing an old run id would mislead the UI into reading it as the run in flight.
			expect(result.item.runId).toBeUndefined()
		}
		expect(harness.items().map((entry) => entry.id)).toEqual(['item-1', 'other'])
	})

	test('rejects an unknown id and a non-needs_input target', async () => {
		const harness = makeQueue({ initial: [item()] })
		expect(await harness.queue.answer('ghost', 'a')).toEqual({ ok: false, reason: 'not_found' })
		expect(await harness.queue.answer('item-1', 'a')).toEqual({ ok: false, reason: 'forbidden_status' })
	})

	test('dispatches the answered item as a continuation of the parked run on the tick', async () => {
		const parked = item({ status: 'needs_input', runId: 'run-20260101-003000', continuesFrom: 'run-20260101-000000', question: 'which database?' })
		const harness = makeQueue({
			initial: [item({ id: 'other' }), parked],
			submitResults: [{ ok: true, runId: 'run-20260101-010000' }],
			metas: { 'run-20260101-000000': meta({ runId: 'run-20260101-000000', status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'waiting for an answer to: which database?' } }) },
		})
		const result = await harness.queue.answer('item-1', 'postgres')
		expect(result.ok).toBe(true)
		expect(harness.submitCalls.length).toBe(1)
		expect(harness.submitCalls[0]?.task).toBe('fix the parser bug')
		expect(harness.items()[0]?.id).toBe('item-1')
		expect(harness.items()[0]?.runId).toBe('run-20260101-010000')
	})

	test('records the same-run resume pointers when the parked checkpoint still names the question', async () => {
		const parked = item({ status: 'needs_input', runId: 'run-20260101-003000', continuesFrom: 'run-20260101-000000', question: 'which database?' })
		const harness = makeQueue({
			initial: [parked],
			hasActiveRun: () => true,
			parkedAsks: { 'run-20260101-003000': { roleId: 'main-0-1', toolCallId: 'ask_1', question: 'which database?' } },
		})

		await harness.queue.answer('item-1', 'postgres')

		const stored: unknown = harness.items()[0]
		if (typeof stored !== 'object' || stored === null) throw new Error('expected the stored item')
		expect(Reflect.get(stored, 'resumeRunId')).toBe('run-20260101-003000')
		expect(Reflect.get(stored, 'resumeToolCallId')).toBe('ask_1')
		expect(Reflect.get(stored, 'continuesFrom')).toBe('run-20260101-003000')
		expect(Reflect.get(stored, 'answer')).toBe('postgres')
	})

	test('the read projection never leaks the internal resume pointers', async () => {
		const parked = item({ status: 'needs_input', runId: 'run-20260101-003000', continuesFrom: 'run-20260101-000000', question: 'which database?' })
		const harness = makeQueue({
			initial: [parked],
			hasActiveRun: () => true,
			parkedAsks: { 'run-20260101-003000': { roleId: 'main-0-1', toolCallId: 'ask_1', question: 'which database?' } },
		})
		await harness.queue.answer('item-1', 'postgres')

		const viewItem: unknown = harness.queue.read().items[0]
		if (typeof viewItem !== 'object' || viewItem === null) throw new Error('expected the viewed item')
		expect(Reflect.has(viewItem, 'resumeRunId')).toBe(false)
		expect(Reflect.has(viewItem, 'resumeToolCallId')).toBe(false)
	})

	test('records no resume pointers when no parked checkpoint matches the question', async () => {
		const parked = item({ status: 'needs_input', runId: 'run-20260101-003000', question: 'which database?' })
		const harness = makeQueue({ initial: [parked], hasActiveRun: () => true })

		await harness.queue.answer('item-1', 'postgres')

		const stored: unknown = harness.items()[0]
		if (typeof stored !== 'object' || stored === null) throw new Error('expected the stored item')
		expect(Reflect.has(stored, 'resumeRunId')).toBe(false)
		expect(Reflect.get(stored, 'answer')).toBe('postgres')
	})
})
