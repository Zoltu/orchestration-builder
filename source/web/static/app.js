// Plain, dependency-free client for the long-running service.
// Polls the JSON API and renders into the DOM using createElement/textContent only — untrusted run content (task text, log payloads, summaries, question text) is never injected via innerHTML, so it cannot break out of the DOM.

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

// The run list is the source of truth for which runs exist and which (at most one) is active.
// `justSubmittedRunId` covers the sub-second window between a successful POST and the new run appearing in the list, so the create form stays disabled through that gap.
let currentSummaries = []
let selectedRunId = null
let selectedRunStatus = null
let activeRunId = null
let justSubmittedRunId = null
let serverAvailable = true

// Per-run polling runs on its own interval so a terminal selected run can stop being polled while the run list keeps polling.
// `selectionGeneration` is bumped on every selection change so a slow in-flight per-run fetch that returns after a switch cannot render a stale run's data into the newly selected view.
let perRunInterval = null
let selectionGeneration = 0

// Signature of the last per-run view rendered into the DOM. The per-run poll fires every second even when nothing changed, so without this guard the whole panel (log rows, roles, summary) is torn down and rebuilt each tick — destroying expanded raw-payload toggles and making the DOM thrash in the debugger. When the signature is unchanged we skip the rebuild entirely.
let lastViewSignature = ''

function clearChildren(element) {
	while (element.firstChild !== null) element.removeChild(element.firstChild)
}

function el(tag, text, className) {
	const node = document.createElement(tag)
	if (text !== undefined) node.textContent = text
	if (className !== undefined) node.className = className
	return node
}

// Renders an absolute ISO timestamp as a relative label ("30s ago", "5m ago").
// A negative delta (clock skew or a just-written future timestamp) reads as "just now" so the label never jumps backwards.
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

// Stamps a node with the absolute timestamp (via data-timestamp + a title tooltip showing the exact time)
// and writes the initial relative label. refreshRelativeTimes() rewrites the label each tick without rebuilding the panel.
function setTimeText(node, iso) {
	node.dataset.timestamp = iso ?? ''
	node.title = iso ?? ''
	node.textContent = formatRelative(iso, Date.now())
}

// Recomputes every stamped time label on the page. The per-run poll skips rebuilding the panel when nothing changed
// (signature guard), so without this the relative labels would freeze at the last render; this lightweight pass keeps them live.
function refreshRelativeTimes() {
	const now = Date.now()
	for (const node of document.querySelectorAll('[data-timestamp]')) {
		const iso = node.dataset.timestamp
		node.textContent = iso === '' || iso === undefined ? '—' : formatRelative(iso, now)
	}
}

function isTerminalStatus(status) {
	return TERMINAL_STATUSES.has(status)
}

function statusLabel(status) {
	if (status === null || status === undefined) return '—'
	return STATUS_LABELS[status] ?? status
}

function renderStatusLine() {
	const status = document.getElementById('status')
	status.onclick = null
	status.style.cursor = 'default'
	if (!serverAvailable) {
		status.textContent = SERVER_UNAVAILABLE_MESSAGE
		status.className = 'status status-unavailable'
		return
	}
	status.className = 'status'
	if (selectedRunId === null) {
		if (activeRunId !== null) {
			status.textContent = 'a run is in progress — click to view'
			status.style.cursor = 'pointer'
			status.onclick = () => setSelectedRun(activeRunId)
			return
		}
		status.textContent = currentSummaries.length === 0 ? 'no runs yet — submit a task to start one' : 'no run selected'
		return
	}
	status.textContent = statusLabel(selectedRunStatus)
}

function markServerUnavailable() {
	if (serverAvailable) {
		serverAvailable = false
		renderStatusLine()
	}
}

function markServerAvailable() {
	if (!serverAvailable) {
		serverAvailable = true
		renderStatusLine()
	}
}

function renderRunList(summaries) {
	const list = document.getElementById('run-list')
	clearChildren(list)

	if (summaries.length === 0) {
		list.appendChild(el('li', 'No runs yet.', 'empty'))
		return
	}

	for (const summary of summaries) {
		const item = el('li')
		if (summary.runId === selectedRunId) item.className = 'selected'
		item.appendChild(el('span', summary.runId, 'run-id'))
		item.appendChild(el('span', statusLabel(summary.status), `run-status run-status-${summary.status ?? 'unknown'}`))
		item.appendChild(el('span', summary.task ?? '—', 'run-task'))
		item.addEventListener('click', () => setSelectedRun(summary.runId))
		list.appendChild(item)
	}
}

function renderRunSummary(view) {
	const meta = document.getElementById('run-meta')
	clearChildren(meta)

	const resultValue = view.result && view.result.summary ? view.result.summary : '—'

	// `time` marks which entries render their value as a relative timestamp (stamped for refreshRelativeTimes).
	const entries = [
		{ label: 'Run', value: view.runId ?? '—', time: false },
		{ label: 'Task', value: view.task ?? '—', time: false },
		{ label: 'Status', value: statusLabel(view.status), time: false },
		{ label: 'Started', value: view.startTime ?? null, time: true },
		{ label: 'Ended', value: view.endTime ?? null, time: true },
		{ label: 'Result', value: resultValue, time: false },
	]
	for (const entry of entries) {
		const dd = el('dd')
		if (entry.time) {
			setTimeText(dd, entry.value)
		} else {
			dd.textContent = entry.value
			if (entry.label === 'Task' || entry.label === 'Result') dd.className = 'preformatted'
		}
		meta.appendChild(el('dt', entry.label))
		meta.appendChild(dd)
	}
}

function renderRoles(roles, activeRole) {
	const list = document.getElementById('roles')
	clearChildren(list)

	if (roles.length === 0) {
		list.appendChild(el('li', 'No role activity yet.'))
		return
	}

	for (const role of roles) {
		const isActive = activeRole !== null && role.role === activeRole
		const item = el('li', undefined, isActive ? 'role-active' : undefined)
		item.appendChild(el('span', undefined, isActive ? 'role-pulse' : undefined))
		item.appendChild(el('strong', role.role))
		item.appendChild(el('span', ` — ${role.eventCount} events · ${role.llmCalls} LLM calls · ${role.toolCalls} tool calls`))
		const times = el('div', undefined, 'role-times')
		const firstSpan = el('span', undefined, 'role-time')
		firstSpan.appendChild(document.createTextNode('first seen '))
		const firstTime = el('time')
		setTimeText(firstTime, role.firstSeen)
		firstSpan.appendChild(firstTime)
		const lastSpan = el('span', undefined, 'role-time')
		lastSpan.appendChild(document.createTextNode('last seen '))
		const lastTime = el('time')
		setTimeText(lastTime, role.lastSeen)
		lastSpan.appendChild(lastTime)
		times.appendChild(firstSpan)
		times.appendChild(lastSpan)
		item.appendChild(times)
		if (role.toolsCalled.length > 0) {
			item.appendChild(el('div', `tools: ${role.toolsCalled.join(', ')}`, 'role-tools'))
		}
		list.appendChild(item)
	}
}

// Expanded-row state is tracked across re-renders so a row the user opened stays open
// when the next poll rebuilds the list, instead of collapsing back to hidden every second.
const expandedLogRows = new Set()

function logRowKey(entry) {
	return `${entry.timestamp}|${entry.type}|${entry.summary}`
}

function renderLog(entries) {
	const list = document.getElementById('log')
	clearChildren(list)

	if (entries.length === 0) {
		list.appendChild(el('li', 'No events logged yet.', 'log-empty'))
		return
	}

	// Newest first so the latest activity is visible without scrolling to the bottom.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		const key = logRowKey(entry)
		const expanded = expandedLogRows.has(key)
		const item = el('li', undefined, 'log-row')
		const timestamp = el('time', undefined, 'log-timestamp')
		setTimeText(timestamp, entry.timestamp)
		item.appendChild(timestamp)
		item.appendChild(el('span', entry.type, 'log-type'))
		item.appendChild(el('span', entry.summary, 'log-summary'))

		const detail = el('pre', undefined, 'log-detail')
		detail.textContent = JSON.stringify(entry.payload, null, 2)
		detail.hidden = !expanded
		const toggle = el('button', expanded ? 'hide' : 'raw', 'log-toggle')
		toggle.type = 'button'
		toggle.addEventListener('click', () => {
			const willExpand = detail.hidden
			detail.hidden = !willExpand
			toggle.textContent = willExpand ? 'hide' : 'raw'
			if (willExpand) expandedLogRows.add(key)
			else expandedLogRows.delete(key)
		})
		item.appendChild(toggle)
		item.appendChild(detail)
		list.appendChild(item)
	}
}

function renderCurrentActivity(activity) {
	const node = document.getElementById('current-activity')
	clearChildren(node)
	if (activity === null) return
	node.appendChild(el('span', `now: ${activity.summary}`, 'current-activity-text'))
}

function renderError(error) {
	const node = document.getElementById('run-error')
	clearChildren(node)
	if (error === null) return
	node.appendChild(el('div', `${error.kind}: ${error.message}`, 'error-text'))
}

function renderArtifacts(artifacts) {
	const container = document.getElementById('run-artifacts')
	clearChildren(container)
	if (artifacts === undefined || artifacts.length === 0) return
	container.appendChild(el('div', 'Artifacts', 'artifacts-heading'))
	const list = el('ul')
	for (const path of artifacts) list.appendChild(el('li', path, 'artifact'))
	container.appendChild(list)
}

function renderQuestions(questions) {
	const list = document.getElementById('questions')
	clearChildren(list)

	if (questions.length === 0) {
		list.appendChild(el('li', 'No pending questions.'))
		return
	}

	for (const question of questions) {
		const item = el('li')
		item.appendChild(el('div', question.question))
		if (question.context !== undefined) {
			item.appendChild(el('div', question.context, 'question-context'))
		}

		const form = el('form')
		form.className = 'question-form'
		const input = document.createElement('input')
		input.type = 'text'
		input.placeholder = 'your answer'
		const button = el('button', 'Answer')
		button.type = 'submit'
		form.appendChild(input)
		form.appendChild(button)
		form.addEventListener('submit', (event) => {
			event.preventDefault()
			if (input.value === '') return
			submitAnswer(question.id, input.value, button)
		})
		item.appendChild(form)
		list.appendChild(item)
	}
}

function updateFormState() {
	const button = document.getElementById('create-run-button')
	const input = document.getElementById('create-run-input')
	const disabled = justSubmittedRunId !== null || activeRunId !== null
	button.disabled = disabled
	input.placeholder = disabled ? 'a run is already in progress' : 'describe a task and start a run'
	button.textContent = disabled ? 'Run in progress…' : 'Start run'
}

function viewSignature(view) {
	const last = view.recentLog.length > 0 ? view.recentLog[view.recentLog.length - 1] : null
	const lastRole = view.roles.length > 0 ? view.roles[view.roles.length - 1] : null
	return [
		view.status,
		view.runId ?? '',
		view.recentLog.length,
		last ? `${last.timestamp}|${last.summary}` : '',
		view.currentActivity ? view.currentActivity.summary : '',
		view.error ? `${view.error.kind}|${view.error.message}` : '',
		view.result ? view.result.summary : '',
		view.roles.length,
		lastRole ? lastRole.lastSeen : '',
	].join('\u0001')
}

function stopPerRunPolling() {
	if (perRunInterval !== null) {
		clearInterval(perRunInterval)
		perRunInterval = null
	}
}

function startPerRunPolling() {
	stopPerRunPolling()
	perRunInterval = setInterval(pollSelectedRun, POLL_INTERVAL_MS)
}

function setSelectedRun(runId) {
	if (runId === selectedRunId) return
	stopPerRunPolling()
	selectionGeneration++
	selectedRunId = runId
	selectedRunStatus = null
	lastViewSignature = ''
	expandedLogRows.clear()
	renderRunList(currentSummaries)
	renderStatusLine()
	pollSelectedRun()
	startPerRunPolling()
}

async function pollSelectedRun() {
	if (selectedRunId === null) return
	const generation = selectionGeneration

	let view
	try {
		const response = await fetch(`api/runs/${encodeURIComponent(selectedRunId)}`)
		if (generation !== selectionGeneration) return
		if (response.status === 404) {
			// The run directory is created early in execution but may not be readable in the instant after submit; keep polling until it appears.
			selectedRunStatus = 'unknown'
			renderStatusLine()
			return
		}
		if (!response.ok) return
		view = await response.json()
	} catch {
		if (generation !== selectionGeneration) return
		markServerUnavailable()
		return
	}
	if (generation !== selectionGeneration) return

	markServerAvailable()

	const signature = viewSignature(view)
	if (signature === lastViewSignature) {
		// Nothing changed since the last render; leave the DOM (and any open raw-payload toggles) untouched.
		if (isTerminalStatus(view.status)) stopPerRunPolling()
		return
	}
	lastViewSignature = signature

	selectedRunStatus = view.status
	const activeRole = !isTerminalStatus(view.status) && view.currentActivity ? view.currentActivity.role : null
	renderRunSummary(view)
	renderCurrentActivity(view.currentActivity)
	renderError(view.error)
	renderArtifacts(view.result ? view.result.artifacts : undefined)
	renderRoles(view.roles, activeRole)
	renderLog(view.recentLog)
	renderStatusLine()
	if (isTerminalStatus(view.status)) stopPerRunPolling()
}

async function pollRunList() {
	let summaries
	try {
		const response = await fetch('api/runs')
		if (!response.ok) return
		summaries = await response.json()
	} catch {
		markServerUnavailable()
		return
	}
	markServerAvailable()
	currentSummaries = Array.isArray(summaries) ? summaries : []

	if (justSubmittedRunId !== null && currentSummaries.some((summary) => summary.runId === justSubmittedRunId)) {
		justSubmittedRunId = null
	}

	const active = currentSummaries.find((summary) => !isTerminalStatus(summary.status))
	activeRunId = active === undefined ? null : active.runId

	if (selectedRunId === null && currentSummaries.length > 0) {
		setSelectedRun(currentSummaries[0].runId)
	}

	renderRunList(currentSummaries)
	updateFormState()
}

async function pollQuestions() {
	let questions
	try {
		const response = await fetch('api/questions')
		if (!response.ok) return
		questions = await response.json()
	} catch {
		markServerUnavailable()
		return
	}
	markServerAvailable()
	renderQuestions(Array.isArray(questions) ? questions : [])
}

async function submitCreateRun(task) {
	const button = document.getElementById('create-run-button')
	const input = document.getElementById('create-run-input')
	button.disabled = true
	input.value = ''

	let runId
	try {
		const response = await fetch('api/runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ task }),
		})
		if (response.status === 201) {
			const body = await response.json()
			runId = body.runId
		} else {
			updateFormState()
			return
		}
	} catch {
		markServerUnavailable()
		updateFormState()
		return
	}

	markServerAvailable()
	justSubmittedRunId = runId
	updateFormState()
	setSelectedRun(runId)
	pollRunList()
}

async function submitAnswer(questionId, answer, button) {
	button.disabled = true
	try {
		const response = await fetch('api/answer', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: questionId, answer }),
		})
		if (!response.ok) {
			button.disabled = false
			return
		}
	} catch {
		markServerUnavailable()
		button.disabled = false
		return
	}
	markServerAvailable()
	pollQuestions()
}

function tick() {
	pollRunList()
	pollQuestions()
	refreshRelativeTimes()
}

document.getElementById('create-run-form').addEventListener('submit', (event) => {
	event.preventDefault()
	const input = document.getElementById('create-run-input')
	const task = input.value.trim()
	if (task === '') return
	if (justSubmittedRunId !== null || activeRunId !== null) return
	submitCreateRun(task)
})

tick()
setInterval(tick, POLL_INTERVAL_MS)
