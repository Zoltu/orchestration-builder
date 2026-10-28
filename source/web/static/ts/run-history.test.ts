import { describe, expect, test } from 'bun:test'
import { deriveHistoryEntries, lineageLink, queueItemLineageLink, runPrimaryLabel, runSummaryIndex } from './run-history.js'
import type { QueueItemLike } from './queue-panel.js'
import type { RunSummary } from './run-list-feed/index.js'

function item(overrides: Partial<QueueItemLike> = {}): QueueItemLike {
	return {
		id: 'item-1',
		task: 'fix the parser bug',
		status: 'waiting',
		queuedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

function summary(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
	return {
		runId,
		status: 'success',
		task: `task for ${runId}`,
		effort: 'standard',
		involvement: 'early-engagement',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		result: null,
		error: null,
		continuesFrom: null,
		suspension: null,
		summary: null,
		...overrides,
	}
}

describe('deriveHistoryEntries', () => {
	test('orders waiting, active, needs_input, then the remaining runs newest-first as given', () => {
		const entries = deriveHistoryEntries(
			[
				item({ id: 'waiting', status: 'waiting' }),
				item({ id: 'needs', status: 'needs_input', runId: 'run-needs' }),
				item({ id: 'active', status: 'active', runId: 'run-active' }),
				item({ id: 'settled', status: 'done', runId: 'run-settled' }),
			],
			[summary('run-3'), summary('run-needs'), summary('run-active'), summary('run-2')],
		)
		expect(entries.map((entry) => entry.kind === 'queued' ? entry.item.id : entry.summary.runId)).toEqual([
			'waiting',
			'active',
			'needs',
			'run-3',
			'run-2',
		])
	})

	test('an active item suppresses the run row it represents', () => {
		const entries = deriveHistoryEntries([item({ id: 'active', status: 'active', runId: 'run-1' })], [summary('run-1'), summary('run-0')])
		expect(entries.filter((entry) => entry.kind === 'run').map((entry) => entry.kind === 'run' ? entry.summary.runId : '')).toEqual(['run-0'])
	})

	test('a needs_input item suppresses its paused run row', () => {
		const entries = deriveHistoryEntries([item({ id: 'parked', status: 'needs_input', runId: 'run-1' })], [summary('run-1', { status: 'needs_clarification' })])
		expect(entries).toHaveLength(1)
		expect(entries[0]?.kind).toBe('queued')
	})

	test('a waiting item suppresses the paused run it will re-enter through resumesRunId', () => {
		const entries = deriveHistoryEntries([item({ id: 'answered', status: 'waiting', resumesRunId: 'run-1' })], [summary('run-1', { status: 'needs_clarification' })])
		expect(entries).toHaveLength(1)
		expect(entries[0]?.kind).toBe('queued')
	})

	test('a continuation waiting on a terminal parent leaves the parent as its own row', () => {
		const entries = deriveHistoryEntries(
			[item({ id: 'continuation', status: 'waiting', continuesFrom: 'run-parent' })],
			[summary('run-parent'), summary('run-older')],
		)
		expect(entries.map((entry) => entry.kind === 'queued' ? entry.item.id : entry.summary.runId)).toEqual(['continuation', 'run-parent', 'run-older'])
	})

	test('suppresses the run ids of every queued group, not only the active one', () => {
		const entries = deriveHistoryEntries(
			[
				item({ id: 'a', status: 'waiting', resumesRunId: 'run-a' }),
				item({ id: 'b', status: 'active', runId: 'run-b' }),
				item({ id: 'c', status: 'needs_input', runId: 'run-c' }),
			],
			[summary('run-a'), summary('run-b'), summary('run-c'), summary('run-free')],
		)
		expect(entries.map((entry) => entry.kind === 'queued' ? entry.item.id : entry.summary.runId)).toEqual(['a', 'b', 'c', 'run-free'])
	})

	test('a modern needs_input item keeps its real runId and its lineage parent visible', () => {
		const entries = deriveHistoryEntries(
			[item({ id: 'parked', status: 'needs_input', runId: 'run-paused', continuesFrom: 'run-parent' })],
			[summary('run-paused', { status: 'needs_clarification' }), summary('run-parent')],
		)
		expect(entries.map((entry) => entry.kind === 'queued' ? entry.item.id : entry.summary.runId)).toEqual(['parked', 'run-parent'])
	})
})

describe('runPrimaryLabel', () => {
	test('running and needs_clarification label the task first line and ignore stale summary/result prose', () => {
		expect(runPrimaryLabel(summary('run-1', { status: 'running', task: 'build the thing\nsecond line', summary: 'old completion text' }))).toBe('build the thing')
		expect(runPrimaryLabel(summary('run-2', { status: 'needs_clarification', task: 'answer me', summary: 'which database?' }))).toBe('answer me')
	})

	test('running and needs_clarification fall back to the run id when there is no task', () => {
		expect(runPrimaryLabel(summary('run-1', { status: 'running', task: null, summary: 'stale' }))).toBe('run-1')
		expect(runPrimaryLabel(summary('run-2', { status: 'needs_clarification', task: '', summary: 'stale' }))).toBe('run-2')
	})

	test('terminal success, error, interrupted, and unknown prefer the generated summary', () => {
		for (const status of ['success', 'error', 'interrupted', 'unknown'] as const) {
			expect(runPrimaryLabel(summary('run-1', { status, task: 'the task', summary: 'the outcome' }))).toBe('the outcome')
		}
	})

	test('terminal runs fall back to the task first line, then the run id', () => {
		expect(runPrimaryLabel(summary('run-1', { status: 'success', task: 'the task\nmore', summary: null }))).toBe('the task')
		expect(runPrimaryLabel(summary('run-2', { status: 'error', task: null, summary: '' }))).toBe('run-2')
	})
})

describe('lineageLink', () => {
	test('returns null without a continuesFrom id', () => {
		expect(lineageLink(null, [])).toBeNull()
		expect(lineageLink(undefined, [])).toBeNull()
		expect(lineageLink('', [])).toBeNull()
	})

	test('labels the parent with its own primary label when it is in the list', () => {
		const parent = summary('run-parent', { status: 'success', task: 'parent task', summary: 'parent outcome' })
		expect(lineageLink('run-parent', [parent])).toEqual({ runId: 'run-parent', label: 'parent outcome', available: true })
	})

	test('labels a paused parent by its task', () => {
		const parent = summary('run-parent', { status: 'needs_clarification', task: 'paused parent', summary: 'which database?' })
		expect(lineageLink('run-parent', [parent])).toEqual({ runId: 'run-parent', label: 'paused parent', available: true })
	})

	test('labels a missing parent by its id', () => {
		expect(lineageLink('run-gone', [summary('run-other')])).toEqual({ runId: 'run-gone', label: 'run-gone', available: false })
	})
})

describe('lineage lookup index', () => {
	test('builds one map keyed by run id and links against it without rescanning the summaries', () => {
		const summaries = [summary('run-a'), summary('run-b', { status: 'needs_clarification', task: 'paused task' })]
		const index = runSummaryIndex(summaries)
		expect(index.get('run-a')).toBe(summaries[0])
		expect(index.get('run-b')).toBe(summaries[1])
		expect(lineageLink('run-b', index)).toEqual({ runId: 'run-b', label: 'paused task', available: true })
		expect(lineageLink('run-missing', index)).toEqual({ runId: 'run-missing', label: 'run-missing', available: false })
	})
})

describe('queueItemLineageLink', () => {
	test('suppresses a self-reference to the item runId or resumesRunId', () => {
		const index = runSummaryIndex([summary('run-self', { status: 'needs_clarification' })])
		expect(queueItemLineageLink(item({ status: 'needs_input', runId: 'run-self', continuesFrom: 'run-self' }), index)).toBeNull()
		expect(queueItemLineageLink(item({ status: 'waiting', resumesRunId: 'run-self', continuesFrom: 'run-self' }), index)).toBeNull()
	})

	test('keeps a genuine parent link and a missing-parent link', () => {
		const index = runSummaryIndex([summary('run-parent', { summary: 'parent outcome' })])
		expect(queueItemLineageLink(item({ status: 'waiting', continuesFrom: 'run-parent' }), index)).toEqual({ runId: 'run-parent', label: 'parent outcome', available: true })
		expect(queueItemLineageLink(item({ status: 'waiting', continuesFrom: 'run-gone' }), index)).toEqual({ runId: 'run-gone', label: 'run-gone', available: false })
	})

	test('returns null without a continuesFrom id', () => {
		expect(queueItemLineageLink(item(), new Map())).toBeNull()
	})
})

describe('suspended history rows', () => {
	test('a suspended queue item is ordered before waiting work and suppresses its run row', () => {
		const entries = deriveHistoryEntries(
			[
				item({ id: 'waiting', status: 'waiting' }),
				item({ id: 'suspended', status: 'suspended', runId: 'run-s' }),
			],
			[summary('run-s', { status: 'suspended', suspension: { category: 'billing', resumePolicy: 'operator', message: 'Top up.', suspendedAt: '2026-01-01T00:02:00.000Z' } }), summary('run-old')],
		)
		expect(entries.map((entry) => entry.kind === 'queued' ? entry.item.id : entry.summary.runId)).toEqual(['suspended', 'waiting', 'run-old'])
	})

	test('a suspended run row labels the task first line, not stale summary prose', () => {
		expect(runPrimaryLabel(summary('run-1', { status: 'suspended', task: 'waiting on credit\nmore', summary: 'stale completion' }))).toBe('waiting on credit')
	})
})
