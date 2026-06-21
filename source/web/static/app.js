// Plain, dependency-free client.
// Polls the JSON API and renders into the DOM using createElement/textContent only — untrusted run content (log lines, summaries, questions) is never injected via innerHTML, so it cannot break out of the DOM.

const STATUS_LABELS = {
	unknown: 'in progress',
	running: 'running',
	success: 'success',
	error: 'error',
	needs_clarification: 'needs clarification',
}

const POLL_INTERVAL_MS = 1000

function clearChildren(element) {
	while (element.firstChild !== null) element.removeChild(element.firstChild)
}

function createElement(tag, text) {
	const node = document.createElement(tag)
	if (text !== undefined) node.textContent = text
	return node
}

function renderRunSummary(view) {
	const status = document.getElementById('status')
	status.textContent = STATUS_LABELS[view.status] ?? view.status

	const meta = document.getElementById('run-meta')
	clearChildren(meta)

	const entries = [
		['Run', view.runId ?? '—'],
		['Task', view.task ?? '—'],
		['Started', view.startTime ?? '—'],
		['Ended', view.endTime ?? '—'],
		['Result', view.result ? view.result.summary : '—'],
	]
	for (const [label, value] of entries) {
		meta.appendChild(createElement('dt', label))
		meta.appendChild(createElement('dd', value))
	}
}

function renderRoles(roles) {
	const list = document.getElementById('roles')
	clearChildren(list)

	if (roles.length === 0) {
		list.appendChild(createElement('li', 'No role activity yet.'))
		return
	}

	for (const role of roles) {
		const item = createElement('li')
		item.appendChild(createElement('strong', role.role))
		item.appendChild(
			createElement(
				'span',
				` — ${role.eventCount} events · ${role.llmCalls} LLM calls · ${role.toolCalls} tool calls`,
			),
		)
		item.appendChild(createElement('div', `first seen ${role.firstSeen} · last seen ${role.lastSeen}`))
		if (role.toolsCalled.length > 0) {
			item.appendChild(createElement('div', `tools: ${role.toolsCalled.join(', ')}`)).className = 'role-tools'
		}
		list.appendChild(item)
	}
}

function renderLog(events) {
	const list = document.getElementById('log')
	clearChildren(list)

	if (events.length === 0) {
		const empty = createElement('li', 'No events logged yet.')
		empty.className = 'log-empty'
		list.appendChild(empty)
		return
	}

	for (const event of events) {
		const item = createElement('li')
		const timestamp = createElement('span', event.timestamp)
		timestamp.className = 'log-timestamp'
		item.appendChild(timestamp)
		item.appendChild(document.createTextNode(' '))
		const type = createElement('span', event.type)
		type.className = 'log-type'
		item.appendChild(type)
		item.appendChild(document.createTextNode(' ' + JSON.stringify(event.payload)))
		list.appendChild(item)
	}
}

function submitAnswer(questionId, answer, button) {
	button.disabled = true
	fetch('/api/answer', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id: questionId, answer }),
	})
		.then((response) => response.json())
		.then(
			() => pollQuestions(),
			() => {
				button.disabled = false
			},
		)
}

function renderQuestions(questions) {
	const list = document.getElementById('questions')
	clearChildren(list)

	if (questions.length === 0) {
		list.appendChild(createElement('li', 'No pending questions.'))
		return
	}

	for (const question of questions) {
		const item = createElement('li')
		item.appendChild(createElement('div', question.question))
		if (question.context !== undefined) {
			const context = createElement('div', question.context)
			context.className = 'question-context'
			item.appendChild(context)
		}

		const form = createElement('form')
		form.className = 'question-form'
		const input = document.createElement('input')
		input.type = 'text'
		input.placeholder = 'your answer'
		const button = createElement('button', 'Answer')
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

function pollRun() {
	fetch('/api/run')
		.then((response) => response.json())
		.then((view) => {
			renderRunSummary(view)
			renderRoles(view.roles)
			renderLog(view.recentLog)
		})
		.catch(() => {})
}

function pollQuestions() {
	fetch('/api/questions')
		.then((response) => response.json())
		.then((questions) => renderQuestions(questions))
		.catch(() => {})
}

function tick() {
	pollRun()
	pollQuestions()
}

tick()
setInterval(tick, POLL_INTERVAL_MS)
