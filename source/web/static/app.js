// Hyperapp client for the long-running service.
// The whole UI is one reactive view of a single state object; polling runs as subscriptions and every side effect (fetch, POST, audio, flash) runs as an effect. Untrusted run content (task text, log payloads, summaries, question text, answers) is interpolated only as children of h() or text-node arguments, which hyperapp places into text nodes and properties — never into markup — so it cannot break out of the DOM. There is no raw-HTML/unsafe API in hyperapp.
import { h, app } from './vendor/hyperapp.js'

const POLL_INTERVAL_MS = 1000
const TERMINAL_STATUSES = new Set(['success', 'error', 'needs_clarification'])
const LOG_PAGE_SIZE = 200
// Large enough to mean "the whole log" for the export fetch; the server caps a single page at this limit.
const LOG_EXPORT_LIMIT = 1000000
const STATUS_LABELS = {
	unknown: 'in progress',
	running: 'running',
	success: 'success',
	error: 'error',
	needs_clarification: 'needs clarification',
}
const SERVER_UNAVAILABLE_MESSAGE = 'server unavailable — it may have shut down'

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

function isTerminalStatus(status) {
	return TERMINAL_STATUSES.has(status)
}

// The active run is the first non-terminal summary; derived in the view rather than stored, so it can never drift from the run list.
function deriveActiveRunId(summaries) {
	const active = summaries.find((summary) => !isTerminalStatus(summary.status))
	return active === undefined ? null : active.runId
}

function logRowKey(entry) {
	return `${entry.timestamp}|${entry.type}|${entry.summary}`
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
	return [
		state,
		Fetch({ url: `api/runs/${encodeURIComponent(state.selectedRunId)}`, ok: GotSelectedRun, fail: FetchFailed }),
	]
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
		nextState.expandedLogRows = {}
		nextState.logPage = null
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
	// In tail mode the log panel mirrors the run view's recent log; once the operator pages back, the panel holds its loaded range and the tail stops auto-refreshing so a frozen view is not silently jumped forward.
	const logPage = state.logPage !== null && state.logPage.offset !== null
		? state.logPage
		: { offset: null, total: null, entries: Array.isArray(body.recentLog) ? body.recentLog : [] }
	return { ...state, selectedRunView: body, selectedRunStatus: body.status, logPage, serverAvailable: true }
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

// The config panel is fetched exactly once on load and never polled, so this action runs a single time; later state transitions preserve the config via the spread.
function GotConfig(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object') return state
	return { ...state, config: body }
}

function SelectRun(state, runId) {
	if (runId === state.selectedRunId) return state
	return { ...state, selectedRunId: runId, selectedRunView: null, selectedRunStatus: null, expandedLogRows: {}, logPage: null }
}

function ToggleMute(state, event) {
	return { ...state, muted: event.target.checked }
}

function ToggleLogRow(state, key) {
	const expandedLogRows = { ...state.expandedLogRows }
	if (expandedLogRows[key]) delete expandedLogRows[key]
	else expandedLogRows[key] = true
	return { ...state, expandedLogRows }
}

// --- Log pagination --------------------------------------------------------
// The log panel shows the most-recent page (drawn from the run view's recentLog) and pages backward on demand.
// `logPage.offset` is the oldest index currently loaded; it stays null in tail mode (only the recent page is shown) until the operator pages back, at which point the panel freezes the tail and prepends older events.
// A probe fetch on the first "Load earlier" learns the true total so the backward page is contiguous with the tail (no overlap, no gap).

function LoadEarlierLog(state) {
	if (typeof state.selectedRunId !== 'string' || state.selectedRunId === '' || state.logPage === null) return state
	const offset = state.logPage.offset
	if (offset !== null) {
		if (offset <= 0) return state
		return fetchEarlierPage(state, offset)
	}
	// Tail mode: probe the total first so the first backward page lines up exactly with the tail's oldest index.
	return [
		state,
		Fetch({
			url: `api/runs/${encodeURIComponent(state.selectedRunId)}/log?offset=0&limit=1`,
			ok: GotLogTotal,
			fail: FetchFailed,
		}),
	]
}

function GotLogTotal(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || state.logPage === null) return state
	const total = typeof body.total === 'number' ? body.total : 0
	const tailLength = state.logPage.entries.length
	const realOffset = Math.max(0, total - tailLength)
	if (realOffset <= 0) {
		// The tail already holds the whole log; nothing earlier to load.
		return { ...state, logPage: { ...state.logPage, offset: 0, total } }
	}
	return fetchEarlierPage({ ...state, logPage: { ...state.logPage, offset: realOffset, total } }, realOffset)
}

function fetchEarlierPage(state, offset) {
	const nextOffset = Math.max(0, offset - LOG_PAGE_SIZE)
	// limit is exactly the span up to the current oldest index, so the fetched page is contiguous with what is already loaded.
	const limit = offset - nextOffset
	if (limit <= 0) return state
	return [
		state,
		Fetch({
			url: `api/runs/${encodeURIComponent(state.selectedRunId)}/log?offset=${nextOffset}&limit=${limit}`,
			ok: GotEarlierLogPage,
			fail: FetchFailed,
		}),
	]
}

function GotEarlierLogPage(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || !Array.isArray(body.events) || state.logPage === null) return state
	const offset = typeof body.offset === 'number' ? body.offset : 0
	const total = typeof body.total === 'number' ? body.total : state.logPage.total
	const older = body.events
	const entries = [...older, ...state.logPage.entries]
	return { ...state, logPage: { ...state.logPage, entries, offset, total: total ?? null }, serverAvailable: true }
}

function ExportLog(state) {
	if (typeof state.selectedRunId !== 'string' || state.selectedRunId === '') return state
	const runId = state.selectedRunId
	return [
		state,
		ExportLogFx({ url: `api/runs/${encodeURIComponent(runId)}/log?format=text&offset=0&limit=${LOG_EXPORT_LIMIT}` }),
	]
}

// A top-level navigation to the text endpoint is turned by the browser into a file download because the server sets `Content-Disposition: attachment; filename="<runId>.log"`.
// This is preferred over fetching the body and synthesizing a `blob:` anchor click: that pattern trips content blockers (uBlock Origin filters programmatic `blob:`/`data:` downloads that lack a direct user-gesture link), whereas a plain navigated URL is indistinguishable from any other link the operator follows and is not filtered.
function runExportLog(_dispatch, payload) {
	window.location.href = payload.url
}

function ExportLogFx(payload) {
	return [runExportLog, payload]
}

function SubmitRun(state, event) {
	event.preventDefault()
	if (state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null) return state
	const input = event.target.querySelector('input')
	if (input === null) return state
	const task = input.value.trim()
	if (task === '') return state
	input.value = ''
	return [
		state,
		Fetch({
			url: 'api/runs',
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) },
			ok: GotCreatedRun,
			fail: FetchFailed,
		}),
	]
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
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) },
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
	// Selecting the new run activates its per-run subscription; an immediate run-list fetch clears justSubmittedRunId as soon as the run appears.
	return [
		{ ...state, justSubmittedRunId: createdRunId, selectedRunId: createdRunId, selectedRunView: null, selectedRunStatus: null, expandedLogRows: {}, logPage: null, serverAvailable: true },
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
	// Refresh the pending list immediately so the answered question disappears without waiting for the next tick.
	return [{ ...state, pendingAnswerId: null, serverAvailable: true }, Fetch({ url: 'api/questions', ok: GotQuestions, fail: FetchFailed })]
}

function AnswerFailed(state) {
	return { ...state, pendingAnswerId: null, serverAvailable: false }
}

function PrimeAudio(state) {
	return [state, PrimeAudioFx()]
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
	return h(
		'ul',
		{ id: 'run-list' },
		state.summaries.map((summary) =>
			h('li', { key: summary.runId, class: { selected: summary.runId === state.selectedRunId }, onclick: [SelectRun, summary.runId] }, [
				h('span', { class: 'run-id' }, summary.runId),
				h('span', { class: `run-status run-status-${summary.status ?? 'unknown'}` }, statusLabel(summary.status)),
				h('span', { class: 'run-task' }, summary.task ?? '—'),
				h('button', { type: 'button', class: 'rerun-button', 'data-task': summary.task ?? '', disabled: rerunDisabled || typeof summary.task !== 'string' || summary.task === '', onclick: RerunTask }, 're-run'),
			]),
		),
	)
}

function RunsPanel(state) {
	const disabled = state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null
	return h('section', { id: 'runs-panel', class: 'panel' }, [
		h('h2', {}, 'Runs'),
		h('form', { class: 'create-run-form', onsubmit: SubmitRun }, [
			h('input', { type: 'text', placeholder: disabled ? 'a run is already in progress' : 'describe a task and start a run', autocomplete: 'off' }),
			h('button', { type: 'submit', disabled }, disabled ? 'Run in progress…' : 'Start run'),
		]),
		RunList(state),
	])
}

function RunSummaryPanel(state) {
	const view = state.selectedRunView
	const runId = view ? view.runId : '—'
	const task = view ? view.task ?? '—' : '—'
	const status = view ? statusLabel(view.status) : '—'
	const startTime = view ? view.startTime ?? null : null
	const endTime = view ? view.endTime ?? null : null
	const resultValue = view && view.result && view.result.summary ? view.result.summary : '—'

	const entries = [
		h('dt', {}, 'Run'), h('dd', {}, runId),
		h('dt', {}, 'Task'), h('dd', { class: 'preformatted' }, task),
		h('dt', {}, 'Status'), h('dd', {}, status),
		h('dt', {}, 'Started'), h('dd', {}, h('time', { title: startTime ?? '' }, formatRelative(startTime, state.now))),
		h('dt', {}, 'Ended'), h('dd', {}, h('time', { title: endTime ?? '' }, formatRelative(endTime, state.now))),
		h('dt', {}, 'Result'), h('dd', { class: 'preformatted' }, resultValue),
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
		h('div', { id: 'run-error', class: 'run-error' }, error ? h('div', { class: 'error-text' }, `${error.kind}: ${error.message}`) : null),
		h('div', { id: 'run-artifacts', class: 'run-artifacts' }, artifacts && artifacts.length > 0 ? [h('div', { class: 'artifacts-heading' }, 'Artifacts'), h('ul', {}, artifacts.map((path) => h('li', { key: path, class: 'artifact' }, path)))] : null),
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

function RolesPanel(state) {
	const view = state.selectedRunView
	const roles = view ? view.roles : []
	const activeRole = view && !isTerminalStatus(view.status) && view.currentActivity ? view.currentActivity.role : null
	const children = roles.length === 0
		? [h('li', {}, 'No role activity yet.')]
		: roles.map((role) => {
				const isActive = activeRole !== null && role.role === activeRole
				return h('li', { key: role.role, class: { 'role-active': isActive } }, [
					isActive ? h('span', { class: 'role-pulse' }) : null,
					h('strong', {}, role.role),
					h('span', {}, ` — ${formatNumber(role.eventCount)} events · ${formatNumber(role.llmCalls)} LLM calls · ${formatNumber(role.toolCalls)} tool calls`),
					h('div', { class: 'role-times' }, [
						h('span', { class: 'role-time' }, ['first seen ', h('time', { title: role.firstSeen ?? '' }, formatRelative(role.firstSeen, state.now))]),
						h('span', { class: 'role-time' }, ['last seen ', h('time', { title: role.lastSeen ?? '' }, formatRelative(role.lastSeen, state.now))]),
					]),
					role.recentTools.length > 0 ? h('div', { class: 'role-tools' }, `recent tools: ${role.recentTools.join(', ')}`) : null,
					role.lastPromptTokens !== null && role.lastPromptTokens !== undefined ? h('div', { class: 'role-context' }, `last context: ${formatTokens(role.lastPromptTokens)} tokens`) : null,
				])
			})
	return h('section', { id: 'roles-panel', class: 'panel' }, [h('h2', {}, 'Role activity'), h('ul', { id: 'roles' }, children)])
}

function canLoadEarlier(logPage) {
	if (logPage === null) return false
	// In extended mode the oldest loaded index must be above 0; in tail mode the recent page must be full (a full page means there may be older events beyond it).
	if (logPage.offset !== null) return logPage.offset > 0
	return logPage.entries.length >= LOG_PAGE_SIZE
}

function LogPanel(state) {
	const logPage = state.logPage
	const entries = logPage !== null ? logPage.entries : []
	const showLoadEarlier = canLoadEarlier(logPage)
	let children
	if (entries.length === 0) {
		children = [h('li', { class: 'log-empty' }, 'No events logged yet.')]
	} else {
		// Newest first so the latest activity is visible without scrolling.
		// The render key is the positional index, not the event content: many log events share identical (type, role, tool) and the millisecond timestamps can collide within a rapid burst, so a content-derived key is not unique and the vendored hyperapp's keyed reconciliation then misplaces DOM nodes (insertBefore on a colliding key), which surfaces as out-of-order timestamps in the panel. A positional key is unique per render and makes the diff patch in place, so the DOM order always matches the array order.
		children = []
		let renderIndex = 0
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]
			const toggleKey = logRowKey(entry)
			const expanded = Boolean(state.expandedLogRows[toggleKey])
			children.push(
				h('li', { key: String(renderIndex), class: 'log-row' }, [
					h('time', { class: 'log-timestamp', title: entry.timestamp ?? '' }, formatRelative(entry.timestamp, state.now)),
					h('span', { class: 'log-type' }, entry.type),
					h('span', { class: 'log-summary' }, entry.summary),
					h('button', { type: 'button', class: 'log-toggle', onclick: [ToggleLogRow, toggleKey] }, expanded ? 'hide' : 'raw'),
					h('pre', { class: 'log-detail', hidden: !expanded }, JSON.stringify(entry.payload, null, 2)),
				]),
			)
			renderIndex++
		}
	}
	// Export sits at the top (a persistent action on the whole log); "Load earlier" sits at the bottom (it extends the list downward). Keeping them separate avoids a crowded controls row and matches their scope.
	const exportButton = state.selectedRunId !== null ? h('button', { type: 'button', class: 'log-export', onclick: [ExportLog, null] }, 'Export') : null
	const loadEarlierButton = showLoadEarlier ? h('button', { type: 'button', class: 'log-load-earlier', onclick: [LoadEarlierLog, null] }, 'Load earlier') : null
	return h('section', { id: 'log-panel', class: 'panel' }, [h('h2', {}, 'Log'), exportButton, h('ol', { id: 'log' }, children), loadEarlierButton])
}

function QuestionsPanel(state) {
	const view = state.selectedRunView
	const history = view ? view.questionHistory : []
	const historyChildren = history.length === 0
		? null
		: [
				h('li', { class: 'question-history-heading' }, 'Past questions'),
				...history.map((entry) =>
					h('li', { key: entry.id ?? entry.askedAt, class: 'question-history-entry' }, [
						h('div', { class: 'question-history-question' }, entry.question),
						entry.context !== undefined ? h('div', { class: 'question-context' }, entry.context) : null,
						entry.answer !== undefined
							? h('div', { class: 'question-history-answer' }, entry.answer)
							: h('div', { class: 'question-history-unanswered' }, 'unanswered'),
					]),
				),
			]

	const questions = state.pendingQuestions
	const pendingChildren = questions.length === 0
		? [h('li', {}, 'No pending questions.')]
		: questions.map((question) =>
				h('li', { key: question.id }, [
					h('div', {}, question.question),
					question.context !== undefined ? h('div', { class: 'question-context' }, question.context) : null,
					h('form', { class: 'question-form', onsubmit: SubmitAnswer(question.id) }, [
						h('input', { type: 'text', placeholder: 'your answer', disabled: state.pendingAnswerId === question.id }),
						h('button', { type: 'submit', disabled: state.pendingAnswerId === question.id }, 'Answer'),
					]),
				]),
			)

	return h('section', { id: 'questions-panel', class: 'panel' }, [
		h('h2', {}, 'Questions'),
		h('ul', { class: 'question-history' }, historyChildren),
		h('ul', { class: 'pending-questions' }, pendingChildren),
	])
}

function ConfigPanel(state) {
	const config = state.config
	if (config === null) {
		return h('section', { id: 'config-panel', class: 'panel' }, [h('h2', {}, 'Configuration'), h('p', { class: 'config-empty' }, 'Loading configuration…')])
	}
	const model = config.model
	const executor = config.executor
	const roles = config.roles
	const roleNames = Object.keys(roles)
	const budgetEntries = [
		`agent depth ${formatNumber(executor.maxAgentDepth)}`,
		`tool calls/role ${formatNumber(executor.maxToolCallsPerRole)}`,
		`tokens/role ${formatNumber(executor.maxTokensPerRole)}`,
		`run time ${formatNumber(executor.maxRunTimeSeconds)}s`,
		`tool timeout ${formatNumber(executor.defaultToolTimeoutSeconds)}s`,
		`repeated calls ${formatNumber(executor.maxRepeatedToolCalls)}`,
		`compaction attempts ${formatNumber(executor.maxCompactionAttempts)}`,
	]
	return h('section', { id: 'config-panel', class: 'panel' }, [
		h('h2', {}, 'Configuration'),
		h('dl', { class: 'config-meta' }, [
			h('dt', {}, 'Model'), h('dd', {}, model.name),
			h('dt', {}, 'Context window'), h('dd', {}, formatNumber(model.contextWindow)),
			h('dt', {}, 'Entry role'), h('dd', {}, config.entryRole),
		]),
		h('div', { class: 'config-budgets' }, budgetEntries.map((entry) => h('span', { class: 'config-budget' }, entry))),
		h('ul', { class: 'config-roles' }, roleNames.map((name) => {
			const tools = roles[name].tools
			return h('li', { key: name, class: 'config-role' }, [
				h('strong', {}, name),
				name === config.entryRole ? h('span', { class: 'config-entry-marker' }, ' (entry)') : null,
				h('div', { class: 'config-role-tools' }, tools.length > 0 ? `tools: ${tools.join(', ')}` : 'no tools'),
			])
		})),
	])
}

function Main(state) {
	return h('main', {}, [
		RunsPanel(state),
		RunSummaryPanel(state),
		RolesPanel(state),
		QuestionsPanel(state),
		LogPanel(state),
		ConfigPanel(state),
	])
}

function view(state) {
	return h('div', {}, [Header(state), Main(state)])
}

// --- App -------------------------------------------------------------------
// The subscriptions array is fixed-size with stable positions: [0] always polls the run list + questions every second; [1] polls the selected run every second but only while one is selected and non-terminal (deactivating on terminal status replaces the manual clearInterval of the prior client); [2] primes the AudioContext on the first user interaction.

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
			expandedLogRows: {},
			shownQuestionIds: {},
			firstQuestionsPoll: true,
			pendingAnswerId: null,
			logPage: null,
			config: null,
			now: Date.now(),
		},
		// The config panel is loaded once and never polled, so its fetch is an init effect rather than a subscription.
		Fetch({ url: 'api/config', ok: GotConfig, fail: FetchFailed }),
	],
	view,
	subscriptions: (state) => [
		onEvery(Tick, POLL_INTERVAL_MS),
		typeof state.selectedRunId === 'string' && state.selectedRunId !== '' && !isTerminalStatus(state.selectedRunStatus) && onEvery(PollSelectedRun, POLL_INTERVAL_MS),
		onFirstInteraction(PrimeAudio),
	],
	node: document.getElementById('app'),
})
