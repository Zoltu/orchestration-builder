import { describe, expect, test } from 'bun:test'
import { createWebSearch, type KagiSearch } from './web-search.ts'

interface SearchCall {
	query: string
	limit: number
	timeoutMs: number
}

function makeSearch(response: unknown, opts: { error?: unknown } = {}): KagiSearch & { calls: SearchCall[] } {
	const calls: SearchCall[] = []
	const search: KagiSearch & { calls: SearchCall[] } = async (query, limit, timeoutMs) => {
		calls.push({ query, limit, timeoutMs })
		if (opts.error !== undefined) throw opts.error
		return response
	}
	search.calls = calls
	return search
}

const SEARCH_BODY = {
	meta: { id: 'abc' },
	data: {
		search: [
			{ url: 'https://a.example', title: 'Result A', snippet: 'alpha', time: '2026-01-01T00:00:00Z' },
			{ url: 'https://b.example', title: 'Result B' },
		],
	},
}

describe('createWebSearch', () => {
	test('returns parsed results on success', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'kagi api' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toEqual([
				{ url: 'https://a.example', title: 'Result A', snippet: 'alpha', time: '2026-01-01T00:00:00Z' },
				{ url: 'https://b.example', title: 'Result B' },
			])
		}
		expect(search.calls).toEqual([{ query: 'kagi api', limit: 5, timeoutMs: 5000 }])
	})

	test('trims surrounding whitespace from the query', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		await handler({ query: '  kagi api  ' })
		expect(search.calls[0]?.query).toBe('kagi api')
	})

	test('treats an absent search bucket as success with an empty array', async () => {
		const search = makeSearch({ meta: {}, data: {} })
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'nothing' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toEqual([])
		}
	})

	test('treats an empty search bucket as success with an empty array', async () => {
		const search = makeSearch({ meta: {}, data: { search: [] } })
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'nothing' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toEqual([])
		}
	})

	test('rejects a missing query', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({})
		expect(result.kind).toBe('invalid_arguments')
		expect(search.calls).toEqual([])
	})

	test('rejects an empty query', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		expect((await handler({ query: '' })).kind).toBe('invalid_arguments')
		expect((await handler({ query: '   ' })).kind).toBe('invalid_arguments')
		expect(search.calls).toEqual([])
	})

	test('rejects a non-string query', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 123 })
		expect(result.kind).toBe('invalid_arguments')
		expect(search.calls).toEqual([])
	})

	test('rejects a non-number limit', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q', limit: '5' })
		expect(result.kind).toBe('invalid_arguments')
		expect(search.calls).toEqual([])
	})

	test('rejects a zero limit', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q', limit: 0 })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a negative limit', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q', limit: -2 })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a non-integer limit', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q', limit: 2.5 })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('clamps a limit above 10 to 10', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q', limit: 25 })
		expect(result.kind).toBe('success')
		expect(search.calls[0]?.limit).toBe(10)
	})

	test('passes an explicit limit through', async () => {
		const search = makeSearch(SEARCH_BODY)
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q', limit: 3 })
		expect(result.kind).toBe('success')
		expect(search.calls[0]?.limit).toBe(3)
	})

	test('is unavailable when search is not configured', async () => {
		const handler = createWebSearch({ search: undefined, timeoutMs: 5000 })
		const result = await handler({ query: 'q' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('web_search is not configured: ORCHESTRATOR_KAGI_API_KEY is not set')
		}
	})

	test('maps a wrong-shaped response to unavailable', async () => {
		const search = makeSearch({ unexpected: true })
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Kagi search returned an unexpected response shape')
		}
	})

	test('maps a client HTTP failure to unavailable', async () => {
		const search = makeSearch(null, { error: new Error('Kagi search failed: HTTP 429: rate limit or balance exhausted') })
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Kagi search failed: HTTP 429: rate limit or balance exhausted')
		}
	})

	test('maps a network failure to timeout', async () => {
		const search = makeSearch(null, { error: new Error('network down') })
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q' })
		expect(result.kind).toBe('timeout')
		if (result.kind !== 'success') {
			expect(result.message).toBe('network down')
		}
	})

	test('maps a non-Error throw to timeout', async () => {
		const search = makeSearch(null, { error: 'boom' })
		const handler = createWebSearch({ search, timeoutMs: 5000 })
		const result = await handler({ query: 'q' })
		expect(result.kind).toBe('timeout')
		if (result.kind !== 'success') {
			expect(result.message).toBe('boom')
		}
	})
})
