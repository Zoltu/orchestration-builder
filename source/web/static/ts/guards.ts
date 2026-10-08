// The shared record guard for the browser modules: a plain object (not null, not an array). One definition so the view modules' input checks cannot drift apart, mirroring the exported isObject the server-side modules share (source/executor/validation.ts) — the static bundle cannot import from the executor, so the browser side keeps its own copy of the same semantics.
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The metric counters a call operation's metrics carry, each nullable (an unreported counter is null, never a fabricated zero).
const METRIC_COUNTERS: readonly string[] = ['tokens', 'promptTokens', 'completionTokens', 'cachedPromptTokens', 'lastPromptTokens', 'elapsedSeconds']

// The OperationMetrics shape guard both wire ingress points (the product client and the dev harness) run before a polled flow model renders: every counter must be null or a finite number. Finite or nothing — a NaN/Infinity counter would poison every sum it touched (the cost strip, the top-bar totals).
export function isOperationMetricsRecord(value: unknown): boolean {
	if (!isObject(value)) return false
	for (const key of METRIC_COUNTERS) {
		const counter = value[key]
		if (counter === null) continue
		if (typeof counter !== 'number' || !Number.isFinite(counter)) return false
	}
	return true
}
