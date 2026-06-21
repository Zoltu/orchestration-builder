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

function clearChildren(element) {
	while (element.firstChild !== null) element.removeChild(element.firstChild)
}

function el(tag, text, className) {
	const node = document.createElement(tag)
	if (text !== undefined) node.textContent = text
	if (className !== undefined) node.className = className
	return node
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
	if (!serverAvailable) {
		status.textContent = SERVER_UNAVAILABLE_MESSAGE
		status.className = 'status status-unavailable'
		return
	}
	status.className = 'status'
	if (selectedRunId === null) {
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

	const entries = [
		['Run', view.runId ?? '—'],
		['Task', view.task ?? '—'],
		['Status', statusLabel(view.status)],
		['Started', view.startTime ?? '—'],
		['Ended', view.endTime ?? '—'],
		['Result', view.result ? view.result.summary : '—'],
	]
	for (const [label, value] of entries) {
		meta.appendChild(el('dt', label))
		meta.appendChild(el('dd', value))
	}
}

function renderRoles(roles) {
	const list = document.getElementById('roles')
	clearChildren(list)

	if (roles.length === 0) {
		list.appendChild(el('li', 'No role activity yet.'))
		return
	}

	for (const role of roles) {
		const item = el('li')
		item.appendChild(el('strong', role.role))
		item.appendChild(el('span', ` — ${role.eventCount} events · ${role.llmCalls} LLM calls · ${role.toolCalls} tool calls`))
		item.appendChild(el('div', `first seen ${role.firstSeen} · last seen ${role.lastSeen}`))
		if (role.toolsCalled.length > 0) {
			item.appendChild(el('div', `tools: ${role.toolsCalled.join(', ')}`, 'role-tools'))
		}
		list.appendChild(item)
	}
}

function renderLog(events) {
	const list = document.getElementById('log')
	clearChildren(list)

	if (events.length === 0) {
		list.appendChild(el('li', 'No events logged yet.', 'log-empty'))
		return
	}

	for (const event of events) {
		const item = el('li')
		item.appendChild(el('span', event.timestamp, 'log-timestamp'))
		item.appendChild(document.createTextNode(' '))
		item.appendChild(el('span', event.type, 'log-type'))
		item.appendChild(document.createTextNode(' ' + JSON.stringify(event.payload)))
		list.appendChild(item)
	}
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
	selectedRunStatus = view.status
	renderRunSummary(view)
	renderRoles(view.roles)
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
