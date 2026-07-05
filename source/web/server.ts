

import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ListRunIds, ReadProjectSettings, ReadRunSnapshotById, WriteProjectSettings } from '../executor/persistence.js'
import type { EffortLevel, GuildConfig } from '../executor/types.js'
import { isEffortLevel } from '../executor/validation.js'
import type { RunState } from '../executor/run-state.js'
import type { RunSubmission } from '../executor/run-submission.js'
import { parseRunSnapshot, paginateLogEvents, renderConfig, renderProjectSettings, renderPendingQuestions, renderRunSummary, renderRunView, formatLogAsText, toRecentLogEntry } from './render.js'

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'static')
const MAX_LOG_LINES = 200

// Content-type by file extension. The static directory holds only these asset kinds, so a small map covers the surface; an unknown extension falls back to a generic binary type so the browser never receives a wrong MIME that would block a module load.
const CONTENT_TYPES: Record<string, string> = {
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.json': 'application/json; charset=utf-8',
}

export interface WebServerConfig {
	port: number
	guildConfig: GuildConfig
	runState: RunState
	runSubmission: RunSubmission
	readRunSnapshotById: ReadRunSnapshotById
	listRunIds: ListRunIds
	readProjectSettings: ReadProjectSettings
	writeProjectSettings: WriteProjectSettings
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

	function serveStaticPath(requestPath: string): Response {
		const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1)
	const resolvedPath = path.resolve(STATIC_DIR, relativePath)
	// The separator check rejects `..` segments that resolve outside the static dir (e.g. `/../source/web/server.ts`), preserving the traversal safety the explicit route map gave for free.
	if (!resolvedPath.startsWith(STATIC_DIR + path.sep)) return json({ ok: false, error: 'not_found' }, 404)
	if (!existsSync(resolvedPath)) return json({ ok: false, error: 'not_found' }, 404)
	const file = Bun.file(resolvedPath)
	const extension = path.extname(resolvedPath)
	const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream'
	// no-store keeps the dev server from caching stale assets (or stale 404s) across restarts, so an edit to app.js is always picked up on the next page load.
	return new Response(file, {
		headers: {
			'content-type': contentType,
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

function parseNonNegativeInt(value: string | null, defaultValue: number): number {
	if (value === null) return defaultValue
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) return defaultValue
	return parsed
}

function runViewFor(readRunSnapshotById: ReadRunSnapshotById, runId: string): ReturnType<typeof renderRunView> | null {
	if (!isKnownRun(readRunSnapshotById, runId)) return null
	const snapshot = parseRunSnapshot(readRunSnapshotById(runId))
	return renderRunView(snapshot, { maxLogLines: MAX_LOG_LINES, now: new Date().toISOString() })
}

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
	const effortValue = body['effort']
	if (effortValue !== undefined && !isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effortOverride: EffortLevel | undefined = effortValue
	const result = runSubmission.submit(taskValue, effortOverride)
	if (result.ok) return json({ runId: result.runId }, 201)
	return json({ ok: false, error: result.error }, 409)
}

function handleGetSettings(readProjectSettings: ReadProjectSettings): Response {
	return json(renderProjectSettings(readProjectSettings()))
}

function handlePutSettings(writeProjectSettings: WriteProjectSettings, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effortValue = body['effort']
	if (!isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	writeProjectSettings({ effort: effortValue })
	return json(renderProjectSettings({ effort: effortValue }))
}

export function createWebServer(config: WebServerConfig): WebServer {
	const guildConfig = config.guildConfig
	const runState = config.runState
	const runSubmission = config.runSubmission
	const readRunSnapshotById = config.readRunSnapshotById
	const listRunIds = config.listRunIds
	const readProjectSettings = config.readProjectSettings
	const writeProjectSettings = config.writeProjectSettings

	const server = Bun.serve({
		port: config.port,
		async fetch(request) {
			const url = new URL(request.url)
			const { pathname } = url

		if (request.method === 'GET') {
			if (pathname === '/api/config') return json(renderConfig(guildConfig))
			if (pathname === '/api/settings') return handleGetSettings(readProjectSettings)
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
		return serveStaticPath(pathname)
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

		if (request.method === 'PUT') {
			if (pathname === '/api/settings') {
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handlePutSettings(writeProjectSettings, body)
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
