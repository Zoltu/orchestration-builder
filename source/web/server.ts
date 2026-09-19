import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequestHandler, type RequestHandlerConfig, type ServeStatic } from './request-handler.js'
import { renderIndexHtmlWithPageTitle } from './page-title.js'

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'static')

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
}

export interface WebServer {
	port: number
	stop(): void
}

export interface StaticAsset {
	resolvedPath: string
	contentType: string
}

// Maps a request path to a file inside the static dir, or null when the path escapes it. The separator check rejects `..` segments that resolve outside the static dir (e.g. `/../source/web/server.ts`), preserving the traversal safety the explicit route map gave for free.
export function resolveStaticAsset(staticDir: string, requestPath: string): StaticAsset | null {
	const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1)
	const resolvedPath = path.resolve(staticDir, relativePath)
	if (!resolvedPath.startsWith(staticDir + path.sep)) return null
	const extension = path.extname(resolvedPath)
	return { resolvedPath, contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' }
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

export interface ServeStaticConfig {
	staticDir: string
	pageTitle: string
	serveAssetFile: ServeAssetFile
}

export function createServeStatic(config: ServeStaticConfig): ServeStatic {
	return async (requestPath) => {
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

export function createWebServer(config: WebServerConfig): WebServer {
	const server = Bun.serve({
		port: config.port,
		fetch: createRequestHandler(config, createServeStatic({ staticDir: STATIC_DIR, pageTitle: config.pageTitle, serveAssetFile: createServeAssetFile() })),
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
