import { describe, expect, test } from 'bun:test'
import { backlogCount, deriveQueuedItems, deriveReorderPosition, isQueueItemLike, queueItemPrimaryText, queueStatusLabel, questionSummary, reorderWaitingItems, taskFirstLine } from './static/ts/queue-panel.js'

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

describe('questionSummary', () => {
	test('returns the first non-empty line, trimmed', () => {
		expect(questionSummary('which database?\nand which schema?')).toBe('which database?')
		expect(questionSummary('\n\n   which database?  \n')).toBe('which database?')
		expect(questionSummary('')).toBe('')
		expect(questionSummary('   \n\t ')).toBe('')
	})

	test('caps a long line at a word boundary with a trailing ellipsis', () => {
		const longSentence = `${'word '.repeat(20)}end`
		const summary = questionSummary(longSentence)
		expect(summary.endsWith('…')).toBe(true)
		expect(summary.length).toBeLessThanOrEqual(73)
		expect(summary.includes('  ')).toBe(false)
	})

	test('cuts at the last space when it falls past the floor', () => {
		const withBoundary = `${'word '.repeat(10)}${'x'.repeat(30)}`
		expect(questionSummary(withBoundary)).toBe(`${'word '.repeat(9)}word…`)
	})

	test('caps a long unbroken token at the limit', () => {
		const longWord = 'x'.repeat(100)
		expect(questionSummary(longWord)).toBe(`${longWord.slice(0, 72)}…`)
	})
})

describe('queueItemPrimaryText', () => {
	test('prefers a question preview for needs_input and the result summary for settled items', () => {
		expect(queueItemPrimaryText(item({ status: 'needs_input', question: 'which database?\nwith which user?' }))).toBe('which database?')
		expect(queueItemPrimaryText(item({ status: 'needs_input', question: '   \n  ' }))).toBe('fix the parser bug')
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
