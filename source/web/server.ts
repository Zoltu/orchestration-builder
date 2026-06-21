// Web UI server.
// A thin HTTP leaf built on Bun.serve: it routes requests, serves the plain static assets, and delegates JSON shaping to render.ts and question/answer handling to the RunState façade from source/executor/run-state.ts.
// No business logic lives here.

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReadRunSnapshot } from '../executor/persistence.js'
import type { RunState } from '../executor/run-state.js'
import { parseRunSnapshot, renderPendingQuestions, renderRunView } from './render.js'

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'static')
const MAX_LOG_LINES = 200

interface StaticAsset {
	fileName: string
	contentType: string
}

const STATIC_ASSETS: Record<string, StaticAsset> = {
	'/': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
	'/app.js': { fileName: 'app.js', contentType: 'text/javascript; charset=utf-8' },
	'/styles.css': { fileName: 'styles.css', contentType: 'text/css; charset=utf-8' },
}

export interface WebServerConfig {
	port: number
	runState: RunState
	readRunSnapshot: ReadRunSnapshot
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
	return new Response(file, { headers: { 'content-type': asset.contentType } })
}

function handleGetRun(readRunSnapshot: ReadRunSnapshot): Response {
	const raw = readRunSnapshot()
	const snapshot = parseRunSnapshot(raw)
	const view = renderRunView(snapshot, { maxLogLines: MAX_LOG_LINES })
	return json(view)
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

export function createWebServer(config: WebServerConfig): WebServer {
	const runState = config.runState
	const readRunSnapshot = config.readRunSnapshot

	const server = Bun.serve({
		port: config.port,
		fetch(request) {
			const { pathname } = new URL(request.url)

			if (request.method === 'GET') {
				if (pathname === '/api/run') return handleGetRun(readRunSnapshot)
				if (pathname === '/api/questions') return json(renderPendingQuestions(runState.pendingQuestions()))
				const asset = STATIC_ASSETS[pathname]
				if (asset !== undefined) return serveStaticAsset(asset)
				return json({ ok: false, error: 'not_found' }, 404)
			}

			if (request.method === 'POST' && pathname === '/api/answer') {
				return request
					.text()
					.then(
						(raw) => {
							let parsed: unknown
							try {
								parsed = JSON.parse(raw)
							} catch {
								return json({ ok: false, error: 'invalid_body' }, 400)
							}
							return handleAnswer(runState, parsed)
						},
						() => json({ ok: false, error: 'invalid_body' }, 400),
					)
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
