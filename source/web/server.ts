import * as path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequestHandler, type RequestHandlerConfig, type ServeStatic } from './request-handler.js'
import { renderIndexHtmlWithPageTitle } from './page-title.js'
import type { StreamHub } from './stream-hub.js'

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'static')

// The single websocket endpoint: the only path the fetch branch upgrades, carrying the live delta stream served by the StreamHub (see stream-hub.ts).
const STREAM_PATH = '/ws/stream'

// Content-type by file extension. The static directory holds only these asset kinds, so a small map covers the surface; an unknown extension falls back to a generic binary type so the browser never receives a wrong MIME that would block a module load.
const CONTENT_TYPES: Record<string, string> = {
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.json': 'application/json; charset=utf-8',
}

export interface WebServerConfig extends RequestHandlerConfig {
	port: number
	// The browser tab title substituted into the served index.html (see page-title.ts); resolved from ORCHESTRATOR_TITLE in serve.ts.
	pageTitle: string
	// The live-delta fan-out hub; optional so plain HTTP compositions (tests, the bootstrap-failure server in serve.ts) build without one. When present, GET /ws/stream upgrades to a websocket routed through the hub's handlers.
	streamHub?: StreamHub
}

export interface WebServer {
	port: number
	stop(): void
}

export interface StaticAsset {
	resolvedPath: string
	contentType: string
}

// Maps a request path to a file inside the static dir, or null when the path escapes it. The separator check rejects `..` segments that resolve outside the static dir (e.g. `/../source/web/server.ts`), preserving the traversal safety the explicit route map gave for free. Raw `.ts` sources are refused outright: they are the authoring format and are never shipped to the browser — the browser-facing URL for a converted module is its `.js` path (see resolveTypeScriptSourceAsset).
export function resolveStaticAsset(staticDir: string, requestPath: string): StaticAsset | null {
	const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1)
	const resolvedPath = path.resolve(staticDir, relativePath)
	if (!resolvedPath.startsWith(staticDir + path.sep)) return null
	const extension = path.extname(resolvedPath)
	if (extension === '.ts') return null
	return { resolvedPath, contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' }
}

// The TypeScript source behind a browser-facing module URL: a `.js` request outside `vendor/` is served from `ts/<same path>.ts` when that source exists, so converted modules keep their pre-conversion URLs and their import specifiers never change. Null when the request is not a module URL, targets the vendored third-party files (always served verbatim), or would escape the static dir — the same separator check as resolveStaticAsset.
export function resolveTypeScriptSourceAsset(staticDir: string, requestPath: string): StaticAsset | null {
	if (!requestPath.endsWith('.js')) return null
	const relativePath = requestPath.slice(1)
	if (relativePath.startsWith('vendor/')) return null
	const resolvedPath = path.resolve(staticDir, 'ts', `${relativePath.slice(0, -'.js'.length)}.ts`)
	if (!resolvedPath.startsWith(staticDir + path.sep)) return null
	return { resolvedPath, contentType: CONTENT_TYPES['.js'] ?? 'application/octet-stream' }
}

function notFound(): Response {
	return new Response(JSON.stringify({ ok: false, error: 'not_found' }), {
		status: 404,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

// The filesystem leaf behind the static handler: streams the resolved asset, or null when the file does not exist. Held separate from createServeStatic so the serve-time title substitution (an orchestration concern) is exercisable in-memory with a fake reader (see server.test.ts).
export type ServeAssetFile = (asset: StaticAsset) => Response | null

export function createServeAssetFile(): ServeAssetFile {
	return (asset) => {
		if (!existsSync(asset.resolvedPath)) return null
		// no-store keeps the dev server from caching stale assets (or stale 404s) across restarts, so an edit to app.js is always picked up on the next page load.
		return new Response(Bun.file(asset.resolvedPath), {
			headers: {
				'content-type': asset.contentType,
				'cache-control': 'no-store',
			},
		})
	}
}

// The filesystem access the TypeScript-serving leaf reads; null is the "no source converted yet" signal that falls back to the real file. Injectable so the transpile pipeline is exercisable in-memory, mirroring PathFilesystem in executor/tools/shared.ts.
export interface TypeScriptSourceFilesystem {
	readSource(sourcePath: string): string | null
}

export const nodeTypeScriptSourceFilesystem: TypeScriptSourceFilesystem = {
	readSource: (sourcePath) => existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : null,
}

// Transpiles the mapped TS source into browser JavaScript on every request. No result cache: the no-store edit-and-refresh contract must keep working and ~25 small files transpile in trivial time. A source that fails to transpile throws — a broken module must be loud, not fall back to a 404 for a file that does not exist.
export function createServeTypeScriptSource(filesystem: TypeScriptSourceFilesystem): ServeAssetFile {
	const transpiler = new Bun.Transpiler({ loader: 'ts' })
	return (asset) => {
		const source = filesystem.readSource(asset.resolvedPath)
		if (source === null) return null
		return new Response(transpiler.transformSync(source), {
			headers: {
				'content-type': asset.contentType,
				'cache-control': 'no-store',
			},
		})
	}
}

export interface ServeStaticConfig {
	staticDir: string
	pageTitle: string
	serveAssetFile: ServeAssetFile
	serveTypeScriptSource: ServeAssetFile
}

export function createServeStatic(config: ServeStaticConfig): ServeStatic {
	return async (requestPath) => {
		const typeScriptSource = resolveTypeScriptSourceAsset(config.staticDir, requestPath)
		if (typeScriptSource !== null) {
			const sourceResponse = config.serveTypeScriptSource(typeScriptSource)
			if (sourceResponse !== null) return sourceResponse
		}
		const asset = resolveStaticAsset(config.staticDir, requestPath)
		if (asset === null) return notFound()
		const assetResponse = config.serveAssetFile(asset)
		if (assetResponse === null) return notFound()
		// Only the app shell's title is substituted; every other asset (and any other HTML page such as the demo harness) passes through untouched.
		if (asset.resolvedPath !== path.resolve(config.staticDir, 'index.html')) return assetResponse
		const html = await assetResponse.text()
		return new Response(renderIndexHtmlWithPageTitle(html, config.pageTitle), { status: assetResponse.status, headers: assetResponse.headers })
	}
}

// The Bun websocket handler set, mapping the three connection events onto the hub. Bun's ServerWebSocket satisfies StreamSocket structurally, so sockets pass through unadapted; the only translation is Bun's binary message variant, decoded to text because the stream protocol is JSON-only. This is glue that Bun calls on real sockets, so it is not unit-tested — the hub itself is, against fake sockets (see stream-hub.test.ts).
function createWebSocketHandlers(streamHub: StreamHub): Bun.WebSocketHandler<undefined> {
	return {
		open: (socket) => streamHub.onOpen(socket),
		message: (socket, message) => streamHub.onMessage(socket, typeof message === 'string' ? message : message.toString()),
		close: (socket) => streamHub.onClose(socket),
	}
}

export function createWebServer(config: WebServerConfig): WebServer {
	const handleRequest = createRequestHandler(config, createServeStatic({
		staticDir: STATIC_DIR,
		pageTitle: config.pageTitle,
		serveAssetFile: createServeAssetFile(),
		serveTypeScriptSource: createServeTypeScriptSource(nodeTypeScriptSourceFilesystem),
	}))
	const streamHub = config.streamHub
	// Two option shapes because Bun's types require a definite `websocket` key when one is present. The upgrade branch intercepts before the request handler: a websocket client GETs the stream path with upgrade headers and server.upgrade answers the 101 handshake, after which Bun requires no response (hence the undefined return). A false return — a plain GET of the path — falls through to the normal handler like any other request.
	const server = streamHub === undefined
		? Bun.serve({
				port: config.port,
				fetch: (request) => handleRequest(request),
			})
		: Bun.serve({
				port: config.port,
				fetch: (request, server) => {
					if (new URL(request.url).pathname === STREAM_PATH && server.upgrade(request)) return undefined
					return handleRequest(request)
				},
				websocket: createWebSocketHandlers(streamHub),
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
