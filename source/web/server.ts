// Web UI server for the long-running service backend.
// A thin HTTP leaf built on Bun.serve: it routes requests, serves the plain static assets, delegates JSON shaping to render.ts, question/answer handling to the RunState façade from source/executor/run-state.ts, and run submission to the RunSubmission orchestration from source/executor/run-submission.ts.
// No business logic lives here.

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ListRunIds, ReadRunSnapshotById } from '../executor/persistence.js'
import type { RunState } from '../executor/run-state.js'
import type { RunSubmission } from '../executor/run-submission.js'
import { parseRunSnapshot, paginateLogEvents, renderPendingQuestions, renderRunSummary, renderRunView, formatLogAsText, toRecentLogEntry } from './render.js'

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'static')
const MAX_LOG_LINES = 200

interface StaticAsset {
	fileName: string
	contentType: string
}

const STATIC_ASSETS: Record<string, StaticAsset> = {
	'/': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
	'/app.js': { fileName: 'app.js', contentType: 'text/javascript; charset=utf-8' },
	'/vendor/hyperapp.js': { fileName: 'vendor/hyperapp.js', contentType: 'text/javascript; charset=utf-8' },
	'/styles.css': { fileName: 'styles.css', contentType: 'text/css; charset=utf-8' },
}

export interface WebServerConfig {
	port: number
	runState: RunState
	runSubmission: RunSubmission
	readRunSnapshotById: ReadRunSnapshotById
	listRunIds: ListRunIds
}

export interface WebServer {
	port: number
	stop(): void
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

function serveStaticAsset(asset: StaticAsset): Response {
	const filePath = path.resolve(STATIC_DIR, asset.fileName)
	const file = Bun.file(filePath)
	// no-store keeps the dev server from caching stale assets (or stale 404s) across restarts, so an edit to app.js is always picked up on the next page load.
	return new Response(file, {
		headers: {
			'content-type': asset.contentType,
			'cache-control': 'no-store',
		},
	})
}

function handleActiveRun(readRunSnapshotById: ReadRunSnapshotById, runSubmission: RunSubmission): Response {
	const runId = runSubmission.lastRunId()
	if (runId === undefined) return json({ ok: false, error: 'no_run' }, 404)
	const view = runViewFor(readRunSnapshotById, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	return json(view)
}

function handleGetRunById(readRunSnapshotById: ReadRunSnapshotById, runId: string): Response {
	const view = runViewFor(readRunSnapshotById, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	return json(view)
}

function runLogPage(readRunSnapshotById: ReadRunSnapshotById, runId: string, query: URLSearchParams): Response {
	if (!isKnownRun(readRunSnapshotById, runId)) return json({ ok: false, error: 'not_found' }, 404)
	const snapshot = parseRunSnapshot(readRunSnapshotById(runId))
	const events = snapshot.logEvents
	const offset = parseNonNegativeInt(query.get('offset'), 0)
	const limit = parseNonNegativeInt(query.get('limit'), MAX_LOG_LINES)
	// ?format=text renders the requested page as plain text with a download disposition, so export reuses the server-side formatter rather than duplicating it in the client.
	if (query.get('format') === 'text') {
		const page = paginateLogEvents(events, { offset, limit })
		return new Response(formatLogAsText(page.events), {
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store',
				'content-disposition': `attachment; filename="${runId}.log"`,
			},
		})
	}
	const page = paginateLogEvents(events, { offset, limit })
	return json({ runId, total: page.total, offset: page.offset, limit: page.limit, events: page.events.map(toRecentLogEntry) })
}

// Parses a query parameter as a non-negative integer, falling back to the default for absent, non-numeric, or negative values — invalid params are treated as defaults per the log endpoint's contract.
function parseNonNegativeInt(value: string | null, defaultValue: number): number {
	if (value === null) return defaultValue
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) return defaultValue
	return parsed
}

function runViewFor(readRunSnapshotById: ReadRunSnapshotById, runId: string): ReturnType<typeof renderRunView> | null {
	if (!isKnownRun(readRunSnapshotById, runId)) return null
	const snapshot = parseRunSnapshot(readRunSnapshotById(runId))
	return renderRunView(snapshot, { maxLogLines: MAX_LOG_LINES })
}

// A run id is "known" if a directory exists for it under the runs base; readRunSnapshotById returns empty artifacts for a missing dir, so the existence check distinguishes a never-started id from an in-progress run.
function isKnownRun(readRunSnapshotById: ReadRunSnapshotById, runId: string): boolean {
	const raw = readRunSnapshotById(runId)
	return raw.metaText !== null || raw.logText !== ''
}

function handleListRuns(readRunSnapshotById: ReadRunSnapshotById, listRunIds: ListRunIds): Response {
	const summaries = listRunIds()
		.slice()
		.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
		.map((runId) => renderRunSummary(runId, parseRunSnapshot(readRunSnapshotById(runId))))
	return json(summaries)
}

function handleAnswer(runState: RunState, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const idValue = body['id']
	const answerValue = body['answer']
	if (typeof idValue !== 'string' || idValue === '') return json({ ok: false, error: 'invalid_body' }, 400)
	if (typeof answerValue !== 'string') return json({ ok: false, error: 'invalid_body' }, 400)
	const result = runState.submitAnswer(idValue, answerValue)
	if (result.kind === 'resolved') return json({ ok: true })
	return json({ ok: false, error: 'not_found' }, 404)
}

function handleCreateRun(runSubmission: RunSubmission, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const taskValue = body['task']
	if (typeof taskValue !== 'string' || taskValue === '') return json({ ok: false, error: 'invalid_body' }, 400)
	const result = runSubmission.submit(taskValue)
	if (result.ok) return json({ runId: result.runId }, 201)
	return json({ ok: false, error: result.error }, 409)
}

export function createWebServer(config: WebServerConfig): WebServer {
	const runState = config.runState
	const runSubmission = config.runSubmission
	const readRunSnapshotById = config.readRunSnapshotById
	const listRunIds = config.listRunIds

	const server = Bun.serve({
		port: config.port,
		async fetch(request) {
			const url = new URL(request.url)
			const { pathname } = url

			if (request.method === 'GET') {
				if (pathname === '/api/run') return handleActiveRun(readRunSnapshotById, runSubmission)
				if (pathname === '/api/runs') return handleListRuns(readRunSnapshotById, listRunIds)
				if (pathname.startsWith('/api/runs/')) {
					const rest = decodeURIComponent(pathname.slice('/api/runs/'.length))
					// Match the /log suffix before the bare :id route so /api/runs/<id>/log reaches the log endpoint rather than being swallowed as a run id of "<id>/log".
					const slashIndex = rest.lastIndexOf('/')
					if (slashIndex >= 0 && rest.slice(slashIndex + 1) === 'log') {
						const runId = rest.slice(0, slashIndex)
						if (runId !== '') return runLogPage(readRunSnapshotById, runId, url.searchParams)
					}
					return handleGetRunById(readRunSnapshotById, rest)
				}
			if (pathname === '/api/questions') return json(renderPendingQuestions(runState.pendingQuestions()))
			// Browsers auto-request /favicon.ico on every page load; answer 204 so it does not pollute the console with a 404.
			if (pathname === '/favicon.ico') return new Response(null, { status: 204 })
			const asset = STATIC_ASSETS[pathname]
			if (asset !== undefined) return serveStaticAsset(asset)
			return json({ ok: false, error: 'not_found' }, 404)
			}

			if (request.method === 'POST') {
				if (pathname === '/api/runs') {
					const body = await readJsonBody(request)
					if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
					return handleCreateRun(runSubmission, body)
				}
				if (pathname === '/api/answer') {
					const body = await readJsonBody(request)
					if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
					return handleAnswer(runState, body)
				}
			}

			return json({ ok: false, error: 'not_found' }, 404)
		},
	})

	const port = server.port
	if (port === undefined) {
		server.stop()
		throw new Error(`Failed to bind web server on port ${config.port}`)
	}

	return {
		port,
		stop: () => server.stop(),
	}
}

async function readJsonBody(request: Request): Promise<unknown | undefined> {
	try {
		const text = await request.text()
		return JSON.parse(text)
	} catch {
		return undefined
	}
}
