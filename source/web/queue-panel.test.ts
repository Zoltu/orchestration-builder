import { describe, expect, test } from 'bun:test'
import { backlogCount, deriveQueuedItems, deriveReorderPosition, isQueueItemLike, matchesParkedRun, queueItemPrimaryText, queueStatusLabel, reorderWaitingItems, taskFirstLine } from './static/ts/queue-panel.js'

// The fixture shape below mirrors the queue item's wire shape (docs/queueing.md "The queue: storage, item model, state machine") the tests build against, pulled off the module's API so the fixtures are checked against the module's own QueueItemLike, mirroring the sibling flow-view.test.ts convention.
type QueueItemLike = Parameters<typeof queueItemPrimaryText>[0]

function item(overrides: Partial<QueueItemLike> = {}): QueueItemLike {
	return {
		id: 'item-1',
		task: 'fix the parser bug',
		status: 'waiting',
		queuedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

describe('isQueueItemLike', () => {
	test('accepts an item the panel can render', () => {
		expect(isQueueItemLike(item())).toBe(true)
	})

	test('rejects entries missing identity, task, or a known status', () => {
		expect(isQueueItemLike(null)).toBe(false)
		expect(isQueueItemLike('item')).toBe(false)
		expect(isQueueItemLike(item({ id: '' }))).toBe(false)
		expect(isQueueItemLike(item({ task: '' }))).toBe(false)
		expect(isQueueItemLike({ ...item(), status: 'dispatched' })).toBe(false)
		expect(isQueueItemLike({ ...item(), runId: 42 })).toBe(false)
		expect(isQueueItemLike({ ...item(), runId: '' })).toBe(false)
	})

	test('accepts the optional lineage and resumed-run fields only as non-empty strings', () => {
		expect(isQueueItemLike(item({ continuesFrom: 'run-parent', resumesRunId: 'run-paused' }))).toBe(true)
		expect(isQueueItemLike({ ...item(), continuesFrom: '' })).toBe(false)
		expect(isQueueItemLike({ ...item(), continuesFrom: 7 })).toBe(false)
		expect(isQueueItemLike({ ...item(), resumesRunId: '' })).toBe(false)
		expect(isQueueItemLike({ ...item(), resumesRunId: null })).toBe(false)
	})
})

describe('deriveQueuedItems', () => {
	test('groups the polled items into the three queued groups in display order and drops the settled and malformed ones', () => {
		const queued = deriveQueuedItems([
			item({ id: 'a', status: 'done', settledAt: '2026-01-01T00:01:00.000Z' }),
			item({ id: 'b' }),
			{ id: 'malformed', task: '', status: 'waiting', queuedAt: '2026-01-01T00:00:00.000Z' },
			item({ id: 'c', status: 'needs_input' }),
			item({ id: 'd', status: 'active' }),
			item({ id: 'e', status: 'cancelled', settledAt: '2026-01-01T00:02:00.000Z' }),
			item({ id: 'f' }),
		])
		expect(queued.waiting.map((entry) => entry.id)).toEqual(['b', 'f'])
		expect(queued.active.map((entry) => entry.id)).toEqual(['d'])
		expect(queued.needsInput.map((entry) => entry.id)).toEqual(['c'])
	})

	test('an empty queue yields three empty groups', () => {
		expect(deriveQueuedItems([])).toEqual({ waiting: [], active: [], needsInput: [] })
	})
})

describe('backlogCount', () => {
	test('counts the waiting and needs_input items only', () => {
		expect(backlogCount([
			item({ id: 'a' }),
			item({ id: 'b', status: 'active' }),
			item({ id: 'c', status: 'needs_input' }),
			item({ id: 'd', status: 'done' }),
		])).toBe(2)
	})
})

describe('queueStatusLabel', () => {
	test('maps every status to its display label and falls back to the raw status', () => {
		expect(queueStatusLabel('waiting')).toBe('waiting')
		expect(queueStatusLabel('active')).toBe('running')
		expect(queueStatusLabel('needs_input')).toBe('needs your answer')
		expect(queueStatusLabel('mysterious')).toBe('mysterious')
	})
})

describe('taskFirstLine', () => {
	test('keeps a short first line verbatim and caps a long one at a word boundary', () => {
		expect(taskFirstLine('fix the parser bug\nsecond line')).toBe('fix the parser bug')
		const longWord = 'x'.repeat(120)
		expect(taskFirstLine(longWord)).toBe(`${longWord.slice(0, 100)}…`)
		const longSentence = `${'w'.repeat(50)} ${'y'.repeat(80)}`
		expect(taskFirstLine(longSentence).endsWith('…')).toBe(true)
	})

	test('cuts at the last space when it falls past the floor', () => {
		const withBoundary = `${'a'.repeat(61)} ${'b'.repeat(50)}`
		expect(taskFirstLine(withBoundary)).toBe(`${'a'.repeat(61)}…`)
	})
})

describe('queueItemPrimaryText', () => {
	test('uses the result summary for a settled done/error item and the task first line for every other status', () => {
		expect(queueItemPrimaryText(item({ status: 'done', resultSummary: 'fixed it', settledAt: '2026-01-01T00:01:00.000Z' }))).toBe('fixed it')
		expect(queueItemPrimaryText(item({ status: 'error', resultSummary: 'blew up', settledAt: '2026-01-01T00:01:00.000Z' }))).toBe('blew up')
		expect(queueItemPrimaryText(item({ status: 'needs_input', question: 'which database?\nwith which user?' }))).toBe('fix the parser bug')
		expect(queueItemPrimaryText(item({ status: 'active', task: 'a running task\nsecond line' }))).toBe('a running task')
		expect(queueItemPrimaryText(item())).toBe('fix the parser bug')
	})

	test('a needs_input item whose task is long still shows the bounded task line, never the question', () => {
		const longTask = `${'t'.repeat(120)}\nquestion follows`
		expect(queueItemPrimaryText(item({ status: 'needs_input', task: longTask, question: 'which database?' }))).toBe(`${'t'.repeat(100)}…`)
	})
})

describe('deriveReorderPosition', () => {
	test('returns the target waiting index excluding the dragged item, null for a self-drop', () => {
		const items = [item({ id: 'a' }), item({ id: 'active', status: 'active' }), item({ id: 'b' }), item({ id: 'c' })]
		expect(deriveReorderPosition(items, 'a', 'b')).toBe(0)
		expect(deriveReorderPosition(items, 'a', 'c')).toBe(1)
		expect(deriveReorderPosition(items, 'b', 'b')).toBeNull()
		expect(deriveReorderPosition(items, 'b', 'missing')).toBeNull()
	})
})

describe('reorderWaitingItems', () => {
	test('moves the dragged item to the clamped position and keeps every other item in place', () => {
		const items = [item({ id: 'a' }), item({ id: 'active', status: 'active' }), item({ id: 'b' }), item({ id: 'c' })]
		expect(reorderWaitingItems(items, 'a', 5).map((entry) => entry.id)).toEqual(['b', 'active', 'c', 'a'])
		expect(reorderWaitingItems(items, 'a', 1).map((entry) => entry.id)).toEqual(['b', 'active', 'a', 'c'])
		expect(reorderWaitingItems(items, 'active', 0).map((entry) => entry.id)).toEqual(['a', 'active', 'b', 'c'])
	})
})

describe('matchesParkedRun', () => {
	test('matches a modern needs_input item by its runId', () => {
		expect(matchesParkedRun(item({ status: 'needs_input', runId: 'run-1' }), 'run-1')).toBe(true)
		expect(matchesParkedRun(item({ status: 'needs_input', runId: 'run-1' }), 'run-2')).toBe(false)
	})

	test('matches a legacy needs_input item with no runId by its continuesFrom', () => {
		expect(matchesParkedRun(item({ status: 'needs_input', continuesFrom: 'run-1' }), 'run-1')).toBe(true)
		expect(matchesParkedRun(item({ status: 'needs_input', runId: '', continuesFrom: 'run-1' }), 'run-1')).toBe(true)
		expect(matchesParkedRun(item({ status: 'needs_input', continuesFrom: 'run-1' }), 'run-2')).toBe(false)
	})

	test('never matches a non-parked item', () => {
		expect(matchesParkedRun(item({ status: 'waiting', continuesFrom: 'run-1' }), 'run-1')).toBe(false)
		expect(matchesParkedRun(item({ status: 'active', runId: 'run-1' }), 'run-1')).toBe(false)
	})
})
