import { describe, expect, test } from 'bun:test'
import type { TaskThreadEntry } from './model.js'
import { paginateTaskThreadEntries, TASK_THREAD_DEFAULT_PAGE_SIZE, TASK_THREAD_MAX_PAGE_SIZE } from './pagination.js'
import type { TaskThreadPage } from './pagination.js'

function entry(sequence: number): TaskThreadEntry {
	return {
		id: `entry-${sequence}`,
		sequence,
		runId: 'run-20260101-000000',
		timestamp: `2026-01-01T00:${String(sequence).padStart(2, '0')}:00.000Z`,
		kind: sequence === 0 ? 'task' : 'system',
		actor: sequence === 0 ? 'human' : 'system',
		label: sequence === 0 ? 'Initial task' : `System ${sequence}`,
		text: `text ${sequence}`,
		context: null,
		status: null,
		systemKind: sequence === 0 ? null : 'notice',
		outcome: null,
		questionId: null,
		relatedEntryId: null,
		queueItemId: null,
		source: 'log',
		textTruncated: false,
	}
}

function entries(count: number): TaskThreadEntry[] {
	return Array.from({ length: count }, (_, sequence) => entry(sequence))
}

function pageOf(result: ReturnType<typeof paginateTaskThreadEntries>): TaskThreadPage {
	if (result.kind !== 'page') throw new Error('expected a page result')
	return result.page
}

describe('paginateTaskThreadEntries', () => {
	test('defaults invalid, non-integer, and non-positive limits', () => {
		const count = TASK_THREAD_DEFAULT_PAGE_SIZE + 20
		for (const limit of [undefined, 0, -5, 1.5, Number.NaN]) {
			expect(pageOf(paginateTaskThreadEntries(entries(count), { limit })).entries.length).toBe(TASK_THREAD_DEFAULT_PAGE_SIZE + 1)
		}
	})

	test('keeps valid limits and clamps larger ones', () => {
		const clamped = pageOf(paginateTaskThreadEntries(entries(TASK_THREAD_MAX_PAGE_SIZE + 20), { limit: TASK_THREAD_MAX_PAGE_SIZE + 5 }))
		expect(clamped.entries.length).toBe(TASK_THREAD_MAX_PAGE_SIZE + 1)
		expect(clamped.pagination.nextCursor).toBe('entry-20')
	})

	test('returns the newest window plus a pinned initial task', () => {
		const page = pageOf(paginateTaskThreadEntries(entries(10), { limit: 3 }))
		expect(page.entries.map((item) => item.id)).toEqual(['entry-0', 'entry-7', 'entry-8', 'entry-9'])
		expect(page.pagination).toEqual({ hasMoreOlder: true, nextCursor: 'entry-7' })
	})

	test('does not duplicate the initial task when it is already inside the window', () => {
		const page = pageOf(paginateTaskThreadEntries(entries(4), { limit: 3 }))
		expect(page.entries.map((item) => item.id)).toEqual(['entry-0', 'entry-1', 'entry-2', 'entry-3'])
		expect(page.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
	})

	test('pages older entries before the cursor and stops at the pinned initial task', () => {
		const first = pageOf(paginateTaskThreadEntries(entries(10), { limit: 3 }))
		const second = pageOf(paginateTaskThreadEntries(entries(10), { limit: 3, before: 'entry-7' }))
		const third = pageOf(paginateTaskThreadEntries(entries(10), { limit: 3, before: 'entry-4' }))
		const fourth = pageOf(paginateTaskThreadEntries(entries(10), { limit: 3, before: 'entry-1' }))
		const initialOnly = pageOf(paginateTaskThreadEntries(entries(10), { limit: 3, before: 'entry-0' }))
		expect(second.entries.map((item) => item.id)).toEqual(['entry-0', 'entry-4', 'entry-5', 'entry-6'])
		expect(second.pagination).toEqual({ hasMoreOlder: true, nextCursor: 'entry-4' })
		expect(third.entries.map((item) => item.id)).toEqual(['entry-0', 'entry-1', 'entry-2', 'entry-3'])
		expect(third.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
		expect(fourth.entries.map((item) => item.id)).toEqual(['entry-0'])
		expect(fourth.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
		expect(initialOnly.entries.map((item) => item.id)).toEqual(['entry-0'])
		expect(initialOnly.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
		expect(first.pagination.nextCursor).toBe('entry-7')
	})

	test('rejects an unknown cursor instead of falling back to the newest page', () => {
		expect(paginateTaskThreadEntries(entries(10), { limit: 3, before: 'not-an-entry' })).toEqual({ kind: 'invalid_cursor' })
		expect(paginateTaskThreadEntries(entries(10), { limit: 3, before: '' })).toEqual({ kind: 'invalid_cursor' })
		expect(paginateTaskThreadEntries(entries(10), { limit: 3, before: 'entry-0' }).kind).toBe('page')
	})

	test('handles empty and single-entry threads', () => {
		expect(pageOf(paginateTaskThreadEntries([], { limit: 3 }))).toEqual({ entries: [], pagination: { hasMoreOlder: false, nextCursor: null } })
		const single = pageOf(paginateTaskThreadEntries([entry(0)], { limit: 3 }))
		expect(single.entries.map((item) => item.id)).toEqual(['entry-0'])
		expect(single.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
	})
})
