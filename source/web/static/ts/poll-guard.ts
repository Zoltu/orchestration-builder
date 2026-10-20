// Per-poll single-flight and retry state for the periodic fetches.
// The host supplies the monotonic time, so the guard stays free of timers, globals, and the clock.

export interface PollGuard {
	tryStart(nowMs: number): boolean
	succeeded(): void
	failed(nowMs: number): void
}

const POLL_RETRY_BASE_MS = 2000
const POLL_RETRY_MAX_MS = 30000

function pollRetryDelayMs(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) return 0
	return Math.min(POLL_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), POLL_RETRY_MAX_MS)
}

export function createPollGuard(): PollGuard {
	let inFlight = false
	let consecutiveFailures = 0
	let retryAtMs = 0
	return {
		tryStart(nowMs: number): boolean {
			if (inFlight) return false
			if (nowMs < retryAtMs) return false
			inFlight = true
			return true
		},
		succeeded(): void {
			inFlight = false
			consecutiveFailures = 0
			retryAtMs = 0
		},
		failed(nowMs: number): void {
			consecutiveFailures += 1
			inFlight = false
			retryAtMs = nowMs + pollRetryDelayMs(consecutiveFailures)
		},
	}
}
