import { activeLivePartial, scopedActiveLivePartial } from '../live-partial.js'
import type { LivePartial } from '../live-partial.js'
import { childInstanceFor, deriveInstanceChain, instancesOf } from './instances.js'
import type { ChainCrumb, InstanceRecord } from './instances.js'
import {
	INSPECTOR_PAGE_LIMIT,
	INSPECTOR_WINDOW_SIZE,
	canPageOlder,
	initialWindowState,
	logWindowUrl,
	mergeLogEvents,
	olderFetchLimit,
	olderPageSpliced,
	olderWindowOffset,
	readLogWindowBody,
	tailPageAppended,
	tailRefreshMustResync,
	tailWindowOffset,
} from './log-window.js'
import type { WindowState } from './log-window.js'
import { deriveTranscriptTurns } from './transcript.js'
import type { TranscriptTurn } from './transcript.js'
import { buildTurnIndex, deriveDefaultScopeRoleId, scopeTurnEntries } from './turns.js'
import { WIRE_DETAIL_CACHE_LIMIT, createWireDetails } from './wire-details.js'
import type { WireDetailState } from './wire-details.js'

// The kind of windowed-log response a request expected. Probe learns a sequence's filtered total; window replaces the loaded range; older splices a page in front; tail appends the poll's new events or asks for a resync.
export type LogResponseKind = 'probe' | 'window' | 'older' | 'tail'

// One windowed-log request. The caller performs the fetch and passes the request back on landing, so a response can never be paired with a different response kind, a stale generation, or another run's session.
export interface FetchRequest {
	readonly runId: string
	readonly scopeRoleId: string | null
	readonly kind: LogResponseKind
	// The session generation that issued the request; a close or start increments it so late responses from before the reset are ignored even when the run id is unchanged.
	readonly generation: number
	readonly url: string
}

// One wire-envelope request. It carries the run id so a response that lands after a run switch still caches under the run it was fetched for.
export interface WireFetchRequest {
	runId: string
	eventIndex: number
	url: string
}

// The result of one scope change: whether the session's active scope changed (the caller re-renders only then) and the probe a newly selected scope window needs. A same-role call reports no change and no request even when that window failed.
export interface ScopeResult {
	changed: boolean
	request: FetchRequest | null
}

// The result of one log landing. `followUp` is the next request the session needs issued (the window after a probe, or a resync after a gapped tail page); `livePartial` is the stream partial as the landing leaves it.
export interface ReceiveResult {
	status: 'accepted' | 'failed' | 'ignored'
	followUp: FetchRequest | null
	livePartial: LivePartial | null
}

// The renderer's whole input: the active window's derived transcript, wayfinding, chain, and paging flags, with the wire cache and child-instance lookups closed over. Every value is a read-only snapshot: the session returns arrays and cached states by reference rather than copying, so callers must treat them as immutable (the renderer only reads them).
export interface InspectorView {
	loadState: 'loading' | 'ready' | 'failed'
	scopedRoleId: string | null
	hasOlder: boolean
	olderLoading: boolean
	instances: InstanceRecord[]
	chain: ChainCrumb[]
	transcript: TranscriptTurn[]
	// Read-only lookup. A cached state is returned by reference; callers must not mutate it or its sections.
	wireDetail(eventIndex: number): WireDetailState
	childInstance(eventIndex: number): string | null
}

export interface InspectorSessionOptions {
	// The maximum number of cached wire-envelope entries. Defaults to 100 (`WIRE_DETAIL_CACHE_LIMIT`); a non-positive-integer value fails construction.
	wireDetailCacheLimit?: number
}

export interface InspectorSession {
	// Starts a fresh inspection session for a non-empty `runId`, dropping the previous run's windows and incrementing the generation. The wire cache survives: it is keyed by run id and is a page-session cache. An empty run id fails fast.
	start(runId: string): FetchRequest | null
	close(): void
	// Sets the explicit scope (null returns to the auto/default scope). A new or previously failed scope window needs a probe, but a call naming the current scope returns changed:false even when its window failed: retry by leaving and returning, scope(null) then scope(roleId).
	scope(roleId: string | null): ScopeResult
	// Lands one windowed-log response using the kind carried by the request. A request this session did not issue, from another run or an older generation, is ignored; a malformed body reads as a failed first load.
	receive(request: FetchRequest, raw: unknown, currentLivePartial: LivePartial | null): ReceiveResult
	// Lands a fetch that never produced a usable response.
	fail(request: FetchRequest): void
	tailRequest(): FetchRequest | null
	olderRequest(): FetchRequest | null
	wireRequest(eventIndex: number): WireFetchRequest | null
	receiveWire(request: WireFetchRequest, ok: boolean, raw: unknown): void
	failWire(request: WireFetchRequest): void
	// Returns the renderer's read-only view. Arrays and cached states may be shared with the session; callers must not mutate them.
	view(): InspectorView
}

interface SessionState {
	runId: string | null
	generation: number
	unscoped: WindowState
	explicitScopeRoleId: string | null
	scopes: Map<string, WindowState>
	wire: ReturnType<typeof createWireDetails>
}

interface IssuedRequestIdentity {
	kind: LogResponseKind
	runId: string
	scopeRoleId: string | null
	generation: number
	url: string
}

export function createInspectorSession(options: InspectorSessionOptions = {}): InspectorSession {
	const state: SessionState = {
		runId: null,
		generation: 0,
		unscoped: initialWindowState(),
		explicitScopeRoleId: null,
		scopes: new Map(),
		wire: createWireDetails({ maxEntries: options.wireDetailCacheLimit ?? WIRE_DETAIL_CACHE_LIMIT }),
	}
	// Only requests this session issued are landable, and their identity is recorded separately so a caller cannot mutate a kind (or run, scope, url, generation) and have the change accepted.
	const issuedRequests = new WeakMap<FetchRequest, IssuedRequestIdentity>()

	function resetWindows() {
		state.unscoped = initialWindowState()
		state.explicitScopeRoleId = null
		state.scopes.clear()
	}

	function issueRequest(scopeRoleId: string | null, kind: LogResponseKind, url: string): FetchRequest {
		if (state.runId === null) throw new Error('InspectorSession issued a request without a run')
		const request: FetchRequest = { runId: state.runId, scopeRoleId, kind, generation: state.generation, url }
		issuedRequests.set(request, { kind, runId: request.runId, scopeRoleId, generation: request.generation, url })
		return request
	}

	function requestIsCurrent(request: FetchRequest): boolean {
		const issued = issuedRequests.get(request)
		if (issued === undefined) return false
		if (issued.kind !== request.kind || issued.runId !== request.runId || issued.scopeRoleId !== request.scopeRoleId || issued.generation !== request.generation || issued.url !== request.url) return false
		return request.runId === state.runId && request.generation === state.generation
	}

	function windowFor(scopeRoleId: string | null): WindowState | null {
		if (scopeRoleId === null) return state.unscoped
		return state.scopes.get(scopeRoleId) ?? null
	}

	function writeWindow(scopeRoleId: string | null, patch: Partial<WindowState>) {
		if (scopeRoleId === null) {
			state.unscoped = { ...state.unscoped, ...patch }
			return
		}
		const base = state.scopes.get(scopeRoleId) ?? initialWindowState()
		state.scopes.set(scopeRoleId, { ...base, ...patch })
	}

	function markWindowFailed(scopeRoleId: string | null) {
		if (scopeRoleId === null) {
			state.unscoped = { ...initialWindowState(), loadState: 'failed' }
			state.explicitScopeRoleId = null
			state.scopes.clear()
			return
		}
		writeWindow(scopeRoleId, { loadState: 'failed', events: [], total: null, tailOffset: null, entries: [], olderLoading: false })
	}

	function probeRequest(scopeRoleId: string | null): FetchRequest | null {
		if (state.runId === null) return null
		return issueRequest(scopeRoleId, 'probe', logWindowUrl(state.runId, scopeRoleId, 0, 1))
	}

	function windowRequest(scopeRoleId: string | null, offset: number): FetchRequest | null {
		if (state.runId === null) return null
		return issueRequest(scopeRoleId, 'window', logWindowUrl(state.runId, scopeRoleId, offset, INSPECTOR_WINDOW_SIZE))
	}

	function livePartialForLanding(scopeRoleId: string | null, livePartial: LivePartial | null, entries: WindowState['entries']): LivePartial | null {
		if (scopeRoleId === null) return activeLivePartial(livePartial, entries)
		return scopedActiveLivePartial(livePartial, entries)
	}

	return {
		start(runId) {
			if (typeof runId !== 'string' || runId === '') throw new Error('InspectorSession.start: runId must be a non-empty string')
			resetWindows()
			state.runId = runId
			state.generation += 1
			return probeRequest(null)
		},

		close() {
			resetWindows()
			state.runId = null
			state.generation += 1
		},

		scope(roleId) {
			if (roleId === state.explicitScopeRoleId) return { changed: false, request: null }
			if (roleId === null) {
				state.explicitScopeRoleId = null
				return { changed: true, request: null }
			}
			const existing = state.scopes.get(roleId)
			const needsLoad = existing === undefined || existing.loadState === 'failed'
			state.explicitScopeRoleId = roleId
			if (!needsLoad) return { changed: true, request: null }
			state.scopes.set(roleId, initialWindowState())
			return { changed: true, request: probeRequest(roleId) }
		},

		receive(request, raw, currentLivePartial) {
			if (!requestIsCurrent(request)) return { status: 'ignored', followUp: null, livePartial: currentLivePartial }
			const body = readLogWindowBody(raw)
			const scopeRoleId = request.scopeRoleId
			if (request.kind === 'probe') {
				if (body === null) {
					markWindowFailed(scopeRoleId)
					return { status: 'failed', followUp: null, livePartial: currentLivePartial }
				}
				if (body.runId !== state.runId) return { status: 'ignored', followUp: null, livePartial: currentLivePartial }
				if (body.total === 0) {
					writeWindow(scopeRoleId, { loadState: 'ready', events: [], total: 0, tailOffset: 0, entries: [], olderLoading: false })
					return { status: 'accepted', followUp: null, livePartial: currentLivePartial }
				}
				const tailOffset = tailWindowOffset(body.total, INSPECTOR_WINDOW_SIZE)
				return { status: 'accepted', followUp: windowRequest(scopeRoleId, tailOffset), livePartial: currentLivePartial }
			}
			if (request.kind === 'window') {
				if (body === null) {
					markWindowFailed(scopeRoleId)
					return { status: 'failed', followUp: null, livePartial: currentLivePartial }
				}
				if (body.runId !== state.runId) return { status: 'ignored', followUp: null, livePartial: currentLivePartial }
				const entries = buildTurnIndex(body.events)
				writeWindow(scopeRoleId, { loadState: 'ready', events: body.events, total: body.total, tailOffset: body.offset, entries, olderLoading: false })
				return { status: 'accepted', followUp: null, livePartial: livePartialForLanding(scopeRoleId, currentLivePartial, entries) }
			}
			if (request.kind === 'older') {
				const record = windowFor(scopeRoleId)
				if (record === null) return { status: 'ignored', followUp: null, livePartial: currentLivePartial }
				if (body === null || body.runId !== state.runId) {
					writeWindow(scopeRoleId, { olderLoading: false })
					return { status: 'failed', followUp: null, livePartial: currentLivePartial }
				}
				const spliced = record.loadState === 'ready' ? olderPageSpliced(record.events, record.tailOffset, body) : null
				if (spliced === null) {
					writeWindow(scopeRoleId, { olderLoading: false })
					return { status: 'failed', followUp: null, livePartial: currentLivePartial }
				}
				const entries = buildTurnIndex(spliced)
				writeWindow(scopeRoleId, { events: spliced, tailOffset: body.offset, entries, olderLoading: false })
				return { status: 'accepted', followUp: null, livePartial: currentLivePartial }
			}
			const record = windowFor(scopeRoleId)
			if (body === null || body.runId !== state.runId || record === null || record.loadState !== 'ready') return { status: 'ignored', followUp: null, livePartial: currentLivePartial }
			if (tailRefreshMustResync(body.events.length, body.offset, body.total, record.events.length)) {
				const tailOffset = tailWindowOffset(body.total, INSPECTOR_WINDOW_SIZE)
				return { status: 'ignored', followUp: windowRequest(scopeRoleId, tailOffset), livePartial: currentLivePartial }
			}
			const appended = tailPageAppended(record.events, record.total, body)
			if (appended === null) return { status: 'ignored', followUp: null, livePartial: currentLivePartial }
			const entries = buildTurnIndex(appended)
			writeWindow(scopeRoleId, { events: appended, total: body.total, entries })
			return { status: 'accepted', followUp: null, livePartial: livePartialForLanding(scopeRoleId, currentLivePartial, entries) }
		},

		fail(request) {
			if (!requestIsCurrent(request)) return
			if (request.kind === 'tail') return
			if (request.kind === 'older') {
				if (windowFor(request.scopeRoleId) !== null) writeWindow(request.scopeRoleId, { olderLoading: false })
				return
			}
			markWindowFailed(request.scopeRoleId)
		},

		tailRequest() {
			if (state.runId === null) return null
			if (state.explicitScopeRoleId !== null) {
				const record = state.scopes.get(state.explicitScopeRoleId)
				if (record === undefined || record.loadState !== 'ready' || typeof record.total !== 'number') return null
				return issueRequest(state.explicitScopeRoleId, 'tail', logWindowUrl(state.runId, state.explicitScopeRoleId, record.total, INSPECTOR_PAGE_LIMIT))
			}
			if (state.unscoped.loadState !== 'ready' || typeof state.unscoped.total !== 'number') return null
			return issueRequest(null, 'tail', logWindowUrl(state.runId, null, state.unscoped.total, INSPECTOR_PAGE_LIMIT))
		},

		olderRequest() {
			if (state.runId === null) return null
			const scopeRoleId = state.explicitScopeRoleId
			const record = windowFor(scopeRoleId)
			if (record === null || record.loadState !== 'ready' || record.olderLoading) return null
			const tailOffset = record.tailOffset
			if (!canPageOlder(tailOffset) || typeof tailOffset !== 'number') return null
			writeWindow(scopeRoleId, { olderLoading: true })
			return issueRequest(scopeRoleId, 'older', logWindowUrl(state.runId, scopeRoleId, olderWindowOffset(tailOffset, INSPECTOR_WINDOW_SIZE), olderFetchLimit(tailOffset, INSPECTOR_WINDOW_SIZE)))
		},

		wireRequest(eventIndex) {
			if (state.runId === null) return null
			if (!Number.isInteger(eventIndex) || eventIndex < 0) return null
			if (!state.wire.begin(state.runId, eventIndex)) return null
			return { runId: state.runId, eventIndex, url: `api/runs/${encodeURIComponent(state.runId)}/log?detail=${eventIndex}` }
		},

		receiveWire(request, ok, raw) {
			state.wire.recordResponse(request.runId, request.eventIndex, ok, raw)
		},

		failWire(request) {
			state.wire.recordFailure(request.runId, request.eventIndex)
		},

		view() {
			const scopedRoleId = state.explicitScopeRoleId
			const scopeRecord = scopedRoleId !== null ? state.scopes.get(scopedRoleId) : undefined
			const active = scopeRecord !== undefined
				? {
						loadState: scopeRecord.loadState,
						events: mergeLogEvents(scopeRecord.events, state.unscoped.events),
						tailOffset: scopeRecord.tailOffset,
						olderLoading: scopeRecord.olderLoading,
					}
				: {
						loadState: state.unscoped.loadState,
						events: state.unscoped.events,
						tailOffset: state.unscoped.tailOffset,
						olderLoading: state.unscoped.olderLoading,
					}
			const effectiveScope = scopedRoleId ?? deriveDefaultScopeRoleId(state.unscoped.entries)
			const entries = buildTurnIndex(active.events)
			const transcript = deriveTranscriptTurns(scopeTurnEntries(entries, effectiveScope), active.events)
			const runId = state.runId
			return {
				loadState: active.loadState,
				scopedRoleId: effectiveScope,
				hasOlder: canPageOlder(active.tailOffset),
				olderLoading: active.olderLoading,
				instances: instancesOf(active.events),
				chain: deriveInstanceChain(active.events, effectiveScope),
				transcript,
				wireDetail: (eventIndex: number) => (runId === null ? { status: 'idle' } : state.wire.lookup(runId, eventIndex)),
				childInstance: (eventIndex: number) => childInstanceFor(active.events, effectiveScope, eventIndex),
			}
		},
	}
}
