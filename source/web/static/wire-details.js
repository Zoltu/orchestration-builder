// The inspector transcript's per-turn wire-envelope session cache, shared shape with the operation-details controller (operation-details.js) but different semantics. The transcript renders each turn's NEW messages from the loaded log window's delta slices, while a turn's "on the wire" expander shows the complete request the model saw at that turn — the folded view the window endpoint reconstructs server-side (`GET /api/runs/:id/log?detail=<index>`). Those folded bodies are the largest material in the log, so the expander fetches on first open and caches per browser session here, keyed `<runId>|<eventIndex>`. Event indexes are stable within a run (the log is append-only), and the run id in the key keeps a previous run's entries from answering for another run's same-numbered event.
//
// Two deliberate departures from the operation-details controller: a failed landing evicts rather than caching — a cached failure would block the retry a reopen schedules forever, so one transient 500 cannot poison a turn for the session — and the cache is bounded, evicting its oldest entry past `maxEntries` since a long inspection session could otherwise accumulate one folded conversation per opened turn (an evicted expander re-fetches on reopen). A cached null — the endpoint's explicit "this event carries no detail sections" — is a valid ready state, so a body-less turn is fetched once like any other.

import { isObject } from './guards.js'

// The shipped cache bound: folded conversations ride the response whole, so the cache holds a bounded number of opened turns and re-fetches an evicted one on reopen.
export const WIRE_DETAIL_CACHE_LIMIT = 100

/**
 * The lookup state for one turn's wire envelope: nothing fetched yet (a miss), the fetch in flight, or the server's answer — `sections` pairs the folded bodies under machine labels and is the explicit null when the event carries none.
 *
 * @typedef {{ status: 'idle' } | { status: 'loading' } | { status: 'ready', sections: Array<{label: string, content: unknown}> | null }} WireDetailState
 */

/**
 * @typedef {Object} WireDetailsController
 * @property {(runId: string, eventIndex: number) => WireDetailState} lookup the cache's state for one turn; a miss reads as idle so the host can distinguish "not fetched" from "in flight"
 * @property {(runId: string, eventIndex: number) => boolean} begin marks an uncached turn 'loading' synchronously (so the open's first render reads a defined state) and returns whether it started — the host builds exactly one fetch per true
 * @property {(runId: string, eventIndex: number, ok: boolean, body: unknown) => void} recordResponse records a resolved fetch: an ok body carrying `detailSections` as an array (or an explicit null) reads ready; anything else evicts so reopening retries
 * @property {(runId: string, eventIndex: number) => void} recordFailure records a fetch that never produced a response by evicting, so reopening retries
 */

/**
 * @param {{ maxEntries: number }} options the entry bound past which the oldest cached turn is evicted
 * @returns {WireDetailsController}
 */
export function createWireDetails(options) {
	const { maxEntries } = options
	if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('createWireDetails: maxEntries must be a positive integer')
	const cache = new Map()

	function keyOf(runId, eventIndex) {
		return `${runId}|${eventIndex}`
	}

	function evictOldestPastCap() {
		while (cache.size > maxEntries) {
			const eldest = cache.keys().next()
			if (eldest.done) break
			cache.delete(eldest.value)
		}
	}

	function evict(runId, eventIndex) {
		cache.delete(keyOf(runId, eventIndex))
	}

	function lookup(runId, eventIndex) {
		const entry = cache.get(keyOf(runId, eventIndex))
		return entry === undefined ? { status: 'idle' } : entry
	}

	function begin(runId, eventIndex) {
		const key = keyOf(runId, eventIndex)
		if (cache.has(key)) return false
		cache.set(key, { status: 'loading' })
		evictOldestPastCap()
		return true
	}

	function recordResponse(runId, eventIndex, ok, body) {
		const sections = readySectionsOf(ok, body)
		if (sections === undefined) {
			evict(runId, eventIndex)
			return
		}
		cache.set(keyOf(runId, eventIndex), { status: 'ready', sections })
		evictOldestPastCap()
	}

	return { lookup, begin, recordResponse, recordFailure: evict }
}

// The shared read of a detail response body, identical across the wires: only an ok response carrying an object whose `detailSections` is an array (or an explicit null for "this event carries none") is ready; anything else returns undefined, which records the landing as an eviction — a failure must not block the reopen retry.
/**
 * @param {boolean} ok
 * @param {unknown} body
 * @returns {Array<{label: string, content: unknown}>|null|undefined}
 */
function readySectionsOf(ok, body) {
	if (!ok) return undefined
	if (!isObject(body)) return undefined
	if (Array.isArray(body['detailSections'])) return body['detailSections']
	if (body['detailSections'] === null) return null
	return undefined
}
