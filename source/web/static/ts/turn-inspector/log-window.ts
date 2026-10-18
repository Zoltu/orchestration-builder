import { isObject } from '../guards.js'
import { readEventIndex } from './values.js'
import type { TurnEntry } from './turns.js'

// The log-event window size: the initial tail fetch, the "older turns" page size, and the resync window after a poll-refresh gap all use it.
export const INSPECTOR_WINDOW_SIZE = 200

// The poll-refresh page cap: the largest gap one tail-refresh fetch can bridge (bounded by the endpoint's own limit cap).
export const INSPECTOR_PAGE_LIMIT = 500

// The loaded-range retention cap: while the modal sits open on an active run the tail refresh keeps appending to the loaded events, so past this many loaded events the poll takes the fresh-tail-window resync instead of appending.
export const INSPECTOR_RETENTION_LIMIT = INSPECTOR_WINDOW_SIZE * 20

// A log event as the windowed endpoint ships it: `{ index, timestamp, type, payload }`, where `index` is the event's log-wide position. The type carries the endpoint's contract; every field read stays behind its runtime guard.
export interface LogWindowEvent {
	index: number
	timestamp: string | null
	type: string
	payload: unknown
}

// The validated shape of one windowed-log response body. The events stay opaque here: the derivations re-guard every field they read.
export interface LogWindowBody {
	runId: string
	total: number
	offset: number
	events: unknown[]
}

// One loaded window: the unscoped tail or one explicit scope's server-filtered sequence.
export interface WindowState {
	loadState: 'loading' | 'ready' | 'failed'
	events: unknown[]
	total: number | null
	tailOffset: number | null
	entries: TurnEntry[]
	olderLoading: boolean
}

export function initialWindowState(): WindowState {
	return { loadState: 'loading', events: [], total: null, tailOffset: null, entries: [], olderLoading: false }
}

// The offset that starts the most recent `windowSize` events of a log with `total` events.
export function tailWindowOffset(total: unknown, windowSize: number): number {
	if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0) return 0
	if (!Number.isInteger(windowSize) || windowSize <= 0) return 0
	return Math.max(0, total - windowSize)
}

// The offset that starts one page of `pageSize` events before `tailOffset` (the current window's start).
export function olderWindowOffset(tailOffset: unknown, pageSize: number): number {
	if (typeof tailOffset !== 'number' || !Number.isInteger(tailOffset) || tailOffset <= 0) return 0
	if (!Number.isInteger(pageSize) || pageSize <= 0) return 0
	return Math.max(0, tailOffset - pageSize)
}

// How many events to fetch when paging back from `tailOffset` by `pageSize`: the gap between the two offsets, or 0 when there is nothing older to fetch.
export function olderFetchLimit(tailOffset: unknown, pageSize: number): number {
	if (typeof tailOffset !== 'number' || !Number.isInteger(tailOffset) || tailOffset <= 0) return 0
	if (!Number.isInteger(pageSize) || pageSize <= 0) return 0
	return tailOffset - olderWindowOffset(tailOffset, pageSize)
}

// True when events older than `tailOffset` may exist (the log has events before the loaded window).
export function canPageOlder(tailOffset: unknown): boolean {
	return typeof tailOffset === 'number' && Number.isInteger(tailOffset) && tailOffset > 0
}

// Whether a tail-refresh page must resync the loaded window instead of appending: the page cannot bridge to the new total, or the loaded range has grown past the retention cap. Malformed inputs read as "no resync".
export function tailRefreshMustResync(pageEventCount: unknown, pageOffset: unknown, pageTotal: unknown, loadedEventCount: unknown): boolean {
	if (typeof pageEventCount !== 'number' || !Number.isInteger(pageEventCount) || pageEventCount < 0) return false
	if (typeof pageOffset !== 'number' || !Number.isInteger(pageOffset) || pageOffset < 0) return false
	if (typeof pageTotal !== 'number' || !Number.isInteger(pageTotal) || pageTotal < 0) return false
	if (pageEventCount < pageTotal - pageOffset) return true
	return typeof loadedEventCount === 'number' && Number.isInteger(loadedEventCount) && loadedEventCount >= INSPECTOR_RETENTION_LIMIT
}

// Merges two windowed event lists into one deduped, log-order list. Rows without a usable global index are dropped; the merge judges the index, never the content.
export function mergeLogEvents(firstEvents: unknown, secondEvents: unknown): LogWindowEvent[] {
	const byIndex = new Map<number, LogWindowEvent>()
	const sources = [...(Array.isArray(firstEvents) ? firstEvents : []), ...(Array.isArray(secondEvents) ? secondEvents : [])]
	for (const event of sources) {
		if (!isLogWindowEventRow(event)) continue
		if (!byIndex.has(event['index'])) byIndex.set(event['index'], event)
	}
	return [...byIndex.values()].sort((a, b) => a['index'] - b['index'])
}

function isLogWindowEventRow(value: unknown): value is LogWindowEvent {
	if (!isObject(value)) return false
	return readEventIndex(value['index']) !== null
}

// The windowed-log fetch URL for one page: the optional instance scope filters server-side, and offset/limit window the (filtered) sequence.
export function logWindowUrl(runId: string, scopeRoleId: string | null, offset: number, limit: number): string {
	const scope = scopeRoleId !== null ? `&instance=${encodeURIComponent(scopeRoleId)}` : ''
	return `api/runs/${encodeURIComponent(runId)}/log?offset=${offset}&limit=${limit}${scope}`
}

// The loaded window list after an older page slots exactly in front of it, or null when the page cannot (a stale or diverged response): the log is append-only, so the page must end exactly where the loaded window begins.
export function olderPageSpliced(existingEvents: unknown, existingTailOffset: unknown, page: LogWindowBody): unknown[] | null {
	if (!Array.isArray(existingEvents)) return null
	if (page.offset + page.events.length !== existingTailOffset) return null
	return [...page.events, ...existingEvents]
}

// The loaded window list after a tail page appends, or null when it cannot (a response landing at an offset the window's end does not name, or an empty page with nothing to append).
export function tailPageAppended(existingEvents: unknown, existingTotal: unknown, page: LogWindowBody): unknown[] | null {
	if (!Array.isArray(existingEvents)) return null
	if (page.offset !== existingTotal) return null
	if (page.events.length === 0) return null
	return [...existingEvents, ...page.events]
}

// Validates one windowed-log response body. Run identity is checked by the session, which treats a body for another run as a stale response rather than a failure.
export function readLogWindowBody(value: unknown): LogWindowBody | null {
	if (!isObject(value)) return null
	const runId = value['runId']
	const total = value['total']
	const offset = value['offset']
	const events = value['events']
	if (typeof runId !== 'string') return null
	if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null
	if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null
	if (!Array.isArray(events)) return null
	return { runId, total, offset, events }
}
