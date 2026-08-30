import { describe, expect, test } from 'bun:test'
import type { Fetcher, KagiExtract } from './fetch-url.ts'
import { createDefaultFetcher, createFetchUrl, FetchTimeoutError } from './fetch-url.ts'

interface FetcherCall {
	url: string
	timeoutMs: number
}

function makeFetcher(body: string, opts: { error?: Error } = {}): Fetcher & { calls: FetcherCall[] } {
	const calls: FetcherCall[] = []
	const fetcher: Fetcher & { calls: FetcherCall[] } = async (url: string, timeoutMs: number) => {
		calls.push({ url, timeoutMs })
		if (opts.error !== undefined) throw opts.error
		return body
	}
	fetcher.calls = calls
	return fetcher
}

function makeKagiExtract(body: unknown, opts: { error?: Error } = {}): KagiExtract & { calls: FetcherCall[] } {
	const calls: FetcherCall[] = []
	const extract: KagiExtract & { calls: FetcherCall[] } = async (url: string, timeoutMs: number) => {
		calls.push({ url, timeoutMs })
		if (opts.error !== undefined) throw opts.error
		return body
	}
	extract.calls = calls
	return extract
}

describe('createFetchUrl', () => {
	test('returns the body string when fetcher succeeds', async () => {
		const fetcher = makeFetcher('hello world')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com/path', method: 'direct' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toBe('hello world')
		}
		expect(fetcher.calls).toEqual([{ url: 'https://example.com/path', timeoutMs: 5000 }])
	})

	test('passes the configured timeout to the fetcher', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(1234, { fetcher })
		await handler({ url: 'https://example.com', method: 'direct' })
		expect(fetcher.calls).toEqual([{ url: 'https://example.com', timeoutMs: 1234 }])
	})

	test('rejects an empty url with invalid_arguments', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: '', method: 'direct' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a non-string url', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 123, method: 'direct' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects an unparseable URL', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'not a url', method: 'direct' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects non-http(s) protocols', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'file:///etc/passwd', method: 'direct' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('maps a network failure to unavailable', async () => {
		const fetcher = makeFetcher('', { error: new Error('network down') })
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 'direct' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Fetch failed via direct (network down)')
		}
	})

	test('maps an HTTP-status failure to unavailable', async () => {
		const fetcher = makeFetcher('', { error: new Error('HTTP 404') })
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 'direct' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Fetch failed via direct (HTTP 404)')
		}
	})

	test('maps a backend timeout to timeout', async () => {
		const fetcher = makeFetcher('', { error: new FetchTimeoutError('fetch timed out after 5000ms') })
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 'direct' })
		expect(result.kind).toBe('timeout')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Fetch failed via direct (fetch timed out after 5000ms)')
		}
	})

	test('maps a kagi abort to timeout', async () => {
		const abort = new Error('This operation was aborted')
		abort.name = 'AbortError'
		const kagiExtract = makeKagiExtract(null, { error: abort })
		const handler = createFetchUrl(5000, { kagiExtract })
		const result = await handler({ url: 'https://example.com', method: 'kagi' })
		expect(result.kind).toBe('timeout')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Fetch failed via kagi (This operation was aborted)')
		}
	})

	test('stringifies a non-Error throw', async () => {
		const fetcher: Fetcher = async () => {
			throw 'boom'
		}
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 'direct' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Fetch failed via direct (boom)')
		}
	})

	test('truncates a very large body to 1 MB', async () => {
		const large = 'x'.repeat(2 * 1024 * 1024)
		const fetcher = makeFetcher(large)
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 'direct' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && typeof result.data === 'string') {
			expect(result.data.length).toBe(1024 * 1024)
		}
	})

	test('rejects an unknown method', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 'smoke' })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind !== 'success') {
			expect(result.message).toBe('method must be one of: auto, direct, kagi, markdown_new')
		}
	})

	test('rejects a non-string method', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 42 })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('method kagi without a kagi backend is unavailable', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, { fetcher })
		const result = await handler({ url: 'https://example.com', method: 'kagi' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('fetch_url method "kagi" requires KAGI_API_KEY, which is not set')
		}
		expect(fetcher.calls).toEqual([])
	})

	test('method kagi returns extracted markdown on success', async () => {
		const kagiExtract = makeKagiExtract({ data: [{ url: 'https://example.com', markdown: '# Title' }] })
		const handler = createFetchUrl(5000, { kagiExtract })
		const result = await handler({ url: 'https://example.com', method: 'kagi' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toBe('# Title')
		}
		expect(kagiExtract.calls).toEqual([{ url: 'https://example.com', timeoutMs: 5000 }])
	})

	test('method markdown_new uses only the markdown.new backend', async () => {
		const markdownNewFetcher = makeFetcher('markdown body')
		const fetcher = makeFetcher('direct body')
		const handler = createFetchUrl(5000, { fetcher, markdownNewFetcher })
		const result = await handler({ url: 'https://example.com', method: 'markdown_new' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toBe('markdown body')
		}
		expect(fetcher.calls).toEqual([])
	})

	test('auto tries kagi, then markdown_new, then direct', async () => {
		const order: string[] = []
		const kagiExtract: KagiExtract = async () => {
			order.push('kagi')
			throw new Error('Kagi extract failed: HTTP 500: boom')
		}
		const markdownNewFetcher: Fetcher = async () => {
			order.push('markdown_new')
			throw new Error('markdown.new failed: HTTP 500')
		}
		const fetcher: Fetcher = async () => {
			order.push('direct')
			throw new Error('HTTP 404')
		}
		const handler = createFetchUrl(5000, { fetcher, kagiExtract, markdownNewFetcher })
		const result = await handler({ url: 'https://example.com', method: 'auto' })
		expect(order).toEqual(['kagi', 'markdown_new', 'direct'])
		expect(result.kind).toBe('unavailable')
	})

	test('falls through to the next backend on failure and returns the first success', async () => {
		const order: string[] = []
		const kagiExtract: KagiExtract = async (url) => {
			order.push('kagi')
			return { data: [{ url, markdown: null }] }
		}
		const markdownNewFetcher: Fetcher = async () => {
			order.push('markdown_new')
			return 'markdown body'
		}
		const fetcher: Fetcher = async () => {
			order.push('direct')
			return 'direct body'
		}
		const handler = createFetchUrl(5000, { fetcher, kagiExtract, markdownNewFetcher })
		const result = await handler({ url: 'https://example.com', method: 'auto' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toBe('markdown body')
		}
		expect(order).toEqual(['kagi', 'markdown_new'])
	})

	test('omits the kagi backend from auto when no kagiExtract is injected', async () => {
		const order: string[] = []
		const markdownNewFetcher: Fetcher = async () => {
			order.push('markdown_new')
			throw new Error('markdown.new failed: HTTP 500')
		}
		const fetcher: Fetcher = async () => {
			order.push('direct')
			return 'direct body'
		}
		const handler = createFetchUrl(5000, { fetcher, markdownNewFetcher })
		const result = await handler({ url: 'https://example.com' })
		expect(result.kind).toBe('success')
		expect(order).toEqual(['markdown_new', 'direct'])
	})

	test('reports every attempted backend when all fail, unavailable on any HTTP failure', async () => {
		const kagiExtract = makeKagiExtract({ data: [{ url: 'https://example.com', markdown: null }] })
		const markdownNewFetcher = makeFetcher('', { error: new Error('markdown.new failed: HTTP 500') })
		const fetcher = makeFetcher('', { error: new Error('HTTP 404') })
		const handler = createFetchUrl(5000, { fetcher, kagiExtract, markdownNewFetcher })
		const result = await handler({ url: 'https://example.com', method: 'auto' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Fetch failed via kagi (Kagi extract returned no markdown for https://example.com); via markdown_new (markdown.new failed: HTTP 500); via direct (HTTP 404)')
		}
	})

	test('maps all-network failures to unavailable', async () => {
		const kagiExtract = makeKagiExtract(null, { error: new Error('socket reset') })
		const markdownNewFetcher = makeFetcher('', { error: new Error('network down') })
		const fetcher = makeFetcher('', { error: new Error('aborted') })
		const handler = createFetchUrl(5000, { fetcher, kagiExtract, markdownNewFetcher })
		const result = await handler({ url: 'https://example.com' })
		expect(result.kind).toBe('unavailable')
		if (result.kind !== 'success') {
			expect(result.message).toBe('Fetch failed via kagi (socket reset); via markdown_new (network down); via direct (aborted)')
		}
	})

	test('truncates large kagi markdown to 1 MB', async () => {
		const large = 'x'.repeat(2 * 1024 * 1024)
		const kagiExtract = makeKagiExtract({ data: [{ url: 'https://example.com', markdown: large }] })
		const handler = createFetchUrl(5000, { kagiExtract })
		const result = await handler({ url: 'https://example.com', method: 'kagi' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && typeof result.data === 'string') {
			expect(result.data.length).toBe(1024 * 1024)
		}
	})
})

describe('createDefaultFetcher', () => {
	test('aborts the request when the injected timer fires', async () => {
		let abortListener: (() => void) | undefined
		const hangingFetch = ((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => reject(new Error('aborted'))
				abortListener = onAbort
				init?.signal?.addEventListener('abort', onAbort)
			})
		}) as typeof fetch
		let scheduledCallback: (() => void) | undefined
		const fakeSetTimeout = (callback: () => void, _ms: number): number => {
			scheduledCallback = callback
			return 1
		}
		const fakeClearTimeout = (_id: number): void => {
			scheduledCallback = undefined
		}
		const fetcher = createDefaultFetcher({
			fetchImpl: hangingFetch,
			setTimeoutImpl: fakeSetTimeout,
			clearTimeoutImpl: fakeClearTimeout,
		})

		const promise = fetcher('https://example.com', 100)
		expect(scheduledCallback).toBeDefined()
		expect(abortListener).toBeDefined()
		scheduledCallback?.()
		await expect(promise).rejects.toBeInstanceOf(FetchTimeoutError)
	})

	test('clears the timer when the request completes before the timeout', async () => {
		const okResponse = new Response('hello', { status: 200 })
		const fetchImpl = (() => Promise.resolve(okResponse)) as unknown as typeof fetch
		let cleared = false
		const fakeClearTimeout = (_id: number): void => {
			cleared = true
		}
		const fakeSetTimeout = (_callback: () => void, _ms: number): number => 7
		const fetcher = createDefaultFetcher({
			fetchImpl,
			setTimeoutImpl: fakeSetTimeout,
			clearTimeoutImpl: fakeClearTimeout,
		})

		const text = await fetcher('https://example.com', 1000)
		expect(text).toBe('hello')
		expect(cleared).toBe(true)
	})

	test('propagates non-OK HTTP responses as errors', async () => {
		const badResponse = new Response('nope', { status: 500 })
		const fetchImpl = (() => Promise.resolve(badResponse)) as unknown as typeof fetch
		const fetcher = createDefaultFetcher({
			fetchImpl,
			setTimeoutImpl: (_cb, _ms) => 0,
			clearTimeoutImpl: () => {},
		})
		await expect(fetcher('https://example.com', 1000)).rejects.toThrow('HTTP 500')
	})
})
