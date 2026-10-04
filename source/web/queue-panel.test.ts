import { describe, expect, test } from 'bun:test'
import { backlogCount, deriveQueueSections, deriveReorderPosition, isQueueItemLike, queueItemPrimaryText, queueStatusLabel, reorderWaitingItems, RECENT_QUEUE_LIMIT, taskFirstLine } from './static/queue-panel.js'

// The panel logic is browser-pure JS, so the exports arrive with inferred types; the fixture shape below mirrors the queue item's wire shape (docs/queueing.md "The queue: storage, item model, state machine") the tests build against, mirroring the sibling flow-view.test.ts convention.
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
	})
})

describe('deriveQueueSections', () => {
	test('groups the polled items into the four panel sections in display order', () => {
		const sections = deriveQueueSections([
			item({ id: 'a', status: 'done', settledAt: '2026-01-01T00:01:00.000Z' }),
			item({ id: 'b' }),
			item({ id: 'c', status: 'needs_input' }),
			item({ id: 'd', status: 'active' }),
			item({ id: 'e', status: 'cancelled', settledAt: '2026-01-01T00:02:00.000Z' }),
			item({ id: 'f' }),
		])
		expect(sections.waiting.map((entry) => entry.id)).toEqual(['b', 'f'])
		expect(sections.active.map((entry) => entry.id)).toEqual(['d'])
		expect(sections.needsInput.map((entry) => entry.id)).toEqual(['c'])
		expect(sections.recent.map((entry) => entry.id)).toEqual(['e', 'a'])
	})

	test('orders the recent bucket newest-settled first and caps it', () => {
		const settled = Array.from({ length: RECENT_QUEUE_LIMIT + 3 }, (_unused, index) => item({ id: `s${index}`, status: 'done', settledAt: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z` }))
		const sections = deriveQueueSections(settled)
		expect(sections.recent.length).toBe(RECENT_QUEUE_LIMIT)
		expect(sections.recent[0]?.id).toBe(`s${RECENT_QUEUE_LIMIT + 2}`)
	})

	test('an empty queue yields four empty sections', () => {
		expect(deriveQueueSections([])).toEqual({ waiting: [], active: [], needsInput: [], recent: [] })
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
})

describe('queueItemPrimaryText', () => {
	test('prefers the question for needs_input and the result summary for settled items', () => {
		expect(queueItemPrimaryText(item({ status: 'needs_input', question: 'which database?' }))).toBe('which database?')
		expect(queueItemPrimaryText(item({ status: 'done', resultSummary: 'fixed it', settledAt: '2026-01-01T00:01:00.000Z' }))).toBe('fixed it')
		expect(queueItemPrimaryText(item({ status: 'error', resultSummary: 'blew up', settledAt: '2026-01-01T00:01:00.000Z' }))).toBe('blew up')
		expect(queueItemPrimaryText(item())).toBe('fix the parser bug')
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
