import { createToolError } from '../../shared/errors.js'
import type { ToolHandler } from '../tool-dispatch.js'

export type Fetcher = (url: string, timeoutMs: number) => Promise<string>

export interface DefaultFetcherDependencies {
	fetchImpl?: typeof globalThis.fetch
	setTimeoutImpl?: (callback: () => void, ms: number) => number
	clearTimeoutImpl?: (id: number) => void
}

const DEFAULT_MAX_BYTES = 1024 * 1024

export function createFetchUrl(timeoutMs: number, fetcher?: Fetcher): ToolHandler {
	const fetchImpl: Fetcher = fetcher ?? defaultFetcher
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
		try {
			const text = await fetchImpl(urlValue, timeoutMs)
			if (text.length > DEFAULT_MAX_BYTES) {
				return { kind: 'success', data: text.slice(0, DEFAULT_MAX_BYTES) }
			}
			return { kind: 'success', data: text }
		} catch (error) {
			const message = error instanceof Error ? error.message : 'fetch failed'
			return createToolError('timeout', `Fetch failed: ${message}`)
		}
	}
}

export function defaultFetcher(url: string, timeoutMs: number): Promise<string> {
	return createDefaultFetcher()(url, timeoutMs)
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