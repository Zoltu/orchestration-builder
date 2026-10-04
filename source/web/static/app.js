// Hyperapp client for the long-running service.
// The whole UI is one reactive view of a single state object; polling runs as subscriptions and every side effect (fetch, POST, audio, flash) runs as an effect. The model is a trusted component; its prose fields (task, result summary, question text, question context, error message) are Markdown the UI renders as formatted text via `showdown` + `highlight.js`. The residual concern is not a malicious model but prompt injection — a malicious file in the workspace coercing the model's output — so the parsed HTML is walked through the allowlist in markdown.js before reaching the DOM; this is a defense-in-depth backstop, with the primary injection defense upstream (see docs/security.md "Web client rendering pipeline"). Machine fields (tool names, operation arguments/results, timestamps, role names, run ids, the one-line current-activity summary) are interpolated only as children of h() or text-node arguments, which hyperapp places into text nodes and properties — never into markup.
import { h, app } from './vendor/hyperapp.js'
import { createMarkdownRenderer } from './markdown-render.js'
import { renderFlowView, deriveLifecycle, deriveNowCaption, deriveCostStrip, createColumnTracker } from './flow-view.js'
import { renderSequenceView } from './sequence-diagram.js'
import { createScrollFollower } from './scroll-follow.js'
import { createLabelResolver, TIER_VALUES, isLabelTier } from './labels.js'
import { buildInfoFromConfig, formatBuildLabel } from './build-info.js'
import { isTerminalStatus, rolesOnlyModel, rolesOnlyParticipants } from './interaction-model.js'
import { deriveFaviconState, faviconHref } from './favicon.js'
import { createTooltipDismiss, deriveTooltipDescriptor, isInFlightAskHuman, resolveInspectorScope, resolveTooltipTarget } from './inspector.js'
import { operationIdsForTooltipDetails } from './tooltip.js'
import { copyRawToClipboard } from './clipboard.js'
import { QuestionModal } from './question-modal.js'
import { createOperationDetails } from './operation-details.js'
import { ResultModal, deriveTerminalResult } from './result-modal.js'
import { InspectorModal, buildTurnIndex, deriveDefaultScopeRoleId, instancesOf, deriveInstanceChain, tailWindowOffset, olderWindowOffset, olderFetchLimit, canPageOlder, tailRefreshMustResync, INSPECTOR_WINDOW_SIZE, INSPECTOR_PAGE_LIMIT } from './inspector-modal.js'
import { createWireDetails, WIRE_DETAIL_CACHE_LIMIT } from './wire-details.js'
import { Tooltip, tooltipStyle } from './tooltip.js'
import { createStreamClient } from './stream-client.js'
import { nextLivePartial, activeLivePartial } from './live-partial.js'
import { backlogCount, deriveQueueSections, deriveReorderPosition, isQueueItemLike, queueItemPrimaryText, queueStatusLabel, reorderWaitingItems, taskFirstLine } from './queue-panel.js'

const POLL_INTERVAL_MS = 1000
const STATUS_LABELS = {
	unknown: 'in progress',
	running: 'running',
	success: 'success',
	error: 'error',
	needs_clarification: 'needs clarification',
	interrupted: 'interrupted',
}
const SERVER_UNAVAILABLE_MESSAGE = 'server unavailable — it may have shut down'

// The effort channel's three levels. The wire strings are the contract (see docs/reference.md "Effort channel"): state, API bodies, and run metadata carry them verbatim, so there is no mapping table — display capitalization is a UI concern only and the executor never reads it. The per-option descriptions are the single copy of what each level means; the compose screen's selector (EffortLevelSelector) and the history badge's hover title both render from this list.
const DEFAULT_EFFORT = 'standard'
const EFFORT_OPTIONS = [
	{ value: 'quick', description: 'The fastest, lightest pass. Good for small fixes and simple tasks.' },
	{ value: 'standard', description: 'Careful work at a reasonable pace. The right choice for most tasks.', recommended: true },
	{ value: 'thorough', description: 'The slowest, most meticulous pass. Best for large or important projects.' },
]

function isEffort(value) {
	return EFFORT_OPTIONS.some((option) => option.value === value)
}

function effortLabel(effort) {
	if (!isEffort(effort)) return '—'
	return effort.charAt(0).toUpperCase() + effort.slice(1)
}

function effortDescription(effort) {
	const option = EFFORT_OPTIONS.find((entry) => entry.value === effort)
	return option !== undefined ? option.description : ''
}

// The logging-level channel's two levels (see docs/reference.md "Logging level"). The wire strings are the contract — API bodies and settings carry them verbatim. Under `standard` the run log still receives every event, but the heavy bodies (each llm_call's sent conversation and received response, each tool_result's full result) are dropped, which keeps long runs' log files small at the cost of the raw-detail toggle showing fewer bodies.
const DEFAULT_LOG_LEVEL = 'full'
const LOG_LEVEL_OPTIONS = [
	{ value: 'full', label: 'Full logging' },
	{ value: 'standard', label: 'Standard (smaller logs)' },
]

function isLogLevel(value) {
	return LOG_LEVEL_OPTIONS.some((option) => option.value === value)
}

// The label tier the flow/sequence views localize through. 'detailed' is the default so a fresh load reads precisely; the toggle in the run-view controls swaps it for a non-technical voice. The values come from labels.js (TIER_VALUES), so a swap re-renders the views through the same resolver without touching the model.
const DEFAULT_FLOW_TIER = 'detailed'

// Derives the guild's static role/tool inventory from the live `/api/config` so the sequence view can lay out every guild role as a column from the first frame (peeking at future participants would defeat the model's "the run reveals what happens" contract). The flow view does not need this — it projects only active participants — but passing it is harmless and keeps the two views' column sets aligned. The 'human' and 'tools' columns are added by the view itself, so this carries only the real roles and tools.
function guildParticipantsFromConfig(config) {
	if (config === null || typeof config !== 'object') return []
	const participants = []
	const roles = config.roles
	if (roles !== null && typeof roles === 'object') {
		for (const name of Object.keys(roles)) participants.push({ id: `guild:${name}`, role: name, kind: 'role' })
	}
	const tools = config.tools
	if (tools !== null && typeof tools === 'object') {
		for (const name of Object.keys(tools)) participants.push({ id: `guild:${name}`, role: name, kind: 'tool' })
	}
	return participants
}

// One shared NumberFormat so every rendered count, token total, and duration in the UI shares the user's locale and grouping; re-instantiating per render is wasteful and would let a locale change between renders drift the formatting.
const numberFormatter = new Intl.NumberFormat(navigator.language)

// Formats any numeric value with locale grouping, returning '—' for null/undefined/non-numbers so callers can pass optional fields (token totals absent on a run with no usage) without a separate guard.
function formatNumber(value) {
	if (value === null || value === undefined) return '—'
	if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
	return numberFormatter.format(value)
}

// The AudioContext is created lazily on first user interaction (browsers start it suspended until a gesture) and reused for every beep; it is module state, not app state, because it is an opaque resource with no place in the view.
let audioContext = null

// The caller-held column high-water mark for the flow view (see createColumnTracker): one per page load so the centerpiece's width stays stable as runs deepen and unwind. Held at module scope like audioContext — it is view-render memory, not app state, and retention across run switches is harmless (the stage simply stays as wide as the deepest run seen this page load).
const flowColumnTracker = createColumnTracker()

// The inspector's operation-details controller (see operation-details.js): key `<runId>|<operationId>`, states 'loading' | 'failed' | ready. The polled flow model ships no detail bodies (they can carry multi-megabyte tool arguments/results), so opening an inspector card fetches the ids its derivation may show from `api/runs/:id/flow?operation=<id>` exactly once per session and caches them. Operation ids are stable within a run (events only append), so an entry never goes stale; the run id in the key keeps a previous run's entries from answering for another run's same-numbered operation. Module scope like flowColumnTracker — cache memory, not app state. This host drives the controller through `begin` + `record*` because its fetches are hyperapp effects whose ok/fail actions must return fresh state to trigger the re-render, so no `onLanded` fan-out is wired.
const operationDetails = createOperationDetails({})

// The inspector transcript's per-turn wire-envelope cache (see wire-details.js): key `<runId>|<eventIndex>` → the folded request sections the window endpoint's `?detail=` returns for a completed turn's "on the wire" expander. The expander fetches on first open and caches per session, so re-opening a turn (and every re-render under an open expander) never re-fetches; a failed fetch evicts rather than caching, so one transient 500 cannot poison a turn — re-opening retries; and the cache is bounded past WIRE_DETAIL_CACHE_LIMIT entries (oldest evicted — a re-opened evicted turn re-fetches). Module scope like operationDetails — cache memory, not app state.
const wireDetails = createWireDetails({ maxEntries: WIRE_DETAIL_CACHE_LIMIT })

// The live-token-stream client (see stream-client.js and docs/reference.md "Live token stream"): module scope like the other session caches, created lazily by the stream subscription on the first watch-screen mount and left connected for the page's lifetime. The stream is an enhancement — the client is contained (never throws, shows no error surface), and the only state it feeds is the ephemeral `livePartial` the inspector modal's in-flight turn renders.
let streamClient = null

// ws vs wss follows the page's own protocol so a TLS deployment upgrades the stream with it.
function streamSocketUrl() {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/ws/stream`
}

function ensureAudioContext() {
	if (audioContext === null) {
		const Ctor = window.AudioContext !== undefined ? window.AudioContext : window.webkitAudioContext
		if (Ctor !== undefined) audioContext = new Ctor()
	}
	return audioContext
}

function formatRelative(iso, now) {
	if (iso === null || iso === undefined || iso === '') return '—'
	const then = Date.parse(iso)
	if (Number.isNaN(then)) return iso
	const seconds = Math.round((now - then) / 1000)
	if (seconds < 1) return 'just now'
	if (seconds < 60) return `${formatNumber(seconds)}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${formatNumber(minutes)}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${formatNumber(hours)}h ago`
	const days = Math.floor(hours / 24)
	return `${formatNumber(days)}d ago`
}

function statusLabel(status) {
	if (status === null || status === undefined) return '—'
	return STATUS_LABELS[status] ?? status
}

function formatElapsed(seconds) {
	if (typeof seconds !== 'number' || seconds < 0 || !Number.isFinite(seconds)) return '—'
	const minutes = Math.floor(seconds / 60)
	const remaining = seconds % 60
	if (minutes === 0) return `${formatNumber(remaining)}s`
	return `${formatNumber(minutes)}m ${formatNumber(remaining)}s`
}

function formatTokens(tokens) {
	return formatNumber(tokens)
}

// --- Markdown rendering ----------------------------------------------------
// Agent-authored prose is Markdown rendered as formatted text via the shared pipeline in `markdown-render.js` (showdown → highlight.js → sanitized vnodes). The renderer is constructed once against this module's `h` and reused everywhere prose appears; the implementation and its memoization live in the shared module so the demo harness renders Markdown through the identical sanitized path.

const renderMarkdown = createMarkdownRenderer(h)

// The active run is the first non-terminal summary; derived in the view rather than stored, so it can never drift from the run list.
function deriveActiveRunId(summaries) {
	const active = summaries.find((summary) => !isTerminalStatus(summary.status))
	return active === undefined ? null : active.runId
}

// --- Custom subscriptions --------------------------------------------------
// hyperapp's @hyperapp/time package would provide onEvery, but vendoring a second file for ~5 lines is not worth the supply-chain cost; the subscriber is defined once here so its reference is stable across renders (patchSubs compares subscriber references to decide whether to restart a subscription).

function onEverySubscriber(dispatch, payload) {
	const id = setInterval(() => dispatch(payload.action), payload.interval)
	return () => clearInterval(id)
}

function onEvery(action, interval) {
	return [onEverySubscriber, { action, interval }]
}

function onFirstInteractionSubscriber(dispatch, payload) {
	const handler = () => dispatch(payload.action)
	window.addEventListener('pointerdown', handler, { once: true })
	window.addEventListener('keydown', handler, { once: true })
	return () => {
		window.removeEventListener('pointerdown', handler)
		window.removeEventListener('keydown', handler)
	}
}

function onFirstInteraction(action) {
	return [onFirstInteractionSubscriber, { action }]
}

// The Escape key dismisses the inspector modal while it is open; the subscription is present only then (the subscriptions array carries it as a stable position whose value is falsy while the modal is closed, which hyperapp ignores), so no key listener exists otherwise.
function onEscapeKeySubscriber(dispatch, payload) {
	const handler = (event) => {
		if (event.key === 'Escape') dispatch(payload.action)
	}
	window.addEventListener('keydown', handler)
	return () => window.removeEventListener('keydown', handler)
}

function onEscapeKey(action) {
	return [onEscapeKeySubscriber, { action }]
}

// --- Custom effects --------------------------------------------------------
// @hyperapp/http is still "planned", so the fetch effecter is hand-written. It parses the body, then dispatches the ok action on a requestAnimationFrame so the dispatch lands in step with hyperapp's repaint cycle (per hyperapp's effects doc); the fail action fires only on a network error, since any HTTP response — even a 4xx/5xx — resolves the ok branch with its status.

function runFetch(dispatch, payload) {
	fetch(payload.url, payload.init).then(
		(response) => {
			const status = response.status
			const ok = response.ok
			response.text().then((text) => {
				let body = null
				if (text.length > 0) {
					try {
						body = JSON.parse(text)
					} catch {
						body = text
					}
				}
				requestAnimationFrame(() => dispatch(payload.ok, { status, ok, body }))
			})
		},
		() => requestAnimationFrame(() => dispatch(payload.fail)),
	)
}

function Fetch(payload) {
	return [runFetch, payload]
}

function runBeep(_dispatch, _payload) {
	const ctx = audioContext
	if (ctx === null || ctx.state !== 'running') return
	const oscillator = ctx.createOscillator()
	const gain = ctx.createGain()
	oscillator.type = 'sine'
	oscillator.frequency.value = 880
	gain.gain.value = 0.08
	oscillator.connect(gain)
	gain.connect(ctx.destination)
	const now = ctx.currentTime
	oscillator.start(now)
	oscillator.stop(now + 0.18)
}

function PlayBeep() {
	return [runBeep, null]
}

function runPrimeAudio(_dispatch, _payload) {
	const ctx = ensureAudioContext()
	if (ctx !== null && ctx.state === 'suspended') ctx.resume()
}

function PrimeAudioFx() {
	return [runPrimeAudio, null]
}

// The favicon effect: derives the three-state favicon from the polled run list and pending questions and swaps the `<link rel="icon">` href only when the derived state's href changes, so an identical poll tick never touches the DOM.
function runUpdateFavicon(_dispatch, state) {
	const link = document.querySelector('link[rel="icon"]')
	if (link === null) return
	const href = faviconHref(deriveFaviconState(state.summaries, state.pendingQuestions))
	if (link.getAttribute('href') === href) return
	link.setAttribute('href', href)
}

function UpdateFavicon(state) {
	return [runUpdateFavicon, state]
}

// --- Actions ---------------------------------------------------------------
// Actions are pure state transitions; side effects are returned as effect tuples alongside the next state. The polling action returns a fresh now so relative timestamps refresh every tick even when the server returns identical data.

function Tick(state) {
	return [
		{ ...state, now: Date.now() },
		Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
		Fetch({ url: 'api/questions', ok: GotQuestions, fail: FetchFailed }),
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
	]
}

function PollSelectedRun(state) {
	// Bail on a non-string id rather than fetching `/api/runs/undefined`; `selectedRunId` is null until a run is selected and can briefly be undefined across a state transition, so the guard keeps the poll from firing on an invalid id.
	if (typeof state.selectedRunId !== 'string' || state.selectedRunId === '') return state
	const runId = encodeURIComponent(state.selectedRunId)
	return [
		state,
		Fetch({ url: `api/runs/${runId}`, ok: GotSelectedRun, fail: FetchFailed }),
		// The flow model is derived server-side from the full log (the truncated recentLog the run view carries is not enough to reconstruct the active path, lingering legs, or per-invocation costs); the centerpiece reads it off this endpoint rather than re-deriving client-side.
		Fetch({ url: `api/runs/${runId}/flow`, ok: GotFlowModel, fail: FetchFailed }),
		// While the inspector modal is open, the same poll also refreshes the log-window tail so in-flight turns appear when they complete (a null effect when closed — hyperapp ignores falsy effects).
		InspectorTailRefresh(state),
	]
}

// The live InteractionModel the flow/sequence views render. The previous frame is kept so `deriveLifecycle` can diff entering/departing nodes; a 404 (the run directory exists but is not yet readable in the instant after submit) clears the model so the centerpiece shows its placeholder until the first readable frame lands. Every path also syncs the sequence-view scroll follower: the model update grows (or clears) the sequence content after the view patch.
function GotFlowModel(state, payload) {
	const status = payload.status
	const ok = payload.ok
	const body = payload.body
	if (status === 404) return [{ ...state, flowModel: null, previousFlowModel: null, serverAvailable: ok }, SyncSequenceFollower()]
	if (!ok || body === null || typeof body !== 'object') return [{ ...state, serverAvailable: ok }, SyncSequenceFollower()]
	if (!Array.isArray(body.participants) || !Array.isArray(body.operations) || typeof body.status !== 'string') {
		return [{ ...state, serverAvailable: true }, SyncSequenceFollower()]
	}
	return [{ ...state, previousFlowModel: state.flowModel, flowModel: body, serverAvailable: true }, SyncSequenceFollower()]
}

function GotRunList(state, payload) {
	const ok = payload.ok
	const body = payload.body
	const summaries = ok && Array.isArray(body) ? body : []
	const nextState = { ...state, summaries, serverAvailable: ok }
	if (nextState.justSubmittedRunId !== null && summaries.some((summary) => summary.runId === nextState.justSubmittedRunId)) {
		nextState.justSubmittedRunId = null
	}
	// Auto-select the newest run when nothing is selected so the user lands on live activity.
	if (nextState.selectedRunId === null && summaries.length > 0) {
		nextState.selectedRunId = summaries[0].runId
		nextState.selectedRunView = null
		nextState.selectedRunStatus = null
	}
	return [nextState, UpdateFavicon(nextState)]
}

// The newest interrupt-question answer the operator has not been shown yet, or null. Keys are run-scoped (`runId|askedAt`) so one map serves every run without per-run resets; a run's first read baselines its already-answered inquiries so opening an old run never pops stale answers.
function latestUnshownAnswer(interrupts, runId, shownInterruptAnswerKeys) {
	let latest = null
	for (const entry of interrupts) {
		if (entry.kind !== 'inquiry' || entry.answer === null) continue
		if (shownInterruptAnswerKeys[`${runId}|${entry.askedAt}`] === true) continue
		latest = entry
	}
	return latest
}

function answeredInquiryKeys(interrupts, runId) {
	const keys = []
	for (const entry of interrupts) {
		if (entry.kind !== 'inquiry' || entry.answer === null) continue
		keys.push(`${runId}|${entry.askedAt}`)
	}
	return keys
}

function GotSelectedRun(state, payload) {
	const status = payload.status
	const ok = payload.ok
	const body = payload.body
	if (status === 404) {
		// The run directory is created early in execution but may not be readable in the instant after submit; the per-run subscription keeps polling until the view appears.
		return [{ ...state, selectedRunStatus: 'unknown', serverAvailable: ok }, SyncSequenceFollower()]
	}
	if (!ok || body === null) return state
	// The result modal fires once when a run the operator is watching completes (a transition out of a non-terminal status into success/error). Selecting an already-terminal historical run does not auto-open it — the flow view's CTA re-opens it on demand — so `previousStatus === null` (the first read of a selected run) is excluded along with the terminal statuses. A terminal status also clears the live partial: the in-flight turn it streamed is over (see "Live token stream").
	const previousStatus = state.selectedRunStatus
	const completedStatus = body.status === 'success' || body.status === 'error' ? body.status : null
	const isCompletionTransition = completedStatus !== null
		&& previousStatus !== null
		&& previousStatus !== 'success'
		&& previousStatus !== 'error'
		&& previousStatus !== 'needs_clarification'
	const runId = typeof body.runId === 'string' ? body.runId : state.selectedRunId
	const resultModalOpen = isCompletionTransition && state.resultShownForRun !== runId ? true : state.resultModalOpen
	const resultShownForRun = isCompletionTransition ? runId : state.resultShownForRun

	const interrupts = Array.isArray(body.interrupts) ? body.interrupts : []
	const shownInterruptAnswerKeys = { ...state.shownInterruptAnswerKeys }
	let interruptAnswerCard = state.interruptAnswerCard
	if (previousStatus === null) {
		for (const key of answeredInquiryKeys(interrupts, runId)) shownInterruptAnswerKeys[key] = true
	} else {
		const newAnswer = latestUnshownAnswer(interrupts, runId, shownInterruptAnswerKeys)
		if (newAnswer !== null) {
			for (const key of answeredInquiryKeys(interrupts, runId)) shownInterruptAnswerKeys[key] = true
			interruptAnswerCard = { question: newAnswer.message, answer: newAnswer.answer, role: newAnswer.role }
		}
	}

	// A completion transition resets the inspector's scope to auto, so the next open lands on the most recently active instance (here, the finishing one) instead of whatever the operator had scoped to during the run.
	const inspector = isCompletionTransition ? { ...state.inspector, scopedRoleId: null } : state.inspector

	return [{ ...state, selectedRunView: body, selectedRunStatus: body.status, resultModalOpen, resultShownForRun, interruptAnswerCard, shownInterruptAnswerKeys, serverAvailable: true, inspector, livePartial: isTerminalStatus(body.status) ? null : state.livePartial }, SyncSequenceFollower()]
}

function GotQuestions(state, payload) {
	const ok = payload.ok
	const body = payload.body
	const questions = ok && Array.isArray(body) ? body : []
	const currentIds = {}
	for (const question of questions) currentIds[question.id] = true

	let hasNew = false
	if (!state.firstQuestionsPoll) {
		for (const id of Object.keys(currentIds)) {
			if (!state.shownQuestionIds[id]) {
				hasNew = true
				break
			}
		}
	}

	const nextState = {
		...state,
		pendingQuestions: questions,
		shownQuestionIds: currentIds,
		firstQuestionsPoll: false,
		serverAvailable: ok,
		// A genuinely new question opens the per-run-view modal so it is unmissable; dismissing it leaves the flow view's Question affordance on the answerer node for re-entry. The modal is view-side state, not model state: the live model's ask_human call is what the flow view renders, this only gates the overlay.
		questionModalOpen: hasNew ? true : state.questionModalOpen,
	}
	// Beep on a genuinely new question unless muted; the modal itself opens via questionModalOpen above. Falsy effects are ignored by hyperapp, so the conditional inlines cleanly.
	if (hasNew) {
		return [nextState, UpdateFavicon(nextState), state.muted ? null : PlayBeep()]
	}
	return [nextState, UpdateFavicon(nextState)]
}

function FetchFailed(state) {
	return { ...state, serverAvailable: false }
}

// --- Queue panel actions -----------------------------------------------------
// The polled queue feeds the queue screen; the mutations post to the /api/queue surface (docs/queueing.md "HTTP API") and every confirm path refetches the queue, since the server's tick may already have dispatched the item the mutation touched.

function GotQueue(state, payload) {
	const ok = payload.ok
	const body = payload.body
	const items = ok && Array.isArray(body) ? body.filter(isQueueItemLike) : []
	const nextState = { ...state, queueItems: items, serverAvailable: ok }
	// The add's in-flight guard releases once the created item shows up in the polled queue — the same release GotRunList applies to justSubmittedRunId; a response that fails or omits the item keeps the guard up.
	if (nextState.justSubmittedItemId !== null && items.some((item) => item.id === nextState.justSubmittedItemId)) nextState.justSubmittedItemId = null
	return nextState
}

// The queue add resolved: the created item's id is remembered so the follow-up queue read can see whether the scheduler dispatched it within the same request (the idle case) — the operator then lands on the new run's watch screen exactly as a start-now submit always has. The poll's own queue reads deliberately do not consume this selection: a task added while a run is in flight dispatches much later, and jumping then would yank the operator off whatever they are reading.
function GotQueuedTask(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || typeof body.id !== 'string' || body.id === '') return { ...state, serverAvailable: ok }
	return [
		{ ...state, justSubmittedItemId: body.id, pendingAddSelectionId: body.id, serverAvailable: true },
		Fetch({ url: 'api/queue', ok: GotQueueAfterAdd, fail: FetchFailed }),
	]
}

function GotQueueAfterAdd(state, payload) {
	const addedId = state.pendingAddSelectionId
	const queued = GotQueue(state, payload)
	if (typeof addedId !== 'string') return queued
	const cleared = { ...queued, pendingAddSelectionId: null }
	const added = queued.queueItems.find((item) => item.id === addedId)
	if (added !== undefined && typeof added.runId === 'string' && added.runId !== '') return SelectRun(cleared, added.runId)
	// The task is still waiting its turn (a run was in flight) — the queue screen is where the operator sees where it sits in line.
	return SetScreen(cleared, 'queue')
}

function StartItemEdit(state, itemId) {
	if (typeof itemId !== 'string' || itemId === '') return state
	return { ...state, editingItemId: itemId }
}

function CancelItemEdit(state) {
	return { ...state, editingItemId: null }
}

function SaveItemEdit(state, event) {
	event.preventDefault()
	const itemId = state.editingItemId
	if (typeof itemId !== 'string' || itemId === '') return state
	const textarea = event.target.querySelector('textarea')
	if (textarea === null) return state
	const task = textarea.value.trim()
	if (task === '') return state
	return [
		{ ...state, editingItemId: null },
		Fetch({
			url: `api/queue/${encodeURIComponent(itemId)}`,
			init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) },
			ok: QueueMutated,
			fail: QueueMutationFailed,
		}),
	]
}

function RemoveQueueItem(state, itemId) {
	if (typeof itemId !== 'string' || itemId === '') return state
	return [
		state,
		Fetch({
			url: `api/queue/${encodeURIComponent(itemId)}`,
			init: { method: 'DELETE' },
			ok: QueueMutated,
			fail: QueueMutationFailed,
		}),
	]
}

function SubmitQueueAnswer(itemId) {
	return function SubmitAnswerForQueueItem(state, event) {
		event.preventDefault()
		const input = event.target.querySelector('input')
		if (input === null) return state
		const answer = input.value
		if (answer === '') return state
		return [
			{ ...state, queueAnswerPendingId: itemId },
			Fetch({
				url: `api/queue/${encodeURIComponent(itemId)}/answer`,
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }) },
				ok: QueueMutated,
				fail: QueueMutationFailed,
			}),
		]
	}
}

function RequeueFailedItem(state, itemId) {
	if (typeof itemId !== 'string' || itemId === '') return state
	return [
		state,
		Fetch({
			url: `api/queue/${encodeURIComponent(itemId)}/requeue`,
			init: { method: 'POST' },
			ok: QueueMutated,
			fail: QueueMutationFailed,
		}),
	]
}

// Every queue mutation's confirm path refetches the queue rather than patching state from the response body: the server's tick may already have dispatched (or re-ordered) the item, so the refetched list is the truth.
function QueueMutated(state, payload) {
	if (!payload.ok) return { ...state, queueAnswerPendingId: null, serverAvailable: true }
	return [
		{ ...state, queueAnswerPendingId: null, serverAvailable: true },
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
	]
}

// A refused or failed mutation refetches too, so an optimistic update (a drag) reconciles with the server's order.
function QueueMutationFailed(state) {
	return [
		{ ...state, queueAnswerPendingId: null, serverAvailable: false },
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
	]
}

// --- Queue drag-to-reorder ---------------------------------------------------
// Waiting rows are HTML5 drag sources and drop targets: dragstart records the dragged item's id (and sets the transfer data, without which Firefox refuses to start the drag), the drop computes the PATCH position from the target row's waiting index, and the reorder applies optimistically before the PATCH confirms. dragend clears the marker whatever happened — including a drop outside any row.

// The event target's data-attribute value, or null — the DOM read every queue row action shares.
function dataAttributeOf(event, attribute) {
	const target = event.currentTarget
	if (target === null || typeof target !== 'object') return null
	const value = target.getAttribute(attribute)
	return typeof value === 'string' && value !== '' ? value : null
}

function DragQueueItem(state, event) {
	const itemId = dataAttributeOf(event, 'data-item-id')
	if (itemId === null) return state
	if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
		event.dataTransfer.setData('text/plain', itemId)
		event.dataTransfer.effectAllowed = 'move'
	}
	return { ...state, draggingItemId: itemId }
}

function DragOverQueueItem(state, event) {
	event.preventDefault()
	if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
	return state
}

function DropQueueItem(state, event) {
	event.preventDefault()
	const targetId = dataAttributeOf(event, 'data-item-id')
	const draggedId = state.draggingItemId
	if (targetId === null || typeof draggedId !== 'string' || draggedId === targetId) return { ...state, draggingItemId: null }
	const position = deriveReorderPosition(state.queueItems, draggedId, targetId)
	if (position === null) return { ...state, draggingItemId: null }
	return [
		{ ...state, queueItems: reorderWaitingItems(state.queueItems, draggedId, position), draggingItemId: null },
		Fetch({
			url: `api/queue/${encodeURIComponent(draggedId)}`,
			init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position }) },
			ok: QueueMutated,
			fail: QueueMutationFailed,
		}),
	]
}

function DragEndQueueItem(state) {
	return state.draggingItemId === null ? state : { ...state, draggingItemId: null }
}

// The guild config is fetched exactly once on load and never polled, so this action runs a single time. The body is not retained in state; only the derived values the views need are kept — the label resolver the flow/sequence views localize through, the guild participant inventory the sequence view lays out columns from, and the build identifier the top bar stamps (null when the response carries none, e.g. running from source).
function GotConfig(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object') return state
	return {
		...state,
		labelResolver: createLabelResolver(body),
		guildParticipants: guildParticipantsFromConfig(body),
		build: buildInfoFromConfig(body),
	}
}

// The saved settings are fetched once on load so the selectors start where the operator last left them; later settings fetches (none today) would not override levels the operator has since picked.
function GotSettings(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (state.runEffort !== null && state.runLogLevel !== null) return { ...state, serverAvailable: ok }
	const readable = ok && body !== null && typeof body === 'object'
	const effort = readable && isEffort(body.effort) ? body.effort : null
	const logLevel = readable && isLogLevel(body.logLevel) ? body.logLevel : null
	return {
		...state,
		runEffort: state.runEffort !== null ? state.runEffort : (effort !== null ? effort : DEFAULT_EFFORT),
		runLogLevel: state.runLogLevel !== null ? state.runLogLevel : (logLevel !== null ? logLevel : DEFAULT_LOG_LEVEL),
		serverAvailable: ok,
	}
}

function SettingsFetchFailed(state) {
	// The selectors still need concrete values to render, so fall back to the defaults rather than sitting at null forever.
	return { ...state, runEffort: state.runEffort ?? DEFAULT_EFFORT, runLogLevel: state.runLogLevel ?? DEFAULT_LOG_LEVEL, serverAvailable: false }
}

// The settings write replaces the file wholesale, so a save carries both persisted fields. The selectors' values are null until the initial GET /api/settings resolves — before that they would only contribute the defaults the selectors show, silently clobbering the operator's persisted choices, so buildSettingsBody refuses to build a body (and the save actions skip the PUT) until both are initialized; the pick still applies locally and persists on the next save.
function buildSettingsBody(runEffort, runLogLevel) {
	if (!isEffort(runEffort) || !isLogLevel(runLogLevel)) return null
	return { effort: runEffort, logLevel: runLogLevel }
}

// A radio pick is one deliberate gesture (unlike a slider drag), so a single change handler both updates state and persists the level as the default for the next run — the selector stays where the operator last left it across page reloads and restarts, with one PUT per pick.
function SaveRunEffort(state, event) {
	const value = event.target.value
	if (!isEffort(value)) return state
	const body = buildSettingsBody(value, state.runLogLevel)
	if (body === null) return { ...state, runEffort: value }
	return [
		{ ...state, runEffort: value, savingEffort: true },
		Fetch({
			url: 'api/settings',
			init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			ok: EffortSaved,
			fail: EffortSaveFailed,
		}),
	]
}

function EffortSaved(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || !isEffort(body.effort)) {
		return { ...state, savingEffort: false, serverAvailable: true }
	}
	return { ...state, savingEffort: false, runEffort: body.effort, runLogLevel: isLogLevel(body.logLevel) ? body.logLevel : state.runLogLevel, serverAvailable: true }
}

function EffortSaveFailed(state) {
	return { ...state, savingEffort: false, serverAvailable: false }
}

// The logging-level picker follows the effort picker exactly: one change both updates state and persists the choice as the project default for the next run.
function SaveRunLogLevel(state, event) {
	const value = event.target.value
	if (!isLogLevel(value)) return state
	const body = buildSettingsBody(state.runEffort, value)
	if (body === null) return { ...state, runLogLevel: value }
	return [
		{ ...state, runLogLevel: value, savingLogLevel: true },
		Fetch({
			url: 'api/settings',
			init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			ok: LogLevelSaved,
			fail: LogLevelSaveFailed,
		}),
	]
}

function LogLevelSaved(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || !isLogLevel(body.logLevel)) {
		return { ...state, savingLogLevel: false, serverAvailable: true }
	}
	return { ...state, savingLogLevel: false, runLogLevel: body.logLevel, runEffort: isEffort(body.effort) ? body.effort : state.runEffort, serverAvailable: true }
}

function LogLevelSaveFailed(state) {
	return { ...state, savingLogLevel: false, serverAvailable: false }
}

function SelectRun(state, runId) {
	if (runId === state.selectedRunId) return [{ ...state, screen: 'watch' }, SyncSequenceFollower()]
	// The flow model, its previous-frame diff, and the per-run modal state belong to the previously-selected run; a switch clears them so the centerpiece shows the new run's first frame without a stale lifecycle diff or a leftover modal. Selecting a run always lands on the watch screen (history rows and the in-progress pill both go through here). Clearing the model unmounts the sequence container, so the switch syncs its scroll follower (the new run's first frame re-attaches it, pinned to the bottom). The live partial belongs to the previous run too and clears with the rest (the stream subscription restarts onto the new run).
	return [
		{
			...state,
			screen: 'watch',
			selectedRunId: runId,
			selectedRunView: null,
			selectedRunStatus: null,
			flowModel: null,
			previousFlowModel: null,
			questionModalOpen: false,
			resultModalOpen: false,
			resultShownForRun: null,
			tooltip: null,
			interruptNotice: null,
			interruptModalOpen: false,
			interruptAnswerCard: null,
			planExpanded: false,
			inspectorModalOpen: false,
			inspector: initialInspectorState(),
			livePartial: null,
		},
		SyncSequenceFollower(),
	]
}

function ToggleMute(state, event) {
	return { ...state, muted: event.target.checked }
}

// The task editor is a multiline textarea, not a single-line input: a task is free-form Markdown a user may draft at length. Enter inserts a newline (the browser default for a textarea) and Tab inserts a real tab character at the caret (handled below), so neither key submits; submission is the submit button, with Ctrl/Cmd+Enter as a keyboard shortcut that re-enters the form's submit path.
function TaskTextareaKeydown(state, event) {
	if (event.key === 'Tab') {
		event.preventDefault()
		const textarea = event.target
		const start = textarea.selectionStart
		const end = textarea.selectionEnd
		textarea.value = textarea.value.slice(0, start) + '\t' + textarea.value.slice(end)
		textarea.selectionStart = textarea.selectionEnd = start + 1
		return state
	}
	if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
		event.preventDefault()
		const form = event.target.form
		if (form !== null && typeof form.requestSubmit === 'function') form.requestSubmit()
		return state
	}
	return state
}

function SubmitRun(state, event) {
	event.preventDefault()
	if (state.justSubmittedItemId !== null || state.justSubmittedRunId !== null) return state
	const form = event.target
	const textarea = form.querySelector('textarea')
	if (textarea === null) return state
	const task = textarea.value.trim()
	if (task === '') return state
	textarea.value = ''
	// The compose box is the queue's front door (docs/queueing.md "UI interaction model"): a plain add posts to the universal queue and the scheduler dispatches it at once when idle. Only a continuation still needs the run-submission endpoint, whose body is the only one that can carry continuesFrom — so while a run is in flight a continuation stays disabled rather than queueing without its lineage.
	if (state.continuation === null) {
		return [
			state,
			Fetch({
				url: 'api/queue',
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildQueueTaskBody(task, state.runEffort)) },
				ok: GotQueuedTask,
				fail: FetchFailed,
			}),
		]
	}
	return [
		state,
		Fetch({
			url: 'api/runs',
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildRunBody(task, state.runEffort, state.runLogLevel, state.continuation)) },
			ok: GotCreatedRun,
			fail: FetchFailed,
		}),
	]
}

// The queue task body carries the effort pick; logLevel is deliberately absent — a queue-native item resolves the level through the standard chain at dispatch (docs/queueing.md "The queue: storage, item model, state machine").
function buildQueueTaskBody(task, runEffort) {
	return isEffort(runEffort) ? { task, effort: runEffort } : { task }
}

// effort and logLevel are omitted when their selectors have not yet initialized (settings still loading), so the server applies its resolution chain rather than receiving a null. continuesFrom rides only when the compose screen is in continuation mode; a re-run passes null and submits a plain task.
function buildRunBody(task, runEffort, runLogLevel, continuation) {
	const body = isEffort(runEffort) ? { task, effort: runEffort } : { task }
	if (isLogLevel(runLogLevel)) body.logLevel = runLogLevel
	if (continuation !== null && typeof continuation.runId === 'string' && continuation.runId !== '') body.continuesFrom = continuation.runId
	return body
}

// A re-run is a one-click resubmit of a past run's task; it reuses the create path (POST /api/runs → GotCreatedRun) so the new run is selected and the active-run guard applies identically.
// stopPropagation keeps the click from also triggering the enclosing list entry's select handler; the task is read from the button's data-task attribute so the action stays a stable top-level function (hyperapp passes the DOM event as the payload to a bare-function handler).
function RerunTask(state, event) {
	event.stopPropagation()
	if (state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null) return state
	const task = event.currentTarget.getAttribute('data-task')
	if (typeof task !== 'string' || task === '') return state
	return [
		state,
		Fetch({
			url: 'api/runs',
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildRunBody(task, state.runEffort, state.runLogLevel, null)) },
			ok: GotCreatedRun,
			fail: FetchFailed,
		}),
	]
}

// The prior run's outcome summary for the continuation chip, or null when the prior run has no result card to quote — the chip then omits the outcome line entirely (the server-side briefing handles the empty case on its own).
function priorOutcomeOf(summary) {
	if (summary.result === null || summary.result === undefined) return null
	if (typeof summary.result.summary !== 'string' || summary.result.summary === '') return null
	return summary.result.summary
}

// Continue switches the compose screen into continuation mode: a new run will anchor to the finished run's outcome via continuesFrom. Like RerunTask it reads the run id off the button (stopPropagation keeps the row's select handler out of the way), and it shares the re-run button's disabled condition so the one-task-at-a-time contract holds for continuations too. The prior task and outcome for the chip are read from the already-polled run list rather than data attributes, so nothing large rides the DOM.
function ContinueRun(state, event) {
	event.stopPropagation()
	if (state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null) return state
	const runId = event.currentTarget.getAttribute('data-run-id')
	if (typeof runId !== 'string' || runId === '') return state
	const summary = state.summaries.find((entry) => entry.runId === runId)
	if (summary === undefined) return state
	return {
		...state,
		screen: 'compose',
		continuation: { runId, task: typeof summary.task === 'string' ? summary.task : '', summary: priorOutcomeOf(summary) },
	}
}

function CancelContinuation(state) {
	return { ...state, continuation: null }
}

function GotCreatedRun(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || !('runId' in body)) return state
	const createdRunId = body.runId
	// Selecting the new run activates its per-run subscription; an immediate run-list fetch clears justSubmittedRunId as soon as the run appears. The continuation and the per-run modal/flow state are reset for the same reason SelectRun resets it — the composed run is on the server now, and a leftover chip would brief a stale lineage into the next task. The live partial clears with the rest (the stream subscription follows the new selection).
	return [
		{ ...state, screen: 'watch', continuation: null, justSubmittedRunId: createdRunId, selectedRunId: createdRunId, selectedRunView: null, selectedRunStatus: null, flowModel: null, previousFlowModel: null, questionModalOpen: false, resultModalOpen: false, resultShownForRun: null, tooltip: null, planExpanded: false, inspectorModalOpen: false, inspector: initialInspectorState(), livePartial: null, serverAvailable: true },
		Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
	]
}

function SubmitAnswer(questionId) {
	return function SubmitAnswerForQuestion(state, event) {
		event.preventDefault()
		const input = event.target.querySelector('input')
		if (input === null) return state
		const answer = input.value
		if (answer === '') return state
		return [
			{ ...state, pendingAnswerId: questionId },
			Fetch({
				url: 'api/answer',
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: questionId, answer }) },
				ok: AnswerSent,
				fail: AnswerFailed,
			}),
		]
	}
}

function AnswerSent(state) {
	// Refresh the pending list immediately so the answered question disappears without waiting for the next tick. An answered question ends a `needs_clarification` wait, which is a terminal status that deactivated the per-run poll; resetting the status to the non-terminal 'unknown' reactivates that poll so the run view and flow model resume as the run continues, and completion can later fire the result modal. The next poll repopulates the real status from the run's meta.
	const reactivated = { ...state, pendingAnswerId: null, selectedRunStatus: 'unknown', serverAvailable: true }
	return [reactivated, Fetch({ url: 'api/questions', ok: GotQuestions, fail: FetchFailed })]
}

function AnswerFailed(state) {
	return { ...state, pendingAnswerId: null, serverAvailable: false }
}

// --- Interrupt form ----------------------------------------------------------
// The operator can speak into the active run at its next safe point: an inquiry asks the run a direct question; a plan modification aborts the active sub-work and re-plans from the top-level planner. The form targets the selected run only while it is the active one, mirroring the server-side 409 contract.

function SetInterruptMode(state, mode) {
	if (mode !== 'inquiry' && mode !== 'plan_modification') return state
	return { ...state, interruptMode: mode }
}

function SubmitInterrupt(state, event) {
	event.preventDefault()
	const runId = state.selectedRunId
	if (typeof runId !== 'string' || runId === '') return state
	const textarea = event.target.querySelector('textarea')
	if (textarea === null) return state
	const message = textarea.value.trim()
	if (message === '') return state
	textarea.value = ''
	return [
		{ ...state, interruptSending: true, interruptNotice: null },
		Fetch({
			url: `api/runs/${encodeURIComponent(runId)}/interrupt`,
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: state.interruptMode, message }) },
			ok: InterruptResponded,
			fail: InterruptFailed,
		}),
	]
}

function InterruptResponded(state, payload) {
	if (payload.status === 202) {
		return { ...state, interruptSending: false, interruptNotice: 'Interrupt sent — it lands at the run\u2019s next safe point; the response appears in the Interrupts list.' }
	}
	if (payload.status === 409) {
		return { ...state, interruptSending: false, interruptNotice: 'The run is no longer active — the interrupt was not sent.' }
	}
	return { ...state, interruptSending: false, interruptNotice: 'The interrupt was rejected.' }
}

function InterruptFailed(state) {
	return { ...state, interruptSending: false, interruptNotice: 'The server could not be reached.', serverAvailable: false }
}

function PrimeAudio(state) {
	return [state, PrimeAudioFx()]
}

// --- Flow / Sequence view controls ----------------------------------------
// The centerpiece's view-mode (Flow vs Sequence) and label tier are pure view state; a swap re-renders the views through the same resolver and model without fetching. The modals are view-side state layered on the live model: the result modal opens on completion (GotSelectedRun) or the flow view's CTA, the question modal opens on a new pending question (GotQuestions) or the flow view's Question affordance.

function SetFlowViewMode(state, mode) {
	if (mode !== 'flow' && mode !== 'sequence') return state
	// Switching modes mounts or unmounts the sequence container, so the swap also syncs its scroll follower (attaching fresh, pinned to the bottom).
	return [{ ...state, flowViewMode: mode }, SyncSequenceFollower()]
}

function ChangeFlowTier(state, event) {
	const value = event.target.value
	if (!isLabelTier(value)) return state
	return { ...state, flowTier: value }
}

// The sequence view's roles-only lens (see interaction-model.js rolesOnlyModel): a checkbox next to the flow/sequence controls that filters the sequence render down to the agent roles plus the human. Pure view state — the full model stays the single source the other surfaces (now caption, cost strip, flow view) read, so toggling only re-renders the sequence view.
function SetSequenceRolesOnly(state, event) {
	return { ...state, sequenceRolesOnly: event.target.checked }
}

// --- Screen navigation ------------------------------------------------------
// The page is a single-screen console: one of four screens (watch / history / compose / queue) fills the viewport below the top bar. The screen is stored view state; nothing here fetches.

function SetScreen(state, screen) {
	if (screen !== 'watch' && screen !== 'history' && screen !== 'compose' && screen !== 'queue') return state
	// Leaving the watch screen unmounts the sequence container (the follower must detach) and returning to it remounts a fresh one; the swap syncs the follower either way.
	// Modal state is deliberately kept alive across the swap: returning to watch restores the session's modal state (an open inspector, its loaded window and scope) instead of a fresh view.
	return [{ ...state, screen }, SyncSequenceFollower()]
}

function ToggleHistoryExpanded(state, runId) {
	if (typeof runId !== 'string' || runId === '') return state
	return { ...state, historyExpanded: { ...state.historyExpanded, [runId]: state.historyExpanded[runId] !== true } }
}

// The plan disclosure is per-view state (only the selected run's plan is rendered), so a single boolean reset on run switch is enough; the poll replacing the run view must not collapse it.
function TogglePlanExpanded(state) {
	return { ...state, planExpanded: state.planExpanded !== true }
}

function OpenInterruptModal(state) {
	return [{ ...state, interruptModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
}

function CloseInterruptModal(state) {
	return { ...state, interruptModalOpen: false }
}

function DismissInterruptAnswer(state) {
	return { ...state, interruptAnswerCard: null }
}

function OpenResultModal(state) {
	// A modal opening covers the run view; clear the inspector so the card does not linger beneath it.
	return [{ ...state, resultModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
}

function CloseResultModal(state) {
	return { ...state, resultModalOpen: false }
}

function OpenQuestionModal(state) {
	return [{ ...state, questionModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
}

function CloseQuestionModal(state) {
	return { ...state, questionModalOpen: false }
}

// --- Run-view inspector (hover) --------------------------------------------
// The inspector card over the flow and sequence SVGs is a hyperapp-managed overlay (the same pattern
// the question/result modals follow), not an imperative DOM append: hovering a node or edge stores a
// tooltip descriptor in state (the target kind+id plus a snapshot of the node's viewport rect), the
// watch stage renders the `Tooltip` card vnode anchored to that rect by `tooltipStyle`, and dismissal
// runs on a short grace timer so the operator can move the pointer from the node into the card to
// select or copy its contents (the card is `pointer-events: auto`, `user-select: text`). The card
// stays open while the pointer is over the node or the card; it dismisses once the pointer is over
// neither. The handlers read the hovered element's `data-operation` / `data-participant` /
// `data-role` off the live `state.flowModel` and `state.labelResolver` (resolved at render time), so
// the inspector never re-fetches and never invents content the model does not carry.

// The grace-period dismiss timer, shared with the dev harness via inspector.js. Expiry dispatches the ClearTooltip action; the factory closes over the raw timer, which is an opaque resource with no place in the view state.
const tooltipDismiss = createTooltipDismiss()

function runScheduleTooltipDismiss(dispatch) {
	tooltipDismiss.schedule(() => dispatch(ClearTooltip))
}

function ScheduleTooltipDismiss() {
	return [runScheduleTooltipDismiss, null]
}

function runCancelTooltipDismiss() {
	tooltipDismiss.cancel()
}

function CancelTooltipDismiss() {
	return [runCancelTooltipDismiss, null]
}

// Dispatched by the grace timer. A no-op when the tooltip is already cleared (e.g. the pointer moved
// to another node and switched, or a modal open cleared it) so a stale timer firing causes no harm.
function ClearTooltip(state) {
	return state.tooltip === null ? state : { ...state, tooltip: null }
}

// The details fetches a hovered target's card may show: the controller marks each uncached id
// 'loading' synchronously so the first render reads a defined state, and each id it began becomes
// one fetch effect (empty when every id is already cached or there is no selected run to fetch
// against).
function fetchOperationDetails(state, target) {
	const runId = state.selectedRunId
	if (typeof runId !== 'string' || runId === '' || state.flowModel === null) return []
	const effects = []
	for (const operationId of operationDetails.begin(runId, operationIdsForTooltipDetails(state.flowModel, target))) {
		effects.push(Fetch({ url: `api/runs/${encodeURIComponent(runId)}/flow?operation=${encodeURIComponent(operationId)}`, ok: GotOperationDetails(runId, operationId), fail: OperationDetailsFailed(runId, operationId) }))
	}
	return effects
}

// The details fetch for one operation resolved: the controller records the server's answer and the
// fresh state is returned so an open card fills in. A ready body caches the details string (or null
// when the operation carries none); anything else — a 404 for an id the model no longer resolves, a
// malformed body, a network failure — caches 'failed', which renders the card section-less.
function GotOperationDetails(runId, operationId) {
	return function GotOperationDetailsForOperation(state, payload) {
		operationDetails.recordResponse(runId, operationId, payload.ok, payload.body)
		return { ...state }
	}
}

function OperationDetailsFailed(runId, operationId) {
	return function OperationDetailsFailedForRun(state) {
		operationDetails.recordFailure(runId, operationId)
		return { ...state }
	}
}

// `mouseover` bubbles from every SVG child the pointer enters, so this fires on each element
// crossing. Three cases:
//  - over the card itself: keep it open and cancel any pending dismiss (the pointer entered the card
//    to select/copy).
//  - over a node/edge target: switch the card to it (canceling any pending dismiss), snapshotting its
//    rect so the card anchors to the node. Returning the same state when the target is unchanged lets
//    hyperapp bail without a re-render. The target's details are fetched here if not cached (the
//    derivation reads them through the session cache once they land).
//  - over empty run-view area: schedule a grace-period dismiss — if the pointer reaches the card (or a
//    new node) before it fires, the dismiss is canceled; otherwise the card dismisses once the pointer
//    is over neither.
function HoverRunView(state, event) {
	if (event.target instanceof Element && event.target.closest('.tooltip-card') !== null) {
		return [state, CancelTooltipDismiss()]
	}
	const target = resolveTooltipTarget(event)
	if (target === null) {
		if (state.tooltip === null) return [state, CancelTooltipDismiss()]
		return [state, ScheduleTooltipDismiss()]
	}
	const current = state.tooltip
	if (current !== null && current.kind === target.kind && current.id === target.id) {
		return [state, CancelTooltipDismiss()]
	}
	return [{ ...state, tooltip: { kind: target.kind, id: target.id, rect: target.rect } }, CancelTooltipDismiss(), ...fetchOperationDetails(state, target)]
}

// `mouseleave` on the run-view stage fires when the pointer leaves the stage entirely (the SVG and
// the card are both descendants of the stage, so moving between them does not fire it). A grace period
// lets the pointer re-enter quickly without a dismiss+reopen flicker; otherwise it clears the card.
function LeaveRunView(state) {
	if (state.tooltip === null) return [state, CancelTooltipDismiss()]
	return [state, ScheduleTooltipDismiss()]
}

// Clicking an in-flight `ask_human` row re-opens the question modal: the sequence view has no
// Question-button overlay like the flow view, so the message row itself is the re-entry affordance
// after a dismiss. A click on an agent's node/slot/message is the drill-in: it opens the inspector modal pre-scoped to that instance (resolveInspectorScope maps the clicked target to the instance id the modal scopes to), and the modal open clears the tooltip so the card does not linger over it.
// Every other click — human/tool/interrupt targets, unknown ids — falls through to the hover path so the click still opens the inspector card at the clicked node, mirroring the dev harness. Hover keeps showing the card exactly as before; the drill-in is the click's job.
// Clicking inside the card (to select text or press a copy affordance) falls through to the hover path's "over the card" branch, which keeps the card open.
function ClickRunView(state, event) {
	if (event.target instanceof Element && event.target.closest('.tooltip-card') !== null) {
		return HoverRunView(state, event)
	}
	const target = resolveTooltipTarget(event)
	if (target !== null && target.kind === 'operation' && state.flowModel !== null && isInFlightAskHuman(state.flowModel, target.id)) {
		// Open the modal and dismiss the inspector so the card does not linger over the modal.
		return [{ ...state, questionModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
	}
	if (target !== null && state.flowModel !== null) {
		const scopeId = resolveInspectorScope(state.flowModel, target)
		if (scopeId !== null) return OpenInspectorModal(state, scopeId)
	}
	return HoverRunView(state, event)
}

// --- LLM turn inspector (modal) ---------------------------------------------
// The stage-controls "Inspect" button opens a modal over the run view that renders one agent instance's LLM turns as a continuous transcript (the per-instance-scoped transcript), derived straight from the windowed log endpoint's `llm_call` payloads — the story needs no per-turn detail fetches; each completed turn's collapsed "on the wire" expander separately fetches the turn's full folded request from the same endpoint's `?detail=` variant, once per session into the bounded wire-details cache. The modal is scoped to one instance of the windowed log: the modal state carries the explicitly scoped instance id (null = auto — the most recently active instance in the loaded window), and the breadcrumb, instance dropdown, and each `agent` call's View affordance re-scope. The data flow is plain effects and state: the log loads with a single cheap probe (`?limit=1`) that learns the log's `total`, then fetches the most recent window; "older turns" pages back; while the modal is open on an active run the 1s poll appends the log's tail so in-flight turns appear when they complete and the live partial swaps for the completed turn.

function initialInspectorState() {
	return { loadState: 'loading', events: [], total: null, tailOffset: null, entries: [], scopedRoleId: null, olderLoading: false }
}

// The inspector's effective scope: the explicitly scoped instance id, or — while unset — the most recently active instance in the loaded window (the newest turn still in flight, else the newest turn), so the modal opens on whatever the run is doing now. A stale explicit scope (its turns paged out of the loaded range) is kept as-is: the transcript reads empty and the dropdown re-scopes.
function effectiveInspectorScope(state) {
	return state.inspector.scopedRoleId ?? deriveDefaultScopeRoleId(state.inspector.entries)
}

// Validates a windowed-log response's shape (what `runLogPage` produces). Run identity is a separate concern: each action compares the body's `runId` against the currently selected run and ignores a mismatch, so a stale response crossing a run switch (which resets the inspector state for the new run) leaves that fresh state alone instead of marking it failed.
function readableInspectorLogBody(payload) {
	if (!payload.ok || payload.body === null || typeof payload.body !== 'object') return null
	const body = payload.body
	if (typeof body.runId !== 'string') return null
	if (typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0) return null
	if (typeof body.offset !== 'number' || !Number.isInteger(body.offset) || body.offset < 0) return null
	if (!Array.isArray(body.events)) return null
	return body
}

// Opens the inspector modal over the run view. `payload` pre-scopes the transcript to an instance id (the view click-through's drill-in; a plain string) or is absent/event-shaped (the stage-controls button), which leaves the scope unset so the modal opens on the most recently active instance.
function OpenInspectorModal(state, payload) {
	if (typeof state.selectedRunId !== 'string' || state.selectedRunId === '') return state
	const scopedRoleId = typeof payload === 'string' && payload !== '' ? payload : null
	// A cheap probe (one event) learns the log's `total` so the first real fetch can start at the most recent window; the probe response's own event is discarded.
	return [
		{ ...state, inspectorModalOpen: true, tooltip: null, inspector: { ...initialInspectorState(), scopedRoleId } },
		CancelTooltipDismiss(),
		Fetch({ url: `api/runs/${encodeURIComponent(state.selectedRunId)}/log?limit=1`, ok: InspectorTotalLoaded, fail: InspectorLogLoadFailed }),
	]
}

function CloseInspectorModal(state) {
	// Closing ends the inspection session (scope, selection, and loaded window with it): reopening refetches from scratch, so no stale scope survives the close.
	return { ...state, inspectorModalOpen: false, inspector: initialInspectorState() }
}

function InspectorTotalLoaded(state, payload) {
	const body = readableInspectorLogBody(payload)
	if (body === null) return [{ ...state, inspector: { ...initialInspectorState(), loadState: 'failed' }, serverAvailable: payload.ok }]
	if (body.runId !== state.selectedRunId) return state
	if (body.total === 0) {
		return [{ ...state, inspector: { ...initialInspectorState(), loadState: 'ready', total: 0, tailOffset: 0, entries: [] }, serverAvailable: true }]
	}
	const tailOffset = tailWindowOffset(body.total, INSPECTOR_WINDOW_SIZE)
	return [
		{ ...state, serverAvailable: true },
		Fetch({ url: `api/runs/${encodeURIComponent(state.selectedRunId)}/log?offset=${tailOffset}&limit=${INSPECTOR_WINDOW_SIZE}`, ok: InspectorWindowLoaded, fail: InspectorLogLoadFailed }),
	]
}

// The window response replaces the loaded events wholesale (initial tail load and gap resync both land here), so the loaded range is always a contiguous slice of the log. The turn pairing also decides the live partial's fate: when the accumulated role no longer holds an in-flight turn, the poll has just recorded its completion and the partial clears (see "Live token stream"); the pairing runs over the full list so a turn completing in an unscoped instance still clears it.
function InspectorWindowLoaded(state, payload) {
	const body = readableInspectorLogBody(payload)
	if (body === null) return [{ ...state, inspector: { ...initialInspectorState(), loadState: 'failed' }, serverAvailable: payload.ok }]
	if (body.runId !== state.selectedRunId) return state
	const entries = buildTurnIndex(body.events)
	return { ...state, inspector: { ...state.inspector, loadState: 'ready', events: body.events, total: body.total, tailOffset: body.offset, entries, olderLoading: false }, livePartial: activeLivePartial(state.livePartial, entries), serverAvailable: true }
}

function LoadOlderTurns(state) {
	const inspector = state.inspector
	if (inspector.loadState !== 'ready' || inspector.olderLoading === true) return state
	const tailOffset = inspector.tailOffset
	if (!canPageOlder(tailOffset) || typeof state.selectedRunId !== 'string') return state
	return [
		{ ...state, inspector: { ...inspector, olderLoading: true } },
		Fetch({ url: `api/runs/${encodeURIComponent(state.selectedRunId)}/log?offset=${olderWindowOffset(tailOffset, INSPECTOR_WINDOW_SIZE)}&limit=${olderFetchLimit(tailOffset, INSPECTOR_WINDOW_SIZE)}`, ok: OlderTurnsLoaded, fail: InspectorOlderLoadFailed }),
	]
}

// The older page must slot exactly in front of the loaded events (contiguous range) — anything else is a stale or diverged response and leaves the list as it was, merely clearing the loading flag for a retry. The log is append-only, so `total` only moves forward through the tail refresh; the older page does not touch it.
function OlderTurnsLoaded(state, payload) {
	const body = readableInspectorLogBody(payload)
	if (body === null || body.runId !== state.selectedRunId || body.offset + body.events.length !== state.inspector.tailOffset) {
		return { ...state, inspector: { ...state.inspector, olderLoading: false } }
	}
	const events = [...body.events, ...state.inspector.events]
	return { ...state, inspector: { ...state.inspector, events, tailOffset: body.offset, entries: buildTurnIndex(events), olderLoading: false }, serverAvailable: true }
}

function InspectorOlderLoadFailed(state) {
	return { ...state, inspector: { ...state.inspector, olderLoading: false }, serverAvailable: false }
}

function InspectorLogLoadFailed(state) {
	return { ...state, inspector: { ...initialInspectorState(), loadState: 'failed' }, serverAvailable: false }
}

// The poll piggyback: one windowed fetch from the loaded range's end. A null effect while the modal is closed, the log has not loaded, or no run is selected — hyperapp ignores falsy effects.
function InspectorTailRefresh(state) {
	if (!state.inspectorModalOpen) return null
	if (state.inspector.loadState !== 'ready' || typeof state.inspector.total !== 'number' || typeof state.selectedRunId !== 'string') return null
	return Fetch({ url: `api/runs/${encodeURIComponent(state.selectedRunId)}/log?offset=${state.inspector.total}&limit=${INSPECTOR_PAGE_LIMIT}`, ok: InspectorTailRefreshed, fail: FetchFailed })
}

// Appends the new events to the loaded range. A response that cannot bridge to the new total (more events landed between two polls than one page carries) resyncs with a fresh tail window instead of leaving a silent gap in the transcript — and so does a loaded range that has grown past the retention cap, since appending at the `full` log level would otherwise grow the modal's memory without bound: the oldest events drop and the "Older turns" control re-fetches them. A response landing after the modal closed leaves the stale inspector state alone.
function InspectorTailRefreshed(state, payload) {
	const body = readableInspectorLogBody(payload)
	if (!state.inspectorModalOpen) return state
	if (body === null || body.runId !== state.selectedRunId || body.offset !== state.inspector.total || state.inspector.loadState !== 'ready') return state
	if (tailRefreshMustResync(body.events.length, body.offset, body.total, state.inspector.events.length)) {
		const tailOffset = tailWindowOffset(body.total, INSPECTOR_WINDOW_SIZE)
		return [state, Fetch({ url: `api/runs/${encodeURIComponent(state.selectedRunId)}/log?offset=${tailOffset}&limit=${INSPECTOR_WINDOW_SIZE}`, ok: InspectorWindowLoaded, fail: InspectorLogLoadFailed })]
	}
	if (body.events.length === 0) return state
	const events = [...state.inspector.events, ...body.events]
	const entries = buildTurnIndex(events)
	// The pairing decides the live partial's fate here too: the completed in-flight turn's partial clears the moment the poll records its `llm_call` (see "Live token stream").
	return { ...state, inspector: { ...state.inspector, events, total: body.total, entries }, livePartial: activeLivePartial(state.livePartial, entries), serverAvailable: true }
}

// Re-scopes the transcript to an instance. The breadcrumb chain derives from the loaded events, so setting the scope pushes the crumb on, and the ↑ parent affordance pops back.
function scopeInspectorTo(state, roleId) {
	if (state.inspector.scopedRoleId === roleId) return state
	return { ...state, inspector: { ...state.inspector, scopedRoleId: roleId } }
}

// The selected value off a change event, or null when it does not carry a usable one.
function eventTargetValue(event) {
	if (event === null || typeof event !== 'object') return null
	const target = event.target
	if (target === null || typeof target !== 'object') return null
	const value = target.value
	return typeof value === 'string' && value !== '' ? value : null
}

// The breadcrumb crumbs, the parent affordance, and an agent call's View control pass the instance id directly; the instance dropdown passes the change event. All re-scope the transcript.
function ScopeInspectorInstance(state, payload) {
	if (state.inspectorModalOpen !== true) return state
	const roleId = typeof payload === 'string' && payload !== '' ? payload : eventTargetValue(payload)
	if (roleId === null) return state
	return scopeInspectorTo(state, roleId)
}

// Whether a `<details>` toggle event reports the expander opening (vs collapsing) — the wire expander fetches on open only.
function toggleOpened(event) {
	if (event === null || typeof event !== 'object') return false
	const target = event.target
	if (target === null || typeof target !== 'object') return false
	return target.open === true
}

// A turn's "on the wire" expander opened: fetch its folded request sections once into the session cache (a cached turn — loading or ready — fetches nothing). The modal wires the action curried with the turn's event index, because the toggle event cannot carry it. Closing touches nothing; re-opening after a failed fetch (the cache evicted it) re-fetches.
function ToggleWireDetail(eventIndex) {
	return function ToggleWireDetailForTurn(state, event) {
		if (state.inspectorModalOpen !== true) return state
		if (!toggleOpened(event)) return state
		if (typeof eventIndex !== 'number' || !Number.isInteger(eventIndex) || eventIndex < 0) return state
		const runId = state.selectedRunId
		if (typeof runId !== 'string' || runId === '') return state
		if (!wireDetails.begin(runId, eventIndex)) return state
		return [{ ...state }, Fetch({ url: `api/runs/${encodeURIComponent(runId)}/log?detail=${eventIndex}`, ok: WireDetailLoaded(runId, eventIndex), fail: WireDetailFailed(runId, eventIndex) })]
	}
}

// The wire fetch resolved: a body carrying `detailSections` (array or explicit null) caches ready; anything else evicts so re-opening retries. Fresh state re-renders the open expander in place; a response landing after the modal closed only updates the cache.
function WireDetailLoaded(runId, eventIndex) {
	return function WireDetailLoadedForTurn(state, payload) {
		wireDetails.recordResponse(runId, eventIndex, payload.ok, payload.body)
		return state.inspectorModalOpen === true ? { ...state } : state
	}
}

function WireDetailFailed(runId, eventIndex) {
	return function WireDetailFailedForTurn(state) {
		wireDetails.recordFailure(runId, eventIndex)
		return state.inspectorModalOpen === true ? { ...state } : state
	}
}

// The inspector modal as the watch screen mounts it: the transcript derives inside the component from the loaded log window and the effective scope (the modal is a pure function of its props, so the vnode tests exercise the same derivation the view renders), plus the breadcrumb chain and instance dropdown from the same events. The turn story reads the event payloads directly; the per-turn "on the wire" expanders read the wire-details session cache through the lookup prop and fetch through the curried toggle action.
function InspectorModalForRun(state) {
	if (!state.inspectorModalOpen) return null
	const runId = state.selectedRunId
	const scopedRoleId = effectiveInspectorScope(state)
	return InspectorModal(h, {
		runLabel: typeof runId === 'string' ? runId : null,
		logEvents: state.inspector.events,
		turns: { loadState: state.inspector.loadState, total: state.inspector.total, tailOffset: state.inspector.tailOffset, olderLoading: state.inspector.olderLoading },
		instances: instancesOf(state.inspector.events),
		chain: deriveInstanceChain(state.inspector.events, scopedRoleId),
		scopedRoleId,
		livePartial: state.livePartial,
		renderMarkdown,
		wireDetailLookup: typeof runId === 'string' ? (eventIndex) => wireDetails.lookup(runId, eventIndex) : null,
		onToggleWire: ToggleWireDetail,
		onScopeInstance: ScopeInspectorInstance,
		onLoadOlder: LoadOlderTurns,
		onClose: CloseInspectorModal,
	})
}

// --- Live token stream (enhancement) ----------------------------------------
// The websocket deltas fold into `livePartial` — the ephemeral in-flight partial the inspector modal renders under the matching in-flight row. The polled run log stays the sole authority for turn history and run state; this only feeds live text, and every path that could leave the partial stale clears it.

function GotLiveDelta(state, delta) {
	// Deltas flow only for the active run; a historical selection (or no selection) ignores them.
	if (state.selectedRunId === null || delta.runId !== state.selectedRunId) return state
	return { ...state, livePartial: nextLivePartial(state.livePartial, delta) }
}

// Socket phase changes clear the partial. On a disconnect the text is stale (and would otherwise linger under the in-flight row); on a fresh connect the accumulation starts empty because deltas resume mid-turn with the middle lost, and showing a gapped text as if continuous would be wrong. Only live partial text is ever lost — the polled log is untouched, and no error surface exists anywhere.
function GotStreamState(state, phase) {
	if (phase !== 'connected' && phase !== 'disconnected') return state
	if (state.livePartial === null) return state
	return { ...state, livePartial: null }
}

// The stream subscription is mounted only while the watch screen shows a selected, non-terminal run (the same non-terminal guard the polling subscription uses). The payload's runId is the only field that changes, so hyperapp restarts the subscription exactly when the selected run changes, and each start re-subscribes (the server replaces the previous subscription). Teardown deliberately leaves the socket connected — the simple lifecycle choice: screen switches cost no reconnect, and deltas that arrive while another screen is shown are dropped by the run filter in GotLiveDelta.
function streamSubscriber(dispatch, payload) {
	if (streamClient === null) {
		streamClient = createStreamClient({
			url: streamSocketUrl(),
			onDelta: (delta) => dispatch(GotLiveDelta, delta),
			onStateChange: (phase) => dispatch(GotStreamState, phase),
		})
	}
	streamClient.subscribe(payload.runId)
	// hyperapp's patchSubs calls the old subscriber's return value on every restart, so a teardown function must always be returned; the stream client deliberately outlives the subscription (page-lifetime client), so teardown is a no-op.
	return () => {}
}

function StreamSubscription(runId) {
	return [streamSubscriber, { runId }]
}

// --- View ------------------------------------------------------------------

// The primary label for a run where space is tight: the task's first line, capped at a word boundary so a long first line cannot stretch the top bar (see queue-panel.js taskFirstLine). History rows and the top bar both use it; the full task is one click away in the row's expanded details.
// The primary label for a run: the LLM-generated one-line summary when the summarizer has produced one, otherwise the task's first line, otherwise the run id. History rows and the top bar share it.
function runPrimaryLabel(summary) {
	if (typeof summary.summary === 'string' && summary.summary !== '') return summary.summary
	if (typeof summary.task === 'string' && summary.task !== '') return taskFirstLine(summary.task)
	return summary.runId
}

// The top bar's live status read: a server-unavailable warning, a clickable "a run is in progress" jump when nothing is selected, the viewed run's status, and a secondary jump pill when the user is browsing a historical run while another is live.
function StatusPills(state) {
	const activeRunId = deriveActiveRunId(state.summaries)
	if (!state.serverAvailable) {
		return [h('span', { class: 'status-pill status-pill-warn' }, SERVER_UNAVAILABLE_MESSAGE)]
	}
	if (state.selectedRunId === null) {
		if (activeRunId !== null) {
			return [h('span', { class: 'status-pill status-pill-live status-pill-clickable', onclick: [SelectRun, activeRunId] }, 'a run is in progress — view')]
		}
		const message = state.summaries.length === 0 ? 'idle' : 'no run selected'
		return [h('span', { class: 'status-pill' }, message)]
	}
	const pills = [h('span', { class: `status-pill status-pill-${state.selectedRunStatus ?? 'unknown'}` }, statusLabel(state.selectedRunStatus))]
	if (activeRunId !== null && activeRunId !== state.selectedRunId) {
		pills.push(h('span', { class: 'status-pill status-pill-live status-pill-clickable', onclick: [SelectRun, activeRunId] }, 'a run is in progress — view'))
	}
	return pills
}

// The viewed run's identity in the top bar: its task's first line as the primary read, with the run id, effort, and relative start as microcopy. Everything here is a machine field or the operator's own task text rendered as textContent.
function ViewedRunLabel(state) {
	const summary = state.summaries.find((entry) => entry.runId === state.selectedRunId)
	if (summary === undefined) return null
	const metaParts = [summary.runId]
	if (isEffort(summary.effort)) metaParts.push(`effort ${effortLabel(summary.effort)}`)
	metaParts.push(`started ${formatRelative(summary.startTime, state.now)}`)
	return h('span', { class: 'topbar-run' }, [
		h('span', { class: 'topbar-run-primary' }, runPrimaryLabel(summary)),
		h('span', { class: 'topbar-run-meta' }, metaParts.join(' · ')),
	])
}

// The serving image's build identifier, the least urgent thing in the bar: a faint version stamp (short sha + built date) after the nav. Nothing renders when build info is absent or formats to an empty label — running from source without a baked build-info.json has nothing to stamp.
function BuildLabel(build) {
	if (build === null) return null
	const label = formatBuildLabel(build)
	if (label === '') return null
	return h('span', { class: 'topbar-build', title: `Built ${build.builtAt}` }, label)
}

function TopBar(state) {
	return h('header', { class: 'topbar' }, [
		h('span', { class: 'topbar-wordmark' }, 'Adaptive Orchestrator'),
		...StatusPills(state),
		ViewedRunLabel(state),
		h('nav', { class: 'topbar-nav' }, [
			// The compose screen is always reachable: with the queue universal, adding a task while a run is in flight queues it for its turn instead of being refused (docs/queueing.md "UI interaction model").
			h('button', { type: 'button', class: { 'nav-button': true, 'is-active': state.screen === 'compose' }, title: 'Add a task to the queue', onclick: [SetScreen, 'compose'] }, 'Add task'),
			h('button', { type: 'button', class: { 'nav-button': true, 'is-active': state.screen === 'queue' }, title: 'Manage the task queue', onclick: [SetScreen, 'queue'] }, `Queue (${backlogCount(state.queueItems)})`),
			h('button', { type: 'button', class: { 'nav-button': true, 'is-active': state.screen === 'history' }, title: 'Browse past runs', onclick: [SetScreen, 'history'] }, `History (${state.summaries.length})`),
			h('label', { class: 'mute-toggle', title: 'Mute the alert sound for incoming questions' }, [
				h('input', { type: 'checkbox', checked: state.muted, onchange: ToggleMute }),
				'mute',
			]),
		]),
		BuildLabel(state.build),
	])
}

// The History screen is the full-screen run browser: compact one-line rows that stay legible no matter how large the underlying prompts and results are, with the full content one expand away. The row's primary line is the run's generated summary (or its task's first line when none exists yet); the expanded details carry the full task and, for terminal runs, the result summary or error — all agent prose through the sanitized Markdown pipeline except the primary line, which is textContent.
function HistoryRow(state, summary, rerunDisabled) {
	const expanded = state.historyExpanded[summary.runId] === true
	return h('li', { key: summary.runId, class: { 'history-row': true, 'is-expanded': expanded, 'is-selected': summary.runId === state.selectedRunId } }, [
		h('div', { class: 'history-row-main', onclick: [SelectRun, summary.runId], title: 'Watch this run' }, [
			h('span', { class: `run-status run-status-${summary.status ?? 'unknown'}` }, statusLabel(summary.status)),
			h('span', { class: 'history-primary' }, runPrimaryLabel(summary)),
			isEffort(summary.effort)
				? h('span', { class: 'run-effort-badge', title: effortDescription(summary.effort) }, `effort ${effortLabel(summary.effort)}`)
				: null,
			h('time', { class: 'history-when', title: summary.startTime ?? '' }, formatRelative(summary.startTime, state.now)),
			// The re-run button shares the create form's disabled condition (a run is active or a submission is in flight) so the one-task-at-a-time contract holds identically for re-runs.
			h('button', { type: 'button', class: 'rerun-button', 'data-task': summary.task ?? '', disabled: rerunDisabled || typeof summary.task !== 'string' || summary.task === '', onclick: RerunTask }, 're-run'),
			// The Continue affordance exists only where it is valid: a terminal run has a settled outcome the new run can anchor to, while continuing a running one would be rejected by the create-run API anyway.
			isTerminalStatus(summary.status)
				? h('button', { type: 'button', class: 'continue-button', 'data-run-id': summary.runId, disabled: rerunDisabled, title: 'Start a new run continuing this one', onclick: ContinueRun }, 'Continue')
				: null,
		]),
		h('button', { type: 'button', class: 'history-expand', 'aria-expanded': expanded, title: expanded ? 'Hide details' : 'Show the full task and result', onclick: [ToggleHistoryExpanded, summary.runId] }, expanded ? 'less ▴' : 'details ▾'),
		expanded ? HistoryRowDetails(summary) : null,
	])
}

// The expanded details are where large prompts and results get their room: the exact run meta, the full task, and the terminal result or error, all rendered at full length inside the scrollable history view.
function HistoryRowDetails(summary) {
	const metaParts = [summary.runId]
	if (isEffort(summary.effort)) metaParts.push(`effort ${effortLabel(summary.effort)}`)
	if (typeof summary.startTime === 'string') metaParts.push(`started ${summary.startTime}`)
	if (typeof summary.endTime === 'string') metaParts.push(`ended ${summary.endTime}`)
	const children = [h('p', { class: 'history-details-meta' }, metaParts.join(' · '))]
	if (typeof summary.task === 'string' && summary.task !== '') {
		children.push(h('p', { class: 'history-details-heading' }, 'Task'))
		children.push(h('div', { class: 'markdown history-details-text' }, renderMarkdown(summary.task)))
	}
	const resultSummary = summary.result !== null && summary.result !== undefined && typeof summary.result.summary === 'string' && summary.result.summary !== '' ? summary.result.summary : null
	if (resultSummary !== null) {
		children.push(h('p', { class: 'history-details-heading' }, 'Result'))
		children.push(h('div', { class: 'markdown history-details-text' }, renderMarkdown(resultSummary)))
	}
	const errorMessage = summary.error !== null && summary.error !== undefined && typeof summary.error.message === 'string' && summary.error.message !== '' ? summary.error.message : null
	if (errorMessage !== null) {
		children.push(h('p', { class: 'history-details-heading' }, 'Error'))
		children.push(h('div', { class: 'markdown history-details-error' }, renderMarkdown(errorMessage)))
	}
	return h('div', { class: 'history-details' }, children)
}

function HistoryScreen(state) {
	const rerunDisabled = state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null
	return h('section', { id: 'history-screen' }, [
		h('div', { class: 'history-scroll' }, [
			state.summaries.length === 0
				? h('p', { class: 'history-empty' }, 'No runs yet — start a new task and it will appear here.')
				: h('ul', { id: 'history-list' }, state.summaries.map((summary) => HistoryRow(state, summary, rerunDisabled))),
		]),
	])
}

// --- Queue panel -------------------------------------------------------------
// The queue screen (docs/queueing.md "UI interaction model"): the polled items grouped into the four sections — waiting (draggable, editable, removable), the one active run, the items waiting for an answer (inline answer box), and the recently settled bucket (done/error/cancelled, with the re-queue action on errors). Item prose — task, question, result summary, error — renders through the sanitized Markdown pipeline (docs/security.md "Web client rendering pipeline"); ids, statuses, and timestamps stay textContent.

function QueueItemMeta(state, item) {
	const parts = []
	if (typeof item.runId === 'string' && item.runId !== '') parts.push(item.runId)
	parts.push(`queued ${formatRelative(item.queuedAt, state.now)}`)
	if (typeof item.settledAt === 'string') parts.push(`settled ${formatRelative(item.settledAt, state.now)}`)
	return h('span', { class: 'queue-item-meta' }, parts.join(' · '))
}

// The waiting row's inline edit form, swapped for the task text while this item is being edited. The textarea is prefilled with the item's current task; saving PATCHes the trimmed text.
function QueueItemEditForm(state, item) {
	return h('form', { class: 'queue-edit-form', onsubmit: SaveItemEdit }, [
		h('textarea', { value: item.task, rows: '3', onkeydown: TaskTextareaKeydown }),
		h('div', { class: 'queue-edit-actions' }, [
			h('button', { type: 'submit' }, 'Save'),
			h('button', { type: 'button', onclick: CancelItemEdit }, 'Cancel'),
		]),
	])
}

// The needs_input row's inline answer box: the recorded question, one input, one submit — the queue-native resume of the parked run.
function QueueItemAnswerForm(state, item) {
	const pending = state.queueAnswerPendingId === item.id
	return h('form', { class: 'queue-answer-form', onsubmit: SubmitQueueAnswer(item.id) }, [
		h('input', { type: 'text', placeholder: 'type your answer', autocomplete: 'off', disabled: pending }),
		h('button', { type: 'submit', disabled: pending }, pending ? 'Sending…' : 'Answer'),
	])
}

function QueueItemRow(state, item) {
	const waiting = item.status === 'waiting'
	const editing = waiting && state.editingItemId === item.id
	const children = [
		h('div', { class: 'queue-item-main' }, [
			h('span', { class: `run-status queue-status queue-status-${item.status}` }, queueStatusLabel(item.status)),
			editing ? QueueItemEditForm(state, item) : h('div', { class: 'queue-item-text markdown' }, renderMarkdown(queueItemPrimaryText(item))),
			QueueItemMeta(state, item),
		]),
	]
	// A re-dispatched waiting item's record of why it ran again (the operator's previous answer) — operator input, rendered as text.
	if (waiting && !editing && typeof item.answer === 'string') {
		children.push(h('p', { class: 'queue-item-answer' }, `Your earlier answer: ${item.answer}`))
	}
	// The error item's own message (what the run said went wrong), under the primary line — agent prose through the sanitized Markdown pipeline.
	if (item.status === 'error' && typeof item.error === 'string' && item.error !== '') {
		children.push(h('div', { class: 'queue-item-error markdown' }, renderMarkdown(item.error)))
	}
	if (waiting && !editing) {
		children.push(h('div', { class: 'queue-item-actions' }, [
			h('button', { type: 'button', class: 'rerun-button', title: 'Edit the task text', onclick: [StartItemEdit, item.id] }, 'Edit'),
			h('button', { type: 'button', class: 'rerun-button', title: 'Remove the task from the queue', onclick: [RemoveQueueItem, item.id] }, 'Remove'),
		]))
	}
	if (item.status === 'needs_input') children.push(QueueItemAnswerForm(state, item))
	if (item.status === 'error') {
		children.push(h('div', { class: 'queue-item-actions' }, [
			h('button', { type: 'button', class: 'rerun-button', title: 'Queue the task again — it runs after everything already waiting', onclick: [RequeueFailedItem, item.id] }, 'Re-queue'),
		]))
	}
	return h('li', {
		key: item.id,
		class: { 'queue-item': true, 'is-waiting': waiting, 'is-dragging': state.draggingItemId === item.id },
		// Only waiting rows drag: a drag is a reorder, and the reorder endpoint takes waiting items only.
		draggable: waiting && !editing,
		'data-item-id': item.id,
		ondragstart: DragQueueItem,
		ondragover: DragOverQueueItem,
		ondrop: DropQueueItem,
		ondragend: DragEndQueueItem,
	}, children)
}

function QueueSection(state, heading, items, emptyText) {
	return h('div', { class: 'queue-section' }, [
		h('h2', { class: 'queue-section-heading' }, `${heading} (${items.length})`),
		items.length === 0
			? h('p', { class: 'queue-section-empty' }, emptyText)
			: h('ul', { class: 'queue-list' }, items.map((item) => QueueItemRow(state, item))),
	])
}

function QueueScreen(state) {
	const sections = deriveQueueSections(state.queueItems)
	if (state.queueItems.length === 0) {
		return h('section', { id: 'queue-screen' }, [
			h('p', { class: 'queue-empty' }, 'No queued tasks — add one from the Add task screen.'),
		])
	}
	return h('section', { id: 'queue-screen' }, [
		h('div', { class: 'queue-scroll' }, [
			QueueSection(state, 'Waiting', sections.waiting, 'Nothing is waiting — tasks added now start immediately.'),
			QueueSection(state, 'Running now', sections.active, 'No run is active right now.'),
			QueueSection(state, 'Needs your answer', sections.needsInput, 'Nothing is waiting for an answer.'),
			QueueSection(state, 'Recently finished', sections.recent, 'No finished tasks yet.'),
		]),
	])
}

// The effort selector is one radio group (shared `name`, real inputs) so arrow keys and screen readers work natively, with each whole card clickable via its wrapping label. The option values are the wire strings verbatim — picking a card fires SaveRunEffort, so the choice applies to the next run and persists as the project default at once. The names, descriptions, and recommended badge all render from EFFORT_OPTIONS, the single home of the per-level copy.
function EffortLevelSelector(value, disabled, saving) {
	return h('fieldset', { class: 'effort-control', disabled }, [
		h('legend', { class: 'effort-label' }, 'Effort level'),
		h('div', { class: 'effort-options' }, EFFORT_OPTIONS.map((option) =>
			h('label', { class: { 'effort-option': true, 'is-selected': option.value === value } }, [
				h('input', { type: 'radio', name: 'run-effort', value: option.value, checked: option.value === value, onchange: SaveRunEffort }),
				h('span', { class: 'effort-option-name' }, [
					effortLabel(option.value),
					option.recommended === true ? h('span', { class: 'effort-recommended' }, 'Recommended') : null,
				]),
				h('span', { class: 'effort-option-description' }, option.description),
			]),
		)),
		h('p', { class: 'effort-tip' }, 'Not sure? Leave it on Standard — it fits most tasks. You can always run the task again with a different level.'),
		h('p', { class: 'effort-note' }, saving ? 'saving…' : ''),
	])
}

// The logging-level selector mirrors the effort selector's radio group at a smaller size — two options whose labels come from LOG_LEVEL_OPTIONS, the single home of the copy. Picking one fires SaveRunLogLevel, so the choice applies to the next run and persists as the project default at once.
function LoggingLevelSelector(value, disabled, saving) {
	return h('fieldset', { class: 'logging-level-control', disabled }, [
		h('legend', { class: 'logging-level-label' }, 'Logging level'),
		h('div', { class: 'logging-level-options' }, LOG_LEVEL_OPTIONS.map((option) =>
			h('label', { class: { 'logging-level-option': true, 'is-selected': option.value === value } }, [
				h('input', { type: 'radio', name: 'run-log-level', value: option.value, checked: option.value === value, onchange: SaveRunLogLevel }),
				h('span', { class: 'logging-level-option-name' }, option.label),
			]),
		)),
		h('p', { class: 'logging-level-note' }, saving ? 'saving…' : ''),
	])
}

// The continuation banner above the compose textarea: names the run being continued and echoes its task (and its outcome, when one exists) so the follow-up is drafted against the right context. Every dynamic string is a machine field rendered as text — never markup. Dismissing returns the form to a plain new task.
function ContinuationChip(state) {
	const continuation = state.continuation
	if (continuation === null) return null
	return h('div', { class: 'continuation-chip', 'aria-label': `Continuing run ${continuation.runId}` }, [
		h('div', { class: 'continuation-chip-text' }, [
			h('p', { class: 'continuation-chip-title' }, `Continuing run ${continuation.runId}`),
			typeof continuation.task === 'string' && continuation.task !== '' ? h('p', { class: 'continuation-chip-task' }, taskFirstLine(continuation.task)) : null,
			continuation.summary !== null ? h('p', { class: 'continuation-chip-outcome' }, `Prior outcome: ${continuation.summary}`) : null,
		]),
		h('button', { type: 'button', class: 'continuation-chip-dismiss', title: 'Discard the continuation and write a fresh task', onclick: CancelContinuation }, 'Cancel'),
	])
}

// The compose screen is the hero when the service is idle — drafting a task is the primary activity when nothing is running, so the editor gets the whole stage. The submit path is the queue's universal add (the scheduler dispatches it at once when the system is idle, so the user-visible behavior of today's "start now" is preserved); in continuation mode the chip rides above the task field and the submit body carries continuesFrom — the only body that can — so a continuation stays disabled while a run is in flight rather than queueing without its lineage.
function ComposeScreen(state) {
	const disabled = state.continuation !== null && deriveActiveRunId(state.summaries) !== null
	const runEffort = isEffort(state.runEffort) ? state.runEffort : DEFAULT_EFFORT
	const runLogLevel = isLogLevel(state.runLogLevel) ? state.runLogLevel : DEFAULT_LOG_LEVEL
	return h('section', { id: 'compose-screen' }, [
		h('div', { class: 'compose-hero' }, [
			h('h1', { class: 'compose-heading' }, state.summaries.length === 0 ? 'What should the orchestrator do?' : 'Add task'),
			h('p', { class: 'compose-sub' }, 'Describe the task in plain language — Markdown works too. Tasks run one at a time; a task added while a run is in progress waits in the queue and starts when it finishes.'),
			h('form', { class: { 'create-run-form': true, 'is-busy': disabled }, onsubmit: SubmitRun }, [
				ContinuationChip(state),
				h('textarea', { name: 'task', placeholder: disabled ? 'a run is already in progress — a continuation starts when it finishes' : 'describe a task (Markdown supported)', autocomplete: 'off', disabled, onkeydown: TaskTextareaKeydown }),
				EffortLevelSelector(runEffort, disabled, state.savingEffort === true),
				LoggingLevelSelector(runLogLevel, disabled, state.savingLogLevel === true),
				h('div', { class: 'submit-controls' }, [
					h('button', { type: 'submit', disabled }, disabled ? 'Run in progress…' : 'Add task'),
				]),
			]),
		]),
	])
}

// The interrupt history is the visible record of what the operator sent and what the run did with it: each inquiry pairs with the role's answer (or a waiting/ended note), each plan modification lists its delivery target and abort count. The question/outcome lines are machine fields or the operator's own text (textContent); the answer is agent prose and renders only through the sanitized Markdown pipeline.
function InterruptHistory(state) {
	const view = state.selectedRunView
	if (view === null || !Array.isArray(view.interrupts) || view.interrupts.length === 0) return null
	return h('div', { class: 'interrupt-history' }, [
		h('h3', {}, 'Earlier interrupts'),
		h('ul', {}, view.interrupts.map((entry, index) => {
			if (entry.kind === 'inquiry') {
				const answerState = entry.answer !== null
					? h('div', { class: 'interrupt-answer markdown' }, renderMarkdown(entry.answer))
					: h('p', { class: 'interrupt-waiting' }, entry.ended ? 'The role finished without answering.' : 'Waiting for the run to answer…')
				return h('li', { key: `interrupt-${index}` }, [
					h('div', { class: 'interrupt-meta-row' }, [
						h('span', { class: 'interrupt-kind' }, 'Question'),
						entry.role !== null ? h('span', { class: 'interrupt-target' }, `to ${entry.role}`) : null,
						h('time', { title: entry.askedAt }, formatRelative(entry.askedAt, state.now)),
					]),
					h('p', { class: 'interrupt-text' }, entry.message),
					answerState,
				])
			}
			return h('li', { key: `interrupt-${index}` }, [
				h('div', { class: 'interrupt-meta-row' }, [
					h('span', { class: 'interrupt-kind interrupt-kind-plan' }, 'Plan change'),
					h('time', { title: entry.askedAt }, formatRelative(entry.askedAt, state.now)),
				]),
				h('p', { class: 'interrupt-text' }, entry.message),
				h('p', { class: 'interrupt-outcome' }, `Delivered to ${entry.targetRole ?? entry.target ?? 'the run'}${entry.aborted.length > 0 ? ` — ${entry.aborted.length} role${entry.aborted.length === 1 ? '' : 's'} aborted` : ''}.`),
			])
		})),
	])
}

// The interrupt form addresses the selected run only while it is the one in flight; a historical selection or an idle service renders nothing. The plan-modification mode carries an upfront warning because it aborts the work currently happening. Every string here is trusted UI copy or the operator's own input (posted, never rendered back), so the form introduces no untrusted-content path.
function InterruptForm(state) {
	const activeRunId = deriveActiveRunId(state.summaries)
	if (activeRunId === null || state.selectedRunId !== activeRunId) return null
	const mode = state.interruptMode
	const queued = state.selectedRunView !== null && state.selectedRunView.interruptPending === true
	return h('div', { class: 'interrupt-form-wrap' }, [
		h('div', { class: 'interrupt-mode', role: 'group', 'aria-label': 'interrupt kind' }, [
			h('label', { class: mode === 'inquiry' ? 'is-active' : '' }, [
				h('input', { type: 'radio', name: 'interrupt-kind', checked: mode === 'inquiry', onchange: [SetInterruptMode, 'inquiry'] }),
				'Ask a question',
			]),
			h('label', { class: mode === 'plan_modification' ? 'is-active' : '' }, [
				h('input', { type: 'radio', name: 'interrupt-kind', checked: mode === 'plan_modification', onchange: [SetInterruptMode, 'plan_modification'] }),
				'Change the plan',
			]),
		]),
		mode === 'plan_modification'
			? h('p', { class: 'interrupt-warning' }, 'Changing the plan aborts the work happening right now and re-plans from the top-level planner.')
			: null,
		h('form', { class: 'interrupt-form', onsubmit: SubmitInterrupt }, [
			h('textarea', {
				name: 'interrupt-message',
				rows: '3',
				placeholder: mode === 'inquiry' ? 'ask the run something (e.g. “what are you working on?”)' : 'describe the change to make (e.g. “use Postgres instead of SQLite”)',
			}),
			h('button', { type: 'submit', disabled: state.interruptSending }, state.interruptSending ? 'Sending…' : 'Send interrupt'),
		]),
		queued ? h('p', { class: 'interrupt-note' }, 'An interrupt is queued and will land at the run\u2019s next safe point.') : null,
		state.interruptNotice !== null ? h('p', { class: 'interrupt-note' }, state.interruptNotice) : null,
	])
}

// The stage-scoped interrupt modal pairs the history of what the operator already sent with the form to send more, so an answer appears in the same place the question was asked. It is reachable only while viewing the active run (the controls-row button is the single entry point and renders only then); the form itself re-checks the condition in case the run completes while the modal is open.
function InterruptModalForRun(state) {
	if (!state.interruptModalOpen) return null
	return h('div', { class: 'interrupt-modal-overlay' }, [
		h('div', { class: 'interrupt-modal-backdrop', onclick: CloseInterruptModal }),
		h('div', { class: 'interrupt-modal-card' }, [
			h('p', { class: 'interrupt-modal-heading' }, 'Interrupt this run'),
			InterruptHistory(state),
			InterruptForm(state),
			h('div', { class: 'interrupt-modal-actions' }, [
				h('button', { type: 'button', class: 'interrupt-modal-close', onclick: CloseInterruptModal }, 'Close'),
			]),
		]),
	])
}

// A newly-arrived answer to the operator's interrupt question, presented as a dismissible card pinned over the stage's corner: unmissable on arrival but never blocking the run view the way a modal would. The question and the answering role's name are textContent (the operator's own words and a machine field); the answer is agent prose through the sanitized Markdown pipeline. The full exchange also lives in the interrupt modal's history.
function InterruptAnswerCardForRun(state) {
	const card = state.interruptAnswerCard
	if (card === null) return null
	return h('div', { class: 'interrupt-answer-card' }, [
		h('p', { class: 'interrupt-answer-card-heading' }, card.role !== null && typeof card.role === 'string' ? `Answer from ${card.role}` : 'The run answered'),
		h('p', { class: 'interrupt-answer-card-question' }, card.question),
		h('div', { class: 'interrupt-answer-card-answer markdown' }, renderMarkdown(card.answer)),
		h('button', { type: 'button', class: 'interrupt-answer-card-close', onclick: DismissInterruptAnswer }, 'Dismiss'),
	])
}

function CostStrip(model) {
	const cost = deriveCostStrip(model)
	return h('div', { class: 'pb-cost-strip' }, [
		h('span', { class: 'pb-cost-item' }, `elapsed ${formatElapsed(cost.elapsedSeconds)}`),
		h('span', { class: 'pb-cost-sep' }, '·'),
		h('span', { class: 'pb-cost-item' }, `${formatTokens(cost.tokens)} tokens`),
	])
}

// The interrupt modal's single entry point, visible only while the viewed run is the one in flight; a historical selection or an idle service renders nothing, mirroring the server-side 409 contract.
function InterruptButton(state) {
	const activeRunId = deriveActiveRunId(state.summaries)
	if (activeRunId === null || state.selectedRunId !== activeRunId) return null
	return h('button', { type: 'button', class: 'interrupt-open-button', title: 'Ask the run a question or change its plan', onclick: OpenInterruptModal }, 'Interrupt')
}

function StageControls(state, model) {
	return h('div', { class: 'stage-controls' }, [
		h('div', { class: 'pb-view-toggle', role: 'group', 'aria-label': 'run view' }, [
			h('button', { type: 'button', class: state.flowViewMode === 'flow' ? 'is-active' : '', onclick: [SetFlowViewMode, 'flow'] }, 'Flow'),
			h('button', { type: 'button', class: state.flowViewMode === 'sequence' ? 'is-active' : '', onclick: [SetFlowViewMode, 'sequence'] }, 'Sequence'),
		]),
		// The roles-only filter is a sequence-view lens, so the toggle shows only while that view is active (the same show-with-the-sequence rule the harness's jump-to-active button follows).
		state.flowViewMode === 'sequence' ? SequenceRolesOnlyToggle(state) : null,
		h('label', { class: 'flow-tier-control' }, [
			h('span', {}, 'Label tier'),
			h('select', { value: state.flowTier, onchange: ChangeFlowTier }, TIER_VALUES.map((value) => h('option', { value, selected: value === state.flowTier }, value))),
		]),
		model !== null ? CostStrip(model) : null,
		InterruptButton(state),
		h('button', { type: 'button', class: 'inspector-open-button', title: 'Inspect this run\u2019s LLM requests and responses, turn by turn', onclick: OpenInspectorModal }, 'Inspect'),
	])
}

// The roles-only checkbox (see SetSequenceRolesOnly). Mirrors the mute toggle's checkbox look so the two filter-ish controls read alike.
function SequenceRolesOnlyToggle(state) {
	return h('label', { class: 'sequence-roles-control', title: 'Hide tool and interrupt columns — show only the agent roles and the human' }, [
		h('input', { type: 'checkbox', checked: state.sequenceRolesOnly === true, onchange: SetSequenceRolesOnly }),
		'roles only',
	])
}

// The run's plan document (the Markdown the planner writes through write_plan), shown as a collapsed disclosure between the stage and the now-caption so the plan is one click away without competing with the live graph. The plan is agent-authored prose like any other the run produces, so its body renders only through the shared sanitized Markdown pipeline; a run without a plan renders nothing at all.
function PlanSection(state) {
	const view = state.selectedRunView
	const plan = view !== null && typeof view.plan === 'string' ? view.plan : ''
	if (plan === '') return null
	const expanded = state.planExpanded === true
	return h('div', { class: 'run-plan' }, [
		h('button', { type: 'button', class: 'run-plan-toggle', 'aria-expanded': expanded, title: expanded ? 'Hide the plan' : 'Show the plan the run is following', onclick: TogglePlanExpanded }, expanded ? 'Plan ▴' : 'Plan ▾'),
		expanded ? h('div', { class: 'run-plan-body markdown' }, renderMarkdown(plan)) : null,
	])
}

// The run's lineage: a run that continued a prior finished run names it here, and clicking jumps to the prior run's view through the same SelectRun path the history rows and status pills use. The id is a machine field rendered as text; a run without lineage renders nothing.
function LineageLine(state) {
	const view = state.selectedRunView
	if (view === null) return null
	if (typeof view.continuesFrom !== 'string' || view.continuesFrom === '') return null
	return h('button', { type: 'button', class: 'run-lineage', title: 'View the run this run continues', onclick: [SelectRun, view.continuesFrom] }, `Continues run ${view.continuesFrom}`)
}

// --- Sequence-view scroll following ----------------------------------------
// The sequence container follows new content while the operator sits at its bottom and browses freely otherwise (see scroll-follow.js). hyperapp has no mounted-element hook, so the follower is synced against the rendered DOM: the effect defers to its own requestAnimationFrame, which hyperapp's render — queued first, at setState — precedes in the same frame, so the patch has landed before the sync runs. The sync attaches a fresh follower when the container element was replaced (mode/screen switches and the placeholder-to-model transition remount it), detaches when the container is gone, and pins to the bottom on every model update while still attached.

let sequenceFollower = null

function runSyncSequenceFollower(_dispatch, _payload) {
	requestAnimationFrame(() => {
		const container = document.querySelector('.pb-sequence-scroll')
		if (!(container instanceof HTMLElement)) {
			if (sequenceFollower !== null) {
				sequenceFollower.destroy()
				sequenceFollower = null
			}
			return
		}
		if (sequenceFollower === null || sequenceFollower.element !== container) {
			if (sequenceFollower !== null) sequenceFollower.destroy()
			sequenceFollower = createScrollFollower(container)
		}
		sequenceFollower.follow()
	})
}

function SyncSequenceFollower() {
	return [runSyncSequenceFollower, null]
}

// The watch screen fills the viewport below the top bar: a controls row, the flex-filling stage, and the now-caption. The Flow view (product surface) and the Sequence view (debug surface) are independent leaves over the same model; the toggle swaps which renders without a fetch. The sequence view mounts inside a vertical scroll container because its timeline grows long, while the flow view scales to the stage.
function WatchScreen(state) {
	const labels = state.labelResolver
	const model = state.flowModel
	// Before the guild config or the first readable flow frame lands, the stage shows a placeholder rather than a half-built graph; both arrive within the first poll, so the placeholder is transient.
	if (labels === null || model === null) {
		const message = state.selectedRunId === null
			? 'Select a run to see its flow.'
			: labels === null
				? 'Loading run view…'
				: 'Waiting for run activity…'
		return h('section', { id: 'watch-screen' }, [
			LineageLine(state),
			StageControls(state, null),
			h('div', { class: 'pb-flow flow-stage' }, [h('p', { class: 'flow-empty' }, message), InspectorModalForRun(state)]),
		])
	}

	const tier = state.flowTier
	const lifecycle = state.previousFlowModel !== null ? deriveLifecycle(state.previousFlowModel, model) : undefined
	const cta = { onclick: OpenResultModal }
	const question = { onclick: OpenQuestionModal }
	// The roles-only toggle filters the sequence render only (model and static guild set alike, so the tools column collapses with the tool rows); the caption, cost strip, and flow view keep reading the full model — the filter is a lens on this one surface, not a change to the run.
	const sequenceModel = state.sequenceRolesOnly === true ? rolesOnlyModel(model) : model
	const sequenceGuildParticipants = state.sequenceRolesOnly === true ? rolesOnlyParticipants(state.guildParticipants) : state.guildParticipants
	// The sequence view takes the guild's static participant set so every role column appears from the first frame.
	const stageContent = state.flowViewMode === 'sequence'
		? h('div', { class: 'pb-sequence-scroll' }, [renderSequenceView(h, sequenceModel, labels, tier, sequenceGuildParticipants)])
		: renderFlowView(h, model, labels, tier, lifecycle, cta, question, flowColumnTracker)

	const nowCaption = deriveNowCaption(model, labels, tier)

	return h('section', { id: 'watch-screen' }, [
		LineageLine(state),
		StageControls(state, model),
		// `.pb-flow` is the positioning context for the per-run-view modals (the question, result, and interrupt overlays are absolute inset 0 within it), so the modals cover the run view rather than the whole page. It is also the hover stage for the inspector: `mouseover`/`mouseleave`/`click` bubble here from every SVG child, so the inspector is wired once for both the flow and sequence views.
		h('div', { class: 'pb-flow flow-stage', onmouseover: HoverRunView, onmouseleave: LeaveRunView, onclick: ClickRunView }, [
			stageContent,
			QuestionModalForRun(state),
			ResultModalForRun(state),
			InterruptModalForRun(state),
			InspectorModalForRun(state),
			InterruptAnswerCardForRun(state),
			TooltipCardForRun(state),
		]),
		PlanSection(state),
		h('p', { class: 'pb-now-caption' }, nowCaption),
	])
}

// The inspector card over the run view. The descriptor in state is resolved against the live model
// and label resolver at render time, so the card reads the same model the SVG renders and never
// re-derives its labels. A descriptor whose id no longer resolves (an operation from a frame the
// poll has since replaced, or a participant/role the model no longer carries) yields an empty title
// and is treated as "no card" so a stale hover state dismisses rather than rendering a heading-less
// card. The card is `position: fixed` (styles.css), anchored to the snapshot rect taken at hover
// time, so it sits at a fixed position relative to the node (not the pointer) and stays put while
// the pointer is over it; its only prose-carrying section is the operation details markdown, which
// the hover wiring fetches on demand and which `formatTooltipContent` routes through the sanitized
// pipeline.
function TooltipCardForRun(state) {
	const tooltip = state.tooltip
	if (tooltip === null) return null
	const model = state.flowModel
	const labels = state.labelResolver
	if (model === null || labels === null) return null
	const descriptor = deriveTooltipDescriptor(model, labels, state.flowTier, tooltip, operationDetailsLookup(state.selectedRunId))
	if (descriptor.title === '') return null
	return Tooltip(h, { title: descriptor.title, sections: descriptor.sections, renderMarkdown, style: tooltipStyle(tooltip.rect) })
}

// The lookup the tooltip derivations read: the session cache's state for one operation id (a miss
// reads as failed, which the derivations render as "no details section" — never as invented
// content).
function operationDetailsLookup(runId) {
	return (operationId) => operationDetails.lookup(runId, operationId)
}

// The pending question the modal renders. The live `/api/questions` poll is the source, so the modal is driven by live data, and the answer form posts to `/api/answer` via the existing SubmitAnswer path. The first pending question is the active one; the modal opens when one arrives (GotQuestions) and re-opens via the flow view's Question affordance.
function QuestionModalForRun(state) {
	if (!state.questionModalOpen) return null
	const question = state.pendingQuestions[0]
	if (question === undefined) return null
	const runLabel = state.selectedRunView !== null && typeof state.selectedRunView.runId === 'string' ? state.selectedRunView.runId : null
	return QuestionModal(h, {
		question: { question: question.question, context: question.context },
		runLabel,
		renderMarkdown,
		onSubmit: SubmitAnswer(question.id),
		onClose: CloseQuestionModal,
		answerPending: state.pendingAnswerId === question.id,
	})
}

// The technical meta line the result modal carries for advanced users: run id, effort, duration, and tool-call count in the text, with the exact start/end timestamps on the hover title. Derived from the run view the per-run poll already fetches, so the modal re-opens with no extra request.
function resultMetaLine(view) {
	if (typeof view.runId !== 'string' || view.budgets === null || view.budgets === undefined) return null
	const parts = [view.runId]
	if (isEffort(view.effort)) parts.push(`effort ${effortLabel(view.effort)}`)
	parts.push(formatElapsed(view.budgets.elapsedSeconds))
	parts.push(`${formatNumber(view.budgets.toolCalls)} tool calls`)
	const title = `started ${view.startTime ?? '—'} → ended ${view.endTime ?? '—'}`
	return { text: parts.join(' · '), title }
}

// The terminal result the modal renders, derived from the live run view the per-run poll already fetches (the flow endpoint carries no result/error fields). The modal opens on a watched run's completion (GotSelectedRun) and re-opens via the flow view's CTA; the descriptor is undefined for a non-terminal run so the modal renders nothing then.
function ResultModalForRun(state) {
	if (!state.resultModalOpen) return null
	const view = state.selectedRunView
	if (view === null) return null
	const descriptor = deriveTerminalResult(view)
	if (descriptor === undefined) return null
	const metaLine = resultMetaLine(view)
	return ResultModal(h, {
		descriptor,
		runLabel: typeof view.runId === 'string' ? view.runId : null,
		metaLine,
		renderMarkdown,
		onCopyRaw: copyRawToClipboard,
		onClose: CloseResultModal,
	})
}

// The screen switch. A zero-state service (no runs, nothing selected) shows the compose hero regardless of the stored screen — drafting the first task is the only meaningful activity then.
function Main(state) {
	if (state.screen === 'history') return h('main', {}, [HistoryScreen(state)])
	if (state.screen === 'compose') return h('main', {}, [ComposeScreen(state)])
	if (state.screen === 'queue') return h('main', {}, [QueueScreen(state)])
	if (state.summaries.length === 0 && state.selectedRunId === null) return h('main', {}, [ComposeScreen(state)])
	return h('main', {}, [WatchScreen(state)])
}

function view(state) {
	return h('div', { class: 'app-shell' }, [TopBar(state), Main(state)])
}

// --- App -------------------------------------------------------------------
// The subscriptions array is fixed-size with stable positions: [0] always polls the run list, the pending questions, and the task queue every second; [1] polls the selected run's run view and flow model every second but only while one is selected and non-terminal (the deactivation on terminal status stops the polling); [2] primes the AudioContext on the first user interaction; [3] dismisses the inspector modal on Escape while it is open; [4] subscribes the live token stream to the selected run while the watch screen shows one that is selected and non-terminal (the same non-terminal guard [1] uses).

app({
	init: [
		{
			summaries: [],
			selectedRunId: null,
			selectedRunView: null,
			selectedRunStatus: null,
			pendingQuestions: [],
			// The polled task queue (docs/queueing.md "UI interaction model"), head first. The add-flow's ids: justSubmittedItemId guards a second submit while one is in flight; pendingAddSelectionId is consumed once by the very next queue read to jump to the new run's watch screen when the scheduler dispatched it within the add request.
			queueItems: [],
			justSubmittedItemId: null,
			pendingAddSelectionId: null,
			// The queue panel's row-level view state: the waiting item being inline-edited, the row being dragged, and the item whose answer is posting.
			editingItemId: null,
			draggingItemId: null,
			queueAnswerPendingId: null,
			serverAvailable: true,
			justSubmittedRunId: null,
			muted: false,
			shownQuestionIds: {},
			firstQuestionsPoll: true,
			pendingAnswerId: null,
			// null until the saved settings load; the selectors initialize from the persisted levels on first load.
			runEffort: null,
			savingEffort: false,
			runLogLevel: null,
			savingLogLevel: false,
			// The live InteractionModel the centerpiece renders, plus its previous frame for `deriveLifecycle`'s enter/depart diff. Both null until the first readable flow frame lands.
			flowModel: null,
			previousFlowModel: null,
			// The label resolver and guild participant inventory are built once from `/api/config` (GotConfig); null/empty until that single load completes. `build` rides the same load: the image's build identifier for the top bar, and stays null when running from source without a baked build-info.json.
			labelResolver: null,
			guildParticipants: [],
			build: null,
			flowTier: DEFAULT_FLOW_TIER,
			flowViewMode: 'flow',
			// The sequence view's roles-only lens (see rolesOnlyModel in interaction-model.js): off by default so the sequence view shows everything.
			sequenceRolesOnly: false,
			// The visible screen: 'watch' (the flow/sequence stage), 'history' (the run browser), or 'compose' (the new-task hero). A zero-state service shows compose regardless (see Main).
			screen: 'watch',
			// Per-history-row expansion, keyed by run id, so the full task/result of several runs can be open at once.
			historyExpanded: {},
			// The continuation pending on the compose screen: the prior run's id (submitted as continuesFrom) plus the task and outcome summary the chip echoes, or null for a plain new task. Set by the History row's Continue button; cleared by the chip's Cancel and after a successful submit.
			continuation: null,
			// Per-run-view modal state. The question modal opens on a new pending question; the result modal opens on a watched run's completion. `resultShownForRun` dedups the auto-open across the polls that follow a completion. The interrupt modal opens only from the stage controls.
			questionModalOpen: false,
			resultModalOpen: false,
			resultShownForRun: null,
			interruptModalOpen: false,
			// The LLM turn inspector opens only from the stage controls; its data (the loaded log window and the derived turn index) lives in `inspector` and resets on open and on run switch.
			inspectorModalOpen: false,
			inspector: initialInspectorState(),
			// The plan disclosure under the stage: collapsed by default, reset with the other per-run view state on a run switch.
			planExpanded: false,
			// The live token stream's ephemeral partial (see "Live token stream"): the in-flight reasoning/content the inspector modal renders under the matching in-flight row. Null whenever nothing is streaming or the stream is down; never an authority on run state.
			livePartial: null,
			// The inspector descriptor over the run view: null when nothing is hovered. Cleared on
			// `mouseleave` of the stage and on run switch; a stale id self-dismisses at render time.
			tooltip: null,
		// Interrupt form state: the kind toggle, an in-flight send flag, and a one-line outcome notice. The answer card presents each newly-arrived interrupt answer once (keys run-scoped in shownInterruptAnswerKeys); a run's first read baselines its answered history so old runs never pop stale cards.
		interruptMode: 'inquiry',
		interruptSending: false,
		interruptNotice: null,
		interruptAnswerCard: null,
		shownInterruptAnswerKeys: {},
		now: Date.now(),
	},
	// The guild config and the saved settings (effort and logging level) are each loaded once on load and never polled, so their fetches are init effects rather than subscriptions.
	Fetch({ url: 'api/config', ok: GotConfig, fail: FetchFailed }),
	Fetch({ url: 'api/settings', ok: GotSettings, fail: SettingsFetchFailed }),
	],
	view,
	subscriptions: (state) => [
		onEvery(Tick, POLL_INTERVAL_MS),
		typeof state.selectedRunId === 'string' && state.selectedRunId !== '' && !isTerminalStatus(state.selectedRunStatus) && onEvery(PollSelectedRun, POLL_INTERVAL_MS),
		onFirstInteraction(PrimeAudio),
		state.inspectorModalOpen === true && onEscapeKey(CloseInspectorModal),
		state.screen === 'watch' && typeof state.selectedRunId === 'string' && state.selectedRunId !== '' && !isTerminalStatus(state.selectedRunStatus) && StreamSubscription(state.selectedRunId),
	],
	node: document.getElementById('app'),
})
