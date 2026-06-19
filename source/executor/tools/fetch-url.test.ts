import { describe, expect, test } from 'bun:test'
import type { Fetcher } from './fetch-url.ts'
import { createDefaultFetcher, createFetchUrl } from './fetch-url.ts'

function makeFetcher(body: string, opts: { shouldThrow?: boolean } = {}): Fetcher & { calls: Array<{ url: string; timeoutMs: number }> } {
	const calls: Array<{ url: string; timeoutMs: number }> = []
	const fetcher: Fetcher & { calls: Array<{ url: string; timeoutMs: number }> } = async (url: string, timeoutMs: number) => {
		calls.push({ url, timeoutMs })
		if (opts.shouldThrow) throw new Error('network down')
		return body
	}
	fetcher.calls = calls
	return fetcher
}

describe('createFetchUrl', () => {
	test('returns the body string when fetcher succeeds', async () => {
		const fetcher = makeFetcher('hello world')
		const handler = createFetchUrl(5000, fetcher)
		const result = await handler({ url: 'https://example.com/path' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toBe('hello world')
		}
		expect(fetcher.calls).toEqual([{ url: 'https://example.com/path', timeoutMs: 5000 }])
	})

	test('passes the configured timeout to the fetcher', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(1234, fetcher)
		await handler({ url: 'https://example.com' })
		expect(fetcher.calls).toEqual([{ url: 'https://example.com', timeoutMs: 1234 }])
	})

	test('rejects an empty url with invalid_arguments', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, fetcher)
		const result = await handler({ url: '' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a non-string url', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, fetcher)
		const result = await handler({ url: 123 })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects an unparseable URL', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, fetcher)
		const result = await handler({ url: 'not a url' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects non-http(s) protocols', async () => {
		const fetcher = makeFetcher('body')
		const handler = createFetchUrl(5000, fetcher)
		const result = await handler({ url: 'file:///etc/passwd' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('wraps a fetcher exception as a timeout error', async () => {
		const fetcher = makeFetcher('', { shouldThrow: true })
		const handler = createFetchUrl(5000, fetcher)
		const result = await handler({ url: 'https://example.com' })
		expect(result.kind).toBe('timeout')
	})

	test('truncates a very large body to 1 MB', async () => {
		const large = 'x'.repeat(2 * 1024 * 1024)
		const fetcher = makeFetcher(large)
		const handler = createFetchUrl(5000, fetcher)
		const result = await handler({ url: 'https://example.com' })
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
		await expect(promise).rejects.toThrow('aborted')
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