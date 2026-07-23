

import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ListRunIds, ReadProjectSettings, ReadRunMetaById, ReadRunSnapshotStats, WriteProjectSettings } from '../executor/persistence.js'
import type { EffortLevel, GuildConfig, ToolManifest } from '../executor/types.js'
import { isEffortLevel, isObject } from '../executor/validation.js'
import type { RunState } from '../executor/run-state.js'
import type { RunSubmission } from '../executor/run-submission.js'
import { paginateLogEvents, parseRunMeta, renderConfig, renderProjectSettings, renderPendingQuestions, renderRunSummary, renderRunView, formatLogAsText, toRecentLogEntry } from './render.js'
import { deriveInteractionModel } from './interaction-model-adapter.js'
import { DEMO_SCENARIOS, deriveDemoFrameModel, findDemoScenario } from './demo-fixtures.js'
import type { ReadRunSnapshot } from './snapshot-cache.js'

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
	tools: Record<string, ToolManifest>
	runState: RunState
	runSubmission: RunSubmission
	readRunSnapshot: ReadRunSnapshot
	readRunMetaById: ReadRunMetaById
	readRunSnapshotStats: ReadRunSnapshotStats
	listRunIds: ListRunIds
	readProjectSettings: ReadProjectSettings
	writeProjectSettings: WriteProjectSettings
}

export interface WebServer {
	port: number
	stop(): void
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

function handleActiveRun(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runSubmission: RunSubmission): Response {
	const runId = runSubmission.lastRunId()
	if (runId === undefined) return json({ ok: false, error: 'no_run' }, 404)
	const view = runViewFor(readRunSnapshot, readRunSnapshotStats, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	return json(view)
}

function handleActiveRunFlow(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runSubmission: RunSubmission): Response {
	const runId = runSubmission.lastRunId()
	if (runId === undefined) return json({ ok: false, error: 'no_run' }, 404)
	return runFlowPage(readRunSnapshot, readRunSnapshotStats, runId)
}

function handleGetRunById(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runId: string): Response {
	const view = runViewFor(readRunSnapshot, readRunSnapshotStats, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	return json(view)
}

function runLogPage(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runId: string, query: URLSearchParams): Response {
	if (!isKnownRun(readRunSnapshotStats, runId)) return json({ ok: false, error: 'not_found' }, 404)
	const snapshot = readRunSnapshot(runId)
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

// Serves the structured InteractionModel derived from a run's full snapshot.
// The model is JSON (identifiers, counters, costs as values; agent prose as markdown strings in `details`); the client renders `details` only through the sanitized Markdown pipeline, so the server does not sanitize — it must not serve pre-rendered HTML that would bypass the client's sanitization.
function runFlowPage(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runId: string): Response {
	if (!isKnownRun(readRunSnapshotStats, runId)) return json({ ok: false, error: 'not_found' }, 404)
	const snapshot = readRunSnapshot(runId)
	return json(deriveInteractionModel(snapshot, new Date().toISOString()))
}

function runViewFor(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runId: string): ReturnType<typeof renderRunView> | null {
	if (!isKnownRun(readRunSnapshotStats, runId)) return null
	const snapshot = readRunSnapshot(runId)
	return renderRunView(snapshot, { maxLogLines: MAX_LOG_LINES, now: new Date().toISOString() })
}

// Feeds the scenario's first `frameIndex + 1` events through the real adapter — the same derivation the product's `/api/runs/:id/flow` runs — so the demo harness exercises the product's `LogEvent → InteractionModel` path rather than authored model frames.
function demoFrameModel(scenarioId: string, frameIndex: number): Response {
	const scenario = findDemoScenario(scenarioId)
	if (scenario === undefined) return json({ ok: false, error: 'not_found' }, 404)
	if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= scenario.events.length) {
		return json({ ok: false, error: 'not_found' }, 404)
	}
	return json(deriveDemoFrameModel(scenario, frameIndex))
}

// The manifest includes the scenario's full participant set (taken from the final frame's model) so the sequence view can lay out every column from the first frame, the same role the product's static guild participant inventory plays for a live run.
function handleDemoScenarios(): Response {
	const manifests = DEMO_SCENARIOS.map((scenario) => {
		const lastFrame = deriveDemoFrameModel(scenario, scenario.events.length - 1)
		return { id: scenario.id, label: scenario.label, frameCount: scenario.events.length, participants: lastFrame.participants }
	})
	return json(manifests)
}

function isKnownRun(readRunSnapshotStats: ReadRunSnapshotStats, runId: string): boolean {
	const stats = readRunSnapshotStats(runId)
	return stats.meta !== null || stats.log !== null
}

function handleListRuns(readRunMetaById: ReadRunMetaById, listRunIds: ListRunIds): Response {
	const summaries = listRunIds()
		.slice()
		.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
		.map((runId) => renderRunSummary(runId, parseRunMeta(readRunMetaById(runId))))
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
	const readRunSnapshot = config.readRunSnapshot
	const readRunMetaById = config.readRunMetaById
	const readRunSnapshotStats = config.readRunSnapshotStats
	const listRunIds = config.listRunIds
	const readProjectSettings = config.readProjectSettings
	const writeProjectSettings = config.writeProjectSettings

	const server = Bun.serve({
		port: config.port,
		async fetch(request) {
			const url = new URL(request.url)
			const { pathname } = url

			if (request.method === 'GET') {
				if (pathname === '/api/config') return json(renderConfig(guildConfig, config.tools))
				if (pathname === '/api/settings') return handleGetSettings(readProjectSettings)
				if (pathname === '/api/run/flow') return handleActiveRunFlow(readRunSnapshot, readRunSnapshotStats, runSubmission)
				if (pathname === '/api/run') return handleActiveRun(readRunSnapshot, readRunSnapshotStats, runSubmission)
				if (pathname === '/api/runs') return handleListRuns(readRunMetaById, listRunIds)
				if (pathname.startsWith('/api/runs/')) {
					const rest = decodeURIComponent(pathname.slice('/api/runs/'.length))
					// Match a /log or /flow suffix before the bare :id route so /api/runs/<id>/log and /api/runs/<id>/flow reach their endpoints rather than being swallowed as a run id of "<id>/log" or "<id>/flow".
					const slashIndex = rest.lastIndexOf('/')
					if (slashIndex >= 0) {
						const suffix = rest.slice(slashIndex + 1)
						const runId = rest.slice(0, slashIndex)
						if (runId !== '') {
							if (suffix === 'log') return runLogPage(readRunSnapshot, readRunSnapshotStats, runId, url.searchParams)
							if (suffix === 'flow') return runFlowPage(readRunSnapshot, readRunSnapshotStats, runId)
						}
					}
					return handleGetRunById(readRunSnapshot, readRunSnapshotStats, rest)
				}
				if (pathname === '/api/questions') return json(renderPendingQuestions(runState.pendingQuestions()))
				if (pathname === '/api/demo/scenarios') return handleDemoScenarios()
				if (pathname.startsWith('/api/demo/flow/')) {
					const rest = decodeURIComponent(pathname.slice('/api/demo/flow/'.length))
					const slashIndex = rest.lastIndexOf('/')
					if (slashIndex >= 0) {
						const scenarioId = rest.slice(0, slashIndex)
						const frameRaw = rest.slice(slashIndex + 1)
						const frameIndex = Number(frameRaw)
						if (scenarioId !== '' && Number.isInteger(frameIndex)) return demoFrameModel(scenarioId, frameIndex)
					}
					return json({ ok: false, error: 'not_found' }, 404)
				}
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
