// Hyperapp client for the long-running service.
// The whole UI is one reactive view of a single state object; polling runs as subscriptions and every side effect (fetch, POST, audio, flash) runs as an effect. Untrusted run content (task text, log payloads, summaries, question text, answers) is interpolated only as children of h() or text-node arguments, which hyperapp places into text nodes and properties — never into markup — so it cannot break out of the DOM. There is no raw-HTML/unsafe API in hyperapp.
import { h, app } from './vendor/hyperapp.js'

const POLL_INTERVAL_MS = 1000
const TERMINAL_STATUSES = new Set(['success', 'error', 'needs_clarification'])
const STATUS_LABELS = {
	unknown: 'in progress',
	running: 'running',
	success: 'success',
	error: 'error',
	needs_clarification: 'needs clarification',
}
const SERVER_UNAVAILABLE_MESSAGE = 'server unavailable — it may have shut down'

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
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

function statusLabel(status) {
	if (status === null || status === undefined) return '—'
	return STATUS_LABELS[status] ?? status
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
	if (state.selectedRunId === null) return state
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
	return { ...state, selectedRunView: body, selectedRunStatus: body.status, serverAvailable: true }
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

function SelectRun(state, runId) {
	if (runId === state.selectedRunId) return state
	return { ...state, selectedRunId: runId, selectedRunView: null, selectedRunStatus: null, expandedLogRows: {} }
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

function GotCreatedRun(state, payload) {
	const ok = payload.ok
	const body = payload.body
	if (!ok || body === null || typeof body !== 'object' || !('runId' in body)) return state
	const createdRunId = body.runId
	// Selecting the new run activates its per-run subscription; an immediate run-list fetch clears justSubmittedRunId as soon as the run appears.
	return [
		{ ...state, justSubmittedRunId: createdRunId, selectedRunId: createdRunId, selectedRunView: null, selectedRunStatus: null, expandedLogRows: {}, serverAvailable: true },
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
	return h(
		'ul',
		{ id: 'run-list' },
		state.summaries.map((summary) =>
			h('li', { key: summary.runId, class: { selected: summary.runId === state.selectedRunId }, onclick: [SelectRun, summary.runId] }, [
				h('span', { class: 'run-id' }, summary.runId),
				h('span', { class: `run-status run-status-${summary.status ?? 'unknown'}` }, statusLabel(summary.status)),
				h('span', { class: 'run-task' }, summary.task ?? '—'),
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

	return h('section', { id: 'run-summary', class: 'panel' }, [
		h('h2', {}, 'Run'),
		h('p', { id: 'current-activity', class: 'current-activity' }, activity ? h('span', { class: 'current-activity-text' }, `now: ${activity.summary}`) : null),
		h('dl', { id: 'run-meta' }, entries),
		h('div', { id: 'run-error', class: 'run-error' }, error ? h('div', { class: 'error-text' }, `${error.kind}: ${error.message}`) : null),
		h('div', { id: 'run-artifacts', class: 'run-artifacts' }, artifacts && artifacts.length > 0 ? [h('div', { class: 'artifacts-heading' }, 'Artifacts'), h('ul', {}, artifacts.map((path) => h('li', { key: path, class: 'artifact' }, path)))] : null),
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
					h('span', {}, ` — ${role.eventCount} events · ${role.llmCalls} LLM calls · ${role.toolCalls} tool calls`),
					h('div', { class: 'role-times' }, [
						h('span', { class: 'role-time' }, ['first seen ', h('time', { title: role.firstSeen ?? '' }, formatRelative(role.firstSeen, state.now))]),
						h('span', { class: 'role-time' }, ['last seen ', h('time', { title: role.lastSeen ?? '' }, formatRelative(role.lastSeen, state.now))]),
					]),
					role.toolsCalled.length > 0 ? h('div', { class: 'role-tools' }, `tools: ${role.toolsCalled.join(', ')}`) : null,
				])
			})
	return h('section', { id: 'roles-panel', class: 'panel' }, [h('h2', {}, 'Role activity'), h('ul', { id: 'roles' }, children)])
}

function LogPanel(state) {
	const view = state.selectedRunView
	const entries = view ? view.recentLog : []
	let children
	if (entries.length === 0) {
		children = [h('li', { class: 'log-empty' }, 'No events logged yet.')]
	} else {
		// Newest first so the latest activity is visible without scrolling.
		children = []
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]
			const key = logRowKey(entry)
			const expanded = Boolean(state.expandedLogRows[key])
			children.push(
				h('li', { key, class: 'log-row' }, [
					h('time', { class: 'log-timestamp', title: entry.timestamp ?? '' }, formatRelative(entry.timestamp, state.now)),
					h('span', { class: 'log-type' }, entry.type),
					h('span', { class: 'log-summary' }, entry.summary),
					h('button', { type: 'button', class: 'log-toggle', onclick: [ToggleLogRow, key] }, expanded ? 'hide' : 'raw'),
					h('pre', { class: 'log-detail', hidden: !expanded }, JSON.stringify(entry.payload, null, 2)),
				]),
			)
		}
	}
	return h('section', { id: 'log-panel', class: 'panel' }, [h('h2', {}, 'Recent log'), h('ol', { id: 'log' }, children)])
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

function Main(state) {
	return h('main', {}, [
		RunsPanel(state),
		RunSummaryPanel(state),
		RolesPanel(state),
		QuestionsPanel(state),
		LogPanel(state),
	])
}

function view(state) {
	return h('div', {}, [Header(state), Main(state)])
}

// --- App -------------------------------------------------------------------
// The subscriptions array is fixed-size with stable positions: [0] always polls the run list + questions every second; [1] polls the selected run every second but only while one is selected and non-terminal (deactivating on terminal status replaces the manual clearInterval of the prior client); [2] primes the AudioContext on the first user interaction.

app({
	init: {
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
		now: Date.now(),
	},
	view,
	subscriptions: (state) => [
		onEvery(Tick, POLL_INTERVAL_MS),
		state.selectedRunId !== null && !isTerminalStatus(state.selectedRunStatus) && onEvery(PollSelectedRun, POLL_INTERVAL_MS),
		onFirstInteraction(PrimeAudio),
	],
	node: document.getElementById('app'),
})
