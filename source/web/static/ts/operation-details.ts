// The operation-details session cache machine shared by the product client (app.js) and the dev harness (demo.js). The flow/frame models ship no per-operation detail bodies (they can carry multi-megabyte tool arguments/results and would ride every polled frame), so when a surface that may show details opens, the host derives the operation ids it needs, the machine marks each uncached id 'loading' and arranges the fetch, and every landing — response or failure — fans out to the host so the waiting surfaces (an open inspector card, a question modal) fill in. See tooltip.js "On-demand operation details" for the lookup protocol the tooltip derivations read.
//
// The cache key is `<context>|<operationId>`; the context half is the host's scoping id (the product client scopes by run id, the harness by scenario id) so one cache serves every context without cross-answering for the same-numbered operation. Operation ids are stable within a context (events only append), so a cached entry never goes stale. The cache is a character-bounded LRU, not a final-per-session map: entries are evicted least-recently-used until both the entry count and the approximated character budget hold, and an evicted id reads as failed so `begin`/`ensure` may fetch it again.
//
// The cache stores the lookup-protocol shape itself, so a host's lookup passes entries through verbatim. Two host profiles drive the same machine: hosts whose fetches are effect-driven (the product client's hyperapp Fetch effects, whose ok/fail actions must return fresh state to trigger the re-render) call `begin` for the ids and `recordResponse`/`recordFailure` from their landing actions; hosts with a plain fetch call `ensure`, which begins the ids and drives `fetchDetail` + the `onLanded` fan-out itself.

import { isObject } from './guards.js'

// The lookup state for one operation's details (the shape tooltip.js "On-demand operation details" defines): the fetch is in flight, the fetch failed (the surface renders section-less), or the server's answer — null when the operation carries no detail material at all.
export type OperationDetailsState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; details: string | null }

// A details landing the host's `fetchDetail` resolves with: the response's ok flag and its already-parsed body (any shape — the machine validates the body itself).
export interface OperationDetailsLanding {
	ok: boolean
	body: unknown
}

export type FetchOperationDetail = (context: string, operationId: string) => Promise<OperationDetailsLanding>

// The landing fan-out: called with the context and operation id after every landing, so the host can refill the surfaces waiting on that id (the harness refills its open inspector card and fills the question modal; the product client's effect-driven actions re-render instead and pass no callback).
export type OnOperationDetailsLanded = (context: string, operationId: string) => void

export interface OperationDetailsDependencies {
	// Required only by `ensure`-driven hosts; the effect-driven host never calls it.
	fetchDetail?: FetchOperationDetail
	// The landing fan-out; absent, landing only updates the cache (the host reacts through its own actions).
	onLanded?: OnOperationDetailsLanded
}

// The cache bounds are required configuration, not defaults: the hosts choose a memory budget appropriate to their session.
export interface OperationDetailsLimits {
	maxEntries: number
	maxCharacters: number
}

export interface OperationDetailsController {
	// The cache's state for one id; a miss reads as 'failed' so a surface never blocks or invents content on a cache that has not answered. A hit counts as a use for LRU eviction.
	lookup(context: string, operationId: string): OperationDetailsState
	// Marks each uncached id 'loading' synchronously (so the first render reads a defined state) and returns exactly the ids it started, deduped against the cache — an effect-driven host builds one fetch per returned id.
	begin(context: string, operationIds: string[]): string[]
	// The fetch-on-demand entry: begins the ids and drives `fetchDetail` for each, recording the landing and firing the fan-out.
	ensure(context: string, operationIds: string[]): void
	// Records a resolved fetch: an ok body carrying a string `details` (or an explicit null) reads as ready, anything else — not-ok, a non-object body, a missing details field — as failed.
	recordResponse(context: string, operationId: string, ok: boolean, body: unknown): void
	// Records a fetch that never produced a response (network failure, unparseable body) as failed.
	recordFailure(context: string, operationId: string): void
}

const LOADING: OperationDetailsState = { status: 'loading' }
const FAILED: OperationDetailsState = { status: 'failed' }

interface CacheEntry {
	state: OperationDetailsState
	characters: number
}

export function createOperationDetails(dependencies: OperationDetailsDependencies, limits: OperationDetailsLimits): OperationDetailsController {
	if (!isPositiveInteger(limits.maxEntries) || !isPositiveInteger(limits.maxCharacters)) throw new Error('createOperationDetails requires positive-integer cache limits')
	const { fetchDetail, onLanded } = dependencies
	const cache = new Map<string, CacheEntry>()
	let totalCharacters = 0

	function keyOf(context: string, operationId: string): string {
		return `${context}|${operationId}`
	}

	function land(context: string, operationId: string): void {
		if (onLanded === undefined) return
		onLanded(context, operationId)
	}

	function store(key: string, state: OperationDetailsState): void {
		const previous = cache.get(key)
		if (previous !== undefined) {
			cache.delete(key)
			totalCharacters -= previous.characters
		}
		const characters = charactersOf(key, state)
		cache.set(key, { state, characters })
		totalCharacters += characters
		evictToLimits()
	}

	function evictToLimits(): void {
		// Keep at least the entry just stored: an entry larger than the whole character budget is still worth caching, and evicting it would re-fetch it immediately.
		while (cache.size > 1 && (cache.size > limits.maxEntries || totalCharacters > limits.maxCharacters)) {
			const eldest = cache.keys().next()
			if (eldest.done) return
			const entry = cache.get(eldest.value)
			cache.delete(eldest.value)
			if (entry !== undefined) totalCharacters -= entry.characters
		}
	}

	function lookup(context: string, operationId: string): OperationDetailsState {
		const key = keyOf(context, operationId)
		const entry = cache.get(key)
		if (entry === undefined) return FAILED
		// Re-insert so the Map's insertion order tracks recency and eviction removes the least-recently-used entry.
		cache.delete(key)
		cache.set(key, entry)
		return entry.state
	}

	function begin(context: string, operationIds: string[]): string[] {
		const started: string[] = []
		for (const operationId of operationIds) {
			const key = keyOf(context, operationId)
			if (cache.has(key)) continue
			store(key, LOADING)
			started.push(operationId)
		}
		return started
	}

	function recordResponse(context: string, operationId: string, ok: boolean, body: unknown): void {
		store(keyOf(context, operationId), detailsStateFrom(ok, body))
		land(context, operationId)
	}

	function recordFailure(context: string, operationId: string): void {
		store(keyOf(context, operationId), FAILED)
		land(context, operationId)
	}

	function ensure(context: string, operationIds: string[]): void {
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

// The budget approximation: a landed entry costs its key plus the details text; loading and failed entries cost only the key. UTF-16 code units are a stable, cheap approximation of the memory the cache retains.
function charactersOf(key: string, state: OperationDetailsState): number {
	if (state.status === 'ready' && state.details !== null) return key.length + state.details.length
	return key.length
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0
}

// The shared read of a details response body, identical across the hosts' wires: only an ok response carrying an object whose `details` is a string (or an explicit null for "this operation has no detail material") is ready — anything else (a 404 for an id the model no longer resolves, a malformed body, a not-ok status) renders as failed, which the surfaces show section-less.
function detailsStateFrom(ok: boolean, body: unknown): OperationDetailsState {
	if (!ok) return FAILED
	if (!isObject(body)) return FAILED
	const details = body['details']
	if (typeof details === 'string') return { status: 'ready', details }
	if (details === null) return { status: 'ready', details: null }
	return FAILED
}
