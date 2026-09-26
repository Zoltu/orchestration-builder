// The operation-details session cache machine shared by the product client (app.js) and the dev harness (demo.js). The flow/frame models ship no per-operation detail bodies (they can carry multi-megabyte tool arguments/results and would ride every polled frame), so when a surface that may show details opens, the host derives the operation ids it needs, the machine marks each uncached id 'loading' and arranges the fetch, and every landing — response or failure — fans out to the host so the waiting surfaces (an open inspector card, a question modal) fill in. See tooltip.js "On-demand operation details" for the lookup protocol the tooltip derivations read.
//
// The cache key is `<context>|<operationId>`; the context half is the host's scoping id (the product client scopes by run id, the harness by scenario id) so one cache serves every context without cross-answering for the same-numbered operation. Operation ids are stable within a context (events only append), so an entry never goes stale and the cache never evicts: a landed id — ready or failed — is final for the session and is never re-fetched.
//
// The cache stores the lookup-protocol shape itself, so a host's lookup passes entries through verbatim. Two host profiles drive the same machine: hosts whose fetches are effect-driven (the product client's hyperapp Fetch effects, whose ok/fail actions must return fresh state to trigger the re-render) call `begin` for the ids and `recordResponse`/`recordFailure` from their landing actions; hosts with a plain fetch call `ensure`, which begins the ids and drives `fetchDetail` + the `onLanded` fan-out itself.

import { isObject } from './guards.js'

/**
 * The lookup state for one operation's details (the shape tooltip.js "On-demand operation details" defines): the fetch is in flight, the fetch failed (the surface renders section-less), or the server's answer — null when the operation carries no detail material at all.
 *
 * @typedef {{ status: 'loading' } | { status: 'failed' } | { status: 'ready', details: string | null }} OperationDetailsState
 */

/**
 * A details landing the host's `fetchDetail` resolves with: the response's ok flag and its already-parsed body (any shape — the machine validates the body itself).
 *
 * @typedef {Object} OperationDetailsLanding
 * @property {boolean} ok
 * @property {unknown} body
 */

/**
 * @typedef {(context: string, operationId: string) => Promise<OperationDetailsLanding>} FetchOperationDetail
 */

/**
 * The landing fan-out: called with the context and operation id after every landing, so the host can refill the surfaces waiting on that id (the harness refills its open inspector card and fills the question modal; the product client's effect-driven actions re-render instead and pass no callback).
 *
 * @typedef {(context: string, operationId: string) => void} OnOperationDetailsLanded
 */

/**
 * @typedef {Object} OperationDetailsDependencies
 * @property {FetchOperationDetail} [fetchDetail] required only by `ensure`-driven hosts; the effect-driven host never calls it
 * @property {OnOperationDetailsLanded} [onLanded] the landing fan-out; absent, landing only updates the cache (the host reacts through its own actions)
 */

/**
 * @typedef {Object} OperationDetailsController
 * @property {(context: string, operationId: string) => OperationDetailsState} lookup the cache's state for one id; a miss reads as 'failed' so a surface never blocks or invents content on a cache that has not answered
 * @property {(context: string, operationIds: string[]) => string[]} begin marks each uncached id 'loading' synchronously (so the first render reads a defined state) and returns exactly the ids it started, deduped against the cache — an effect-driven host builds one fetch per returned id
 * @property {(context: string, operationIds: string[]) => void} ensure the fetch-on-demand entry: begins the ids and drives `fetchDetail` for each, recording the landing and firing the fan-out
 * @property {(context: string, operationId: string, ok: boolean, body: unknown) => void} recordResponse records a resolved fetch: a ok body carrying a string `details` (or an explicit null) reads as ready, anything else — not-ok, a non-object body, a missing details field — as failed
 * @property {(context: string, operationId: string) => void} recordFailure records a fetch that never produced a response (network failure, unparseable body) as failed
 */

const LOADING = { status: 'loading' }
const FAILED = { status: 'failed' }

/**
 * @param {OperationDetailsDependencies} dependencies
 * @returns {OperationDetailsController}
 */
export function createOperationDetails(dependencies) {
	const { fetchDetail, onLanded } = dependencies
	const cache = new Map()

	function keyOf(context, operationId) {
		return `${context}|${operationId}`
	}

	function land(context, operationId) {
		if (onLanded === undefined) return
		onLanded(context, operationId)
	}

	function lookup(context, operationId) {
		const entry = cache.get(keyOf(context, operationId))
		return entry === undefined ? FAILED : entry
	}

	function begin(context, operationIds) {
		const started = []
		for (const operationId of operationIds) {
			const key = keyOf(context, operationId)
			if (cache.has(key)) continue
			cache.set(key, LOADING)
			started.push(operationId)
		}
		return started
	}

	function recordResponse(context, operationId, ok, body) {
		cache.set(keyOf(context, operationId), detailsStateFrom(ok, body))
		land(context, operationId)
	}

	function recordFailure(context, operationId) {
		cache.set(keyOf(context, operationId), FAILED)
		land(context, operationId)
	}

	function ensure(context, operationIds) {
		if (fetchDetail === undefined) throw new Error('createOperationDetails was built without fetchDetail, so ensure cannot fetch')
		for (const operationId of begin(context, operationIds)) {
			fetchDetail(context, operationId).then(
				(landing) => recordResponse(context, operationId, landing.ok, landing.body),
				() => recordFailure(context, operationId),
			)
		}
	}

	return { lookup, begin, ensure, recordResponse, recordFailure }
}

// The shared read of a details response body, identical across the hosts' wires: only an ok response carrying an object whose `details` is a string (or an explicit null for "this operation has no detail material") is ready — anything else (a 404 for an id the model no longer resolves, a malformed body, a not-ok status) renders as failed, which the surfaces show section-less.
/**
 * @param {boolean} ok
 * @param {unknown} body
 * @returns {OperationDetailsState}
 */
function detailsStateFrom(ok, body) {
	if (!ok) return FAILED
	if (!isObject(body)) return FAILED
	if (typeof body.details === 'string') return { status: 'ready', details: body.details }
	if (body.details === null) return { status: 'ready', details: null }
	return FAILED
}
