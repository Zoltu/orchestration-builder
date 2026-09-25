// On-demand LLM request/response inspector for the run view: a stage-scoped modal listing the run's LLM turns (from the windowed log endpoint `GET /api/runs/:id/log`) with a detail pane that fetches one turn's full request/response bodies on demand (`GET /api/runs/:id/log?detail=<index>`, which folds an llm_call delta into the full conversation server-side). Proactive, not always-on: nothing here rides the 1s polls except the turn-list tail refresh while the modal is open on an active run, and detail bodies are fetched once per turn per session.
//
// Realtime contract: turns land at turn granularity only — the run log carries no token-level streaming. While a turn is in flight the log holds only its `llm_call_start` event (the role is known, the request and response are not), so the turn list renders that start as an "in flight" row and the tail refresh replaces it with the completed `llm_call` entry once the model responds. That delay is the intended behavior, not a defect.
//
// Under the run's `standard` logging level the log drops the sent/received bodies (see docs/reference.md "Logging level"), so a detail fetch returns only turn metadata; the detail pane then renders an honest degraded notice pointing at the logging-level setting instead of an empty error. The `h` and `renderMarkdown` dependencies are passed in rather than imported so the component stays free of hyperapp and showdown coupling and is exercisable in tests with fakes (mirroring question-modal.js / result-modal.js).
//
// The turn list is windowed: the modal opens on the most recent `INSPECTOR_WINDOW_SIZE` log events and an "older turns" control pages back by the same size, growing the loaded range (the loaded events are kept so pairing an `llm_call_start` with its `llm_call` stays correct across page boundaries; the poll's tail refresh appends new events to the same range). The loaded range therefore grows while the modal stays open on an active run — turn-inspection sessions are expected to be short, and reopening the modal resets it — so past `INSPECTOR_RETENTION_LIMIT` loaded events the poll resyncs with a fresh tail window instead of appending, keeping long-lived sessions bounded.
//
// The pure helpers (the window-offset math and `deriveDetailBodyState`) ship exported even though the component consumes them internally — per the labels.js convention, pure math/detail helpers are exported so the tests exercise the same implementations the view uses rather than a parallel copy.

import { isObject } from './guards.js'

// The log-event window size: the initial tail fetch, the "older turns" page size, and the resync window after a poll-refresh gap all use it.
export const INSPECTOR_WINDOW_SIZE = 200

// The poll-refresh page cap: the largest gap one tail-refresh fetch can bridge (bounded by the endpoint's own limit cap).
export const INSPECTOR_PAGE_LIMIT = 500

// The loaded-range retention cap: while the modal sits open on an active run the tail refresh keeps appending to the loaded events (rows carry full payloads at the `full` log level), so past this many loaded events the app.js poll takes the fresh-tail-window resync instead of appending.
export const INSPECTOR_RETENTION_LIMIT = INSPECTOR_WINDOW_SIZE * 20

/**
 * A log event as the windowed endpoint ships it: `{ index, timestamp, type, payload }`, where `index` is the event's log-wide position (the same identity `?detail=` addresses).
 *
 * @typedef {Object} LogWindowEvent
 * @property {number} index
 * @property {string|null} timestamp
 * @property {string} type
 * @property {unknown} payload
 */

/**
 * One LLM turn as the turn list renders it. `eventIndex` is the identity used for selection and `?detail=` addressing (a completed turn's `llm_call` event; an in-flight turn's `llm_call_start` event).
 *
 * @typedef {Object} TurnEntry
 * @property {'completed'|'in_flight'} kind
 * @property {number} eventIndex
 * @property {number|null} startEventIndex the paired `llm_call_start`'s index, on completed entries only
 * @property {number} turnNumber 1-based, chronological over the loaded events
 * @property {string} role
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

/**
 * A detail section as the detail endpoint ships it (the `LogDetailSection` shape from source/web/render.ts): a machine label (`'sent'`, `'received'`, `'finish reason'`, `'usage'`) and the raw content.
 *
 * @typedef {Object} DetailSection
 * @property {string} label
 * @property {unknown} content
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
 * The usage triple the turn list renders, or null when the payload carries none (absent, non-object, or non-numeric fields).
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
 * The event's log-wide index, or null when the window row does not carry a usable one (a non-integer or negative index cannot address `?detail=`).
 * @param {unknown} value
 * @returns {number|null}
 */
function readEventIndex(value) {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
	return value
}

// Derives the turn list from a window of log events (the shape `GET /api/runs/:id/log` returns). An `llm_call` event becomes a completed entry; an `llm_call_start` becomes an in-flight entry unless a matching `llm_call` for the same role follows it, in which case they pair into one completed entry. Matching is LIFO per role name so the same-name nesting the executor allows (a role spawning a same-named child) pairs like brackets — the log cannot carry the start's roleId, so the role name is the only key available. Entries come back in chronological (log) order with 1-based `turnNumber`s over the loaded events; malformed rows (non-objects, other types, non-record payloads, missing role, unusable index) are skipped so one torn row cannot corrupt the list. The log is append-only, so an in-flight entry that later completes is replaced wholesale by the next `buildTurnIndex` over the grown window.
/**
 * @param {unknown} logEvents
 * @returns {TurnEntry[]}
 */
export function buildTurnIndex(logEvents) {
	if (!Array.isArray(logEvents)) return []
	// Unmatched starts still open per role, chronological; popped LIFO on their matching call.
	const openStarts = new Map()
	const entries = []
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const type = event['type']
		if (type !== 'llm_call' && type !== 'llm_call_start') continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		const role = typeof payload['role'] === 'string' && payload['role'] !== '' ? payload['role'] : null
		const eventIndex = readEventIndex(event['index'])
		if (role === null || eventIndex === null) continue
		const timestamp = typeof event['timestamp'] === 'string' ? event['timestamp'] : null
		if (type === 'llm_call_start') {
			const open = openStarts.get(role)
			if (open === undefined) {
				openStarts.set(role, [{ eventIndex, timestamp }])
			} else {
				open.push({ eventIndex, timestamp })
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

// --- Detail body availability ------------------------------------------------

/**
 * Whether a detail response carries the turn's message bodies: `'full'` when a `sent` or `received` section is present, `'degraded'` otherwise (metadata-only sections, no sections at all, or a malformed response — under the `standard` logging level bodies are dropped from the log itself, so the honest rendering is the degraded notice, not an error). The caller distinguishes a fetch failure via its own state.
 * @param {unknown} detailSections
 * @returns {'full'|'degraded'}
 */
export function deriveDetailBodyState(detailSections) {
	if (!Array.isArray(detailSections)) return 'degraded'
	for (const section of detailSections) {
		if (!isObject(section)) continue
		if (section['label'] === 'sent' || section['label'] === 'received') return 'full'
	}
	return 'degraded'
}

// --- Selection continuity ----------------------------------------------------

/**
 * The selected turn's event index in the freshly derived list, given the selection made against the previous list. The log is append-only, so a surviving index keeps the selection; an in-flight turn's start index that has since paired maps to its completed entry (so a selected "in flight" row seamlessly becomes its completed detail); anything else reads as deselected.
 * @param {unknown} previousEventIndex
 * @param {TurnEntry[]} entries
 * @returns {number|null}
 */
export function resolveSelection(previousEventIndex, entries) {
	if (!Number.isInteger(previousEventIndex) || previousEventIndex < 0) return null
	for (const entry of entries) {
		if (entry.eventIndex === previousEventIndex) return previousEventIndex
	}
	for (const entry of entries) {
		if (entry.kind === 'completed' && entry.startEventIndex === previousEventIndex) return entry.eventIndex
	}
	return null
}

// --- Rendering ---------------------------------------------------------------

// Fixed trusted copy for the degraded state (not agent prose, so it never flows through Markdown): it names the cause (the run logged at the standard level) and the fix (pick Full logging before starting a run), instead of showing an empty pane that reads as a bug.
const DEGRADED_NOTICE = 'Message bodies were not logged for this run: the logging level is Standard, which records turn metadata only (roles, usage, finish reasons). Choose Full logging on the compose screen before starting a run to capture the full request and response bodies here.'

const IN_FLIGHT_NOTE = 'This turn is in flight — its request and response appear here once the model responds.'

// The selected turn's row label for the detail pane's fallback when the selection no longer resolves (the poll has since rebuilt the list): treated as "nothing selected" rather than an error.
const DETAIL_EMPTY = 'Select a turn to inspect its request and response.'

function clockLabel(timestamp) {
	if (typeof timestamp !== 'string' || timestamp === '') return '—'
	const parsed = new Date(timestamp)
	if (Number.isNaN(parsed.getTime())) return timestamp
	return parsed.toLocaleTimeString()
}

function usageLabel(usage) {
	if (usage === null || typeof usage.totalTokens !== 'number' || !Number.isFinite(usage.totalTokens)) return '—'
	return `${usage.totalTokens} tok`
}

// Pretty-prints a value as JSON, falling back to its String form when it is not serializable so the `<pre>` never throws (mirrors tooltip.js).
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

function labeledSection(h, label, bodyNode) {
	return h('div', { class: 'inspector-section' }, [
		h('span', { class: 'inspector-section-label' }, [label]),
		bodyNode,
	])
}

// The `sent` section: one labeled block per message — role as a machine chip, content as sanitized Markdown, tool calls as pretty-printed JSON. A message that is neither renders as its JSON so nothing is invented or dropped.
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
	if (rows.length === 0) return h('span', { class: 'inspector-empty-value' }, ['—'])
	return h('div', { class: 'inspector-message-list' }, rows)
}

// The `received` section: the assistant response with its content, its reasoning (clearly labeled and rendered as Markdown — the reasoning is model prose an operator is specifically inspecting for), and its parsed tool calls.
function receivedNode(h, renderMarkdown, received) {
	if (!isObject(received)) return h('span', { class: 'inspector-empty-value' }, ['—'])
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
	if (children.length === 0) return h('span', { class: 'inspector-empty-value' }, ['—'])
	return h('div', { class: 'inspector-received' }, children)
}

// Renders one detail section by its machine label. The turn list only ever fetches `llm_call` details, so the labels are the four `formatLogDetailSections` produces for that type; anything else falls back to the tooltip's by-kind formatting (JSON for objects, Markdown for prose) so a future section kind degrades readably rather than vanishing.
function detailSectionNode(h, renderMarkdown, section) {
	if (!isObject(section)) return null
	const label = typeof section['label'] === 'string' ? section['label'] : ''
	const content = section['content']
	if (label === 'sent') {
		if (!Array.isArray(content)) return null
		return labeledSection(h, 'Sent messages', sentMessagesNode(h, renderMarkdown, content))
	}
	if (label === 'received') return labeledSection(h, 'Received', receivedNode(h, renderMarkdown, content))
	if (label === 'finish reason') {
		return labeledSection(h, 'Finish reason', h('span', { class: 'inspector-scalar' }, [typeof content === 'string' && content !== '' ? content : '—']))
	}
	if (label === 'usage') {
		if (!isObject(content)) return null
		return labeledSection(h, 'Usage', jsonBlock(h, content))
	}
	if (isObject(content) || Array.isArray(content)) return labeledSection(h, label, jsonBlock(h, content))
	if (typeof content === 'string' && content !== '') return labeledSection(h, label, h('div', { class: 'inspector-prose markdown' }, renderMarkdown(content)))
	return labeledSection(h, label, h('span', { class: 'inspector-scalar' }, [content === null || content === undefined ? '—' : String(content)]))
}

function detailSectionsNode(h, renderMarkdown, sections) {
	const children = []
	for (const section of sections) {
		const node = detailSectionNode(h, renderMarkdown, section)
		if (node !== null) children.push(node)
	}
	return h('div', { class: 'inspector-detail-sections' }, children)
}

// The detail pane's body for the selected turn's cached detail state: `'loading'`/`null` (the fetch the select action scheduled is in flight), `'failed'` (the fetch errored), or `{ sections }` — rendered in full or, when the sections lack sent/received bodies, as the honest degraded notice alongside whatever metadata sections exist.
function detailPaneBody(h, renderMarkdown, detailState) {
	if (detailState === 'loading' || detailState === null || detailState === undefined) {
		return h('p', { class: 'inspector-detail-note' }, 'Loading the turn detail…')
	}
	if (detailState === 'failed') {
		return h('p', { class: 'inspector-detail-note' }, 'The turn detail could not be loaded.')
	}
	if (!isObject(detailState)) return h('p', { class: 'inspector-detail-note' }, 'The turn detail could not be loaded.')
	const sections = detailState['sections']
	if (deriveDetailBodyState(sections) === 'degraded') {
		const metadataSections = Array.isArray(sections) ? sections : []
		return h('div', { class: 'inspector-detail-degraded' }, [
			h('p', { class: 'inspector-degraded-notice' }, DEGRADED_NOTICE),
			detailSectionsNode(h, renderMarkdown, metadataSections),
		])
	}
	return detailSectionsNode(h, renderMarkdown, Array.isArray(sections) ? sections : [])
}

// One turn row: number, role, and time on the top line; usage, finish reason, and the body-availability hint on the second. The click is wired as the hyperapp tuple `[onSelectTurn, entry]` so the action receives the entry (mirroring how app.js wires list-row actions).
function turnRowNode(h, entry, selectedEventIndex, onSelectTurn) {
	const inFlight = entry.kind === 'in_flight'
	const hint = entry.levelHint
	const hintTitle = hint === 'full'
		? 'Message bodies are logged for this turn.'
		: 'Only turn metadata was logged (standard logging level) — no message bodies.'
	return h('button', { type: 'button', class: { 'inspector-turn': true, 'is-selected': entry.eventIndex === selectedEventIndex, 'is-in-flight': inFlight }, onclick: [onSelectTurn, entry] }, [
		h('span', { class: 'inspector-turn-top' }, [
			h('span', { class: 'inspector-turn-number' }, [`#${entry.turnNumber}`]),
			h('span', { class: 'inspector-turn-role' }, [entry.role]),
			h('time', { class: 'inspector-turn-time', title: entry.timestamp ?? '' }, [clockLabel(entry.timestamp)]),
		]),
		h('span', { class: 'inspector-turn-bottom' }, [
			inFlight ? h('span', { class: 'inspector-turn-flight' }, ['in flight…']) : null,
			h('span', { class: 'inspector-turn-tokens' }, [inFlight ? '' : usageLabel(entry.usage)]),
			h('span', { class: 'inspector-turn-finish' }, [inFlight ? '' : entry.finishReason ?? '—']),
			hint !== null ? h('span', { class: `inspector-turn-hint inspector-turn-hint-${hint}`, title: hintTitle }, [hint]) : null,
		]),
	])
}

// The modal overlay: a backdrop over the run view plus a wide two-pane card — the turn list on the left (newest first, with an "older turns" control paging back through the log), the selected turn's detail on the right. `onSelectTurn` is wired per row with the entry as payload; `onLoadOlder` and `onClose` are caller-supplied actions wired bare, mirroring the result modal's close wiring.
export function InspectorModal(h, props) {
	const renderMarkdown = props.renderMarkdown
	const turns = isObject(props.turns) ? props.turns : {}
	const entries = Array.isArray(turns['entries']) ? turns['entries'] : []
	const selectedEventIndex = typeof turns['selectedEventIndex'] === 'number' ? turns['selectedEventIndex'] : null
	const runLabel = typeof props.runLabel === 'string' && props.runLabel !== '' ? props.runLabel : null
	const onSelectTurn = props.onSelectTurn
	const onLoadOlder = props.onLoadOlder
	const onClose = props.onClose
	const loadState = turns['loadState']
	const olderLoading = turns['olderLoading'] === true
	const hasOlder = canPageOlder(turns['tailOffset'])

	const listChildren = []
	if (loadState === 'loading') {
		listChildren.push(h('p', { class: 'inspector-list-note' }, 'Loading the run log…'))
	} else if (loadState === 'failed') {
		listChildren.push(h('p', { class: 'inspector-list-note' }, 'The run log could not be loaded.'))
	} else if (entries.length === 0) {
		listChildren.push(h('p', { class: 'inspector-list-note' }, 'No LLM turns logged for this run yet.'))
	} else {
		for (let position = entries.length - 1; position >= 0; position--) {
			listChildren.push(turnRowNode(h, entries[position], selectedEventIndex, onSelectTurn))
		}
	}
	if (loadState === 'ready' && hasOlder) {
		listChildren.push(h('button', { type: 'button', class: 'inspector-older', disabled: olderLoading, onclick: onLoadOlder }, olderLoading ? 'loading older turns…' : 'Older turns'))
	}

	// The detail pane: the selected turn resolved against the list so a stale selection reads as "nothing selected", then the in-flight note, then the cached detail state.
	const selectedEntry = entries.find((entry) => isObject(entry) && entry['eventIndex'] === selectedEventIndex) ?? null
	let detailChildren = [h('p', { class: 'inspector-detail-note' }, DETAIL_EMPTY)]
	if (selectedEntry !== null) {
		if (selectedEntry.kind === 'in_flight') {
			detailChildren = [h('p', { class: 'inspector-detail-note' }, IN_FLIGHT_NOTE)]
		} else {
			detailChildren = [detailPaneBody(h, renderMarkdown, props.detailState)]
		}
	}

	return h('div', { class: 'inspector-modal-overlay' }, [
		h('div', { class: 'inspector-modal-backdrop', onclick: onClose }),
		h('div', { class: 'inspector-modal-card' }, [
			h('div', { class: 'inspector-modal-heading-row' }, [
				h('p', { class: 'inspector-modal-heading' }, runLabel !== null ? [`LLM turns \u00b7 ${runLabel}`] : ['LLM turns']),
				h('button', { type: 'button', class: 'inspector-modal-close', onclick: onClose }, 'Close'),
			]),
			h('div', { class: 'inspector-modal-body' }, [
				h('div', { class: 'inspector-turn-pane' }, listChildren),
				h('div', { class: 'inspector-detail-pane' }, detailChildren),
			]),
		]),
	])
}
