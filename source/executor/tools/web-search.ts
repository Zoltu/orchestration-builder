import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { parseKagiSearchResults } from './kagi.js'

export type KagiSearch = (query: string, limit: number, timeoutMs: number) => Promise<unknown>

export interface WebSearchOptions {
	search: KagiSearch | undefined
	timeoutMs: number
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

// The kagi client throws plain Errors, so its HTTP-status failures are recognized by the message
// shape it guarantees ("Kagi <operation> failed: HTTP <status>"); any other throw is a network
// failure or abort and maps to "timeout".
function isKagiHttpFailure(message: string): boolean {
	return message.startsWith('Kagi') && message.includes('HTTP')
}

export function createWebSearch(options: WebSearchOptions): ToolHandler {
	return async (args) => {
		const queryValue = args['query']
		if (typeof queryValue !== 'string' || queryValue.trim() === '') {
			return createToolError('invalid_arguments', 'query must be a non-empty string')
		}
		const limitValue = args['limit']
		let limit = DEFAULT_LIMIT
		if (limitValue !== undefined) {
			if (typeof limitValue !== 'number' || !Number.isInteger(limitValue) || limitValue <= 0) {
				return createToolError('invalid_arguments', 'limit must be a positive integer; values above 10 are clamped to 10')
			}
			limit = Math.min(limitValue, MAX_LIMIT)
		}
		if (options.search === undefined) {
			return createToolError('unavailable', 'web_search is not configured: KAGI_API_KEY is not set')
		}
		let body: unknown
		try {
			body = await options.search(queryValue.trim(), limit, options.timeoutMs)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (isKagiHttpFailure(message)) return createToolError('unavailable', message)
			return createToolError('timeout', message)
		}
		const results = parseKagiSearchResults(body)
		if (results === undefined) {
			return createToolError('unavailable', 'Kagi search returned an unexpected response shape')
		}
		return { kind: 'success', data: results }
	}
}
