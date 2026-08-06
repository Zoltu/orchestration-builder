// The interrupt platform's cross-boundary state. The queue is per-run: external trigger sources (the operator API, the shutdown path) submit requests, and the engine drains them at the safe point (the top of a role's turn loop — never mid-LLM-call). Loop-check cadence triggers are not queued here; the engine evaluates them in the draining role's own loop so they never go stale behind operator requests.
// The channel is the service-level singleton that binds the active run's queue, mirroring the human backend's bindRunLog pattern: one run at a time, so a single slot suffices.

export type InterruptKind = 'inquiry' | 'plan_modification' | 'notice'

export interface InterruptRequest {
	kind: InterruptKind
	message: string
}

export interface InterruptQueue {
	submit(request: InterruptRequest): void
	drain(): InterruptRequest | undefined
	pending(): boolean
}

export function createInterruptQueue(): InterruptQueue {
	const requests: InterruptRequest[] = []
	return {
		submit(request) {
			requests.push(request)
		},
		drain() {
			return requests.shift()
		},
		pending() {
			return requests.length > 0
		},
	}
}

export type InterruptSubmitResult = 'accepted' | 'no_active_run'

export interface InterruptChannel {
	bindQueue(queue: InterruptQueue | null): void
	submit(request: InterruptRequest): InterruptSubmitResult
	pending(): boolean
}

export function createInterruptChannel(): InterruptChannel {
	let bound: InterruptQueue | null = null
	return {
		bindQueue(queue) {
			bound = queue
		},
		submit(request) {
			if (bound === null) return 'no_active_run'
			bound.submit(request)
			return 'accepted'
		},
		pending() {
			return bound !== null && bound.pending()
		},
	}
}
