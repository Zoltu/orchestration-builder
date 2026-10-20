// Owns the lifecycle of periodic poll requests: per-key single-flight guards, a timeout that stays armed through the body read, cancellation, and 5xx backoff.
// The host supplies the request, clock, abort controller, and timer leaves, so the whole lifecycle runs in memory under test.

import { createPollGuard } from './poll-guard.js'
import type { PollGuard } from './poll-guard.js'

export type PollKey = 'run-list' | 'questions' | 'queue' | 'selected-run' | 'flow' | 'inspector-tail'

export interface PollRequest {
	url: string
	init?: RequestInit
}

export interface PollResponse {
	status: number
	ok: boolean
	version: string | null
	text(): Promise<string>
}

export type PollFetchOutcome =
	| { kind: 'skipped' }
	| { kind: 'cancelled' }
	| { kind: 'failed' }
	| { kind: 'response'; status: number; ok: boolean; version: string | null; bodyText: string }

export interface PollFetcher {
	start(pollKey: PollKey, request: PollRequest): Promise<PollFetchOutcome>
	cancel(pollKey: PollKey): void
	cancelAll(): void
}

export interface PollFetcherDependencies<TimeoutHandle> {
	request: (url: string, init: RequestInit | undefined, signal: AbortSignal) => Promise<PollResponse>
	now: () => number
	createAbortController: () => AbortController
	scheduleTimeout: (callback: () => void, delayMs: number) => TimeoutHandle
	cancelTimeout: (handle: TimeoutHandle) => void
}

const POLL_TIMEOUT_MS = 30_000

interface ActiveRequest<TimeoutHandle> {
	cancelled: boolean
	abortController: AbortController | null
	timeoutHandle: TimeoutHandle | null
}

type StartedRequest =
	| { kind: 'cancelled' }
	| { kind: 'response'; response: PollResponse; bodyText: string }

export function createPollFetcher<TimeoutHandle>(dependencies: PollFetcherDependencies<TimeoutHandle>): PollFetcher {
	const guards = new Map<PollKey, PollGuard>()
	const activeRequests = new Map<PollKey, ActiveRequest<TimeoutHandle>>()

	function pollGuardFor(pollKey: PollKey): PollGuard {
		const existing = guards.get(pollKey)
		if (existing !== undefined) return existing
		const created = createPollGuard()
		guards.set(pollKey, created)
		return created
	}

	function clearTimeoutFor(activeRequest: ActiveRequest<TimeoutHandle>): void {
		if (activeRequest.timeoutHandle === null) return
		dependencies.cancelTimeout(activeRequest.timeoutHandle)
		activeRequest.timeoutHandle = null
	}

	function finish(pollKey: PollKey, activeRequest: ActiveRequest<TimeoutHandle>): void {
		clearTimeoutFor(activeRequest)
		if (activeRequests.get(pollKey) === activeRequest) activeRequests.delete(pollKey)
	}

	function start(pollKey: PollKey, request: PollRequest): Promise<PollFetchOutcome> {
		const guard = pollGuardFor(pollKey)
		if (!guard.tryStart(dependencies.now())) return Promise.resolve({ kind: 'skipped' })
		const activeRequest: ActiveRequest<TimeoutHandle> = { cancelled: false, abortController: null, timeoutHandle: null }
		activeRequests.set(pollKey, activeRequest)
		return Promise.resolve()
			.then((): StartedRequest | Promise<StartedRequest> => {
				if (activeRequest.cancelled) return { kind: 'cancelled' }
				const abortController = dependencies.createAbortController()
				activeRequest.abortController = abortController
				activeRequest.timeoutHandle = dependencies.scheduleTimeout(() => abortController.abort(), POLL_TIMEOUT_MS)
				return dependencies.request(request.url, request.init, abortController.signal).then((response) =>
					response.text().then((bodyText): StartedRequest => ({ kind: 'response', response, bodyText })),
				)
			})
			.then(
				(started): PollFetchOutcome => {
					finish(pollKey, activeRequest)
					if (started.kind === 'cancelled' || activeRequest.cancelled) return { kind: 'cancelled' }
					if (started.response.status >= 500) guard.failed(dependencies.now())
					else guard.succeeded()
					return { kind: 'response', status: started.response.status, ok: started.response.ok, version: started.response.version, bodyText: started.bodyText }
				},
				(): PollFetchOutcome => {
					finish(pollKey, activeRequest)
					if (activeRequest.cancelled) return { kind: 'cancelled' }
					guard.failed(dependencies.now())
					return { kind: 'failed' }
				},
			)
	}

	function cancel(pollKey: PollKey): void {
		const activeRequest = activeRequests.get(pollKey)
		if (activeRequest !== undefined) {
			activeRequest.cancelled = true
			activeRequests.delete(pollKey)
			clearTimeoutFor(activeRequest)
			if (activeRequest.abortController !== null) activeRequest.abortController.abort()
		}
		guards.delete(pollKey)
	}

	function cancelAll(): void {
		const pollKeys = new Set<PollKey>([...guards.keys(), ...activeRequests.keys()])
		for (const pollKey of pollKeys) cancel(pollKey)
	}

	return { start, cancel, cancelAll }
}
