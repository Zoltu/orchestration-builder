// Hyperapp client for the long-running service.
// The whole UI is one reactive view of a single state object; polling runs as subscriptions and every side effect (fetch, POST, audio, flash) runs as an effect. The model is a trusted component; its prose fields (task, result summary, question text, question context, error message) are Markdown the UI renders as formatted text via `showdown` + `highlight.js`. The residual concern is not a malicious model but prompt injection — a malicious file in the workspace coercing the model's output — so the parsed HTML is walked through the allowlist in markdown.js before reaching the DOM; this is a defense-in-depth backstop, with the primary injection defense upstream (see docs/security.md "Web client rendering pipeline"). Machine fields (tool names, operation arguments/results, timestamps, role names, run ids, the one-line current-activity summary) are interpolated only as children of h() or text-node arguments, which hyperapp places into text nodes and properties — never into markup.
import { h, app } from './vendor/hyperapp.js'
import { createMarkdownRenderer } from './markdown-render.js'
import { renderFlowView, deriveLifecycle, deriveNowCaption, deriveCostStrip, createColumnTracker } from './flow-view.js'
import { renderSequenceView } from './sequence-diagram.js'
import { createLabelResolver, TIER_VALUES, isLabelTier } from './labels.js'
import { isTerminalStatus } from './interaction-model.js'
import { createTooltipDismiss, deriveTooltipDescriptor, isInFlightAskHuman, resolveTooltipTarget } from './inspector.js'
import { copyRawToClipboard } from './clipboard.js'
import { QuestionModal } from './question-modal.js'
import { ResultModal, deriveTerminalResult } from './result-modal.js'
import { Tooltip, tooltipStyle } from './tooltip.js'

const POLL_INTERVAL_MS = 1000
const STATUS_LABELS = {
	unknown: 'in progress',
	running: 'running',
	success: 'success',
	error: 'error',
	needs_clarification: 'needs clarification',
}
const SERVER_UNAVAILABLE_MESSAGE = 'server unavailable — it may have shut down'

// The effort channel's six stops, quality-graded. The integer is the contract (see docs/reference.md "Effort channel"); these labels are a UI concern only and the executor never reads them.
const EFFORT_LABELS = ['fastest', 'quick', 'moderate', 'standard', 'thorough', 'highest quality']
const DEFAULT_EFFORT = 3

function effortLabel(effort) {
	if (typeof effort !== 'number' || !Number.isInteger(effort) || effort < 0 || effort > 5) return '—'
	return EFFORT_LABELS[effort] ?? '—'
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

function runFlash(_dispatch, _payload) {
	const panel = document.getElementById('questions-panel')
	if (panel === null) return
	// Web Animations API replays cleanly on every call, so a second question arriving mid-flash re-triggers it without class-list juggling.
	panel.animate(
		[
			{ background: '#fff1f0', borderColor: '#cf222e', boxShadow: '0 0 0 4px rgba(207, 34, 46, 0.35)' },
			{ background: '#ffffff', borderColor: '#e2e2e7', boxShadow: '0 0 0 0 rgba(207, 34, 46, 0)' },
		],
		{ duration: 1000, easing: 'ease-out' },
	)
}

function Flash() {
	return [runFlash, null]
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

// --- Actions ---------------------------------------------------------------
// Actions are pure state transitions; side effects are returned as effect tuples alongside the next state. The polling action returns a fresh now so relative timestamps refresh every tick even when the server returns identical data.

function Tick(state) {
	return [
		{ ...state, now: Date.now() },
		Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
		Fetch({ url: 'api/questions', ok: GotQuestions, fail: FetchFailed }),
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
	]
}

// The live InteractionModel the flow/sequence views render. The previous frame is kept so `deriveLifecycle` can diff entering/departing nodes; a 404 (the run directory exists but is not yet readable in the instant after submit) clears the model so the centerpiece shows its placeholder until the first readable frame lands.
function GotFlowModel(state, payload) {
	const status = payload.status
	const ok = payload.ok
	const body = payload.body
	if (status === 404) return { ...state, flowModel: null, previousFlowModel: null, serverAvailable: ok }
	if (!ok || body === null || typeof body !== 'object') return { ...state, serverAvailable: ok }
	if (!Array.isArray(body.participants) || !Array.isArray(body.operations) || typeof body.status !== 'string') {
		return { ...state, serverAvailable: true }
	}
	return { ...state, previousFlowModel: state.flowModel, flowModel: body, serverAvailable: true }
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
	return nextState
}

function GotSelectedRun(state, payload) {
	const status = payload.status
	const ok = payload.ok
	const body = payload.body
	if (status === 404) {
		// The run directory is created early in execution but may not be readable in the instant after submit; the per-run subscription keeps polling until the view appears.
		return { ...state, selectedRunStatus: 'unknown', serverAvailable: ok }
	}
	if (!ok || body === null) return state
	// The result modal fires once when a run the operator is watching completes (a transition out of a non-terminal status into success/error). Selecting an already-terminal historical run does not auto-open it — the flow view's CTA re-opens it on demand — so `previousStatus === null` (the first read of a selected run) is excluded along with the terminal statuses.
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
	return { ...state, selectedRunView: body, selectedRunStatus: body.status, resultModalOpen, resultShownForRun, serverAvailable: true }
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
	// Flash always on a genuinely new question; beep only when not muted. Falsy effects are ignored by hyperapp, so the conditionals inline cleanly.
	if (hasNew) {
		return [nextState, Flash(), state.muted ? null : PlayBeep()]
	}
	return nextState
}

function FetchFailed(state) {
	return { ...state, serverAvailable: false }
}

// The guild config is fetched exactly once on load and never polled, so this action runs a single time. The body is not retained in state; only the two derived values the flow/sequence views need are kept — the label resolver they localize through and the guild participant inventory the sequence view lays out columns from — so a swapped guild re-flavors the run view on the next load.
function GotConfig(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object') return state
	return {
		...state,
		labelResolver: createLabelResolver(body),
		guildParticipants: guildParticipantsFromConfig(body),
	}
}

// The saved effort position is fetched once on load so the slider starts where the operator last left it; later settings fetches (none today) would not override a position the operator has since moved.
function GotSettings(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (state.runEffort !== null) return { ...state, serverAvailable: ok }
	const effort = ok && body !== null && typeof body === 'object' && typeof body.effort === 'number' ? body.effort : null
	return { ...state, runEffort: effort !== null ? effort : DEFAULT_EFFORT, serverAvailable: ok }
}

function SettingsFetchFailed(state) {
	// The slider still needs a concrete value to render, so fall back to the default rather than sitting at null forever.
	if (state.runEffort !== null) return { ...state, serverAvailable: false }
	return { ...state, runEffort: DEFAULT_EFFORT, serverAvailable: false }
}

// oninput updates the readout live as the slider is dragged; the state change is pure and fires no request.
function ChangeRunEffort(state, event) {
	const value = Number(event.target.value)
	if (!Number.isInteger(value) || value < 0 || value > 5) return state
	return { ...state, runEffort: value }
}

// onchange fires once on slider release and persists the chosen position as the default for the next run, so the slider stays where the operator last left it across page reloads and restarts. One PUT per adjustment, not a stream of in-flight requests.
function SaveRunEffort(state, event) {
	const value = Number(event.target.value)
	if (!Number.isInteger(value) || value < 0 || value > 5) return state
	return [
		{ ...state, runEffort: value, savingEffort: true },
		Fetch({
			url: 'api/settings',
			init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effort: value }) },
			ok: EffortSaved,
			fail: EffortSaveFailed,
		}),
	]
}

function EffortSaved(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || typeof body.effort !== 'number') {
		return { ...state, savingEffort: false, serverAvailable: true }
	}
	return { ...state, savingEffort: false, runEffort: body.effort, serverAvailable: true }
}

function EffortSaveFailed(state) {
	return { ...state, savingEffort: false, serverAvailable: false }
}

function SelectRun(state, runId) {
	if (runId === state.selectedRunId) return state
	// The flow model, its previous-frame diff, and the per-run modal state belong to the previously-selected run; a switch clears them so the centerpiece shows the new run's first frame without a stale lifecycle diff or a leftover modal.
	return {
		...state,
		selectedRunId: runId,
		selectedRunView: null,
		selectedRunStatus: null,
		flowModel: null,
		previousFlowModel: null,
		questionModalOpen: false,
		resultModalOpen: false,
		resultShownForRun: null,
		tooltip: null,
	}
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
	if (state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null) return state
	const form = event.target
	const textarea = form.querySelector('textarea')
	if (textarea === null) return state
	const task = textarea.value.trim()
	if (task === '') return state
	textarea.value = ''
	return [
		state,
		Fetch({
			url: 'api/runs',
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildRunBody(task, state.runEffort)) },
			ok: GotCreatedRun,
			fail: FetchFailed,
		}),
	]
}

// effort is omitted when the slider has not yet initialized (settings still loading), so the server applies the project default rather than receiving a null.
function buildRunBody(task, runEffort) {
	if (typeof runEffort === 'number' && Number.isInteger(runEffort) && runEffort >= 0 && runEffort <= 5) {
		return { task, effort: runEffort }
	}
	return { task }
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
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildRunBody(task, state.runEffort)) },
			ok: GotCreatedRun,
			fail: FetchFailed,
		}),
	]
}

function GotCreatedRun(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || !('runId' in body)) return state
	const createdRunId = body.runId
	// Selecting the new run activates its per-run subscription; an immediate run-list fetch clears justSubmittedRunId as soon as the run appears. The per-run modal/flow state is reset for the same reason SelectRun resets it.
	return [
		{ ...state, justSubmittedRunId: createdRunId, selectedRunId: createdRunId, selectedRunView: null, selectedRunStatus: null, flowModel: null, previousFlowModel: null, questionModalOpen: false, resultModalOpen: false, resultShownForRun: null, tooltip: null, serverAvailable: true },
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

function PrimeAudio(state) {
	return [state, PrimeAudioFx()]
}

// --- Flow / Sequence view controls ----------------------------------------
// The centerpiece's view-mode (Flow vs Sequence) and label tier are pure view state; a swap re-renders the views through the same resolver and model without fetching. The modals are view-side state layered on the live model: the result modal opens on completion (GotSelectedRun) or the flow view's CTA, the question modal opens on a new pending question (GotQuestions) or the flow view's Question affordance.

function SetFlowViewMode(state, mode) {
	if (mode !== 'flow' && mode !== 'sequence') return state
	return { ...state, flowViewMode: mode }
}

function ChangeFlowTier(state, event) {
	const value = event.target.value
	if (!isLabelTier(value)) return state
	return { ...state, flowTier: value }
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
// FlowPanel renders the `Tooltip` card vnode anchored to that rect by `tooltipStyle`, and dismissal
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

// `mouseover` bubbles from every SVG child the pointer enters, so this fires on each element
// crossing. Three cases:
//  - over the card itself: keep it open and cancel any pending dismiss (the pointer entered the card
//    to select/copy).
//  - over a node/edge target: switch the card to it (canceling any pending dismiss), snapshotting its
//    rect so the card anchors to the node. Returning the same state when the target is unchanged lets
//    hyperapp bail without a re-render.
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
	return [{ ...state, tooltip: { kind: target.kind, id: target.id, rect: target.rect } }, CancelTooltipDismiss()]
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
// after a dismiss. Every other click falls through to the hover path so a click also opens the
// inspector at the clicked node, mirroring the dev harness. Clicking inside the card (to select text
// or press a copy affordance) falls through to the hover path's "over the card" branch, which keeps
// the card open.
function ClickRunView(state, event) {
	if (event.target instanceof Element && event.target.closest('.tooltip-card') !== null) {
		return HoverRunView(state, event)
	}
	const target = resolveTooltipTarget(event)
	if (target !== null && target.kind === 'operation' && state.flowModel !== null && isInFlightAskHuman(state.flowModel, target.id)) {
		// Open the modal and dismiss the inspector so the card does not linger over the modal.
		return [{ ...state, questionModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
	}
	return HoverRunView(state, event)
}

// --- View ------------------------------------------------------------------

function StatusLine(state) {
	const activeRunId = deriveActiveRunId(state.summaries)
	if (!state.serverAvailable) {
		return h('p', { id: 'status', class: 'status status-unavailable' }, SERVER_UNAVAILABLE_MESSAGE)
	}
	if (state.selectedRunId === null) {
		if (activeRunId !== null) {
			return h('p', { id: 'status', class: 'status status-clickable', onclick: [SelectRun, activeRunId] }, 'a run is in progress — click to view')
		}
		const message = state.summaries.length === 0 ? 'no runs yet — submit a task to start one' : 'no run selected'
		return h('p', { id: 'status', class: 'status' }, message)
	}
	return h('p', { id: 'status', class: 'status' }, statusLabel(state.selectedRunStatus))
}

function Header(state) {
	return h('header', {}, [
		h('h1', {}, 'Adaptive Orchestrator'),
		StatusLine(state),
		h('label', { class: 'mute-toggle' }, [
			h('input', { type: 'checkbox', checked: state.muted, onchange: ToggleMute }),
			'mute alert sound',
		]),
	])
}

function RunList(state) {
	if (state.summaries.length === 0) {
		return h('ul', { id: 'run-list' }, h('li', { class: 'empty' }, 'No runs yet.'))
	}
	// The re-run button shares the create form's disabled condition (a run is active or a submission is in flight) so the one-task-at-a-time contract holds identically for re-runs.
	const rerunDisabled = state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null
	const activeRunId = deriveActiveRunId(state.summaries)
	return h(
		'ul',
		{ id: 'run-list' },
		state.summaries.map((summary) => {
			// A run row is a vertical stack: a compact meta line (run id + status), the task on its own line rendered as the same sanitized Markdown the per-run view uses, and an actions line (effort badge + re-run). Splitting the task onto its own wrapped line is what makes a long task legible in the narrow sidebar instead of wrapping badly across a single cramped row.
			const effortBadge = summary.effort !== null && summary.effort !== undefined
				? h('span', { class: 'run-effort-badge', title: `effort ${summary.effort} — ${effortLabel(summary.effort)}` }, `effort ${summary.effort}`)
				: null
			return h('li', { key: summary.runId, class: { selected: summary.runId === state.selectedRunId, 'is-active': summary.runId === activeRunId }, onclick: [SelectRun, summary.runId] }, [
				h('div', { class: 'run-meta-row' }, [
					h('span', { class: 'run-id' }, summary.runId),
					h('span', { class: `run-status run-status-${summary.status ?? 'unknown'}` }, statusLabel(summary.status)),
				]),
				h('div', { class: 'run-task markdown' }, renderMarkdown(summary.task ?? '—')),
				h('div', { class: 'run-actions-row' }, [
					effortBadge,
					h('button', { type: 'button', class: 'rerun-button', 'data-task': summary.task ?? '', disabled: rerunDisabled || typeof summary.task !== 'string' || summary.task === '', onclick: RerunTask }, 're-run'),
				]),
			])
		}),
	)
}

// The task editor lives in the main column, not the sidebar: a user may draft a long Markdown task and needs horizontal room plus a tall multiline field. The effort slider sits beside the submit button so the two run-shaping controls are together.
function SubmitPanel(state) {
	const disabled = state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null
	const runEffort = typeof state.runEffort === 'number' ? state.runEffort : DEFAULT_EFFORT
	return h('section', { id: 'submit-panel', class: 'panel' }, [
		h('h2', {}, 'New run'),
		h('form', { class: { 'create-run-form': true, 'is-busy': disabled }, onsubmit: SubmitRun }, [
			h('textarea', { name: 'task', placeholder: disabled ? 'a run is already in progress' : 'describe a task (Markdown supported) and start a run', autocomplete: 'off', rows: '4', disabled, onkeydown: TaskTextareaKeydown }),
			h('div', { class: 'submit-controls' }, [
				h('div', { class: 'effort-control run-effort-control' }, [
					h('label', { class: 'effort-label', for: 'run-effort' }, 'Effort'),
					h('input', { id: 'run-effort', type: 'range', min: '0', max: '5', step: '1', value: String(runEffort), disabled, oninput: ChangeRunEffort, onchange: SaveRunEffort }),
					h('span', { class: 'effort-value' }, `${runEffort} — ${effortLabel(runEffort)}`),
					state.savingEffort === true ? h('span', { class: 'effort-note' }, 'saving…') : null,
				]),
				h('button', { type: 'submit', disabled }, disabled ? 'Run in progress…' : 'Start run'),
			]),
		]),
	])
}

function RunsPanel(state) {
	return h('section', { id: 'runs-panel', class: 'panel' }, [
		h('h2', {}, 'Runs'),
		RunList(state),
	])
}

function RunSummaryPanel(state) {
	const view = state.selectedRunView
	const runId = view ? view.runId : '—'
	const task = view ? view.task : null
	const status = view ? statusLabel(view.status) : '—'
	const effort = view && typeof view.effort === 'number' ? view.effort : null
	const startTime = view ? view.startTime ?? null : null
	const endTime = view ? view.endTime ?? null : null
	const resultValue = view && view.result && view.result.summary ? view.result.summary : null

	const entries = [
		h('dt', {}, 'Run'), h('dd', {}, runId),
		h('dt', {}, 'Task'), h('dd', { class: 'markdown' }, renderMarkdown(task)),
		h('dt', {}, 'Status'), h('dd', {}, status),
		h('dt', {}, 'Effort'), h('dd', {}, effort !== null ? `${effort} — ${effortLabel(effort)}` : '—'),
		h('dt', {}, 'Started'), h('dd', {}, h('time', { title: startTime ?? '' }, formatRelative(startTime, state.now))),
		h('dt', {}, 'Ended'), h('dd', {}, h('time', { title: endTime ?? '' }, formatRelative(endTime, state.now))),
		h('dt', {}, 'Result'), h('dd', { class: 'markdown' }, renderMarkdown(resultValue)),
	]

	const activity = view ? view.currentActivity : null
	const error = view ? view.error : null
	const artifacts = view && view.result ? view.result.artifacts : undefined
	const budgets = view ? view.budgets : null

	return h('section', { id: 'run-summary', class: 'panel' }, [
		h('h2', {}, 'Run'),
		h('p', { id: 'current-activity', class: 'current-activity' }, activity ? h('span', { class: 'current-activity-text' }, `now: ${activity.summary}`) : null),
		h('dl', { id: 'run-meta' }, entries),
		budgets ? BudgetsLine(budgets) : null,
		// The kind is a fixed machine label and stays a plain text node; the message is agent prose and renders as Markdown.
		h('div', { id: 'run-error', class: 'run-error' }, error ? h('div', { class: 'error-text' }, [h('strong', {}, `${error.kind}: `), ...renderMarkdown(error.message)]) : null),
		h('div', { id: 'run-artifacts', class: 'run-artifacts' }, artifacts && artifacts.length > 0 ? [h('div', { class: 'artifacts-heading' }, 'Artifacts'), h('ul', {}, artifacts.map((path, index) => h('li', { key: `${path}-${index}`, class: 'artifact' }, path)))] : null),
	])
}

// Prompt tokens are split into uncached and cached because they are billed at different rates: cachedPromptTokens is the subset of promptTokens served from the endpoint's prompt cache, so the uncached prompt bill is promptTokens - cachedPromptTokens.
function BudgetsLine(b) {
	const breakdown = b.tokenBreakdown
	const tokenSpans = [h('span', { class: 'budget-token-budget' }, `tokens ${formatTokens(b.tokensUsed)}`)]
	if (breakdown !== null && breakdown !== undefined) {
		const uncachedPrompt = breakdown.promptTokens - breakdown.cachedPromptTokens
		tokenSpans.push(h('span', { class: 'budget-token-detail' }, [
			h('span', { class: 'budget-token-prompt' }, `prompt ${formatTokens(uncachedPrompt)}`),
			breakdown.cachedPromptTokens > 0 ? h('span', { class: 'budget-token-cached' }, `cached ${formatTokens(breakdown.cachedPromptTokens)}`) : null,
			h('span', { class: 'budget-token-completion' }, `completion ${formatTokens(breakdown.completionTokens)}`),
		]))
	}
	return h('div', { class: 'budgets' }, [
		h('span', { class: 'budget-budget' }, `elapsed ${formatElapsed(b.elapsedSeconds)}`),
		h('span', { class: 'budget-budget' }, `tool calls ${formatNumber(b.toolCalls)}`),
		...tokenSpans,
	])
}

function FlowPanel(state) {
	const labels = state.labelResolver
	const model = state.flowModel
	// Before the guild config or the first readable flow frame lands, the centerpiece shows a placeholder rather than a half-built graph; both arrive within the first poll, so the placeholder is transient.
	if (labels === null || model === null) {
		const message = state.selectedRunId === null
			? 'Select a run to see its flow.'
			: labels === null
				? 'Loading run view…'
				: 'Waiting for run activity…'
		return h('section', { id: 'flow-panel', class: 'panel' }, [
			h('h2', {}, 'Run view'),
			h('div', { class: 'pb-flow flow-stage' }, h('p', { class: 'flow-empty' }, message)),
		])
	}

	const tier = state.flowTier
	const lifecycle = state.previousFlowModel !== null ? deriveLifecycle(state.previousFlowModel, model) : undefined
	const cta = { onclick: OpenResultModal }
	const question = { onclick: OpenQuestionModal }
	// The flow view and sequence view are independent leaves over the same model; the view toggle swaps which renders without a fetch. The sequence view takes the guild's static participant set so every role column appears from the first frame.
	const svg = state.flowViewMode === 'sequence'
		? renderSequenceView(h, model, labels, tier, state.guildParticipants)
		: renderFlowView(h, model, labels, tier, lifecycle, cta, question, flowColumnTracker)

	const cost = deriveCostStrip(model)
	const nowCaption = deriveNowCaption(model, labels, tier)

	return h('section', { id: 'flow-panel', class: 'panel' }, [
		h('h2', {}, 'Run view'),
		h('div', { class: 'flow-controls' }, [
			h('div', { class: 'pb-view-toggle', role: 'group', 'aria-label': 'run view' }, [
				h('button', { type: 'button', class: state.flowViewMode === 'flow' ? 'is-active' : '', onclick: [SetFlowViewMode, 'flow'] }, 'Flow'),
				h('button', { type: 'button', class: state.flowViewMode === 'sequence' ? 'is-active' : '', onclick: [SetFlowViewMode, 'sequence'] }, 'Sequence'),
			]),
			h('label', { class: 'flow-tier-control' }, [
				h('span', {}, 'Label tier'),
				h('select', { value: tier, onchange: ChangeFlowTier }, TIER_VALUES.map((value) => h('option', { value, selected: value === tier }, value))),
			]),
		]),
		h('div', { class: 'pb-cost-strip' }, [
			h('span', { class: 'pb-cost-item' }, `elapsed ${formatElapsed(cost.elapsedSeconds)}`),
			h('span', { class: 'pb-cost-sep' }, '·'),
			h('span', { class: 'pb-cost-item' }, `${formatTokens(cost.tokens)} tokens`),
		]),
		// `.pb-flow` is the positioning context for the per-run-view modals (the question and result overlays are absolute inset 0 within it), so the modals cover the run view rather than the whole page. It is also the hover stage for the inspector: `mouseover`/`mouseleave`/`click` bubble here from every SVG child, so the inspector is wired once for both the flow and sequence views.
		h('div', { class: 'pb-flow flow-stage', onmouseover: HoverRunView, onmouseleave: LeaveRunView, onclick: ClickRunView }, [
			svg,
			QuestionModalForRun(state),
			ResultModalForRun(state),
			TooltipCardForRun(state),
		]),
		h('p', { class: 'pb-now-caption' }, nowCaption),
	])
}

// The inspector card over the run view. The descriptor in state is resolved against the live model
// and label resolver at render time, so the card reads the same model the SVG renders and never
// re-fetches. A descriptor whose id no longer resolves (an operation from a frame the poll has since
// replaced, or a participant/role the model no longer carries) yields an empty title and is treated as
// "no card" so a stale hover state dismisses rather than rendering a heading-less card. The card is
// `position: fixed` (styles.css), anchored to the snapshot rect taken at hover time, so it sits at a
// fixed position relative to the node (not the pointer) and stays put while the pointer is over it;
// its only prose-carrying section is the operation `details` markdown, routed through the sanitized
// pipeline by `formatTooltipContent`.
function TooltipCardForRun(state) {
	const tooltip = state.tooltip
	if (tooltip === null) return null
	const model = state.flowModel
	const labels = state.labelResolver
	if (model === null || labels === null) return null
	const descriptor = deriveTooltipDescriptor(model, labels, state.flowTier, tooltip)
	if (descriptor.title === '') return null
	return Tooltip(h, { title: descriptor.title, sections: descriptor.sections, renderMarkdown, style: tooltipStyle(tooltip.rect) })
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

// The terminal result the modal renders, derived from the live run view the per-run poll already fetches (the flow endpoint carries no result/error fields). The modal opens on a watched run's completion (GotSelectedRun) and re-opens via the flow view's CTA; the descriptor is undefined for a non-terminal run so the modal renders nothing then.
function ResultModalForRun(state) {
	if (!state.resultModalOpen) return null
	const view = state.selectedRunView
	if (view === null) return null
	const descriptor = deriveTerminalResult(view)
	if (descriptor === undefined) return null
	return ResultModal(h, {
		descriptor,
		runLabel: typeof view.runId === 'string' ? view.runId : null,
		renderMarkdown,
		onCopyRaw: copyRawToClipboard,
		onClose: CloseResultModal,
	})
}

function Main(state) {
	return h('main', {}, [
		SubmitPanel(state),
		RunsPanel(state),
		FlowPanel(state),
		RunSummaryPanel(state),
	])
}

function view(state) {
	return h('div', {}, [Header(state), Main(state)])
}

// --- App -------------------------------------------------------------------
// The subscriptions array is fixed-size with stable positions: [0] always polls the run list + questions every second; [1] polls the selected run's run view and flow model every second but only while one is selected and non-terminal (deactivating on terminal status replaces the manual clearInterval of the prior client); [2] primes the AudioContext on the first user interaction.

app({
	init: [
		{
			summaries: [],
			selectedRunId: null,
			selectedRunView: null,
			selectedRunStatus: null,
			pendingQuestions: [],
			serverAvailable: true,
			justSubmittedRunId: null,
			muted: false,
			shownQuestionIds: {},
			firstQuestionsPoll: true,
			pendingAnswerId: null,
			// null until the saved effort loads; the slider initializes from the persisted position on first load.
			runEffort: null,
			savingEffort: false,
			// The live InteractionModel the centerpiece renders, plus its previous frame for `deriveLifecycle`'s enter/depart diff. Both null until the first readable flow frame lands.
			flowModel: null,
			previousFlowModel: null,
			// The label resolver and guild participant inventory are built once from `/api/config` (GotConfig); null/empty until that single load completes.
			labelResolver: null,
			guildParticipants: [],
			flowTier: DEFAULT_FLOW_TIER,
			flowViewMode: 'flow',
		// Per-run-view modal state. The question modal opens on a new pending question; the result modal opens on a watched run's completion. `resultShownForRun` dedups the auto-open across the polls that follow a completion.
		questionModalOpen: false,
		resultModalOpen: false,
		resultShownForRun: null,
		// The inspector descriptor over the run view: null when nothing is hovered. Cleared on
		// `mouseleave` of the stage and on run switch; a stale id self-dismisses at render time.
		tooltip: null,
		now: Date.now(),
	},
	// The guild config and the saved effort position are each loaded once on load and never polled, so their fetches are init effects rather than subscriptions.
	Fetch({ url: 'api/config', ok: GotConfig, fail: FetchFailed }),
	Fetch({ url: 'api/settings', ok: GotSettings, fail: SettingsFetchFailed }),
	],
	view,
	subscriptions: (state) => [
		onEvery(Tick, POLL_INTERVAL_MS),
		typeof state.selectedRunId === 'string' && state.selectedRunId !== '' && !isTerminalStatus(state.selectedRunStatus) && onEvery(PollSelectedRun, POLL_INTERVAL_MS),
		onFirstInteraction(PrimeAudio),
	],
	node: document.getElementById('app'),
})
