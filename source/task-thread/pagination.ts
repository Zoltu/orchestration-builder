import type { TaskThreadEntry, TaskThreadPagination } from './model.js'

export const TASK_THREAD_DEFAULT_PAGE_SIZE = 500
export const TASK_THREAD_MAX_PAGE_SIZE = 1000

export interface TaskThreadPageRequest {
	limit?: number
	before?: string
}

export interface TaskThreadPage {
	entries: TaskThreadEntry[]
	pagination: TaskThreadPagination
}

export type TaskThreadPageResult =
	| { kind: 'page'; page: TaskThreadPage }
	| { kind: 'invalid_cursor' }

function normalizeTaskThreadPageLimit(limit: number | undefined): number {
	if (limit === undefined) return TASK_THREAD_DEFAULT_PAGE_SIZE
	if (!Number.isInteger(limit) || limit <= 0) return TASK_THREAD_DEFAULT_PAGE_SIZE
	return Math.min(limit, TASK_THREAD_MAX_PAGE_SIZE)
}

function normalizeEntries(entries: readonly TaskThreadEntry[]): TaskThreadEntry[] {
	return [...entries].sort((left, right) => left.sequence - right.sequence)
}

function findCursorIndex(entries: readonly TaskThreadEntry[], before: string | undefined): number {
	if (before === undefined) return -1
	return entries.findIndex((entry) => entry.id === before)
}

// The initial task stays pinned even when it falls outside the page window, so the drawer always shows the task the run started from.
// The next cursor is the oldest entry in the window, not the pinned initial task; paging before the pinned task would return nothing older.
export function paginateTaskThreadEntries(entries: readonly TaskThreadEntry[], request: TaskThreadPageRequest): TaskThreadPageResult {
	const limit = normalizeTaskThreadPageLimit(request.limit)
	const ordered = normalizeEntries(entries)
	const cursorIndex = findCursorIndex(ordered, request.before)
	if (request.before !== undefined && cursorIndex < 0) return { kind: 'invalid_cursor' }
	const initial = ordered[0]
	if (initial === undefined) return { kind: 'page', page: { entries: [], pagination: { hasMoreOlder: false, nextCursor: null } } }
	const windowEnd = cursorIndex >= 0 ? cursorIndex : ordered.length
	const windowStart = Math.max(0, windowEnd - limit)
	const windowEntries = ordered.slice(windowStart, windowEnd)
	const hasMoreOlder = windowStart > 1
	const nextCursor = hasMoreOlder ? windowEntries[0]?.id ?? null : null
	const pageById = new Map<string, TaskThreadEntry>()
	pageById.set(initial.id, initial)
	for (const entry of windowEntries) {
		if (!pageById.has(entry.id)) pageById.set(entry.id, entry)
	}
	const pageEntries = [...pageById.values()].sort((left, right) => left.sequence - right.sequence)
	return { kind: 'page', page: { entries: pageEntries, pagination: { hasMoreOlder, nextCursor } } }
}
