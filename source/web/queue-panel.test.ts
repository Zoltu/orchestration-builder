import { describe, expect, test } from 'bun:test'
import { backlogCount, deriveQueuedItems, deriveRunOrderItems, deriveRunOrderPosition, isOperatorPausedItem, isPausedPostWrite, isPausedPreWrite, isQueueItemLike, matchesParkedRun, queueItemPrimaryText, queueRowPauseKind, queueStatusLabel, queueStatusText, reorderRunOrderItems, runOrderHint, taskFirstLine, writeStateLabel } from './static/ts/queue-panel.js'

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

	test('accepts an optional well-formed pause record and rejects a malformed one', () => {
		const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
		expect(isQueueItemLike(item({ status: 'suspended', runId: 'run-s', pause }))).toBe(true)
		expect(isQueueItemLike({ ...item(), pause: { message: 7, pausedAt: '2026-01-01T00:02:00.000Z' } })).toBe(false)
		expect(isQueueItemLike({ ...item(), pause: { message: 'Paused.', pausedAt: null } })).toBe(false)
	})

	test('accepts optional question, context, and assistant fallback strings and rejects non-string values', () => {
		expect(isQueueItemLike(item({ status: 'needs_input', runId: 'run-c', question: 'which database?', context: 'a context', assistantFallback: 'a fallback' }))).toBe(true)
		expect(isQueueItemLike({ ...item(), question: 7 })).toBe(false)
		expect(isQueueItemLike({ ...item(), context: ['not', 'a', 'string'] })).toBe(false)
		expect(isQueueItemLike({ ...item(), assistantFallback: null })).toBe(false)
	})

	test('accepts only the yielded true marker on suspended or active rows, and a boolean or null write state', () => {
		expect(isQueueItemLike(item({ status: 'suspended', yielded: true, writeCapableStarted: false }))).toBe(true)
		expect(isQueueItemLike(item({ status: 'active', yielded: true, writeCapableStarted: true }))).toBe(true)
		expect(isQueueItemLike(item({ status: 'active', writeCapableStarted: true }))).toBe(true)
		expect(isQueueItemLike(item({ status: 'active', writeCapableStarted: null }))).toBe(true)
		expect(isQueueItemLike(item({ status: 'waiting', writeCapableStarted: undefined }))).toBe(true)
		expect(isQueueItemLike({ ...item(), yielded: false })).toBe(false)
		expect(isQueueItemLike({ ...item(), yielded: 'yes' })).toBe(false)
		expect(isQueueItemLike({ ...item({ status: 'waiting' }), yielded: true })).toBe(false)
		expect(isQueueItemLike({ ...item({ status: 'needs_input' }), yielded: true })).toBe(false)
		expect(isQueueItemLike({ ...item(), writeCapableStarted: 'no' })).toBe(false)
	})
})

describe('deriveQueuedItems', () => {
	test('groups the polled items into the queued groups in display order and drops the settled and malformed ones', () => {
		const queued = deriveQueuedItems([
			item({ id: 'a', status: 'done', settledAt: '2026-01-01T00:01:00.000Z' }),
			item({ id: 'b' }),
			{ id: 'malformed', task: '', status: 'waiting', queuedAt: '2026-01-01T00:00:00.000Z' },
			item({ id: 'c', status: 'needs_input', runId: 'run-c' }),
			item({ id: 'd', status: 'active' }),
			item({ id: 'e', status: 'cancelled', settledAt: '2026-01-01T00:02:00.000Z' }),
			item({ id: 'f' }),
		])
		expect(queued.suspended).toEqual([])
		expect(queued.runOrder.map((entry) => entry.id)).toEqual(['b', 'f'])
		expect(queued.active.map((entry) => entry.id)).toEqual(['d'])
		expect(queued.needsInput.map((entry) => entry.id)).toEqual(['c'])
	})

	test('an empty queue yields every empty group', () => {
		expect(deriveQueuedItems([])).toEqual({ suspended: [], runOrder: [], active: [], needsInput: [] })
	})

	test('distinguishes priority suspended rows from pre-write operator pauses in the run order', () => {
		const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
		const queued = deriveQueuedItems([
			item({ id: 'waiting' }),
			item({ id: 'provider', status: 'suspended', runId: 'run-provider' }),
			item({ id: 'pre', status: 'suspended', runId: 'run-pre', pause, writeCapableStarted: false }),
			item({ id: 'post', status: 'suspended', runId: 'run-post', pause, writeCapableStarted: true }),
			item({ id: 'unknown', status: 'suspended', runId: 'run-unknown', pause, writeCapableStarted: null }),
			item({ id: 'yielded', status: 'suspended', runId: 'run-yielded', pause, yielded: true, writeCapableStarted: false }),
		])
		expect(queued.suspended.map((entry) => entry.id)).toEqual(['provider', 'post', 'unknown'])
		expect(queued.runOrder.map((entry) => entry.id)).toEqual(['waiting', 'pre', 'yielded'])
	})

	test('a parked item keeps its question, context, and assistant fallback through the guard and projection', () => {
		const queued = deriveQueuedItems([item({ id: 'parked', status: 'needs_input', runId: 'run-p', question: 'which database?', context: 'a context', assistantFallback: 'a fallback' })])
		expect(queued.needsInput[0]).toMatchObject({ id: 'parked', question: 'which database?', context: 'a context', assistantFallback: 'a fallback' })
	})
})

describe('backlogCount', () => {
	test('counts the waiting and needs_input items only', () => {
		expect(backlogCount([
			item({ id: 'a' }),
			item({ id: 'b', status: 'active' }),
			item({ id: 'c', status: 'needs_input', runId: 'run-c' }),
			item({ id: 'd', status: 'done' }),
		])).toBe(2)
	})
})

describe('queueStatusLabel', () => {
	test('maps every status to its display label and falls back to the raw status', () => {
		expect(queueStatusLabel('waiting')).toBe('waiting')
		expect(queueStatusLabel('active')).toBe('running')
		expect(queueStatusLabel('suspended')).toBe('suspended')
		expect(queueStatusLabel('needs_input')).toBe('needs your answer')
		expect(queueStatusLabel('mysterious')).toBe('mysterious')
	})

	test('an operator-paused row reads Paused while a provider suspension reads Suspended or needs attention', () => {
		expect(queueStatusLabel('suspended', 'operator')).toBe('paused')
		expect(queueStatusLabel('suspended', 'provider')).toBe('suspended')
		expect(queueStatusLabel('suspended', 'provider', true)).toBe('needs attention')
		expect(queueStatusLabel('suspended', 'operator', true)).toBe('paused')
	})

	test('a suspended row takes its pause kind from the item record or the matching run summary', () => {
		const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
		const pausedItem = item({ status: 'suspended', runId: 'run-s', pause })
		expect(queueRowPauseKind(pausedItem, undefined)).toBe('operator')
		expect(queueRowPauseKind(item({ status: 'suspended', runId: 'run-s' }), { status: 'suspended', pause })).toBe('operator')
		expect(queueRowPauseKind(item({ status: 'suspended', runId: 'run-s' }), { status: 'suspended', suspension: { category: 'billing' } })).toBe('provider')
	})
})

describe('queueStatusText', () => {
	test('a yielded suspended pause reads queued before writing, while an active yielded marker keeps the normal running label', () => {
		const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
		expect(queueStatusText(item({ status: 'suspended', runId: 'run-s', pause, yielded: true, writeCapableStarted: false }), 'operator')).toBe('queued before writing')
		expect(queueStatusText(item({ status: 'active', runId: 'run-s', pause, yielded: true, writeCapableStarted: false }), 'none')).toBe('running')
	})

	test('a non-yielded suspended row keeps its pause label', () => {
		const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
		expect(queueStatusText(item({ status: 'suspended', runId: 'run-s', pause, writeCapableStarted: false }), 'operator')).toBe('paused')
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
		expect(queueItemPrimaryText(item({ status: 'needs_input', runId: 'run-c', question: 'which database?\nwith which user?' }))).toBe('fix the parser bug')
		expect(queueItemPrimaryText(item({ status: 'active', task: 'a running task\nsecond line' }))).toBe('a running task')
		expect(queueItemPrimaryText(item())).toBe('fix the parser bug')
	})

	test('a needs_input item whose task is long still shows the bounded task line, never the question', () => {
		const longTask = `${'t'.repeat(120)}\nquestion follows`
		expect(queueItemPrimaryText(item({ status: 'needs_input', runId: 'run-c', task: longTask, question: 'which database?' }))).toBe(`${'t'.repeat(100)}…`)
	})
})

const operatorPause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }

describe('run-order write-state helpers', () => {
	test('an operator pause is identified from the item pause record, never from a provider suspension or a non-suspended row', () => {
		expect(isOperatorPausedItem(item({ status: 'suspended', runId: 'run-s', pause: operatorPause }))).toBe(true)
		expect(isOperatorPausedItem(item({ status: 'suspended', runId: 'run-s' }))).toBe(false)
		expect(isOperatorPausedItem(item({ status: 'waiting', pause: operatorPause }))).toBe(false)
		expect(isOperatorPausedItem(item({ status: 'active', runId: 'run-a', pause: operatorPause }))).toBe(false)
	})

	test('pre-write and post-write require an operator pause plus a known write state; unknown and provider rows match neither', () => {
		const pre = item({ status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: false })
		const post = item({ status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: true })
		const unknown = item({ status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: null })
		const provider = item({ status: 'suspended', runId: 'run-s', writeCapableStarted: false })
		expect(isPausedPreWrite(pre)).toBe(true)
		expect(isPausedPreWrite(post)).toBe(false)
		expect(isPausedPreWrite(unknown)).toBe(false)
		expect(isPausedPreWrite(provider)).toBe(false)
		expect(isPausedPostWrite(post)).toBe(true)
		expect(isPausedPostWrite(pre)).toBe(false)
		expect(isPausedPostWrite(provider)).toBe(false)
	})

	test('a yielded marker with a null write state stays out of the pre-write run order', () => {
		const yieldedUnknown = item({ status: 'suspended', runId: 'run-y', pause: operatorPause, yielded: true, writeCapableStarted: null })
		expect(isPausedPreWrite(yieldedUnknown)).toBe(false)
		expect(writeStateLabel(yieldedUnknown)).toBe('Write state unknown')
		expect(deriveRunOrderItems([yieldedUnknown])).toEqual([])
		expect(deriveQueuedItems([yieldedUnknown]).suspended.map((entry) => entry.id)).toEqual(['item-1'])
	})

	test('writeStateLabel reports the state only for active and suspended rows, with unknown for null or absent', () => {
		expect(writeStateLabel(item({ status: 'active', writeCapableStarted: false }))).toBe('Pre-write')
		expect(writeStateLabel(item({ status: 'suspended', writeCapableStarted: true }))).toBe('Post-write')
		expect(writeStateLabel(item({ status: 'suspended', writeCapableStarted: null }))).toBe('Write state unknown')
		expect(writeStateLabel(item({ status: 'active' }))).toBe('Write state unknown')
		expect(writeStateLabel(item({ status: 'waiting' }))).toBeNull()
		expect(writeStateLabel(item({ status: 'needs_input' }))).toBeNull()
	})
})

describe('deriveRunOrderItems', () => {
	test('keeps waiting and operator-paused pre-write suspended rows in file order, including a yielded pause', () => {
		const items = [
			item({ id: 'waiting-a' }),
			item({ id: 'active', status: 'active', runId: 'run-a' }),
			item({ id: 'provider', status: 'suspended', runId: 'run-p' }),
			item({ id: 'pre', status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: false }),
			item({ id: 'waiting-b' }),
			item({ id: 'post', status: 'suspended', runId: 'run-post', pause: operatorPause, writeCapableStarted: true }),
			item({ id: 'unknown', status: 'suspended', runId: 'run-u', pause: operatorPause, writeCapableStarted: null }),
			item({ id: 'yielded', status: 'suspended', runId: 'run-y', pause: operatorPause, yielded: true, writeCapableStarted: false }),
		]
		expect(deriveRunOrderItems(items).map((entry) => entry.id)).toEqual(['waiting-a', 'pre', 'waiting-b', 'yielded'])
	})
})

describe('deriveRunOrderPosition', () => {
	test('returns the target index among the run-order items excluding the dragged row, or null when either row is not orderable', () => {
		const items = [
			item({ id: 'a' }),
			item({ id: 'active', status: 'active' }),
			item({ id: 'pre', status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: false }),
			item({ id: 'b' }),
			item({ id: 'post', status: 'suspended', runId: 'run-post', pause: operatorPause, writeCapableStarted: true }),
			item({ id: 'c' }),
		]
		expect(deriveRunOrderPosition(items, 'a', 'pre')).toBe(0)
		expect(deriveRunOrderPosition(items, 'a', 'c')).toBe(2)
		expect(deriveRunOrderPosition(items, 'pre', 'b')).toBe(1)
		expect(deriveRunOrderPosition(items, 'a', 'a')).toBeNull()
		expect(deriveRunOrderPosition(items, 'a', 'active')).toBeNull()
		expect(deriveRunOrderPosition(items, 'active', 'b')).toBeNull()
		expect(deriveRunOrderPosition(items, 'a', 'missing')).toBeNull()
	})
})

describe('reorderRunOrderItems', () => {
	test('moves the dragged orderable row among the run order while non-orderable rows keep their file positions', () => {
		const items = [
			item({ id: 'a' }),
			item({ id: 'active', status: 'active' }),
			item({ id: 'pre', status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: false }),
			item({ id: 'b' }),
			item({ id: 'post', status: 'suspended', runId: 'run-post', pause: operatorPause, writeCapableStarted: true }),
			item({ id: 'c' }),
		]
		expect(reorderRunOrderItems(items, 'a', 5).map((entry) => entry.id)).toEqual(['pre', 'active', 'b', 'c', 'post', 'a'])
		expect(reorderRunOrderItems(items, 'a', 1).map((entry) => entry.id)).toEqual(['pre', 'active', 'a', 'b', 'post', 'c'])
		expect(reorderRunOrderItems(items, 'pre', 0).map((entry) => entry.id)).toEqual(['pre', 'active', 'a', 'b', 'post', 'c'])
		expect(reorderRunOrderItems(items, 'active', 0)).toBe(items)
		expect(reorderRunOrderItems(items, 'post', 0)).toBe(items)
		expect(reorderRunOrderItems(items, 'missing', 0)).toBe(items)
	})
})

describe('runOrderHint', () => {
	test('names the first row and counts the runnable tasks ahead of every later row', () => {
		const items = [
			item({ id: 'a' }),
			item({ id: 'active', status: 'active' }),
			item({ id: 'pre', status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: false }),
			item({ id: 'b' }),
			item({ id: 'post', status: 'suspended', runId: 'run-post', pause: operatorPause, writeCapableStarted: true }),
		]
		expect(runOrderHint(item({ id: 'a' }), items)).toBe('First in run order')
		expect(runOrderHint(item({ id: 'pre', status: 'suspended', runId: 'run-s', pause: operatorPause, writeCapableStarted: false }), items)).toBe('1 runnable task ahead')
		expect(runOrderHint(item({ id: 'b' }), items)).toBe('2 runnable tasks ahead')
		expect(runOrderHint(item({ id: 'active', status: 'active' }), items)).toBeNull()
		expect(runOrderHint(item({ id: 'post', status: 'suspended', runId: 'run-post', pause: operatorPause, writeCapableStarted: true }), items)).toBeNull()
	})
})

describe('matchesParkedRun', () => {
	test('matches a parked item by its runId', () => {
		expect(matchesParkedRun(item({ status: 'needs_input', runId: 'run-1' }), 'run-1')).toBe(true)
		expect(matchesParkedRun(item({ status: 'needs_input', runId: 'run-1' }), 'run-2')).toBe(false)
	})

	test('does not match a parked item without a runId, even when continuesFrom names the run', () => {
		expect(matchesParkedRun(item({ status: 'needs_input', continuesFrom: 'run-1' }), 'run-1')).toBe(false)
		expect(matchesParkedRun(item({ status: 'needs_input', runId: '', continuesFrom: 'run-1' }), 'run-1')).toBe(false)
	})

	test('never matches a non-parked item', () => {
		expect(matchesParkedRun(item({ status: 'waiting', continuesFrom: 'run-1' }), 'run-1')).toBe(false)
		expect(matchesParkedRun(item({ status: 'active', runId: 'run-1' }), 'run-1')).toBe(false)
	})
})

describe('suspended queue rows', () => {
	test('groups suspended items before waiting and keeps needs_input unchanged', () => {
		const queued = deriveQueuedItems([
			item({ id: 'waiting', status: 'waiting' }),
			item({ id: 'suspended', status: 'suspended', runId: 'run-s', suspendedAt: '2026-01-01T00:02:00.000Z' }),
			item({ id: 'needs', status: 'needs_input', runId: 'run-n' }),
		])
		expect(queued.suspended.map((entry) => entry.id)).toEqual(['suspended'])
		expect(queued.needsInput.map((entry) => entry.id)).toEqual(['needs'])
	})

	test('counts a suspended pause, including a yielded pause, in the backlog because it blocks dispatch', () => {
		expect(backlogCount([
			item({ id: 'a' }),
			item({ id: 'b', status: 'suspended', runId: 'run-b' }),
			item({ id: 'c', status: 'active' }),
			item({ id: 'd', status: 'suspended', runId: 'run-d', pause: operatorPause, yielded: true, writeCapableStarted: false }),
		])).toBe(3)
	})

	test('a provider suspended row is not a reorder source or target, while a pre-write pause is', () => {
		const items = [
			item({ id: 'a', status: 'waiting' }),
			item({ id: 's', status: 'suspended', runId: 'run-s' }),
			item({ id: 'p', status: 'suspended', runId: 'run-p', pause: operatorPause, writeCapableStarted: false }),
			item({ id: 'b', status: 'waiting' }),
		]
		expect(deriveRunOrderPosition(items, 'a', 's')).toBeNull()
		expect(reorderRunOrderItems(items, 's', 0)).toBe(items)
		expect(deriveRunOrderPosition(items, 'a', 'p')).toBe(0)
		expect(reorderRunOrderItems(items, 'a', 1).map((entry) => entry.id)).toEqual(['p', 's', 'a', 'b'])
	})
})
