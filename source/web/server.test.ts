import { afterAll, describe, expect, test } from 'bun:test'
import { createWebHumanBackend } from '../executor/human-backend.ts'
import { createRunState } from '../executor/run-state.ts'
import { createRunSubmission, type RunSubmission, type StartRun } from '../executor/run-submission.ts'
import type { RunSnapshotRaw } from '../executor/persistence.ts'
import type { RunMeta } from '../executor/types.js'
import { createWebServer, type WebServer } from './server.ts'

function snapshotFor(runId: string, status: RunMeta['status'] = 'success', overrides: Partial<RunMeta> = {}): RunSnapshotRaw {
	return {
		metaText: JSON.stringify({
			runId,
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: `task for ${runId}`,
			status,
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			...overrides,
		}),
		logText: [
			JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'llm_call', payload: { role: 'planner' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'role_finished', payload: { role: 'planner', status: 'success' } }),
		].join('\n'),
	}
}

const snapshots = new Map<string, RunSnapshotRaw>([
	['run-1', snapshotFor('run-1')],
	['run-2', snapshotFor('run-2', 'error', {
		result: { status: 'error', summary: 'failed', artifacts: ['output.txt', 'logs/run.txt'] },
		error: { kind: 'llm_unavailable', message: 'connection refused' },
	})],
	['run-3', {
		metaText: JSON.stringify({
			runId: 'run-3',
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: 'task for run-3',
			status: 'needs_clarification',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
		}),
		logText: [
			JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'llm_call', payload: { role: 'planner' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'ask_human', payload: { id: 'q1', question: 'Which framework?', context: 'src/index.ts' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:30.000Z', type: 'human_answer', payload: { id: 'q1', answer: 'react' } }),
			JSON.stringify({ timestamp: '2026-01-01T00:00:31.000Z', type: 'ask_human', payload: { id: 'q2', question: 'Still unsure?' } }),
		].join('\n'),
	}],
])

const unknownRunIds = new Set(['never-started'])

function readRunSnapshotById(runId: string): RunSnapshotRaw {
	if (unknownRunIds.has(runId)) return { metaText: null, logText: '' }
	return snapshots.get(runId) ?? snapshotFor(runId)
}

function listRunIds(): string[] {
	return Array.from(snapshots.keys())
}

// A run with more than MAX_LOG_LINES (200) events so pagination is exercisable end to end.
function longLogRun(id: string): RunSnapshotRaw {
	const lines: string[] = []
	for (let i = 0; i < 250; i++) {
		lines.push(JSON.stringify({ timestamp: `t${String(i).padStart(3, '0')}`, type: 'llm_call', payload: { role: 'planner' } }))
	}
	return {
		metaText: JSON.stringify({
			runId: id,
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: `task for ${id}`,
			status: 'success',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
		}),
		logText: lines.join('\n'),
	}
}

snapshots.set('run-long', longLogRun('run-long'))

// Shared server for the read-only routes (static assets, list, get-by-id, questions, answer).
// The submission-mutating routes get their own fresh server per test to avoid cross-test ordering coupling.
const humanBackend = createWebHumanBackend()
const runState = createRunState({ humanBackend })
const readOnlyServer: WebServer = createWebServer({
	port: 0,
	runState,
	runSubmission: createRunSubmission({
		startRun: async () => ({ runId: 'unused', guildPath: 'g', benchmarkPath: 'b', task: 't', status: 'success', startTime: 's' }),
		generateRunId: () => 'unused',
	}),
	readRunSnapshotById,
	listRunIds,
})

afterAll(() => {
	readOnlyServer.stop()
})

const readOnlyBaseUrl = `http://localhost:${readOnlyServer.port}`

interface SubmissionServer {
	server: WebServer
	baseUrl: string
	submission: RunSubmission
	resolveActive: () => ((meta: RunMeta) => void)
}

// Builds a fresh server + submission whose startRun parks on a caller-controlled resolver, so each test drives its own run lifecycle without touching shared state.
function createSubmissionServer(): SubmissionServer {
	let resolveActive: (meta: RunMeta) => void = () => {}
	const startRun: StartRun = () => new Promise<RunMeta>((resolve) => {
		resolveActive = resolve
	})
	let nextId = 0
	const submission = createRunSubmission({ startRun, generateRunId: () => `test-run-${nextId++}` })
	const server = createWebServer({
		port: 0,
		runState: createRunState({ humanBackend: createWebHumanBackend() }),
		runSubmission: submission,
		readRunSnapshotById,
		listRunIds,
	})
	return {
		server,
		baseUrl: `http://localhost:${server.port}`,
		submission,
		resolveActive: () => resolveActive,
	}
}

function terminalMeta(runId: string, task: string): RunMeta {
	return {
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task,
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}
}

describe('createWebServer static assets', () => {
	test('GET / returns the HTML page', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/html')
		const body = await response.text()
		expect(body).toContain('Adaptive Orchestrator')
	})

	test('GET /app.js returns the client script', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/app.js`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/javascript')
		const body = await response.text()
		expect(body).toContain('fetch')
	})

	test('GET /vendor/hyperapp.js returns the vendored library', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/vendor/hyperapp.js`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/javascript')
		const body = await response.text()
		expect(body).toContain('export var app')
	})

	test('GET /styles.css returns the stylesheet', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/styles.css`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/css')
		const body = await response.text()
		expect(body).toContain('body')
	})

	test('GET /unknown returns a 404 json error', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/unknown`)
		expect(response.status).toBe(404)
		const body = await response.json()
		expect(body).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('createWebServer /api/run alias', () => {
	test('returns the active (most recent) run view', async () => {
		const { server, baseUrl, submission, resolveActive } = createSubmissionServer()
		try {
			submission.submit('bootstrap task')
			const response = await fetch(`${baseUrl}/api/run`)
			expect(response.status).toBe(200)
			const view = await response.json()
			expect(view.runId).toBe('test-run-0')
			expect(view.task).toBe('task for test-run-0')

			resolveActive()(terminalMeta('test-run-0', 'bootstrap task'))
			await submission.awaitActive()
		} finally {
			server.stop()
		}
	})

	test('returns 404 no_run when no run has ever been started', async () => {
		const { server, baseUrl } = createSubmissionServer()
		try {
			const response = await fetch(`${baseUrl}/api/run`)
			expect(response.status).toBe(404)
			expect(await response.json()).toEqual({ ok: false, error: 'no_run' })
		} finally {
			server.stop()
		}
	})

	test('keeps surfacing the most recent run after it completes', async () => {
		const { server, baseUrl, submission, resolveActive } = createSubmissionServer()
		try {
			submission.submit('bootstrap task')
			resolveActive()(terminalMeta('test-run-0', 'bootstrap task'))
			await submission.awaitActive()

			const response = await fetch(`${baseUrl}/api/run`)
			expect(response.status).toBe(200)
			const view = await response.json()
			expect(view.runId).toBe('test-run-0')
		} finally {
			server.stop()
		}
	})
})

describe('createWebServer /api/runs (list)', () => {
	test('returns the known runs as summaries, newest first by id', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs`)
		expect(response.status).toBe(200)
		const list = await response.json()
		expect(Array.isArray(list)).toBe(true)
		expect(list.length).toBe(4)
		expect(list[0].runId).toBe('run-long')
		expect(list[1].runId).toBe('run-3')
		expect(list[2].runId).toBe('run-2')
		expect(list[3].runId).toBe('run-1')
		expect(list[2]).toEqual({
			runId: 'run-2',
			status: 'error',
			task: 'task for run-2',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
		})
	})
})

describe('createWebServer /api/runs/:id', () => {
	test('returns the full run view for a known run id', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-1`)
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.runId).toBe('run-1')
		expect(view.status).toBe('success')
		expect(view.roles.length).toBe(1)
		expect(view.roles[0].role).toBe('planner')
		expect(view.recentLog.length).toBe(2)
		expect(view.recentLog[0].summary).toBe('planner · llm call')
		expect(view.recentLog[0].payload).toEqual({ role: 'planner' })
		expect(view.error).toBeNull()
		expect(view.currentActivity.role).toBe('planner')
		expect(view.currentActivity.summary).toBe('planner · finished (success)')
	})

	test('surfaces error, artifacts, currentActivity, and readable recentLog for a failed run', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-2`)
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.error).toEqual({ kind: 'llm_unavailable', message: 'connection refused' })
		expect(view.result.artifacts).toEqual(['output.txt', 'logs/run.txt'])
		expect(view.currentActivity.summary).toBe('planner · finished (success)')
		expect(view.recentLog[0].summary).toBe('planner · llm call')
		expect(view.recentLog[1].summary).toBe('planner · finished (success)')
	})

	test('returns 404 for an unknown run id', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/never-started`)
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('returns questionHistory pairing ask_human with human_answer events', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-3`)
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.questionHistory.length).toBe(2)
		expect(view.questionHistory[0]).toEqual({
			id: 'q1',
			question: 'Which framework?',
			context: 'src/index.ts',
			askedAt: '2026-01-01T00:00:02.000Z',
			answer: 'react',
			answeredAt: '2026-01-01T00:00:30.000Z',
		})
		expect(view.questionHistory[1]).toEqual({
			id: 'q2',
			question: 'Still unsure?',
			askedAt: '2026-01-01T00:00:31.000Z',
		})
	})
})

describe('createWebServer GET /api/runs/:id/log', () => {
	test('returns the default first page with total, offset, and limit', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-long/log`)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.runId).toBe('run-long')
		expect(body.total).toBe(250)
		expect(body.offset).toBe(0)
		expect(body.limit).toBe(200)
		expect(body.events.length).toBe(200)
		expect(body.events[0].timestamp).toBe('t000')
		expect(body.events[199].timestamp).toBe('t199')
		expect(body.events[0].summary).toBe('planner · llm call')
		expect(body.events[0].payload).toEqual({ role: 'planner' })
	})

	test('returns a later page with explicit offset and limit', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-long/log?offset=240&limit=20`)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.total).toBe(250)
		expect(body.offset).toBe(240)
		expect(body.limit).toBe(20)
		expect(body.events.length).toBe(10)
		expect(body.events[0].timestamp).toBe('t240')
		expect(body.events[9].timestamp).toBe('t249')
	})

	test('returns an empty page with the correct total when offset is past the end', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-long/log?offset=300&limit=10`)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.total).toBe(250)
		expect(body.offset).toBe(300)
		expect(body.events).toEqual([])
	})

	test('treats invalid query params as defaults', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-long/log?offset=abc&limit=-5`)
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.offset).toBe(0)
		expect(body.limit).toBe(200)
		expect(body.events.length).toBe(200)
	})

	test('returns 404 for an unknown run id', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/never-started/log`)
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('does not regress the bare :id route (the /log suffix is not swallowed)', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-1`)
		expect(response.status).toBe(200)
		const view = await response.json()
		expect(view.runId).toBe('run-1')
	})

	test('format=text returns the page as a downloadable plain-text log', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-1/log?format=text`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/plain')
		expect(response.headers.get('content-disposition')).toBe('attachment; filename="run-1.log"')
		const text = await response.text()
		const lines = text.split('\n')
		expect(lines.length).toBe(2)
		expect(lines[0]).toBe('2026-01-01T00:00:01.000Z\tllm_call\tplanner · llm call')
		expect(lines[1]).toBe('2026-01-01T00:00:02.000Z\trole_finished\tplanner · finished (success)')
	})

	test('format=text honors offset and limit', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/run-long/log?format=text&offset=0&limit=3`)
		expect(response.status).toBe(200)
		const lines = (await response.text()).split('\n')
		expect(lines.length).toBe(3)
		expect(lines[0]).toContain('t000')
		expect(lines[2]).toContain('t002')
	})

	test('format=text returns 404 for an unknown run id', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/runs/never-started/log?format=text`)
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('createWebServer POST /api/runs', () => {
	test('accepts a task when no run is active and returns 201 with the run id', async () => {
		const { server, baseUrl, submission, resolveActive } = createSubmissionServer()
		try {
			const response = await fetch(`${baseUrl}/api/runs`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ task: 'a new task' }),
			})
			expect(response.status).toBe(201)
			const body = await response.json()
			expect(body.runId).toBe('test-run-0')
			expect(submission.activeRunId()).toBe('test-run-0')

			resolveActive()(terminalMeta('test-run-0', 'a new task'))
			await submission.awaitActive()
		} finally {
			server.stop()
		}
	})

	test('rejects a second submit while a run is active with 409 run_in_progress', async () => {
		const { server, baseUrl, submission, resolveActive } = createSubmissionServer()
		try {
			submission.submit('first')
			const response = await fetch(`${baseUrl}/api/runs`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ task: 'second' }),
			})
			expect(response.status).toBe(409)
			expect(await response.json()).toEqual({ ok: false, error: 'run_in_progress' })

			resolveActive()(terminalMeta('test-run-0', 'first'))
			await submission.awaitActive()
		} finally {
			server.stop()
		}
	})

	test('rejects a body missing the task field with 400 invalid_body', async () => {
		const { server, baseUrl } = createSubmissionServer()
		try {
			const response = await fetch(`${baseUrl}/api/runs`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ notTask: 'x' }),
			})
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
		} finally {
			server.stop()
		}
	})

	test('rejects malformed json with 400 invalid_body', async () => {
		const { server, baseUrl } = createSubmissionServer()
		try {
			const response = await fetch(`${baseUrl}/api/runs`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{ not json',
			})
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
		} finally {
			server.stop()
		}
	})
})

describe('createWebServer /api/questions and /api/answer', () => {
	test('GET /api/questions returns the pending list from the run state', async () => {
		const askPromise = humanBackend.ask('Which framework?', 'src/index.ts')

		const response = await fetch(`${readOnlyBaseUrl}/api/questions`)
		expect(response.status).toBe(200)
		const questions = await response.json()
		expect(questions.length).toBe(1)
		expect(questions[0].question).toBe('Which framework?')
		expect(questions[0].context).toBe('src/index.ts')
		expect(typeof questions[0].id).toBe('string')

		const id = questions[0].id
		const answerResponse = await fetch(`${readOnlyBaseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, answer: 'react' }),
		})
		expect(answerResponse.status).toBe(200)
		expect(await answerResponse.json()).toEqual({ ok: true })

		expect(await askPromise).toBe('react')

		const afterResponse = await fetch(`${readOnlyBaseUrl}/api/questions`)
		const afterQuestions = await afterResponse.json()
		expect(afterQuestions).toEqual([])
	})

	test('POST /api/answer for an unknown id returns 404 not_found', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'does-not-exist', answer: 'whatever' }),
		})
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('POST /api/answer with malformed json returns 400 invalid_body', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{ not json',
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('POST /api/answer with a missing id returns 400 invalid_body', async () => {
		const response = await fetch(`${readOnlyBaseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ answer: 'no id' }),
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})
})
