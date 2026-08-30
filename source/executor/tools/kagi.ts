import * as fs from 'node:fs'
import * as path from 'node:path'
import { isObject } from '../validation.js'

export interface KagiSearchResult {
	title: string
	url: string
	snippet?: string
	time?: string
}

export interface KagiClient {
	search(query: string, limit: number, timeoutMs: number): Promise<unknown>
	extract(url: string, timeoutMs: number): Promise<unknown>
}

export interface KagiClientDependencies {
	fetchImpl?: typeof globalThis.fetch
}

const KAGI_SEARCH_URL = 'https://kagi.com/api/v1/search'
const KAGI_EXTRACT_URL = 'https://kagi.com/api/v1/extract'

function isKagiSearchItem(value: unknown): value is { url: string; title: string; snippet?: string; time?: string } {
	if (!isObject(value)) return false
	if (typeof value.url !== 'string') return false
	if (typeof value.title !== 'string') return false
	if (value.snippet !== undefined && typeof value.snippet !== 'string') return false
	if (value.time !== undefined && typeof value.time !== 'string') return false
	return true
}

export function parseKagiSearchResults(body: unknown): KagiSearchResult[] | undefined {
	if (!isObject(body)) return undefined
	if (!isObject(body.data)) return undefined
	if (body.data.search === undefined) return []
	if (!Array.isArray(body.data.search)) return undefined
	const results: KagiSearchResult[] = []
	for (const item of body.data.search) {
		if (!isKagiSearchItem(item)) return undefined
		const result: KagiSearchResult = { title: item.title, url: item.url }
		if (item.snippet !== undefined) result.snippet = item.snippet
		if (item.time !== undefined) result.time = item.time
		results.push(result)
	}
	return results
}

export function parseKagiExtractMarkdown(body: unknown): string | undefined {
	if (!isObject(body)) return undefined
	if (!Array.isArray(body.data)) return undefined
	const page = body.data[0]
	if (!isObject(page)) return undefined
	if (typeof page.error === 'string') return undefined
	if (typeof page.markdown !== 'string' || page.markdown === '') return undefined
	return page.markdown
}

export function extractKagiErrorMessage(body: unknown): string | undefined {
	if (!isObject(body)) return undefined
	if (!Array.isArray(body.error)) return undefined
	const entry = body.error[0]
	if (!isObject(entry)) return undefined
	if (typeof entry.message === 'string' && entry.message !== '') return entry.message
	if (typeof entry.code === 'string') return entry.code
	return undefined
}

// The client returns the body as unknown on purpose: shape validation is the caller's job via the
// guards above, keeping this leaf a thin wire wrapper. HTTP failures throw Errors whose messages
// contain "HTTP <status>" — web-search.ts relies on that marker to classify failures — and timeout
// aborts propagate as the fetch's own AbortError, which fetch-url.ts matches by name.
export function createKagiClient(apiKey: string, dependencies: KagiClientDependencies = {}): KagiClient {
	const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
	async function post(operation: string, url: string, payload: unknown, timeoutMs: number): Promise<unknown> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetchImpl(url, {
				method: 'POST',
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				signal: controller.signal,
			})
			if (response.status !== 200) {
				const detail = await readErrorMessage(response)
				const suffix = detail === undefined ? '' : `: ${detail}`
				throw new Error(`Kagi ${operation} failed: HTTP ${response.status}${suffix}`)
			}
			const body: unknown = await response.json()
			return body
		} finally {
			clearTimeout(timer)
		}
	}
	return {
		search: (query, limit, timeoutMs) => post('search', KAGI_SEARCH_URL, { query, limit }, timeoutMs),
		extract: (url, timeoutMs) => post('extract', KAGI_EXTRACT_URL, { pages: [{ url }] }, timeoutMs),
	}
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
	let body: unknown
	try {
		body = await response.json()
	} catch {
		return undefined
	}
	return extractKagiErrorMessage(body)
}

export function createDockerSecretReader(secretsDir: string): (name: string) => string | undefined {
	return (name) => {
		const secretPath = path.join(secretsDir, name)
		if (!fs.existsSync(secretPath)) return undefined
		const contents = fs.readFileSync(secretPath, 'utf8').trim()
		if (contents === '') return undefined
		return contents
	}
}

// Docker secrets are conventionally named in lowercase; the uppercase variant covers deployments
// that mount the secret under the environment variable's name.
export function resolveKagiApiKey(environment: Record<string, string | undefined>, readSecret: (name: string) => string | undefined): string | undefined {
	const fromEnvironment = environment.KAGI_API_KEY?.trim()
	if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
	const fromLowercaseSecret = readSecret('kagi_api_key')
	if (fromLowercaseSecret !== undefined && fromLowercaseSecret !== '') return fromLowercaseSecret
	const fromUppercaseSecret = readSecret('KAGI_API_KEY')
	if (fromUppercaseSecret !== undefined && fromUppercaseSecret !== '') return fromUppercaseSecret
	return undefined
}
