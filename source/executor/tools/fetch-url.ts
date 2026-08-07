import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { parseKagiExtractMarkdown } from './kagi.js'

export type Fetcher = (url: string, timeoutMs: number) => Promise<string>

export interface DefaultFetcherDependencies {
	fetchImpl?: typeof globalThis.fetch
	setTimeoutImpl?: (callback: () => void, ms: number) => number
	clearTimeoutImpl?: (id: number) => void
}

export type FetchMethod = 'auto' | 'direct' | 'kagi' | 'markdown_new'

export type KagiExtract = (url: string, timeoutMs: number) => Promise<unknown>

export interface FetchUrlOptions {
	fetcher?: Fetcher
	kagiExtract?: KagiExtract
	markdownNewFetcher?: Fetcher
}

interface FetchBackend {
	name: string
	run: Fetcher
}

export const DEFAULT_MAX_BYTES = 1024 * 1024

const FETCH_METHODS: readonly FetchMethod[] = ['auto', 'direct', 'kagi', 'markdown_new']

function isFetchMethod(value: string): value is FetchMethod {
	return FETCH_METHODS.some((method) => method === value)
}

export function createFetchUrl(timeoutMs: number, options: FetchUrlOptions = {}): ToolHandler {
	const directFetcher = options.fetcher ?? createDefaultFetcher()
	const markdownNewFetcher = options.markdownNewFetcher ?? createMarkdownNewFetcher()
	const kagiFetcher = options.kagiExtract === undefined ? undefined : wrapKagiExtract(options.kagiExtract)
	return async (args) => {
		const urlValue = args['url']
		if (typeof urlValue !== 'string' || urlValue === '') {
			return createToolError('invalid_arguments', 'url must be a non-empty string')
		}
		let parsed: URL
		try {
			parsed = new URL(urlValue)
		} catch {
			return createToolError('invalid_arguments', `Invalid URL: ${urlValue}`)
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return createToolError('invalid_arguments', `Unsupported protocol: ${parsed.protocol}`)
		}
		const methodValue = args['method']
		let method: FetchMethod = 'auto'
		if (methodValue !== undefined) {
			if (typeof methodValue !== 'string' || !isFetchMethod(methodValue)) {
				return createToolError('invalid_arguments', `method must be one of: ${FETCH_METHODS.join(', ')}`)
			}
			method = methodValue
		}
		if (method === 'kagi' && kagiFetcher === undefined) {
			return createToolError('unavailable', 'fetch_url method "kagi" requires KAGI_API_KEY, which is not set')
		}
		const backends: FetchBackend[] = []
		if ((method === 'auto' || method === 'kagi') && kagiFetcher !== undefined) {
			backends.push({ name: 'kagi', run: kagiFetcher })
		}
		if (method === 'auto' || method === 'markdown_new') {
			backends.push({ name: 'markdown_new', run: markdownNewFetcher })
		}
		if (method === 'auto' || method === 'direct') {
			backends.push({ name: 'direct', run: directFetcher })
		}
		const failures: Array<{ name: string; message: string }> = []
		for (const backend of backends) {
			try {
				const text = await backend.run(urlValue, timeoutMs)
				if (text.length > DEFAULT_MAX_BYTES) {
					return { kind: 'success', data: text.slice(0, DEFAULT_MAX_BYTES) }
				}
				return { kind: 'success', data: text }
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				failures.push({ name: backend.name, message })
			}
		}
		const detail = failures.map((failure) => `via ${failure.name} (${failure.message})`).join('; ')
		const kind = failures.some((failure) => isHttpStatusFailure(failure.message)) ? 'unavailable' : 'timeout'
		return createToolError(kind, `Fetch failed ${detail}`)
	}
}

function wrapKagiExtract(kagiExtract: KagiExtract): Fetcher {
	return async (url, timeoutMs) => {
		const body = await kagiExtract(url, timeoutMs)
		const markdown = parseKagiExtractMarkdown(body)
		if (markdown === undefined) {
			throw new Error(`Kagi extract returned no markdown for ${url}`)
		}
		return markdown
	}
}

// Backends report HTTP-status failures as Error messages containing "HTTP <status>" (see kagi.ts
// and createMarkdownNewFetcher); any other throw is a network failure or abort and maps to "timeout".
function isHttpStatusFailure(message: string): boolean {
	return message.includes('HTTP ')
}

export function createMarkdownNewFetcher(dependencies: { fetchImpl?: typeof globalThis.fetch } = {}): Fetcher {
	const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
	return async (url, timeoutMs) => {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetchImpl('https://markdown.new/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url }),
				signal: controller.signal,
			})
			if (response.status !== 200) {
				throw new Error(`markdown.new failed: HTTP ${response.status}`)
			}
			return await response.text()
		} finally {
			clearTimeout(timer)
		}
	}
}

export function createDefaultFetcher(deps: DefaultFetcherDependencies = {}): Fetcher {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch
	const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout
	const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout
	return async (url, timeoutMs) => {
		const controller = new AbortController()
		const timer = setTimeoutImpl(() => controller.abort(), timeoutMs)
		try {
			const response = await fetchImpl(url, { signal: controller.signal })
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`)
			}
			return await response.text()
		} finally {
			clearTimeoutImpl(timer)
		}
	}
}
