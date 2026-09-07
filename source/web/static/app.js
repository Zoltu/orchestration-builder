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

	return { ...state, selectedRunView: body, selectedRunStatus: body.status, resultModalOpen, resultShownForRun, interruptAnswerCard, shownInterruptAnswerKeys, serverAvailable: true }
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
		return [nextState, state.muted ? null : PlayBeep()]
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

// The saved effort level is fetched once on load so the selector starts where the operator last left it; later settings fetches (none today) would not override a level the operator has since picked.
function GotSettings(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (state.runEffort !== null) return { ...state, serverAvailable: ok }
	const effort = ok && body !== null && typeof body === 'object' && isEffort(body.effort) ? body.effort : null
	return { ...state, runEffort: effort !== null ? effort : DEFAULT_EFFORT, serverAvailable: ok }
}

function SettingsFetchFailed(state) {
	// The selector still needs a concrete value to render, so fall back to the default rather than sitting at null forever.
	if (state.runEffort !== null) return { ...state, serverAvailable: false }
	return { ...state, runEffort: DEFAULT_EFFORT, serverAvailable: false }
}

// A radio pick is one deliberate gesture (unlike a slider drag), so a single change handler both updates state and persists the level as the default for the next run — the selector stays where the operator last left it across page reloads and restarts, with one PUT per pick.
function SaveRunEffort(state, event) {
	const value = event.target.value
	if (!isEffort(value)) return state
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
	if (!ok || body === null || typeof body !== 'object' || !isEffort(body.effort)) {
		return { ...state, savingEffort: false, serverAvailable: true }
	}
	return { ...state, savingEffort: false, runEffort: body.effort, serverAvailable: true }
}

function EffortSaveFailed(state) {
	return { ...state, savingEffort: false, serverAvailable: false }
}

function SelectRun(state, runId) {
	if (runId === state.selectedRunId) return { ...state, screen: 'watch' }
	// The flow model, its previous-frame diff, and the per-run modal state belong to the previously-selected run; a switch clears them so the centerpiece shows the new run's first frame without a stale lifecycle diff or a leftover modal. Selecting a run always lands on the watch screen (history rows and the in-progress pill both go through here).
	return {
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

// effort is omitted when the selector has not yet initialized (settings still loading), so the server applies the project default rather than receiving a null.
function buildRunBody(task, runEffort) {
	if (isEffort(runEffort)) return { task, effort: runEffort }
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
		{ ...state, screen: 'watch', justSubmittedRunId: createdRunId, selectedRunId: createdRunId, selectedRunView: null, selectedRunStatus: null, flowModel: null, previousFlowModel: null, questionModalOpen: false, resultModalOpen: false, resultShownForRun: null, tooltip: null, planExpanded: false, serverAvailable: true },
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
	return { ...state, flowViewMode: mode }
}

function ChangeFlowTier(state, event) {
	const value = event.target.value
	if (!isLabelTier(value)) return state
	return { ...state, flowTier: value }
}

// --- Screen navigation ------------------------------------------------------
// The page is a single-screen console: one of three screens (watch / history / compose) fills the viewport below the top bar. The screen is stored view state; nothing here fetches.

function SetScreen(state, screen) {
	if (screen !== 'watch' && screen !== 'history' && screen !== 'compose') return state
	return { ...state, screen }
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

// The primary label for a run where space is tight: the task's first line, capped at a word boundary so a long first line cannot stretch the top bar. History rows and the top bar both use it; the full task is one click away in the row's expanded details.
function firstLineOfTask(task) {
	const firstLine = task.split('\n', 1)[0].trim()
	if (firstLine.length <= 100) return firstLine
	const capped = firstLine.slice(0, 100)
	const lastSpace = capped.lastIndexOf(' ')
	return `${lastSpace > 60 ? capped.slice(0, lastSpace) : capped}…`
}

// The primary label for a run: the LLM-generated one-line summary when the summarizer has produced one, otherwise the task's first line, otherwise the run id. History rows and the top bar share it.
function runPrimaryLabel(summary) {
	if (typeof summary.summary === 'string' && summary.summary !== '') return summary.summary
	if (typeof summary.task === 'string' && summary.task !== '') return firstLineOfTask(summary.task)
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

function TopBar(state) {
	const activeRunId = deriveActiveRunId(state.summaries)
	const composeDisabled = state.justSubmittedRunId !== null || activeRunId !== null
	return h('header', { class: 'topbar' }, [
		h('span', { class: 'topbar-wordmark' }, 'Adaptive Orchestrator'),
		...StatusPills(state),
		ViewedRunLabel(state),
		h('nav', { class: 'topbar-nav' }, [
			h('button', { type: 'button', class: { 'nav-button': true, 'is-active': state.screen === 'compose' }, disabled: composeDisabled, title: composeDisabled ? 'A run is in progress — a new task can start when it finishes' : 'Start a new task', onclick: [SetScreen, 'compose'] }, 'New task'),
			h('button', { type: 'button', class: { 'nav-button': true, 'is-active': state.screen === 'history' }, title: 'Browse past runs', onclick: [SetScreen, 'history'] }, `History (${state.summaries.length})`),
			h('label', { class: 'mute-toggle', title: 'Mute the alert sound for incoming questions' }, [
				h('input', { type: 'checkbox', checked: state.muted, onchange: ToggleMute }),
				'mute',
			]),
		]),
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

// The compose screen is the hero when the service is idle — drafting a task is the primary activity when nothing is running, so the editor gets the whole stage. The submit path and the one-task-at-a-time busy contract are unchanged.
function ComposeScreen(state) {
	const disabled = state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null
	const runEffort = isEffort(state.runEffort) ? state.runEffort : DEFAULT_EFFORT
	return h('section', { id: 'compose-screen' }, [
		h('div', { class: 'compose-hero' }, [
			h('h1', { class: 'compose-heading' }, state.summaries.length === 0 ? 'What should the orchestrator do?' : 'New task'),
			h('p', { class: 'compose-sub' }, 'Describe the task in plain language — Markdown works too. The orchestrator runs one task at a time.'),
			h('form', { class: { 'create-run-form': true, 'is-busy': disabled }, onsubmit: SubmitRun }, [
				h('textarea', { name: 'task', placeholder: disabled ? 'a run is already in progress — a new task can start when it finishes' : 'describe a task (Markdown supported) and start a run', autocomplete: 'off', disabled, onkeydown: TaskTextareaKeydown }),
				EffortLevelSelector(runEffort, disabled, state.savingEffort === true),
				h('div', { class: 'submit-controls' }, [
					h('button', { type: 'submit', disabled }, disabled ? 'Run in progress…' : 'Start run'),
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
		h('label', { class: 'flow-tier-control' }, [
			h('span', {}, 'Label tier'),
			h('select', { value: state.flowTier, onchange: ChangeFlowTier }, TIER_VALUES.map((value) => h('option', { value, selected: value === state.flowTier }, value))),
		]),
		model !== null ? CostStrip(model) : null,
		InterruptButton(state),
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
			StageControls(state, null),
			h('div', { class: 'pb-flow flow-stage' }, h('p', { class: 'flow-empty' }, message)),
		])
	}

	const tier = state.flowTier
	const lifecycle = state.previousFlowModel !== null ? deriveLifecycle(state.previousFlowModel, model) : undefined
	const cta = { onclick: OpenResultModal }
	const question = { onclick: OpenQuestionModal }
	// The sequence view takes the guild's static participant set so every role column appears from the first frame.
	const stageContent = state.flowViewMode === 'sequence'
		? h('div', { class: 'pb-sequence-scroll' }, [renderSequenceView(h, model, labels, tier, state.guildParticipants)])
		: renderFlowView(h, model, labels, tier, lifecycle, cta, question, flowColumnTracker)

	const nowCaption = deriveNowCaption(model, labels, tier)

	return h('section', { id: 'watch-screen' }, [
		StageControls(state, model),
		// `.pb-flow` is the positioning context for the per-run-view modals (the question, result, and interrupt overlays are absolute inset 0 within it), so the modals cover the run view rather than the whole page. It is also the hover stage for the inspector: `mouseover`/`mouseleave`/`click` bubble here from every SVG child, so the inspector is wired once for both the flow and sequence views.
		h('div', { class: 'pb-flow flow-stage', onmouseover: HoverRunView, onmouseleave: LeaveRunView, onclick: ClickRunView }, [
			stageContent,
			QuestionModalForRun(state),
			ResultModalForRun(state),
			InterruptModalForRun(state),
			InterruptAnswerCardForRun(state),
			TooltipCardForRun(state),
		]),
		PlanSection(state),
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
	if (state.summaries.length === 0 && state.selectedRunId === null) return h('main', {}, [ComposeScreen(state)])
	return h('main', {}, [WatchScreen(state)])
}

function view(state) {
	return h('div', { class: 'app-shell' }, [TopBar(state), Main(state)])
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
			// null until the saved effort loads; the selector initializes from the persisted level on first load.
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
			// The visible screen: 'watch' (the flow/sequence stage), 'history' (the run browser), or 'compose' (the new-task hero). A zero-state service shows compose regardless (see Main).
			screen: 'watch',
			// Per-history-row expansion, keyed by run id, so the full task/result of several runs can be open at once.
			historyExpanded: {},
			// Per-run-view modal state. The question modal opens on a new pending question; the result modal opens on a watched run's completion. `resultShownForRun` dedups the auto-open across the polls that follow a completion. The interrupt modal opens only from the stage controls.
			questionModalOpen: false,
			resultModalOpen: false,
			resultShownForRun: null,
			interruptModalOpen: false,
			// The plan disclosure under the stage: collapsed by default, reset with the other per-run view state on a run switch.
			planExpanded: false,
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
	// The guild config and the saved effort level are each loaded once on load and never polled, so their fetches are init effects rather than subscriptions.
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
