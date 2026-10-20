import { describe, expect, test } from 'bun:test'
import { createPollFetcher } from './poll-fetch.js'
import type { PollFetcher, PollResponse } from './poll-fetch.js'

interface FakeTimeout {
	callback: () => void
	delayMs: number
	cancelled: boolean
}

interface FakeClock {
	now(): number
	setNow(value: number): void
	scheduleTimeout(callback: () => void, delayMs: number): FakeTimeout
	cancelTimeout(handle: FakeTimeout): void
	activeTimeoutCount(): number
	fireTimeouts(): void
}

interface Deferred<T> {
	promise: Promise<T>
	resolve(value: T): void
	reject(reason: unknown): void
}

function createDeferred<T>(): Deferred<T> {
	let resolvePromise: (value: T) => void = () => {}
	let rejectPromise: (reason: unknown) => void = () => {}
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve
		rejectPromise = reject
	})
	return {
		promise,
		resolve(value: T): void {
			resolvePromise(value)
		},
		reject(reason: unknown): void {
			rejectPromise(reason)
		},
	}
}

function createFakeClock(): FakeClock {
	let current = 0
	const timeouts: FakeTimeout[] = []
	return {
		now: () => current,
		setNow(value: number): void {
			current = value
		},
		scheduleTimeout(callback: () => void, delayMs: number): FakeTimeout {
			const handle = { callback, delayMs, cancelled: false }
			timeouts.push(handle)
			return handle
		},
		cancelTimeout(handle: FakeTimeout): void {
			handle.cancelled = true
		},
		activeTimeoutCount(): number {
			return timeouts.filter((timeout) => !timeout.cancelled).length
		},
		fireTimeouts(): void {
			for (const timeout of timeouts) {
				if (timeout.cancelled) continue
				timeout.cancelled = true
				timeout.callback()
			}
		},
	}
}

function response(status: number, bodyText: string): PollResponse {
	return {
		status,
		ok: status >= 200 && status < 300,
		version: null,
		text: async () => bodyText,
	}
}

function createTestFetcher(clock: FakeClock, request: (url: string, init: RequestInit | undefined, signal: AbortSignal) => Promise<PollResponse>): PollFetcher {
	return createPollFetcher({
		request,
		now: () => clock.now(),
		createAbortController: () => new AbortController(),
		scheduleTimeout: (callback, delayMs) => clock.scheduleTimeout(callback, delayMs),
		cancelTimeout: (handle) => clock.cancelTimeout(handle),
	})
}

describe('createPollFetcher', () => {
	test('skips a second start while the first response body is pending', async () => {
		const clock = createFakeClock()
		const body = createDeferred<string>()
		const requestStarted = createDeferred<void>()
		let requestCount = 0
		const fetcher = createTestFetcher(clock, () => {
			requestCount += 1
			requestStarted.resolve(undefined)
			return Promise.resolve({ status: 200, ok: true, version: null, text: () => body.promise })
		})
		const first = fetcher.start('flow', { url: '/flow' })
		await requestStarted.promise
		expect(requestCount).toBe(1)
		const second = await fetcher.start('flow', { url: '/flow' })
		expect(second).toEqual({ kind: 'skipped' })
		expect(clock.activeTimeoutCount()).toBe(1)
		body.resolve('ok')
		const outcome = await first
		expect(outcome.kind).toBe('response')
	})

	test('a body-read failure releases the guard and backs off', async () => {
		const clock = createFakeClock()
		let bodyShouldFail = true
		const fetcher = createTestFetcher(clock, async () => ({
			status: 200,
			ok: true,
			version: null,
			text: () => bodyShouldFail ? Promise.reject(new Error('body dropped')) : Promise.resolve('ok'),
		}))
		const failed = await fetcher.start('flow', { url: '/flow' })
		expect(failed).toEqual({ kind: 'failed' })
		expect(clock.activeTimeoutCount()).toBe(0)
		expect(await fetcher.start('flow', { url: '/flow' })).toEqual({ kind: 'skipped' })
		clock.setNow(2000)
		bodyShouldFail = false
		const succeeded = await fetcher.start('flow', { url: '/flow' })
		expect(succeeded.kind).toBe('response')
	})

	test('a stalled body hits the request timeout', async () => {
		const clock = createFakeClock()
		const requestStarted = createDeferred<void>()
		let rejectBody: ((reason: Error) => void) | null = null
		const fetcher = createTestFetcher(clock, async (_url, _init, signal) => {
			const body = new Promise<string>((_resolve, reject) => {
				rejectBody = reject
			})
			signal.addEventListener('abort', () => {
				if (rejectBody === null) return
				rejectBody(new Error('aborted'))
				rejectBody = null
			})
			requestStarted.resolve(undefined)
			return { status: 200, ok: true, version: null, text: () => body }
		})
		const outcomePromise = fetcher.start('flow', { url: '/flow' })
		await requestStarted.promise
		expect(clock.activeTimeoutCount()).toBe(1)
		clock.fireTimeouts()
		const outcome = await outcomePromise
		expect(outcome).toEqual({ kind: 'failed' })
		expect(clock.activeTimeoutCount()).toBe(0)
		expect(await fetcher.start('flow', { url: '/flow' })).toEqual({ kind: 'skipped' })
	})

	test('a synchronous request throw becomes a failure and does not wedge the key', async () => {
		const clock = createFakeClock()
		let shouldThrow = true
		const fetcher = createTestFetcher(clock, () => {
			if (shouldThrow) throw new Error('synchronous request failure')
			return Promise.resolve(response(200, 'ok'))
		})
		const outcome = await fetcher.start('flow', { url: '/flow' })
		expect(outcome).toEqual({ kind: 'failed' })
		clock.setNow(2000)
		shouldThrow = false
		const recovered = await fetcher.start('flow', { url: '/flow' })
		expect(recovered.kind).toBe('response')
	})

	test('a 5xx dispatches a response but still backs off', async () => {
		const clock = createFakeClock()
		const fetcher = createTestFetcher(clock, async () => response(503, 'down'))
		const outcome = await fetcher.start('queue', { url: '/queue' })
		expect(outcome.kind).toBe('response')
		if (outcome.kind !== 'response') return
		expect(outcome.status).toBe(503)
		expect(await fetcher.start('queue', { url: '/queue' })).toEqual({ kind: 'skipped' })
		clock.setNow(2000)
		expect((await fetcher.start('queue', { url: '/queue' })).kind).toBe('response')
	})

	for (const status of [304, 404]) {
		test(`a ${status} response resets the backoff`, async () => {
			const clock = createFakeClock()
			let mode: 'fail' | 'status' = 'fail'
			const fetcher = createTestFetcher(clock, async () => {
				if (mode === 'fail') throw new Error('network')
				return response(status, '')
			})
			expect(await fetcher.start('selected-run', { url: '/run' })).toEqual({ kind: 'failed' })
			clock.setNow(2000)
			mode = 'status'
			expect((await fetcher.start('selected-run', { url: '/run' })).kind).toBe('response')
			expect((await fetcher.start('selected-run', { url: '/run' })).kind).toBe('response')
		})
	}

	test('cancel returns cancelled, dispatches nothing, and leaves no backoff', async () => {
		const clock = createFakeClock()
		const requestStarted = createDeferred<void>()
		let mode: 'pending' | 'success' = 'pending'
		const fetcher = createTestFetcher(clock, (_url, _init, signal) => {
			if (mode === 'success') return Promise.resolve(response(200, 'ok'))
			requestStarted.resolve(undefined)
			return new Promise<PollResponse>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')))
			})
		})
		const pending = fetcher.start('inspector-tail', { url: '/tail' })
		await requestStarted.promise
		fetcher.cancel('inspector-tail')
		expect(await pending).toEqual({ kind: 'cancelled' })
		expect(clock.activeTimeoutCount()).toBe(0)
		mode = 'success'
		const next = await fetcher.start('inspector-tail', { url: '/tail' })
		expect(next.kind).toBe('response')
	})

	test('a cancelled request settling after a new start does not disturb the new guard', async () => {
		const clock = createFakeClock()
		const oldResponse = createDeferred<PollResponse>()
		const oldStarted = createDeferred<void>()
		let requestCount = 0
		const fetcher = createTestFetcher(clock, () => {
			requestCount += 1
			if (requestCount === 1) {
				oldStarted.resolve(undefined)
				return oldResponse.promise
			}
			return Promise.resolve(response(200, 'ok'))
		})
		const oldRequest = fetcher.start('flow', { url: '/old' })
		await oldStarted.promise
		fetcher.cancel('flow')
		const newOutcome = await fetcher.start('flow', { url: '/new' })
		expect(newOutcome.kind).toBe('response')
		oldResponse.reject(new Error('stale request'))
		expect(await oldRequest).toEqual({ kind: 'cancelled' })
		const laterOutcome = await fetcher.start('flow', { url: '/newer' })
		expect(laterOutcome.kind).toBe('response')
	})

	test('cancelAll clears guard state so a subsequent start runs', async () => {
		const clock = createFakeClock()
		const bothStarted = createDeferred<void>()
		let requestCount = 0
		let mode: 'pending' | 'success' = 'pending'
		const fetcher = createTestFetcher(clock, (_url, _init, signal) => {
			if (mode === 'success') return Promise.resolve(response(200, 'ok'))
			requestCount += 1
			if (requestCount === 2) bothStarted.resolve(undefined)
			return new Promise<PollResponse>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')))
			})
		})
		const first = fetcher.start('selected-run', { url: '/run' })
		const second = fetcher.start('flow', { url: '/flow' })
		await bothStarted.promise
		fetcher.cancelAll()
		expect(await first).toEqual({ kind: 'cancelled' })
		expect(await second).toEqual({ kind: 'cancelled' })
		expect(clock.activeTimeoutCount()).toBe(0)
		mode = 'success'
		const next = await fetcher.start('queue', { url: '/queue' })
		expect(next.kind).toBe('response')
	})
})
