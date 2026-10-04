import { describe, expect, test } from 'bun:test'
import { assembleBriefingLines, cancelWaitingItem, dispatchingItem, enqueueAtHead, enqueueAtTail, isQueueItem, isTaskQueue, mapSettledItemState, MAX_BRIEFING_RUN_LINES, normalizeNewItem, recordAnswer, requeueErrorItem, releaseToWaiting, reorderWaitingItem, repairActiveItem, settleActiveItem } from './task-queue.ts'
import type { QueueItem, TaskQueue } from './task-queue.ts'
import type { RunMeta } from './types.js'

function item(overrides: Partial<QueueItem> = {}): QueueItem {
	return {
		id: 'item-1',
		task: 'fix the parser bug',
		status: 'waiting',
		queuedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

function queue(...items: QueueItem[]): TaskQueue {
	return { items }
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

const fullItem: QueueItem = {
	id: '8a3a2c1e-0000-4000-8000-000000000001',
	task: 'fix the parser bug',
	effort: 'thorough',
	logLevel: 'standard',
	continuesFrom: 'run-20260101-000000',
	status: 'needs_input',
	runId: 'run-20260101-003000',
	queuedAt: '2026-01-01T00:00:00.000Z',
	question: 'which database?',
	answer: 'postgres',
}

// An untyped item builder for the rejection tests: malformed field values must survive typecheck to reach the guard.
function rawItem(overrides: Record<string, unknown> = {}): unknown {
	return { id: 'item-1', task: 'fix the parser bug', status: 'waiting', queuedAt: '2026-01-01T00:00:00.000Z', ...overrides }
}

describe('isQueueItem', () => {
	test('accepts a minimal item and a fully-populated item, and round-trips through JSON', () => {
		expect(isQueueItem(item())).toBe(true)
		expect(isQueueItem(fullItem)).toBe(true)
		const copy: unknown = JSON.parse(JSON.stringify(fullItem))
		expect(isQueueItem(copy)).toBe(true)
	})

	test('rejects non-objects and missing required fields', () => {
		expect(isQueueItem(null)).toBe(false)
		expect(isQueueItem('item')).toBe(false)
		expect(isQueueItem([])).toBe(false)
		expect(isQueueItem(rawItem({ id: undefined }))).toBe(false)
		expect(isQueueItem(rawItem({ id: '' }))).toBe(false)
		expect(isQueueItem(rawItem({ task: undefined }))).toBe(false)
		expect(isQueueItem(rawItem({ task: '' }))).toBe(false)
		expect(isQueueItem(rawItem({ queuedAt: undefined }))).toBe(false)
		expect(isQueueItem(rawItem({ status: undefined }))).toBe(false)
	})

	test('rejects malformed optional fields', () => {
		expect(isQueueItem(rawItem({ status: 'pending' }))).toBe(false)
		expect(isQueueItem(rawItem({ effort: 'extreme' }))).toBe(false)
		expect(isQueueItem(rawItem({ logLevel: 'quiet' }))).toBe(false)
		expect(isQueueItem(rawItem({ continuesFrom: 'not-a-run-id' }))).toBe(false)
		expect(isQueueItem(rawItem({ runId: 'not-a-run-id' }))).toBe(false)
		expect(isQueueItem(rawItem({ settledAt: 7 }))).toBe(false)
		expect(isQueueItem(rawItem({ question: 7 }))).toBe(false)
		expect(isQueueItem(rawItem({ answer: true }))).toBe(false)
		expect(isQueueItem(rawItem({ resultSummary: [] }))).toBe(false)
		expect(isQueueItem(rawItem({ error: {} }))).toBe(false)
	})
})

describe('isTaskQueue', () => {
	test('accepts an empty queue and a queue of valid items, and round-trips through JSON', () => {
		expect(isTaskQueue({ items: [] })).toBe(true)
		expect(isTaskQueue(queue(item(), fullItem))).toBe(true)
		const copy: unknown = JSON.parse(JSON.stringify(queue(fullItem)))
		expect(isTaskQueue(copy)).toBe(true)
	})

	test('rejects non-objects, a missing or non-array items field, and malformed entries', () => {
		expect(isTaskQueue(null)).toBe(false)
		expect(isTaskQueue('queue')).toBe(false)
		expect(isTaskQueue({})).toBe(false)
		expect(isTaskQueue({ items: {} })).toBe(false)
		expect(isTaskQueue({ items: [rawItem({ status: 'ghost' })] })).toBe(false)
		expect(isTaskQueue({ items: [item(), 'not an item'] })).toBe(false)
	})
})

describe('normalizeNewItem', () => {
	const handles = { id: '8a3a2c1e-0000-4000-8000-000000000002', queuedAt: '2026-01-01T00:00:00.000Z' }

	test('builds a waiting item from a valid body, omitting absent optional fields', () => {
		const result = normalizeNewItem({ task: 'fix the parser bug', effort: 'thorough' }, handles)
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
	})

	test('accepts logLevel and continuesFrom when well-formed', () => {
		const result = normalizeNewItem({ task: 't', logLevel: 'standard', continuesFrom: 'run-20260101-000000' }, handles)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.logLevel).toBe('standard')
			expect(result.item.continuesFrom).toBe('run-20260101-000000')
		}
	})

	test('rejects a malformed body with a reason', () => {
		expect(normalizeNewItem('task', handles).ok).toBe(false)
		expect(normalizeNewItem({}, handles).ok).toBe(false)
		expect(normalizeNewItem({ task: '' }, handles).ok).toBe(false)
		expect(normalizeNewItem({ task: 't', effort: 'extreme' }, handles).ok).toBe(false)
		expect(normalizeNewItem({ task: 't', logLevel: 'quiet' }, handles).ok).toBe(false)
		expect(normalizeNewItem({ task: 't', continuesFrom: 'nope' }, handles).ok).toBe(false)
	})
})

describe('enqueueAtTail and enqueueAtHead', () => {
	test('append and prepend without mutating the input queue', () => {
		const first = item({ id: 'a' })
		const second = item({ id: 'b' })
		const original = queue(first)
		expect(enqueueAtTail(original, second).items).toEqual([first, second])
		expect(enqueueAtHead(original, second).items).toEqual([second, first])
		expect(original.items).toEqual([first])
	})
})

describe('reorderWaitingItem', () => {
	test('moves a waiting item to a 0-based position within the waiting list', () => {
		const a = item({ id: 'a' })
		const b = item({ id: 'b' })
		const c = item({ id: 'c' })
		const result = reorderWaitingItem(queue(a, b, c), 'c', 0)
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.queue.items.map((i) => i.id)).toEqual(['c', 'a', 'b'])
	})

	test('positions index the waiting sublist only; non-waiting items keep their file positions', () => {
		const active = item({ id: 'active', status: 'active', runId: 'run-20260101-000000' })
		const a = item({ id: 'a' })
		const b = item({ id: 'b' })
		const done = item({ id: 'done', status: 'done', settledAt: '2026-01-01T01:00:00.000Z' })
		const result = reorderWaitingItem(queue(active, a, done, b), 'b', 0)
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.queue.items.map((i) => i.id)).toEqual(['active', 'b', 'done', 'a'])
	})

	test('clamps out-of-range positions into the waiting list', () => {
		const a = item({ id: 'a' })
		const b = item({ id: 'b' })
		expect(reorderWaitingItem(queue(a, b), 'a', -3).ok).toBe(true)
		const underClamped = reorderWaitingItem(queue(a, b), 'b', -3)
		if (underClamped.ok) expect(underClamped.queue.items.map((i) => i.id)).toEqual(['b', 'a'])
		const overClamped = reorderWaitingItem(queue(a, b), 'a', 99)
		if (overClamped.ok) expect(overClamped.queue.items.map((i) => i.id)).toEqual(['b', 'a'])
	})

	test('rejects an unknown id and a non-waiting target', () => {
		expect(reorderWaitingItem(queue(item()), 'ghost', 0)).toEqual({ ok: false, reason: 'not_found' })
		expect(reorderWaitingItem(queue(item({ status: 'active', runId: 'run-20260101-000000' })), 'item-1', 0)).toEqual({ ok: false, reason: 'forbidden_status' })
	})
})

describe('cancelWaitingItem', () => {
	test('marks a waiting item cancelled with settledAt, keeping the operator-facing record', () => {
		const target = item({ question: 'q', answer: 'a' })
		const result = cancelWaitingItem(queue(target), 'item-1', '2026-01-01T02:00:00.000Z')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.status).toBe('cancelled')
			expect(result.item.settledAt).toBe('2026-01-01T02:00:00.000Z')
			expect(result.item.question).toBe('q')
			expect(result.queue.items.length).toBe(1)
		}
	})

	test('rejects an unknown id and a non-waiting target', () => {
		expect(cancelWaitingItem(queue(item()), 'ghost', '2026-01-01T02:00:00.000Z')).toEqual({ ok: false, reason: 'not_found' })
		expect(cancelWaitingItem(queue(item({ status: 'needs_input' })), 'item-1', '2026-01-01T02:00:00.000Z')).toEqual({ ok: false, reason: 'forbidden_status' })
	})
})

describe('requeueErrorItem', () => {
	test('returns an error item to waiting at the tail with the lineage re-pointed at the errored run', () => {
		const errored = item({ status: 'error', runId: 'run-20260101-010000', settledAt: '2026-01-01T01:00:00.000Z', resultSummary: 'boom', error: 'it broke' })
		const other = item({ id: 'other' })
		const result = requeueErrorItem(queue(errored, other), 'item-1')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.status).toBe('waiting')
			expect(result.item.continuesFrom).toBe('run-20260101-010000')
			expect(result.item.runId).toBeUndefined()
			expect(result.item.resultSummary).toBeUndefined()
			expect(result.item.error).toBeUndefined()
			expect(result.item.settledAt).toBeUndefined()
			expect(result.queue.items.map((i) => i.id)).toEqual(['other', 'item-1'])
		}
	})

	test('rejects an unknown id and a non-error target', () => {
		expect(requeueErrorItem(queue(item()), 'ghost')).toEqual({ ok: false, reason: 'not_found' })
		expect(requeueErrorItem(queue(item({ status: 'waiting' })), 'item-1')).toEqual({ ok: false, reason: 'forbidden_status' })
	})
})

describe('recordAnswer', () => {
	test('records the answer and moves a needs_input item to the front of the queue as waiting', () => {
		const parked = item({ status: 'needs_input', runId: 'run-20260101-003000', continuesFrom: 'run-20260101-000000', question: 'which database?' })
		const other = item({ id: 'other' })
		const result = recordAnswer(queue(other, parked), 'item-1', 'postgres')
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.item.status).toBe('waiting')
			expect(result.item.answer).toBe('postgres')
			expect(result.item.question).toBe('which database?')
			expect(result.item.continuesFrom).toBe('run-20260101-000000')
			expect(result.queue.items.map((i) => i.id)).toEqual(['item-1', 'other'])
		}
	})

	test('rejects an unknown id and a non-needs_input target', () => {
		expect(recordAnswer(queue(item()), 'ghost', 'a')).toEqual({ ok: false, reason: 'not_found' })
		expect(recordAnswer(queue(item({ status: 'waiting' })), 'item-1', 'a')).toEqual({ ok: false, reason: 'forbidden_status' })
	})
})

describe('mapSettledItemState', () => {
	test('maps success to done with the result summary', () => {
		expect(mapSettledItemState(meta({ result: { status: 'success', summary: 'fixed it' } }))).toEqual({ status: 'done', resultSummary: 'fixed it' })
	})

	test('maps error to error with the result summary and the run-described error', () => {
		const settled = mapSettledItemState(meta({
			status: 'error',
			result: { status: 'error', summary: 'could not fix', error: { kind: 'loop_detected', message: 'the test suite hangs' } },
		}))
		expect(settled).toEqual({ status: 'error', resultSummary: 'could not fix', error: 'the test suite hangs' })
	})

	test('maps needs_clarification to needs_input with the question recovered by the uniform prefix rule', () => {
		expect(mapSettledItemState(meta({ status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'waiting for an answer to: which database?' } })))
			.toEqual({ status: 'needs_input', question: 'which database?' })
	})

	test('stores a directly-finished needs_clarification summary verbatim as the question', () => {
		expect(mapSettledItemState(meta({ status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'I need a decision on the schema' } })))
			.toEqual({ status: 'needs_input', question: 'I need a decision on the schema' })
	})

	test('returns undefined for statuses that map to no item state', () => {
		expect(mapSettledItemState(meta({ status: 'running' }))).toBeUndefined()
		expect(mapSettledItemState(meta({ status: 'interrupted', error: { kind: 'interrupted', message: 'stopped' } }))).toBeUndefined()
	})
})

describe('settleActiveItem', () => {
	test('settles the active item the run belongs to, with settledAt', () => {
		const active = item({ status: 'active', runId: 'run-20260101-010000' })
		const result = settleActiveItem(queue(active), 'run-20260101-010000', meta({ result: { status: 'success', summary: 'fixed it' } }), '2026-01-01T01:00:00.000Z')
		if (result.kind !== 'settled') throw new Error('expected a settlement')
		expect(result.item.status).toBe('done')
		expect(result.item.resultSummary).toBe('fixed it')
		expect(result.item.settledAt).toBe('2026-01-01T01:00:00.000Z')
	})

	test('a needs_clarification settlement re-points the lineage at the just-settled run and leaves no settledAt', () => {
		const active = item({ status: 'active', runId: 'run-20260101-010000', continuesFrom: 'run-20260101-000000' })
		const result = settleActiveItem(queue(active), 'run-20260101-010000', meta({ status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'waiting for an answer to: which port?' } }), '2026-01-01T01:00:00.000Z')
		if (result.kind !== 'settled') throw new Error('expected a settlement')
		expect(result.item.status).toBe('needs_input')
		expect(result.item.continuesFrom).toBe('run-20260101-010000')
		expect(result.item.question).toBe('which port?')
		expect(result.item.settledAt).toBeUndefined()
	})

	test('reports a run the queue does not know and a meta that maps to no item state', () => {
		expect(settleActiveItem(queue(item({ status: 'active', runId: 'run-20260101-010000' })), 'run-20260101-999999', meta(), '2026-01-01T01:00:00.000Z').kind).toBe('unknown_run')
		expect(settleActiveItem(queue(item({ status: 'active', runId: 'run-20260101-010000' })), 'run-20260101-010000', meta({ status: 'interrupted', error: { kind: 'interrupted', message: 'stopped' } }), '2026-01-01T01:00:00.000Z').kind).toBe('not_settleable')
	})
})

describe('repairActiveItem', () => {
	test('an active item whose run meta is terminal settles from that meta, exactly the live mapping', () => {
		const active = item({ status: 'active', runId: 'run-20260101-010000' })
		const repaired = repairActiveItem(active, meta({ result: { status: 'success', summary: 'fixed it' }, endTime: '2026-01-01T00:40:00.000Z' }), '2026-01-01T02:00:00.000Z')
		expect(repaired.kind).toBe('settled')
		if (repaired.kind === 'settled') {
			expect(repaired.item.status).toBe('done')
			expect(repaired.item.resultSummary).toBe('fixed it')
			expect(repaired.item.settledAt).toBe('2026-01-01T00:40:00.000Z')
		}
	})

	test('an active item whose run reconciled interrupted returns to waiting with the lineage re-pointed', () => {
		const active = item({ status: 'active', runId: 'run-20260101-010000' })
		const repaired = repairActiveItem(active, meta({ status: 'interrupted', error: { kind: 'interrupted', message: 'the service stopped' } }), '2026-01-01T02:00:00.000Z')
		expect(repaired.kind).toBe('released')
		if (repaired.kind === 'released') {
			expect(repaired.item.status).toBe('waiting')
			expect(repaired.item.continuesFrom).toBe('run-20260101-010000')
			expect(repaired.item.runId).toBeUndefined()
		}
	})

	test('an active item whose run meta still reads running is the boot-resumed run\u2019s own item and stays untouched', () => {
		const active = item({ status: 'active', runId: 'run-20260101-010000' })
		const repaired = repairActiveItem(active, meta({ status: 'running' }), '2026-01-01T02:00:00.000Z')
		expect(repaired).toEqual({ kind: 'untouched', item: active })
		expect(repaired.item).toBe(active)
	})

	test('an active item whose run meta is unreadable is released to waiting', () => {
		const active = item({ status: 'active', runId: 'run-20260101-010000' })
		const repaired = repairActiveItem(active, null, '2026-01-01T02:00:00.000Z')
		expect(repaired.kind).toBe('released')
		if (repaired.kind === 'released') expect(repaired.item.status).toBe('waiting')
	})

	test('an orphaned dispatching marker binds to the resumed run when the task matches', () => {
		const marker = dispatchingItem(item())
		const repaired = repairActiveItem(marker, meta({ status: 'running', task: 'fix the parser bug' }), '2026-01-01T02:00:00.000Z')
		expect(repaired.kind).toBe('bound')
		if (repaired.kind === 'bound') {
			expect(repaired.item.status).toBe('active')
			expect(repaired.item.runId).toBe('run-20260101-010000')
		}
	})

	test('an orphaned dispatching marker returns to waiting on a task mismatch or no resumed run', () => {
		const marker = dispatchingItem(item())
		const mismatched = repairActiveItem(marker, meta({ status: 'running', task: 'a different task' }), '2026-01-01T02:00:00.000Z')
		expect(mismatched.kind).toBe('released')
		if (mismatched.kind === 'released') expect(mismatched.item.status).toBe('waiting')
		const noResume = repairActiveItem(marker, null, '2026-01-01T02:00:00.000Z')
		expect(noResume.kind).toBe('released')
		if (noResume.kind === 'released') expect(noResume.item.status).toBe('waiting')
	})

	test('a released item keeps its question and answer for the re-dispatch', () => {
		const answered = releaseToWaiting(item({ status: 'active', runId: 'run-20260101-010000', question: 'q', answer: 'a' }), 'run-20260101-010000')
		expect(answered.question).toBe('q')
		expect(answered.answer).toBe('a')
	})
})

describe('assembleBriefingLines', () => {
	test('always opens with the platform marker and the queued-at line, and ends with the standing instruction', () => {
		const lines = assembleBriefingLines({ queuedAt: '2026-01-01T00:00:00.000Z', items: [], runs: [] })
		expect(lines[0]).toBe('[Queued-task briefing — what happened while this task waited in the queue.]')
		expect(lines[1]).toBe('Queued at 2026-01-01T00:00:00.000Z.')
		expect(lines[lines.length - 1]).toContain('The workspace may have changed since this task was queued')
	})

	test('lists runs completed since queuedAt, one line per run carrying the full run id, with the task-text fallback when the summary is null', () => {
		const lines = assembleBriefingLines({
			queuedAt: '2026-01-01T00:00:00.000Z',
			items: [],
			runs: [
				{ runId: 'run-20260101-010000', task: 'fix the parser', status: 'success', endTime: '2026-01-01T01:00:00.000Z', summary: 'fixed the parser' },
				{ runId: 'run-20260101-020000', task: 'add a footer', status: 'success', endTime: '2026-01-01T02:00:00.000Z', summary: null },
				{ runId: 'run-20251231-000000', task: 'before queueing', status: 'success', endTime: '2025-12-31T00:00:00.000Z', summary: 'before the item was queued' },
				{ runId: 'run-20260101-030000', task: 'in flight', status: 'running', endTime: null, summary: null },
			],
		})
		const runLines = lines.filter((line) => line.startsWith('- run-'))
		expect(runLines).toEqual([
			'- run-20260101-010000: fixed the parser',
			'- run-20260101-020000: add a footer',
		])
	})

	test('lists queue items cancelled while the item waited', () => {
		const lines = assembleBriefingLines({
			queuedAt: '2026-01-01T00:00:00.000Z',
			items: [
				item({ id: 'cancelled-1', status: 'cancelled', settledAt: '2026-01-01T01:00:00.000Z' }),
				item({ id: 'cancelled-before', status: 'cancelled', settledAt: '2025-12-31T00:00:00.000Z' }),
			],
			runs: [],
		})
		expect(lines.filter((line) => line.startsWith('- '))).toEqual(['- fix the parser bug'])
	})

	test('carries the question and the operator\u2019s answer on a needs_input resume', () => {
		const lines = assembleBriefingLines({ queuedAt: '2026-01-01T00:00:00.000Z', items: [], runs: [], question: 'which database?', answer: 'postgres' })
		expect(lines).toContain('Resuming from your question: which database?')
		expect(lines).toContain('The operator answered: postgres')
	})

	test('keeps only the most recent runs when the history exceeds the cap', () => {
		const runs = Array.from({ length: MAX_BRIEFING_RUN_LINES + 5 }, (_, index) => ({
			runId: `run-20260101-${String(index).padStart(6, '0')}`,
			task: `task ${index}`,
			status: 'success' as const,
			endTime: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
			summary: `summary ${index}`,
		}))
		const lines = assembleBriefingLines({ queuedAt: '2026-01-01T00:00:00.000Z', items: [], runs })
		const runLines = lines.filter((line) => line.startsWith('- run-'))
		expect(runLines.length).toBe(MAX_BRIEFING_RUN_LINES)
		expect(runLines[0]).toContain('summary 5')
		expect(runLines[runLines.length - 1]).toContain(`summary ${MAX_BRIEFING_RUN_LINES + 4}`)
	})
})
