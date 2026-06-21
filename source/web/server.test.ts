import { afterAll, describe, expect, test } from 'bun:test'
import { createWebHumanBackend } from '../executor/human-backend.ts'
import { createRunState } from '../executor/run-state.ts'
import type { RunSnapshotRaw } from '../executor/persistence.ts'
import { createWebServer, type WebServer } from './server.ts'

const humanBackend = createWebHumanBackend()
const runState = createRunState({ humanBackend })

const fakeSnapshot: RunSnapshotRaw = {
	metaText: JSON.stringify({
		runId: 'run-1',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'fix the bug',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	}),
	logText: [
		JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'llm_call', payload: { role: 'planner' } }),
		JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'role_finished', payload: { role: 'planner', status: 'success' } }),
	].join('\n'),
}

const server: WebServer = createWebServer({
	port: 0,
	runState,
	readRunSnapshot: () => fakeSnapshot,
})

afterAll(() => {
	server.stop()
})

const baseUrl = `http://localhost:${server.port}`

describe('createWebServer static assets', () => {
	test('GET / returns the HTML page', async () => {
		const response = await fetch(`${baseUrl}/`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/html')
		const body = await response.text()
		expect(body).toContain('Adaptive Orchestrator')
	})

	test('GET /app.js returns the client script', async () => {
		const response = await fetch(`${baseUrl}/app.js`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/javascript')
		const body = await response.text()
		expect(body).toContain('fetch')
	})

	test('GET /styles.css returns the stylesheet', async () => {
		const response = await fetch(`${baseUrl}/styles.css`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('text/css')
		const body = await response.text()
		expect(body).toContain('body')
	})

	test('GET /unknown returns a 404 json error', async () => {
		const response = await fetch(`${baseUrl}/unknown`)
		expect(response.status).toBe(404)
		const body = await response.json()
		expect(body).toEqual({ ok: false, error: 'not_found' })
	})
})

describe('createWebServer /api/run', () => {
	test('returns the shaped run view from the read snapshot', async () => {
		const response = await fetch(`${baseUrl}/api/run`)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('application/json')
		const view = await response.json()
		expect(view.status).toBe('success')
		expect(view.runId).toBe('run-1')
		expect(view.task).toBe('fix the bug')
		expect(view.roles.length).toBe(1)
		expect(view.roles[0].role).toBe('planner')
		expect(view.recentLog.length).toBe(2)
	})
})

describe('createWebServer /api/questions and /api/answer', () => {
	test('GET /api/questions returns the pending list from the run state', async () => {
		const askPromise = humanBackend.ask('Which framework?', 'src/index.ts')

		const response = await fetch(`${baseUrl}/api/questions`)
		expect(response.status).toBe(200)
		const questions = await response.json()
		expect(questions.length).toBe(1)
		expect(questions[0].question).toBe('Which framework?')
		expect(questions[0].context).toBe('src/index.ts')
		expect(typeof questions[0].id).toBe('string')

		const id = questions[0].id
		const answerResponse = await fetch(`${baseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, answer: 'react' }),
		})
		expect(answerResponse.status).toBe(200)
		expect(await answerResponse.json()).toEqual({ ok: true })

		expect(await askPromise).toBe('react')

		const afterResponse = await fetch(`${baseUrl}/api/questions`)
		const afterQuestions = await afterResponse.json()
		expect(afterQuestions).toEqual([])
	})

	test('POST /api/answer for an unknown id returns 404 not_found', async () => {
		const response = await fetch(`${baseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'does-not-exist', answer: 'whatever' }),
		})
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
	})

	test('POST /api/answer with malformed json returns 400 invalid_body', async () => {
		const response = await fetch(`${baseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{ not json',
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})

	test('POST /api/answer with a missing id returns 400 invalid_body', async () => {
		const response = await fetch(`${baseUrl}/api/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ answer: 'no id' }),
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_body' })
	})
})
