// The run's LLM story for one agent instance: an on-demand modal over the run view that renders the scoped instance's turns as one continuous transcript. The turns come from the windowed log endpoint `GET /api/runs/:id/log`; each completed turn's `llm_call` payload carries the turn's NEW messages (the `sent` slice — the conversation opening on the first turn, then the prior response's echo, the tool results, and platform notices), the assistant response (`received`), the usage, and the finish reason, so the transcript's story needs no per-turn detail fetches: the loaded events are the story.
//
// Each completed turn's header also carries a collapsed "on the wire" expander: the FULL request conversation the model saw at that turn — system + task + every message up to and including the turn — which is a different view of the same turn than the inline new-messages rendering, so it is labeled distinctly and fetched on demand from the window endpoint's `?detail=` fold (the delta slices the story reads cannot show it). The app caches one fetched envelope per turn in a bounded session cache (wire-details.js) and hands the modal a lookup; the modal never fetches itself.
//
// Reading order: the conversation opening (system prompt + task, the first turn's leading system/user messages) is hoisted into one collapsed expander above the turns; every turn then renders a quiet header (turn number within the instance, token bill, finish reason) followed by its new messages in order and its response — reasoning labeled 💭, all agent-authored prose through the sanitized Markdown pipeline. Tool calls render inline with their outcome joined from the tool result that answers them: the executor appends an assistant message holding all its calls first and then each result in call order, so pairing within a slice is positional. The echo assistant message at a slice's head renders nowhere — its content and calls are the previous turn's response section — which is why each turn contributes only its slice and the document never repeats itself.
//
// Realtime contract: turns land at turn granularity only — the run log carries no token-level streaming. While a turn is in flight the log holds only its `llm_call_start` event (the role is known, the request and response are not), so the transcript renders it as an in-flight section at the bottom, and the poll's tail refresh replaces it with the completed `llm_call` turn in sequence. The live token stream (docs/reference.md "Live token stream") layers an optional refinement on top: the app passes the ephemeral `livePartial` it accumulates from the websocket, and the in-flight section renders it as labeled reasoning/response — nothing renders when the partial is absent, and the pairing this module derives is also what tells the app an in-flight turn has completed.
//
// Under the run's `standard` logging level the log drops the sent/received bodies (see docs/reference.md "Logging level"), so each turn renders its header plus an honest degraded notice pointing at the logging-level setting; the transcript stays navigable. The `h` and `renderMarkdown` dependencies are passed in rather than imported so the component stays free of hyperapp and showdown coupling and is exercisable in tests with fakes (mirroring question-modal.js / result-modal.js).
//
// The transcript reads the windowed log: the modal opens on the most recent `INSPECTOR_WINDOW_SIZE` log events and an "older turns" control pages back by the same size, growing the loaded range (the poll's tail refresh appends new events to the same range, resyncing past `INSPECTOR_RETENTION_LIMIT`). Paging back grows the transcript toward its true beginning — the opening expander re-derives from whatever the loaded range's first turn carries.
//
// Scoping to an instance loads that instance's data explicitly: the endpoint's `?instance=<roleId>` variant filters the log server-side to the instance's turns and its full ancestor chain's lifecycle, so a scoped transcript opens on the most recent window of the instance's OWN sequence — an old agent's turns and complete breadcrumb load without paging back through the whole log — and "older turns" pages back within the filtered set (see "Per-scope windows" below).
//
// The transcript is scoped to one agent instance: a run's turns are spread across its role instances (the orchestrator, each delegated child), so the modal shows the scoped instance's turns — renumbered within the instance — with a breadcrumb (`orchestrator-0 ▸ coder-1 ▸ coder-1-2`) for the delegation chain and a minimal instance dropdown for wayfinding. The scoped instance defaults to the most recently active one (the newest unmatched `llm_call_start`, else the newest `llm_call`), and the caller re-scopes via the breadcrumb/dropdown or an `agent` call's View affordance. Instance identity comes from the events' `roleId` fields, falling back to the role name where a payload carries none (old logs whose turn events predate per-instance ids, matching the conversation fold's tolerance in source/web/render.ts) — under that fallback the turns of a role's instances are indistinguishable and scope to the role name as one group. The scoped render source is the scope's own window merged with the unscoped tail window (`mergeLogEvents`): the tail keeps the dropdown's wayfinding and the `agent` calls' child affordances alive (the server filter deliberately omits children), while the scope's own filtered sequence is authoritative for the transcript and its paging offsets.
//
// The pure helpers (the window-offset math, the transcript derivation, `childInstanceFor`, and the instance/scope derivations) ship exported even though the component consumes them internally — per the labels.js convention, pure helpers are exported so the tests exercise the same implementations the view uses rather than a parallel copy.

import { isObject } from './guards.js'

// The log-event window size: the initial tail fetch, the "older turns" page size, and the resync window after a poll-refresh gap all use it.
export const INSPECTOR_WINDOW_SIZE = 200

// The poll-refresh page cap: the largest gap one tail-refresh fetch can bridge (bounded by the endpoint's own limit cap).
export const INSPECTOR_PAGE_LIMIT = 500

// The loaded-range retention cap: while the modal sits open on an active run the tail refresh keeps appending to the loaded events (rows carry full payloads at the `full` log level), so past this many loaded events the app.js poll takes the fresh-tail-window resync instead of appending — the oldest events drop and the "Older turns" control re-fetches them on demand.
export const INSPECTOR_RETENTION_LIMIT = INSPECTOR_WINDOW_SIZE * 20

/**
 * A log event as the windowed endpoint ships it: `{ index, timestamp, type, payload }`, where `index` is the event's log-wide position.
 *
 * @typedef {Object} LogWindowEvent
 * @property {number} index
 * @property {string|null} timestamp
 * @property {string} type
 * @property {unknown} payload
 */

/**
 * One LLM turn as the turn index derives it. `eventIndex` is the turn's identity in the log (a completed turn's `llm_call` event; an in-flight turn's `llm_call_start` event). `roleId` is the turn's role-instance id — the payload's `roleId` when present, else the role name (old logs' turn events carry no instance id, matching the conversation fold's tolerance), so an in-flight turn that completes keeps its instance and never jumps scope.
 *
 * @typedef {Object} TurnEntry
 * @property {'completed'|'in_flight'} kind
 * @property {number} eventIndex
 * @property {number|null} startEventIndex the paired `llm_call_start`'s index, on completed entries only
 * @property {number} turnNumber 1-based, chronological over the loaded events
 * @property {string} role
 * @property {string} roleId
 * @property {number|null} messageCount the full request's message count (the `llm_call` payload's `messageCount`; null when absent or malformed, and for in-flight turns)
 * @property {string|null} timestamp
 * @property {TurnUsage|null} usage
 * @property {string|null} finishReason
 * @property {'full'|'standard'|null} levelHint body availability inferred from the payload shape
 */

/**
 * @typedef {Object} TurnUsage
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} totalTokens
 * @property {number} [cachedPromptTokens]
 */

// --- Window offset math -----------------------------------------------------
// The endpoint pages forward from `offset`, so "the most recent window" and "one page older" are both derived from the known `total`/`tailOffset` instead of being fetched blind. All four helpers treat non-integer or negative inputs as "nothing to fetch" (0), so a malformed response degrades to the first page rather than a bad request.

/**
 * The offset that starts the most recent `windowSize` events of a log with `total` events.
 *
 * @param {unknown} total
 * @param {number} windowSize
 * @returns {number}
 */
export function tailWindowOffset(total, windowSize) {
	if (!Number.isInteger(total) || total <= 0) return 0
	if (!Number.isInteger(windowSize) || windowSize <= 0) return 0
	return Math.max(0, total - windowSize)
}

/**
 * The offset that starts one page of `pageSize` events before `tailOffset` (the current window's start).
 *
 * @param {unknown} tailOffset
 * @param {number} pageSize
 * @returns {number}
 */
export function olderWindowOffset(tailOffset, pageSize) {
	if (!Number.isInteger(tailOffset) || tailOffset <= 0) return 0
	if (!Number.isInteger(pageSize) || pageSize <= 0) return 0
	return Math.max(0, tailOffset - pageSize)
}

/**
 * How many events to fetch when paging back from `tailOffset` by `pageSize`: the gap between the two offsets, or 0 when there is nothing older to fetch.
 *
 * @param {unknown} tailOffset
 * @param {number} pageSize
 * @returns {number}
 */
export function olderFetchLimit(tailOffset, pageSize) {
	if (!Number.isInteger(tailOffset) || tailOffset <= 0) return 0
	if (!Number.isInteger(pageSize) || pageSize <= 0) return 0
	return tailOffset - olderWindowOffset(tailOffset, pageSize)
}

/**
 * True when events older than `tailOffset` may exist (the log has events before the loaded window).
 *
 * @param {unknown} tailOffset
 * @returns {boolean}
 */
export function canPageOlder(tailOffset) {
	return Number.isInteger(tailOffset) && tailOffset > 0
}

// Whether a tail-refresh page must resync the loaded window instead of appending: the page cannot bridge to the new total (more events landed between two polls than one page carries — appending would leave a silent gap in the transcript), or the loaded range has grown past the retention cap (the memory bound — the oldest events drop out and the "Older turns" control re-fetches them on demand). Malformed inputs read as "no resync" so a broken response never throws; the caller resyncs via `tailWindowOffset`.
/**
 * @param {unknown} pageEventCount the page's event count
 * @param {unknown} pageOffset the page's log-wide offset
 * @param {unknown} pageTotal the log's total at fetch time
 * @param {unknown} loadedEventCount the loaded range's current event count
 * @returns {boolean}
 */
export function tailRefreshMustResync(pageEventCount, pageOffset, pageTotal, loadedEventCount) {
	if (!Number.isInteger(pageEventCount) || pageEventCount < 0) return false
	if (!Number.isInteger(pageOffset) || pageOffset < 0) return false
	if (!Number.isInteger(pageTotal) || pageTotal < 0) return false
	if (pageEventCount < pageTotal - pageOffset) return true
	return Number.isInteger(loadedEventCount) && loadedEventCount >= INSPECTOR_RETENTION_LIMIT
}

// --- Per-scope windows -------------------------------------------------------
// Scoping the modal to one agent instance loads that instance's data explicitly from the server-filtered window endpoint (`?instance=<roleId>`): the server sees the whole log, so the scoped window carries the instance's turns and its full ancestor chain's lifecycle no matter how far back they fall — the breadcrumb always renders completely, and an old agent's transcript needs no paging back through the whole log. The app keeps one loaded window per explicit scope, keyed by the scoped role id, alongside the unscoped tail window (which keeps serving the instance dropdown's wayfinding, the default scope, and the child-instance affordances the filter deliberately omits — children are not ancestors). The endpoint windows the filtered sequence, so the same offset math drives both windows.

/**
 * A per-scope loaded window: the same fields the unscoped window carries, for one instance's server-filtered event set. `total` is the FILTERED sequence's total and `tailOffset` the loaded window's start within it.
 *
 * @typedef {Object} ScopeWindow
 * @property {'loading'|'ready'|'failed'} loadState
 * @property {LogWindowEvent[]} events
 * @property {number|null} total
 * @property {number|null} tailOffset
 * @property {TurnEntry[]} entries
 */

/**
 * A fresh per-scope window: loading, empty. The scope's probe and window fetches fill it.
 *
 * @returns {ScopeWindow}
 */
export function initialScopeWindow() {
	return { loadState: 'loading', events: [], total: null, tailOffset: null, entries: [] }
}

/**
 * Merges two windowed event lists into one deduped, log-order list: the render source for an explicitly scoped modal is the scope's own window augmented with the unscoped tail window, whose overlapping rows (both are windows over the same append-only log, and a row's global `index` is its identity) collapse to one. Rows without a usable global index are dropped — every row the endpoint ships carries one, and the transcript's pairing reads only indexed rows anyway.
 *
 * @param {unknown} firstEvents
 * @param {unknown} secondEvents
 * @returns {LogWindowEvent[]}
 */
export function mergeLogEvents(firstEvents, secondEvents) {
	const byIndex = new Map()
	const sources = [...(Array.isArray(firstEvents) ? firstEvents : []), ...(Array.isArray(secondEvents) ? secondEvents : [])]
	for (const event of sources) {
		if (!isObject(event)) continue
		const index = event['index']
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue
		if (!byIndex.has(index)) byIndex.set(index, event)
	}
	return [...byIndex.values()].sort((a, b) => a['index'] - b['index'])
}

/**
 * The modal's render inputs for the modal's current scope: the explicit scope's own window (its load state and paging offsets — the "Older turns" control pages within the filtered set) with its events merged with the unscoped tail window (wayfinding: the dropdown's instance list and the `agent` calls' child affordances read the instances the scoped filter deliberately omits), or the unscoped window itself when the scope is unset or its window has not landed yet (the modal then shows the unscoped window's loading state until the scope's probe responds).
 *
 * @param {unknown} inspector the app's inspector state
 * @param {string|null} explicitScopeRoleId
 * @returns {{ loadState: string, events: LogWindowEvent[], total: number|null, tailOffset: number|null }}
 */
export function scopeViewFor(inspector, explicitScopeRoleId) {
	const state = isObject(inspector) ? inspector : {}
	const unscoped = {
		loadState: typeof state['loadState'] === 'string' ? state['loadState'] : 'loading',
		events: Array.isArray(state['events']) ? state['events'] : [],
		total: typeof state['total'] === 'number' ? state['total'] : null,
		tailOffset: typeof state['tailOffset'] === 'number' ? state['tailOffset'] : null,
	}
	if (typeof explicitScopeRoleId !== 'string' || explicitScopeRoleId === '' || !isObject(state['scopes'])) return unscoped
	const record = state['scopes'][explicitScopeRoleId]
	if (!isObject(record)) return unscoped
	return {
		loadState: typeof record['loadState'] === 'string' ? record['loadState'] : 'loading',
		events: mergeLogEvents(record['events'], unscoped.events),
		total: typeof record['total'] === 'number' ? record['total'] : null,
		tailOffset: typeof record['tailOffset'] === 'number' ? record['tailOffset'] : null,
	}
}

// The windowed-log fetch URL for one page: the optional instance scope filters server-side, and offset/limit window the (filtered) sequence. Exported because the app's landing actions build the follow-up fetches (probe → window, tail resync) against the same URL shape the fetch-decision helpers return.
/**
 * @param {unknown} runId raw (unencoded)
 * @param {string|null} scopeRoleId
 * @param {number} offset
 * @param {number} limit
 * @returns {string}
 */
export function logWindowUrl(runId, scopeRoleId, offset, limit) {
	if (typeof runId !== 'string' || runId === '') return ''
	const scope = scopeRoleId !== null ? `&instance=${encodeURIComponent(scopeRoleId)}` : ''
	return `api/runs/${encodeURIComponent(runId)}/log?offset=${offset}&limit=${limit}${scope}`
}

/**
 * The fetch a scope change to `roleId` needs, or null when no fetch should fire: a scope whose window already loaded (or is loading) is reused as-is — the poll's scoped tail refresh keeps a live run's window current, and a terminal run's window is complete — while a failed window retries. The fetch is the cheap one-event probe that learns the FILTERED total, so the window fetch can start at the most recent window of the instance's own sequence (the unscoped total says nothing about it).
 *
 * @param {unknown} inspector
 * @param {unknown} runId
 * @param {unknown} roleId
 * @returns {{ url: string }|null}
 */
export function scopeLoadFetch(inspector, runId, roleId) {
	if (typeof runId !== 'string' || runId === '') return null
	if (typeof roleId !== 'string' || roleId === '') return null
	if (isObject(inspector) && isObject(inspector['scopes'])) {
		const record = inspector['scopes'][roleId]
		if (isObject(record) && record['loadState'] !== 'failed') return null
	}
	return { url: logWindowUrl(runId, roleId, 0, 1) }
}

/**
 * The poll's tail-refresh fetch for the modal's ACTIVE scope — the explicit scope's own window when one is set (the transcript is the live surface then; the unscoped window's dropdown contents are session-static while the scope holds, and a scope reset to the default catches the unscoped window up on the next tick), else the unscoped window. Null when the active window has not loaded, the run id is unusable, or the modal is closed (the caller guards). The response lands back in the same scope's window: the app curries the landing action with `scopeRoleId`.
 *
 * @param {unknown} inspector
 * @param {unknown} runId
 * @returns {{ scopeRoleId: string|null, url: string }|null}
 */
export function tailRefreshFetch(inspector, runId) {
	if (typeof runId !== 'string' || runId === '' || !isObject(inspector)) return null
	const scopeRoleId = typeof inspector['scopedRoleId'] === 'string' && inspector['scopedRoleId'] !== '' ? inspector['scopedRoleId'] : null
	if (scopeRoleId !== null) {
		const record = isObject(inspector['scopes']) ? inspector['scopes'][scopeRoleId] : undefined
		if (!isObject(record) || record['loadState'] !== 'ready' || typeof record['total'] !== 'number') return null
		return { scopeRoleId, url: logWindowUrl(runId, scopeRoleId, record['total'], INSPECTOR_PAGE_LIMIT) }
	}
	if (inspector['loadState'] !== 'ready' || typeof inspector['total'] !== 'number') return null
	return { scopeRoleId: null, url: logWindowUrl(runId, null, inspector['total'], INSPECTOR_PAGE_LIMIT) }
}

/**
 * The "Older turns" fetch for the modal's ACTIVE scope: one page back within that scope's own loaded sequence — the unscoped window's offsets for the default scope, the scoped window's filtered offsets when explicitly scoped (the endpoint windows the filtered list, so the same offset math applies). Null when a page is already in flight, the active window has nothing older, or the ids are unusable.
 *
 * @param {unknown} inspector
 * @param {unknown} runId
 * @returns {{ scopeRoleId: string|null, url: string }|null}
 */
export function olderTurnsFetch(inspector, runId) {
	if (typeof runId !== 'string' || runId === '' || !isObject(inspector)) return null
	if (inspector['olderLoading'] === true) return null
	const scopeRoleId = typeof inspector['scopedRoleId'] === 'string' && inspector['scopedRoleId'] !== '' ? inspector['scopedRoleId'] : null
	if (scopeRoleId !== null) {
		const record = isObject(inspector['scopes']) ? inspector['scopes'][scopeRoleId] : undefined
		if (!isObject(record) || record['loadState'] !== 'ready' || !canPageOlder(record['tailOffset'])) return null
		const tailOffset = record['tailOffset']
		return { scopeRoleId, url: logWindowUrl(runId, scopeRoleId, olderWindowOffset(tailOffset, INSPECTOR_WINDOW_SIZE), olderFetchLimit(tailOffset, INSPECTOR_WINDOW_SIZE)) }
	}
	if (inspector['loadState'] !== 'ready' || !canPageOlder(inspector['tailOffset'])) return null
	return { scopeRoleId: null, url: logWindowUrl(runId, null, olderWindowOffset(inspector['tailOffset'], INSPECTOR_WINDOW_SIZE), olderFetchLimit(inspector['tailOffset'], INSPECTOR_WINDOW_SIZE)) }
}

/**
 * The loaded window list after an older page slots exactly in front of it, or null when the page cannot (a stale or diverged response): the log is append-only, so the page must end exactly where the loaded window begins.
 *
 * @param {unknown} existingEvents
 * @param {unknown} existingTailOffset
 * @param {unknown} page the validated window response body
 * @returns {LogWindowEvent[]|null}
 */
export function olderPageSpliced(existingEvents, existingTailOffset, page) {
	if (!Array.isArray(existingEvents) || !isObject(page) || !Array.isArray(page['events'])) return null
	const offset = page['offset']
	if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return null
	if (offset + page['events'].length !== existingTailOffset) return null
	return [...page['events'], ...existingEvents]
}

/**
 * The loaded window list after a tail page appends, or null when it cannot (a response landing at an offset the window's end does not name, or an empty page with nothing to append).
 *
 * @param {unknown} existingEvents
 * @param {unknown} existingTotal
 * @param {unknown} page the validated window response body
 * @returns {LogWindowEvent[]|null}
 */
export function tailPageAppended(existingEvents, existingTotal, page) {
	if (!Array.isArray(existingEvents) || !isObject(page) || !Array.isArray(page['events'])) return null
	if (page['offset'] !== existingTotal) return null
	if (page['events'].length === 0) return null
	return [...existingEvents, ...page['events']]
}

// --- Turn index derivation ---------------------------------------------------

/**
 * The payload fields an `llm_call` keeps under the `standard` logging level (source/executor/log-level.ts): the sent and received bodies are dropped, so their presence in the payload is what distinguishes a full-detail turn from a metadata-only one.
 * @param {unknown} payload
 * @returns {'full'|'standard'}
 */
function payloadLevelHint(payload) {
	if (Array.isArray(payload['sent'])) return 'full'
	const received = payload['received']
	if (isObject(received)) return 'full'
	return 'standard'
}

/**
 * The usage triple the transcript header renders, or null when the payload carries none (absent, non-object, or non-numeric fields).
 * @param {unknown} value
 * @returns {TurnUsage|null}
 */
function readUsage(value) {
	if (!isObject(value)) return null
	const promptTokens = value['promptTokens']
	const completionTokens = value['completionTokens']
	const totalTokens = value['totalTokens']
	if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number' || typeof totalTokens !== 'number') return null
	if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null
	const usage = { promptTokens, completionTokens, totalTokens }
	if (typeof value['cachedPromptTokens'] === 'number' && Number.isFinite(value['cachedPromptTokens'])) usage['cachedPromptTokens'] = value['cachedPromptTokens']
	return usage
}

/**
 * The event's log-wide index, or null when the window row does not carry a usable one (a non-integer or negative index cannot be a turn's identity).
 * @param {unknown} value
 * @returns {number|null}
 */
function readEventIndex(value) {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
	return value
}

/**
 * The full request's message count the payload reports (docs/reference.md "Log events"), or null when absent or malformed — the wire expander's collapsed summary shows it before any fetch.
 * @param {unknown} value
 * @returns {number|null}
 */
function readMessageCount(value) {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
	return value
}

// Derives the turn index from a window of log events (the shape `GET /api/runs/:id/log` returns). An `llm_call` event becomes a completed entry; an `llm_call_start` becomes an in-flight entry unless a matching `llm_call` for the same role follows it, in which case they pair into one completed entry. Matching is LIFO per role name so the same-name nesting the executor allows (a role spawning a same-named child) pairs like brackets — pairing stays name-keyed even though the events carry `roleId`, because a start may predate the executor's per-instance ids (old logs) and the executor's single-flight turn loop makes same-name nesting bracket-like; each entry's `roleId` comes from its own event's payload, falling back to the role name when absent. An `llm_unavailable` or `context_budget_exceeded` event closes the same role's newest open start (single-flight makes that start the failed turn's bracket) instead of leaving it matched to nothing: a turn that never completed has no story of its own beyond the failure event, so it renders as failed/dropped there rather than as an eternal in-flight row. Entries come back in chronological (log) order with 1-based `turnNumber`s over the loaded events; malformed rows (non-objects, other types, non-record payloads, missing role, unusable index) are skipped so one torn row cannot corrupt the list. The log is append-only, so an in-flight entry that later completes is replaced wholesale by the next `buildTurnIndex` over the grown window.
/**
 * @param {unknown} logEvents
 * @returns {TurnEntry[]}
 */
export function buildTurnIndex(logEvents) {
	if (!Array.isArray(logEvents)) return []
	// Unmatched starts still open per role, chronological; popped LIFO on their matching call — or on the role's turn-failure event, which closes a failed turn's bracket so no ghost in-flight row survives.
	const openStarts = new Map()
	const entries = []
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const type = event['type']
		if (type !== 'llm_call' && type !== 'llm_call_start' && type !== 'llm_unavailable' && type !== 'context_budget_exceeded') continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		const role = typeof payload['role'] === 'string' && payload['role'] !== '' ? payload['role'] : null
		if (role === null) continue
		if (type === 'llm_unavailable' || type === 'context_budget_exceeded') {
			const failed = openStarts.get(role)
			if (failed !== undefined && failed.length > 0) failed.pop()
			continue
		}
		const eventIndex = readEventIndex(event['index'])
		if (eventIndex === null) continue
		const timestamp = typeof event['timestamp'] === 'string' ? event['timestamp'] : null
		const roleId = typeof payload['roleId'] === 'string' && payload['roleId'] !== '' ? payload['roleId'] : role
		if (type === 'llm_call_start') {
			const open = openStarts.get(role)
			if (open === undefined) {
				openStarts.set(role, [{ eventIndex, timestamp, roleId }])
			} else {
				open.push({ eventIndex, timestamp, roleId })
			}
			continue
		}
		const open = openStarts.get(role)
		const start = open !== undefined && open.length > 0 ? open.pop() : null
		entries.push({
			kind: 'completed',
			eventIndex,
			startEventIndex: start !== null ? start.eventIndex : null,
			turnNumber: 0,
			role,
			roleId,
			messageCount: readMessageCount(payload['messageCount']),
			timestamp,
			usage: readUsage(payload['usage']),
			finishReason: typeof payload['finishReason'] === 'string' && payload['finishReason'] !== '' ? payload['finishReason'] : null,
			levelHint: payloadLevelHint(payload),
		})
	}
	for (const [role, open] of openStarts) {
		for (const start of open) {
		entries.push({
			kind: 'in_flight',
			eventIndex: start.eventIndex,
			startEventIndex: null,
			turnNumber: 0,
			role,
			roleId: start.roleId,
			messageCount: null,
			timestamp: start.timestamp,
			usage: null,
			finishReason: null,
			levelHint: null,
		})
		}
	}
	entries.sort((a, b) => a.eventIndex - b.eventIndex)
	return entries.map((entry, position) => ({ ...entry, turnNumber: position + 1 }))
}

// --- Instance scoping --------------------------------------------------------
// The modal scopes its transcript to one agent instance. Instances are known from `role_start`/`role_finished` events (which always carry `roleId`) and, where the loaded turn events predate per-instance ids (old logs), from the turn events themselves falling back to the role name — so the dropdown always offers at least the identity the turn entries can scope to.

/**
 * One agent instance present in the loaded event window, as the instance dropdown renders it.
 *
 * @typedef {Object} InstanceRecord
 * @property {string} roleId
 * @property {string} role
 * @property {string|null} parentRoleId the parent instance's id when an event names it; null when absent or unknown
 * @property {string|null} parentRole the parent role's name; null for the entry role or unknown
 * @property {boolean} live true while no `role_finished` for the instance is in the window (a start whose finish has paged out still reads live — the window is all the modal knows)
 */

/**
 * A non-empty string field, or null.
 * @param {unknown} value
 * @returns {string|null}
 */
function readInstanceId(value) {
	if (typeof value !== 'string' || value === '') return null
	return value
}

// The distinct agent instances in a window of log events, in first-appearance order. Real instances come from `role_start` (which also carries the parent linkage) and are marked finished by `role_finished`; turn events (`llm_call`/`llm_call_start`) whose payload carries no `roleId` ensure a role-name fallback instance whose live flag follows its newest turn event (a start reads as a turn in flight, a call as none). Malformed rows are skipped; an empty or non-array window yields no instances.
/**
 * @param {unknown} logEvents
 * @returns {InstanceRecord[]}
 */
export function instancesOf(logEvents) {
	if (!Array.isArray(logEvents)) return []
	const instances = new Map()
	const realIds = new Set()
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const type = event['type']
		const payload = event['payload']
		if (!isObject(payload)) continue
		if (type === 'role_start' || type === 'role_finished') {
			const roleId = readInstanceId(payload['roleId'])
			const role = readInstanceId(payload['role'])
			if (roleId === null || role === null) continue
			const known = instances.get(roleId)
			if (type === 'role_start') {
				if (known === undefined) {
					instances.set(roleId, { roleId, role, parentRoleId: readInstanceId(payload['parentRoleId']), parentRole: readInstanceId(payload['parent']), live: true })
				}
			} else if (known === undefined) {
				instances.set(roleId, { roleId, role, parentRoleId: null, parentRole: readInstanceId(payload['parent']), live: false })
			} else {
				known['live'] = false
			}
			realIds.add(roleId)
			continue
		}
		if (type !== 'llm_call' && type !== 'llm_call_start') continue
		const role = readInstanceId(payload['role'])
		if (role === null) continue
		const payloadRoleId = readInstanceId(payload['roleId'])
		if (payloadRoleId !== null) {
			// A real id whose role_start paged out still lists (live — no finish is known for it); its status stays owned by the role events.
			if (!realIds.has(payloadRoleId) && !instances.has(payloadRoleId)) {
				instances.set(payloadRoleId, { roleId: payloadRoleId, role, parentRoleId: null, parentRole: null, live: true })
			}
			continue
		}
		// No id on the turn payload (old logs): the role name is the only identity the transcript can scope to, and its live flag follows the newest turn event — a start reads as a turn in flight, a call as none.
		instances.set(role, { roleId: role, role, parentRoleId: null, parentRole: null, live: type === 'llm_call_start' })
	}
	return [...instances.values()]
}

/**
 * One breadcrumb crumb: an instance on the delegation chain from the chain root down to the scoped instance.
 *
 * @typedef {Object} ChainCrumb
 * @property {string} roleId
 * @property {string} role
 */

// The delegation chain for `roleId` as far as the loaded window allows: the instance's own `role_start` event walks up through its parent linkage — the exact `parentRoleId` when the payload names it, else (old logs) the latest earlier `role_start` of the parent role at depth − 1, which the executor's single-flight depth-first execution makes unambiguous. An ancestor outside the window (or named by id but absent) ends the walk: the chain renders root-most-known → instance rather than inventing a root. A roleId with no `role_start` in the window (a turn event's instance whose start paged out) renders as a lone crumb, its role name read from the turn payload when available. Cycles in malformed logs end the walk too.
/**
 * @param {unknown} logEvents
 * @param {unknown} roleId
 * @returns {ChainCrumb[]}
 */
export function deriveInstanceChain(logEvents, roleId) {
	if (typeof roleId !== 'string' || roleId === '') return []
	if (!Array.isArray(logEvents)) return [{ roleId, role: roleId }]
	const starts = new Map()
	const turnRoles = new Map()
	let position = 0
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		if (event['type'] === 'role_start') {
			const startRoleId = readInstanceId(payload['roleId'])
			const role = readInstanceId(payload['role'])
			if (startRoleId === null || role === null) continue
			if (!starts.has(startRoleId)) {
				starts.set(startRoleId, {
					role,
					parentRoleId: readInstanceId(payload['parentRoleId']),
					parentRole: readInstanceId(payload['parent']),
					depth: typeof payload['depth'] === 'number' && Number.isFinite(payload['depth']) ? payload['depth'] : null,
					position,
				})
			}
			position += 1
			continue
		}
		if (event['type'] !== 'llm_call' && event['type'] !== 'llm_call_start') continue
		const startRoleId = readInstanceId(payload['roleId'])
		const role = readInstanceId(payload['role'])
		if (startRoleId !== null && role !== null) turnRoles.set(startRoleId, role)
	}
	const own = starts.get(roleId)
	const chain = [{ roleId, role: own !== undefined ? own.role : turnRoles.get(roleId) ?? roleId }]
	if (own === undefined) return chain
	const visited = new Set([roleId])
	let current = own
	while (true) {
		const parent = resolveParentStart(current, starts, visited)
		if (parent === null) break
		chain.unshift({ roleId: parent.roleId, role: parent.role })
		visited.add(parent.roleId)
		current = parent
	}
	return chain
}

// The parent's `role_start` for the walk above, or null when the chain ends: the exact parent instance when the payload names its id and the window holds its start; otherwise the name-and-depth heuristic for logs whose starts carry no `parentRoleId`.
/**
 * @param {{ role: string, parentRoleId: string|null, parentRole: string|null, depth: number|null, position: number }} start
 * @param {Map<string, { role: string, parentRoleId: string|null, parentRole: string|null, depth: number|null, position: number }>} starts
 * @param {Set<string>} visited
 * @returns {{ roleId: string, role: string, parentRoleId: string|null, parentRole: string|null, depth: number|null, position: number }|null}
 */
function resolveParentStart(start, starts, visited) {
	if (start.parentRoleId !== null) {
		if (visited.has(start.parentRoleId)) return null
		const exact = starts.get(start.parentRoleId)
		return exact !== undefined ? { roleId: start.parentRoleId, ...exact } : null
	}
	if (start.parentRole === null || start.depth === null) return null
	let best = null
	for (const [candidateId, candidate] of starts) {
		if (visited.has(candidateId)) continue
		if (candidate.role !== start.parentRole) continue
		if (candidate.depth === null || candidate.depth !== start.depth - 1) continue
		if (candidate.position >= start.position) continue
		if (best === null || candidate.position > best.position) best = { roleId: candidateId, ...candidate }
	}
	return best
}

// The instance id the modal scopes to when the operator has not picked one: the most recently active instance in the freshly derived list — the newest turn still in flight (an unmatched `llm_call_start`), else the newest turn of any kind. Null when the list holds no usable entries.
/**
 * @param {unknown} entries
 * @returns {string|null}
 */
export function deriveDefaultScopeRoleId(entries) {
	if (!Array.isArray(entries)) return null
	let newest = null
	let newestInFlight = null
	for (const entry of entries) {
		if (!isObject(entry)) continue
		if (typeof entry['roleId'] !== 'string' || entry['roleId'] === '') continue
		newest = entry['roleId']
		if (entry['kind'] === 'in_flight') newestInFlight = entry['roleId']
	}
	return newestInFlight ?? newest
}

// The turn entries of one instance, renumbered 1-based within the instance (the transcript shows the scoped instance's turns, so its numbering is the instance's own). An unset or empty scope yields an empty list — the dropdown is the way back. Entries are copied so the renumbering never mutates the full list.
/**
 * @param {unknown} entries
 * @param {unknown} scopedRoleId
 * @returns {TurnEntry[]}
 */
export function scopeTurnEntries(entries, scopedRoleId) {
	if (!Array.isArray(entries)) return []
	if (typeof scopedRoleId !== 'string' || scopedRoleId === '') return []
	const scoped = []
	for (const entry of entries) {
		if (!isObject(entry)) continue
		if (entry['roleId'] !== scopedRoleId) continue
		scoped.push(entry)
	}
	return scoped.map((entry, position) => ({ ...entry, turnNumber: position + 1 }))
}

// --- Transcript derivation ---------------------------------------------------
// The scoped instance's turns as one continuous document. Each completed turn contributes only the slice its `llm_call` payload carries — its new messages plus its response — so stitching the turns in order never repeats a message: the echo assistant message at a slice's head is the previous turn's response (rendered there, with the calls and the outcome the slice's tool results supply), and a tool result that answers a call rendered in the previous turn's response is consumed by that rendering.

/**
 * The outcome a tool result reports, as the transcript renders it: the result kind when the serialization names one, and a one-line summary.
 *
 * @typedef {Object} TranscriptOutcome
 * @property {string|null} kind
 * @property {string} summary
 */

/**
 * One of a turn's new messages as the transcript renders it. Assistant messages never render (their content and calls are the previous turn's response section), so a message is a user/system prose message or a tool result with its parsed outcome.
 *
 * @typedef {Object} TranscriptMessage
 * @property {string} role
 * @property {string} content
 * @property {TranscriptOutcome|null} outcome tool messages only
 */

/**
 * One tool call of the assistant's response: the call's identity, its raw arguments text, and the outcome of the tool result that answered it — null when no answered result is in the loaded window (the call belongs to the newest turn, or the answering turn's slice is not logged).
 *
 * @typedef {Object} TranscriptToolCall
 * @property {string} id
 * @property {string} name
 * @property {string} argumentsText
 * @property {TranscriptOutcome|null} outcome
 */

/**
 * One turn of the transcript. `opening` carries the hoisted conversation opening (the first turn's leading system/user messages — the system prompt and the task; empty on every other turn); `messages` the turn's remaining new messages in order; `received` the response (null for an in-flight turn and for a turn whose bodies the standard logging level dropped).
 *
 * @typedef {Object} TranscriptTurn
 * @property {'completed'|'in_flight'} kind
 * @property {number} turnNumber
 * @property {number} eventIndex
 * @property {string} role
 * @property {string} roleId
 * @property {number|null} messageCount the full request's message count, for the wire expander's collapsed summary
 * @property {string|null} timestamp
 * @property {TurnUsage|null} usage
 * @property {string|null} finishReason
 * @property {'full'|'standard'|null} bodyLevel
 * @property {TranscriptMessage[]} opening
 * @property {TranscriptMessage[]} messages
 * @property {{ reasoning: string, content: string, toolCalls: TranscriptToolCall[] }|null} received
 */

// The loaded events indexed by log position, so each turn entry can read its own `llm_call` payload in one pass. Non-record payloads index as null and read as body-less.
/**
 * @param {unknown[]} logEvents
 * @returns {Map<number, unknown>}
 */
function payloadIndex(logEvents) {
	const byIndex = new Map()
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const index = readEventIndex(event['index'])
		if (index === null) continue
		byIndex.set(index, isObject(event['payload']) ? event['payload'] : null)
	}
	return byIndex
}

// The validated sent slice of an `llm_call` payload: each message as the transcript renders it — role, content, the parsed outcome of tool results, and the raw tool calls assistant messages carry (so the slice walk can join them with the results that follow). Messages that are not records or lack a role are skipped; null when the payload carries no slice (the standard logging level dropped the bodies).
/**
 * @param {unknown} payload
 * @returns {TranscriptMessage[]|null}
 */
function sentSliceOf(payload) {
	if (payload === null || !isObject(payload)) return null
	if (!Array.isArray(payload['sent'])) return null
	const messages = []
	for (const raw of payload['sent']) {
		if (!isObject(raw)) continue
		const role = typeof raw['role'] === 'string' && raw['role'] !== '' ? raw['role'] : null
		if (role === null) continue
		const content = typeof raw['content'] === 'string' ? raw['content'] : ''
		const message = { role, content, outcome: null }
		if (role === 'tool') {
			message['outcome'] = outcomeOfToolContent(content)
		} else if (role === 'assistant' && Array.isArray(raw['tool_calls'])) {
			message['tool_calls'] = toolCallsOf(raw['tool_calls'])
		}
		messages.push(message)
	}
	return messages
}

// The validated received response of an `llm_call` payload, or null when the payload carries none. Only the fields the transcript renders are kept.
/**
 * @param {unknown} payload
 * @returns {{ reasoning: string, content: string, toolCalls: TranscriptToolCall[] }|null}
 */
function receivedOf(payload) {
	if (payload === null || !isObject(payload)) return null
	const received = payload['received']
	if (!isObject(received)) return null
	return {
		reasoning: typeof received['reasoning'] === 'string' ? received['reasoning'] : '',
		content: typeof received['content'] === 'string' ? received['content'] : '',
		toolCalls: Array.isArray(received['toolCalls']) ? toolCallsOf(received['toolCalls']) : [],
	}
}

// The validated tool calls of an assistant message (`tool_calls`, the wire shape) or a received response (`toolCalls`, the shaped shape) — both carry `id` and `function.name`/`function.arguments`, which is all the transcript renders.
/**
 * @param {unknown[]} rawCalls
 * @returns {TranscriptToolCall[]}
 */
function toolCallsOf(rawCalls) {
	const calls = []
	for (const rawCall of rawCalls) {
		if (!isObject(rawCall) || !isObject(rawCall['function'])) continue
		calls.push({
			id: typeof rawCall['id'] === 'string' ? rawCall['id'] : '',
			name: typeof rawCall['function']['name'] === 'string' ? rawCall['function']['name'] : '',
			argumentsText: typeof rawCall['function']['arguments'] === 'string' ? rawCall['function']['arguments'] : '',
		})
	}
	return calls
}

// The outcome a tool-result message reports: the conversation carries the serialized ToolResult — success results are the bare data JSON, errors the `{ kind, message, details }` envelope — so the kind is read off the envelope when it names one and the summary prefers the error message, then the result card's summary, then the compact JSON. Non-JSON text (a serialization the conversation-length truncation cut) reads as an unknown kind with the raw text.
/**
 * @param {string} content
 * @returns {TranscriptOutcome}
 */
function outcomeOfToolContent(content) {
	const parsed = parseJsonOrUndefined(content)
	if (parsed === undefined) return { kind: null, summary: capSummary(content) }
	if (isObject(parsed) && typeof parsed['kind'] === 'string' && parsed['kind'] !== 'success' && typeof parsed['message'] === 'string' && parsed['message'] !== '') {
		return { kind: parsed['kind'], summary: capSummary(parsed['message']) }
	}
	if (isObject(parsed) && typeof parsed['summary'] === 'string' && parsed['summary'] !== '') return { kind: 'success', summary: capSummary(parsed['summary']) }
	return { kind: 'success', summary: compactValue(parsed) }
}

// Walks one turn's sent slice pairing each assistant message's tool calls with the tool messages that answer them — the executor appends the assistant message with all its calls first and then each result in call order, so the pairing within the slice is positional. Returns the outcome per call id (the map the previous turn's response renders its calls from) and, per tool-message position, the id of the call it answers (the consumed positions the next slice's rendering skips).
/**
 * @param {TranscriptMessage[]} sent
 * @returns {{ byId: Map<string, TranscriptOutcome>, answeredBy: Map<number, string> }}
 */
function sliceOutcomeWalk(sent) {
	const byId = new Map()
	const answeredBy = new Map()
	const pending = []
	for (let position = 0; position < sent.length; position++) {
		const message = sent[position]
		if (message['role'] === 'assistant' && Array.isArray(message['tool_calls'])) {
			for (const call of message['tool_calls']) pending.push(call)
			continue
		}
		if (message['role'] !== 'tool') continue
		const call = pending.shift()
		if (call === undefined) continue
		answeredBy.set(position, call['id'])
		byId.set(call['id'], message['outcome'])
	}
	return { byId, answeredBy }
}

// The call ids the previous turn's response rendered inline, or null when there is no previous turn in the document or its response was not rendered (its bodies were not logged) — a slice's tool results then render standalone instead of being consumed by that rendering.
/**
 * @param {{ sent: TranscriptMessage[], received: { reasoning: string, content: string, toolCalls: TranscriptToolCall[] }|null }|null} previousBody
 * @returns {Set<string>|null}
 */
function renderedCallIds(previousBody) {
	if (previousBody === null || previousBody.received === null) return null
	const ids = new Set()
	for (const call of previousBody.received.toolCalls) ids.add(call['id'])
	return ids
}

// The conversation opening: the leading run of system/user messages at the head of the scoped instance's first turn's slice — the system prompt and the task. The run stops at the first assistant or tool message (those belong to the turn's own rendering).
/**
 * @param {TranscriptMessage[]} sent
 * @returns {TranscriptMessage[]}
 */
function leadingOpening(sent) {
	const opening = []
	for (const message of sent) {
		if (message['role'] !== 'system' && message['role'] !== 'user') break
		opening.push(message)
	}
	return opening
}

// The scoped instance's transcript: its turn entries stitched into one continuous document (see the module header for the no-repetition contract). Entries arrive pre-scoped and renumbered (scopeTurnEntries); each completed turn's body comes from the `llm_call` payload the loaded events hold at the entry's event index — a turn the standard level logged body-less renders its header and notice only, an in-flight turn carries no body at all. Malformed entries are skipped.
/**
 * @param {unknown} entries
 * @param {unknown} logEvents
 * @returns {TranscriptTurn[]}
 */
export function deriveTranscriptTurns(entries, logEvents) {
	if (!Array.isArray(entries)) return []
	const events = Array.isArray(logEvents) ? logEvents : []
	const payloads = payloadIndex(events)
	const bodies = []
	const walks = []
	for (const entry of entries) {
		if (!isObject(entry) || entry['levelHint'] !== 'full') {
			bodies.push(null)
			walks.push(null)
			continue
		}
		const payload = payloads.get(entry['eventIndex'])
		const sent = sentSliceOf(payload)
		const body = sent !== null ? { sent, received: receivedOf(payload) } : null
		bodies.push(body)
		walks.push(body !== null ? sliceOutcomeWalk(body.sent) : null)
	}
	const turns = []
	for (let position = 0; position < entries.length; position++) {
		const entry = entries[position]
		if (!isObject(entry)) continue
		const body = bodies[position]
		const opening = []
		const messages = []
		let received = null
		if (body !== null) {
			const walk = walks[position]
			// The previous turn's rendered calls: the tool results in this turn's slice that answer them are already rendered there (inline with the calls), so they do not render again here.
			const previousCallIds = renderedCallIds(bodies[position - 1] ?? null)
			let startFrom = 0
			if (position === 0) {
				for (const message of leadingOpening(body.sent)) opening.push(message)
				startFrom = opening.length
			}
			for (let index = startFrom; index < body.sent.length; index++) {
				const message = body.sent[index]
				if (message === undefined) continue
				// The echo assistant message is the previous turn's response — its content and calls render in that turn's response section (or, when that turn lies outside the loaded window, the Older turns control pages it into the document).
				if (message['role'] === 'assistant') continue
				if (message['role'] === 'tool' && previousCallIds !== null && walk !== null) {
					const answered = walk.answeredBy.get(index)
					if (answered !== undefined && previousCallIds.has(answered)) continue
				}
				messages.push(message)
			}
			// The answering results live in the next turn's slice; the transcript's last turn has none, so its calls read as unanswered.
			const nextWalk = position + 1 < walks.length ? walks[position + 1] : null
			const ownReceived = body.received
			if (ownReceived !== null) {
				received = {
					reasoning: ownReceived.reasoning,
					content: ownReceived.content,
					toolCalls: ownReceived.toolCalls.map((call) => ({ ...call, outcome: nextWalk !== null && nextWalk.byId.has(call['id']) ? nextWalk.byId.get(call['id']) ?? null : null })),
				}
			}
		}
		turns.push({
			kind: entry['kind'] === 'in_flight' ? 'in_flight' : 'completed',
			turnNumber: typeof entry['turnNumber'] === 'number' ? entry['turnNumber'] : 0,
			eventIndex: typeof entry['eventIndex'] === 'number' ? entry['eventIndex'] : 0,
			role: typeof entry['role'] === 'string' ? entry['role'] : '',
			roleId: typeof entry['roleId'] === 'string' ? entry['roleId'] : '',
			messageCount: readMessageCount(entry['messageCount']),
			timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null,
			usage: readUsage(entry['usage']),
			finishReason: typeof entry['finishReason'] === 'string' ? entry['finishReason'] : null,
			bodyLevel: entry['levelHint'] === 'full' || entry['levelHint'] === 'standard' ? entry['levelHint'] : null,
			opening,
			messages,
			received,
		})
	}
	return turns
}

// The child instance an `agent` tool call spawned, or null: the first `role_start` after the turn's event whose `parentRoleId` names the parent instance. The executor dispatches the agent call immediately after the turn's `llm_call` lands, so the first match is the call's child — a turn that delegates twice delegates sequentially, and one affordance per turn resolves to the first child. Old logs whose `role_start` predates per-instance parent ids fall back to the parent role-name echo (`parent`), matching the scope's own role-name fallback. Malformed input reads as no child.
/**
 * @param {unknown} logEvents
 * @param {unknown} parentRoleId
 * @param {unknown} afterEventIndex
 * @returns {string|null}
 */
export function childInstanceFor(logEvents, parentRoleId, afterEventIndex) {
	if (!Array.isArray(logEvents)) return null
	if (typeof parentRoleId !== 'string' || parentRoleId === '') return null
	if (typeof afterEventIndex !== 'number' || !Number.isInteger(afterEventIndex) || afterEventIndex < 0) return null
	for (const event of logEvents) {
		if (!isObject(event)) continue
		if (event['type'] !== 'role_start') continue
		const index = readEventIndex(event['index'])
		if (index === null || index <= afterEventIndex) continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		const roleId = readInstanceId(payload['roleId'])
		if (roleId === null) continue
		const exactParent = readInstanceId(payload['parentRoleId'])
		if (exactParent !== null) {
			if (exactParent === parentRoleId) return roleId
			continue
		}
		if (payload['parent'] === parentRoleId) return roleId
	}
	return null
}

// --- Rendering ---------------------------------------------------------------

// Fixed trusted copy for the per-turn degraded notice (not agent prose, so it never flows through Markdown): it names the cause (the run logged at the standard level) and the fix (pick Full logging before starting a run), instead of an empty section that reads as a bug.
const DEGRADED_NOTICE = 'Message bodies were not logged for this turn: the run\u2019s logging level is Standard, which records turn metadata only (roles, usage, finish reasons). Choose Full logging on the compose screen before starting a run to capture the full request and response bodies here.'

const IN_FLIGHT_NOTE = 'This turn is in flight — its request and response appear here once the model responds.'

const OPENING_LABEL = 'system prompt \u00b7 task'

// Compact summaries cap at this length so the transcript reads inline; the full text rides the element's title.
const SUMMARY_MAX_CHARS = 240

function capSummary(text) {
	if (text.length <= SUMMARY_MAX_CHARS) return text
	return `${text.slice(0, SUMMARY_MAX_CHARS)}\u2026`
}

// Parses a JSON text, or undefined when it is not valid JSON. Tool results and tool-call arguments are serialized JSON, but the conversation-length truncation can cut one mid-string; parse failure is an expected shape, not an exceptional one.
/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJsonOrUndefined(text) {
	if (typeof text !== 'string' || text === '') return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

// One-line JSON form of a parsed value, falling back to its String form when it is not serializable so the summary never throws (mirrors tooltip.js).
/**
 * @param {unknown} value
 * @returns {string}
 */
function compactValue(value) {
	try {
		return capSummary(JSON.stringify(value))
	} catch {
		return capSummary(String(value))
	}
}

// One-line summary of a tool call's raw arguments: the arguments re-stringified compact when parseable, else the raw text.
/**
 * @param {string} argumentsText
 * @returns {string}
 */
function argumentsSummary(argumentsText) {
	const parsed = parseJsonOrUndefined(argumentsText)
	if (parsed === undefined) return capSummary(argumentsText)
	return compactValue(parsed)
}

function usageLabel(usage) {
	if (usage === null || typeof usage['totalTokens'] !== 'number' || !Number.isFinite(usage['totalTokens'])) return '\u2014'
	return `${usage['totalTokens']} tok`
}

function labeledSection(h, label, bodyNode) {
	return h('div', { class: 'inspector-section' }, [
		h('span', { class: 'inspector-section-label' }, [label]),
		bodyNode,
	])
}

// The success/error chip a tool result or an answered tool call carries. An unknown kind (non-JSON result text) renders the neutral em dash so nothing is invented.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {TranscriptOutcome|null} outcome
 * @returns {unknown}
 */
function outcomeChipNode(h, outcome) {
	if (outcome === null || outcome.kind === null || outcome.kind === '') return null
	if (outcome.kind === 'success') return h('span', { class: 'inspector-tool-outcome inspector-tool-outcome-success' }, ['\u2713 success'])
	return h('span', { class: 'inspector-tool-outcome inspector-tool-outcome-error' }, [`\u2717 ${outcome.kind}`])
}

// The transcript's message blocks: a user or system message renders its role chip and its content through the sanitized Markdown pipeline; a tool message renders as a result row with its outcome chip and compact summary.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {TranscriptMessage} message
 * @returns {unknown}
 */
function messageNode(h, renderMarkdown, message) {
	if (message.role === 'tool') {
		const outcome = message.outcome
		return h('div', { class: 'inspector-message inspector-tool-result' }, [
			h('span', { class: 'inspector-message-role' }, ['tool result']),
			outcomeChipNode(h, outcome),
			outcome !== null && outcome.summary !== '' ? h('pre', { class: 'inspector-tool-call-result' }, [outcome.summary]) : null,
		])
	}
	return h('div', { class: 'inspector-message' }, [
		h('span', { class: 'inspector-message-role' }, [message.role]),
		message.content !== '' ? h('div', { class: 'inspector-message-content markdown' }, renderMarkdown(message.content)) : null,
	])
}

// One inline tool call of the assistant's response: the tool name, the compact arguments summary, the outcome chip once the answering result exists in the loaded window, and the compact result summary. An `agent` call that spawned a child instance renders as the delegation affordance — `agent → <child>` with a View control that re-scopes the transcript to the child (pushing the breadcrumb; the ↑ parent affordance pops back). No identifiable child renders the call as plain text.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {TranscriptTurn} turn
 * @param {TranscriptToolCall} call
 * @param {{ logEvents: unknown[], scopedRoleId: string|null, livePartial: { roleId: string|null, role: string, reasoning: string, content: string }|null, onScopeInstance: unknown }} links
 * @returns {unknown}
 */
function toolCallNode(h, turn, call, links) {
	const childRoleId = call.name === 'agent' ? childInstanceFor(links.logEvents, links.scopedRoleId, turn.eventIndex) : null
	const children = [h('span', { class: 'inspector-tool-call-name' }, [call.name])]
	if (childRoleId !== null) children.push(h('span', { class: 'inspector-tool-call-child-id' }, [`\u2192 ${childRoleId}`]))
	const argsSummary = argumentsSummary(call.argumentsText)
	if (argsSummary !== '') children.push(h('span', { class: 'inspector-tool-call-args', title: call.argumentsText }, [argsSummary]))
	if (call.outcome !== null) children.push(outcomeChipNode(h, call.outcome))
	if (childRoleId !== null) {
		children.push(h('button', { type: 'button', class: 'inspector-tool-call-view', title: `Scope the transcript to the child instance ${childRoleId}`, onclick: [links.onScopeInstance, childRoleId] }, ['View \u25b8']))
	}
	if (call.outcome !== null && call.outcome.summary !== '') children.push(h('pre', { class: 'inspector-tool-call-result' }, [call.outcome.summary]))
	return h('div', { class: 'inspector-tool-call' }, children)
}

// The turn's response: the reasoning (labeled 💭 — the model's prose an operator is specifically inspecting for) and the content, both through the sanitized Markdown pipeline, then the response's tool calls inline.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {TranscriptTurn} turn
 * @param {{ logEvents: unknown[], scopedRoleId: string|null, livePartial: { roleId: string|null, role: string, reasoning: string, content: string }|null, onScopeInstance: unknown }} links
 * @returns {unknown}
 */
function responseNode(h, renderMarkdown, turn, links) {
	const received = turn.received
	if (received === null) return null
	const children = []
	if (received.reasoning !== '') children.push(labeledSection(h, '\ud83d\udcad Reasoning', h('div', { class: 'inspector-reasoning markdown' }, renderMarkdown(received.reasoning))))
	if (received.content !== '') children.push(h('div', { class: 'inspector-prose markdown' }, renderMarkdown(received.content)))
	for (const call of received.toolCalls) children.push(toolCallNode(h, turn, call, links))
	if (children.length === 0) children.push(h('span', { class: 'inspector-empty-value' }, ['\u2014']))
	return h('div', { class: 'inspector-response' }, children)
}

// The quiet per-turn header: the turn's number within the instance, its token bill, and its finish reason. An in-flight turn has none of the latter two yet — it reads "in flight…".
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {TranscriptTurn} turn
 * @returns {unknown}
 */
function turnHeaderNode(h, turn) {
	if (turn.kind === 'in_flight') return h('div', { class: 'inspector-turn-header' }, [`Turn ${turn.turnNumber} \u00b7 in flight\u2026`])
	return h('div', { class: 'inspector-turn-header' }, [`Turn ${turn.turnNumber} \u00b7 ${usageLabel(turn.usage)} \u00b7 ${turn.finishReason ?? '\u2014'}`])
}

// The conversation opening (the scoped instance's first turn's leading system/user messages — the system prompt and the task), collapsed by default: it is context, not story, so one native details expander holds it above the turns.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {TranscriptMessage[]} opening
 * @returns {unknown}
 */
function openingNode(h, renderMarkdown, opening) {
	if (opening.length === 0) return null
	return h('details', { class: 'inspector-opening' }, [
		h('summary', { class: 'inspector-opening-summary' }, [OPENING_LABEL]),
		h('div', { class: 'inspector-opening-body' }, opening.map((message) => messageNode(h, renderMarkdown, message))),
	])
}

// --- On-the-wire expander ----------------------------------------------------
// Each completed turn's collapsed view of the FULL request the model saw at that turn (system + task + every message up to and including it). It is a different view of the same turn than the inline new-messages rendering above the response — the transcript's story vs the complete envelope — so it is labeled distinctly and its body comes from the window endpoint's `?detail=` fold via the app's bounded session cache (wire-details.js), which the modal reads through the injected lookup and never fetches itself.

const WIRE_LABEL = 'on the wire'

// Fixed trusted copy for the expander's three non-section states (not agent prose, so none flows through Markdown). The idle state is only visible when a fetch has failed and been evicted (or the entry aged out of the cache) — an open expander never renders it otherwise, because the open marks the cache loading before the next render.
const WIRE_RETRY_NOTICE = 'The full request could not be loaded — close and reopen this expander to retry.'

const WIRE_LOADING_NOTE = 'Loading the full request\u2026'

const WIRE_EMPTY_NOTICE = 'No request or response detail was logged for this turn.'

// The wire state a turn's expander renders, normalized from the session cache's lookup so a malformed entry reads as the retry notice rather than inventing content (the never-invent rule the transcript follows throughout).
/**
 * @param {unknown} value
 * @returns {{ status: 'idle' } | { status: 'loading' } | { status: 'ready', sections: Array<{label: string, content: unknown}>|null }}
 */
function wireStateForRender(value) {
	if (!isObject(value)) return { status: 'idle' }
	if (value['status'] === 'loading') return { status: 'loading' }
	if (value['status'] === 'ready') return { status: 'ready', sections: Array.isArray(value['sections']) ? value['sections'] : null }
	return { status: 'idle' }
}

// The expander's collapsed summary: the label plus the full request's message count when the turn's payload reports one — the count is known before any fetch, because it rides the turn's own `llm_call` payload.
/**
 * @param {TranscriptTurn} turn
 * @returns {string}
 */
function wireSummaryLabel(turn) {
	const count = turn.messageCount
	if (typeof count !== 'number') return WIRE_LABEL
	return `${WIRE_LABEL} \u00b7 ${count} message${count === 1 ? '' : 's'}`
}

// Pretty-prints a value as JSON, falling back to its String form when it is not serializable so the `<pre>` never throws (mirrors tooltip.js).
/**
 * @param {unknown} value
 * @returns {string}
 */
function toJsonText(value) {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function jsonBlock(h, content) {
	return h('pre', { class: 'inspector-json' }, [toJsonText(content)])
}

// The `sent` section: one labeled block per message of the folded request — role as a machine chip, content as sanitized Markdown, tool calls as pretty-printed JSON. A message that is neither renders as its JSON so nothing is invented or dropped.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {unknown[]} messages
 * @returns {unknown}
 */
function sentMessagesNode(h, renderMarkdown, messages) {
	const rows = []
	for (const message of messages) {
		if (!isObject(message)) continue
		const children = [h('span', { class: 'inspector-message-role' }, typeof message['role'] === 'string' && message['role'] !== '' ? message['role'] : 'message')]
		if (typeof message['content'] === 'string' && message['content'] !== '') {
			children.push(h('div', { class: 'inspector-message-content markdown' }, renderMarkdown(message['content'])))
		}
		if (Array.isArray(message['tool_calls']) && message['tool_calls'].length > 0) {
			children.push(jsonBlock(h, message['tool_calls']))
		}
		if (children.length > 1) rows.push(h('div', { class: 'inspector-message' }, children))
	}
	if (rows.length === 0) return h('span', { class: 'inspector-empty-value' }, ['\u2014'])
	return h('div', { class: 'inspector-message-list' }, rows)
}

// The `received` section: the assistant response with its content and its reasoning (both rendered as Markdown — model prose an operator is specifically inspecting for) and its parsed tool calls.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {unknown} received
 * @returns {unknown}
 */
function receivedNode(h, renderMarkdown, received) {
	if (!isObject(received)) return h('span', { class: 'inspector-empty-value' }, ['\u2014'])
	const children = []
	if (typeof received['content'] === 'string' && received['content'] !== '') {
		children.push(labeledSection(h, 'Response', h('div', { class: 'inspector-prose markdown' }, renderMarkdown(received['content']))))
	}
	if (typeof received['reasoning'] === 'string' && received['reasoning'] !== '') {
		children.push(labeledSection(h, 'Reasoning', h('div', { class: 'inspector-reasoning markdown' }, renderMarkdown(received['reasoning']))))
	}
	if (Array.isArray(received['toolCalls']) && received['toolCalls'].length > 0) {
		children.push(labeledSection(h, 'Tool calls', jsonBlock(h, received['toolCalls'])))
	}
	if (children.length === 0) return h('span', { class: 'inspector-empty-value' }, ['\u2014'])
	return h('div', { class: 'inspector-received' }, children)
}

// Renders one wire section by its machine label. The endpoint only ever returns the four `formatLogDetailSections` labels for an `llm_call`; anything else falls back to the tooltip's by-kind formatting (JSON for objects, Markdown for prose) so a future section kind degrades readably rather than vanishing.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {unknown} section
 * @returns {unknown}
 */
function wireSectionNode(h, renderMarkdown, section) {
	if (!isObject(section)) return null
	const label = typeof section['label'] === 'string' ? section['label'] : ''
	const content = section['content']
	if (label === 'sent') {
		if (!Array.isArray(content)) return null
		return labeledSection(h, 'Sent messages', sentMessagesNode(h, renderMarkdown, content))
	}
	if (label === 'received') return labeledSection(h, 'Received', receivedNode(h, renderMarkdown, content))
	if (label === 'finish reason') {
		return labeledSection(h, 'Finish reason', h('span', { class: 'inspector-scalar' }, [typeof content === 'string' && content !== '' ? content : '\u2014']))
	}
	if (label === 'usage') {
		if (!isObject(content)) return null
		return labeledSection(h, 'Usage', jsonBlock(h, content))
	}
	if (isObject(content) || Array.isArray(content)) return labeledSection(h, label, jsonBlock(h, content))
	if (typeof content === 'string' && content !== '') return labeledSection(h, label, h('div', { class: 'inspector-prose markdown' }, renderMarkdown(content)))
	return labeledSection(h, label, h('span', { class: 'inspector-scalar' }, [content === null || content === undefined ? '\u2014' : String(content)]))
}

/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {Array<{label: string, content: unknown}>} sections
 * @returns {unknown}
 */
function wireSectionsNode(h, renderMarkdown, sections) {
	const children = []
	for (const section of sections) {
		const node = wireSectionNode(h, renderMarkdown, section)
		if (node !== null) children.push(node)
	}
	return h('div', { class: 'inspector-wire-sections' }, children)
}

// The expander's body from the cache's normalized state: the folded sections (or the honest empty notice), the loading note, or the retry notice for a state with no envelope behind it.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {{ status: 'idle' } | { status: 'loading' } | { status: 'ready', sections: Array<{label: string, content: unknown}>|null }} state
 * @returns {unknown}
 */
function wireBodyNode(h, renderMarkdown, state) {
	if (state.status === 'ready') {
		if (state.sections === null) return h('p', { class: 'inspector-wire-note' }, [WIRE_EMPTY_NOTICE])
		return wireSectionsNode(h, renderMarkdown, state.sections)
	}
	if (state.status === 'loading') return h('p', { class: 'inspector-wire-note' }, [WIRE_LOADING_NOTE])
	return h('p', { class: 'inspector-wire-note' }, [WIRE_RETRY_NOTICE])
}

// The per-turn "on the wire" expander, rendered by every completed turn (an in-flight turn has no `llm_call` to fetch). Collapsed like the opening expander; the first open fires the app's toggle handler, which fetches the sections once into the session cache, and the body renders the cache's state. The lookup and toggle wiring are injected props — a modal mounted without them renders no expander rather than a dead one.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {TranscriptTurn} turn
 * @param {{ logEvents: unknown[], scopedRoleId: string|null, livePartial: { roleId: string|null, role: string, reasoning: string, content: string }|null, onScopeInstance: unknown, wireDetailLookup: ((eventIndex: number) => unknown)|null, onToggleWire: ((eventIndex: number) => unknown)|null }} links
 * @returns {unknown}
 */
function wireExpanderNode(h, renderMarkdown, turn, links) {
	if (turn.kind !== 'completed') return null
	if (links.wireDetailLookup === null || links.onToggleWire === null) return null
	const state = wireStateForRender(links.wireDetailLookup(turn.eventIndex))
	return h('details', { class: 'inspector-wire', ontoggle: links.onToggleWire(turn.eventIndex) }, [
		h('summary', { class: 'inspector-wire-summary' }, [wireSummaryLabel(turn)]),
		h('div', { class: 'inspector-wire-body' }, [wireBodyNode(h, renderMarkdown, state)]),
	])
}

// The live partial prop, validated: an absent or malformed prop renders nothing rather than inventing sections (the never-invent rule the transcript follows throughout). Only the fields the rendering reads are carried.
/**
 * @param {unknown} value
 * @returns {{ roleId: string|null, role: string, reasoning: string, content: string }|null}
 */
function livePartialForRender(value) {
	if (!isObject(value)) return null
	const role = typeof value['role'] === 'string' ? value['role'] : null
	if (role === null) return null
	const roleId = typeof value['roleId'] === 'string' && value['roleId'] !== '' ? value['roleId'] : null
	const reasoning = typeof value['reasoning'] === 'string' ? value['reasoning'] : ''
	const content = typeof value['content'] === 'string' ? value['content'] : ''
	return { roleId, role, reasoning, content }
}

// Whether the transcript turn is the in-flight turn the live partial belongs to. The partial's own `roleId` is matched first so a same-named sibling instance's ghost turn (an unmatched start whose failure event has paged out of the loaded window) never hosts another instance's stream; turns whose id fell back to the role name (old logs) pair on the role name as before.
/**
 * @param {TranscriptTurn} turn
 * @param {{ roleId: string|null, role: string, reasoning: string, content: string }|null} livePartial
 * @returns {boolean}
 */
function isLiveTurn(turn, livePartial) {
	if (livePartial === null) return false
	if (turn.kind !== 'in_flight') return false
	if (turn.role !== turn.roleId && livePartial.roleId !== null && livePartial.roleId !== '') return turn.roleId === livePartial.roleId
	return turn.role === livePartial.role
}

// The live block at the in-flight turn: the streamed reasoning and response, each labeled like the transcript's response sections and rendered through the same sanitized Markdown pipeline. A field with no text yet renders nothing, and an all-empty partial renders no block at all — the app clears the partial when the socket drops, so a stale block never lingers.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {{ role: string, reasoning: string, content: string }} livePartial
 * @returns {unknown}
 */
function livePartialNode(h, renderMarkdown, livePartial) {
	const children = []
	if (livePartial.reasoning !== '') children.push(labeledSection(h, '\ud83d\udcad Reasoning', h('div', { class: 'inspector-reasoning markdown' }, renderMarkdown(livePartial.reasoning))))
	if (livePartial.content !== '') children.push(labeledSection(h, 'Response', h('div', { class: 'inspector-prose markdown' }, renderMarkdown(livePartial.content))))
	if (children.length === 0) return null
	return h('div', { class: 'inspector-live-partial' }, children)
}

// One turn of the transcript: the quiet header, then the turn's new messages in order, then the response, then the collapsed "on the wire" expander (completed turns only). An in-flight turn renders its note and — when the websocket partial matches this instance — the live reasoning/content block beneath it; the poll's completed turn replaces both in sequence. A turn the standard level logged body-less renders the honest degraded notice instead.
/**
 * @param {function(string, Record<string, unknown>, unknown): unknown} h
 * @param {function(string): unknown} renderMarkdown
 * @param {TranscriptTurn} turn
 * @param {{ logEvents: unknown[], scopedRoleId: string|null, livePartial: { roleId: string|null, role: string, reasoning: string, content: string }|null, onScopeInstance: unknown, wireDetailLookup: ((eventIndex: number) => unknown)|null, onToggleWire: ((eventIndex: number) => unknown)|null }} links
 * @returns {unknown}
 */
function turnSectionNode(h, renderMarkdown, turn, links) {
	const children = [turnHeaderNode(h, turn)]
	if (turn.kind === 'in_flight') {
		children.push(h('p', { class: 'inspector-transcript-note' }, [IN_FLIGHT_NOTE]))
		if (isLiveTurn(turn, links.livePartial) && links.livePartial !== null) {
			const block = livePartialNode(h, renderMarkdown, links.livePartial)
			if (block !== null) children.push(block)
		}
	} else if (turn.bodyLevel === 'standard') {
		children.push(h('p', { class: 'inspector-degraded-notice' }, [DEGRADED_NOTICE]))
	} else {
		for (const message of turn.messages) children.push(messageNode(h, renderMarkdown, message))
		const response = responseNode(h, renderMarkdown, turn, links)
		if (response !== null) children.push(response)
	}
	const wire = wireExpanderNode(h, renderMarkdown, turn, links)
	if (wire !== null) children.push(wire)
	return h('div', { class: { 'inspector-turn-section': true, 'is-in-flight': turn.kind === 'in_flight' } }, children)
}

// The breadcrumb row: one crumb per chain instance, root first, joined by '▸' separators; the last crumb is the scoped instance (disabled — it is where the transcript already is). Each earlier crumb and the '↑ parent' affordance re-scope via the hyperapp tuple `[onScopeInstance, roleId]`, so the action receives the instance id directly. A chain that renders nothing (no loaded instances) renders no row.
function breadcrumbNode(h, chain, onScopeInstance) {
	const crumbs = []
	for (const crumb of chain) {
		if (!isObject(crumb) || typeof crumb['roleId'] !== 'string' || crumb['roleId'] === '') return null
		crumbs.push(crumb)
	}
	if (crumbs.length === 0) return null
	const children = []
	for (let position = 0; position < crumbs.length; position++) {
		const crumb = crumbs[position]
		if (position > 0) children.push(h('span', { class: 'inspector-crumb-sep' }, '\u25b8'))
		const isCurrent = position === crumbs.length - 1
		children.push(h('button', { type: 'button', class: { 'inspector-crumb': true, 'is-current': isCurrent }, disabled: isCurrent, title: isCurrent ? 'The instance the transcript is scoped to' : `Scope the transcript to ${crumb.roleId}`, onclick: [onScopeInstance, crumb.roleId] }, [crumb.roleId]))
	}
	if (crumbs.length > 1) {
		const parent = crumbs[crumbs.length - 2]
		children.push(h('button', { type: 'button', class: 'inspector-parent-up', title: `Scope the transcript to the parent instance ${parent.roleId}`, onclick: [onScopeInstance, parent.roleId] }, '\u2191 parent'))
	}
	return h('div', { class: 'inspector-breadcrumb-row' }, children)
}

// The minimal instance dropdown above the transcript (wayfinding): one option per loaded instance, labeled with the role name, the instance id when it differs, and the live/finished status; selecting re-scopes. The change event goes to the bare `onScopeInstance` action (the app reads the selected value off the event, mirroring the flow-tier select).
function instanceSelectNode(h, instances, scopedRoleId, onScopeInstance) {
	const options = []
	for (const instance of instances) {
		if (!isObject(instance) || typeof instance['roleId'] !== 'string' || instance['roleId'] === '') return null
		const role = typeof instance['role'] === 'string' && instance['role'] !== '' ? instance['role'] : instance['roleId']
		const status = instance['live'] === true ? 'live' : 'finished'
		const idSuffix = instance['roleId'] !== role ? ` (${instance['roleId']})` : ''
		options.push(h('option', { value: instance['roleId'], selected: instance['roleId'] === scopedRoleId }, [`${role}${idSuffix} \u2014 ${status}`]))
	}
	if (options.length === 0) return null
	const selectProps = { class: 'inspector-instance-select', onchange: onScopeInstance }
	if (scopedRoleId !== null) selectProps['value'] = scopedRoleId
	return h('label', { class: 'inspector-instance-row' }, [
		h('span', { class: 'inspector-instance-label' }, 'Instance'),
		h('select', selectProps, options),
	])
}

// The modal overlay: a backdrop over the run view plus a wide card whose body is the scoped instance's transcript — one continuous document of the instance's turns, topped by the "older turns" window control and the collapsed conversation opening. Above the body sit the heading, the delegation-chain breadcrumb, and the instance dropdown. `onScopeInstance` is wired bare on the dropdown (it reads the change event) and per crumb/View affordance with the instance id as payload; `onLoadOlder` and `onClose` are caller-supplied actions wired bare, mirroring the result modal's close wiring. `wireDetailLookup` reads the app's bounded session cache for a turn's "on the wire" envelope and `onToggleWire` is the app's open action factory (the expander wires it curried with the turn's event index, since the toggle event cannot carry it); a modal mounted without either renders no expanders.
export function InspectorModal(h, props) {
	const renderMarkdown = props.renderMarkdown
	const logEvents = Array.isArray(props.logEvents) ? props.logEvents : []
	const scopedRoleId = typeof props.scopedRoleId === 'string' && props.scopedRoleId !== '' ? props.scopedRoleId : null
	const turns = isObject(props.turns) ? props.turns : {}
	const runLabel = typeof props.runLabel === 'string' && props.runLabel !== '' ? props.runLabel : null
	const instances = Array.isArray(props.instances) ? props.instances : []
	const chain = Array.isArray(props.chain) ? props.chain : []
	const onScopeInstance = props.onScopeInstance
	const onLoadOlder = props.onLoadOlder
	const onClose = props.onClose
	const wireDetailLookup = typeof props.wireDetailLookup === 'function' ? props.wireDetailLookup : null
	const onToggleWire = typeof props.onToggleWire === 'function' ? props.onToggleWire : null
	const loadState = turns['loadState']
	const olderLoading = turns['olderLoading'] === true
	const hasOlder = canPageOlder(turns['tailOffset'])
	const livePartial = livePartialForRender(props.livePartial)

	const entries = scopeTurnEntries(buildTurnIndex(logEvents), scopedRoleId)
	const transcript = deriveTranscriptTurns(entries, logEvents)
	const links = { logEvents, scopedRoleId, livePartial, onScopeInstance, wireDetailLookup, onToggleWire }

	const bodyChildren = []
	if (loadState === 'loading') {
		bodyChildren.push(h('p', { class: 'inspector-transcript-note' }, ['Loading the run log\u2026']))
	} else if (loadState === 'failed') {
		bodyChildren.push(h('p', { class: 'inspector-transcript-note' }, ['The run log could not be loaded.']))
	} else {
		if (hasOlder) {
			bodyChildren.push(h('button', { type: 'button', class: 'inspector-older', disabled: olderLoading, onclick: onLoadOlder }, olderLoading ? 'loading older turns\u2026' : 'Older turns'))
		}
		if (transcript.length === 0) {
			// Scoped and unscoped empties read differently: a scope with no turns in the loaded range is wayfinding (older turns may page back, another instance may hold them), not an empty log.
			bodyChildren.push(h('p', { class: 'inspector-transcript-note' }, [scopedRoleId !== null ? 'No turns logged for this instance in the loaded range yet.' : 'No LLM turns logged for this run yet.']))
		} else {
			const firstTurn = transcript[0]
			if (firstTurn !== undefined) {
				const opening = openingNode(h, renderMarkdown, firstTurn.opening)
				if (opening !== null) bodyChildren.push(opening)
			}
			for (const turn of transcript) bodyChildren.push(turnSectionNode(h, renderMarkdown, turn, links))
		}
	}

	const breadcrumb = breadcrumbNode(h, chain, onScopeInstance)
	const instanceRow = instanceSelectNode(h, instances, scopedRoleId, onScopeInstance)
	return h('div', { class: 'inspector-modal-overlay' }, [
		h('div', { class: 'inspector-modal-backdrop', onclick: onClose }),
		h('div', { class: 'inspector-modal-card' }, [
			h('div', { class: 'inspector-modal-heading-row' }, [
				h('p', { class: 'inspector-modal-heading' }, runLabel !== null ? [`LLM turns \u00b7 ${runLabel}`] : ['LLM turns']),
				h('button', { type: 'button', class: 'inspector-modal-close', onclick: onClose }, 'Close'),
			]),
			breadcrumb !== null ? breadcrumb : null,
			instanceRow !== null ? instanceRow : null,
			h('div', { class: 'inspector-modal-body' }, bodyChildren),
		]),
	])
}
