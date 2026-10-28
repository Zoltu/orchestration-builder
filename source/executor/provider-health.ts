import { classifyProviderFailure } from './provider-failure.js'
import type { ResumePolicy, SuspensionCategory, SuspensionRecord } from './types.js'

// The coarse states a provider can be in. 'unknown' means the health probe could not tell (for example a /models endpoint the provider does not implement); it permits dispatch because there is no evidence of failure, but it never permits an automatic resume.
export type ProviderHealthState = 'healthy' | 'degraded' | 'unavailable' | 'unknown'

// The health snapshot is deliberately restricted to enum, timestamps, and counters. Endpoint URLs, credentials, model names, headers, request content, and provider error bodies never enter this record.
export type ProviderHealth = {
	state: ProviderHealthState
	category: 'none' | SuspensionCategory
	since: string
	lastCheckedAt: string
	lastSuccessAt?: string
	consecutiveFailures: number
	nextProbeAt?: string
}

export type HealthView = {
	provider: ProviderHealth
	suspendedRunId: string | null
	// The bound suspension's coarse policy, null when no suspended run is bound (including a boot adoption before its record is hydrated).
	resumePolicy: ResumePolicy | null
}

// The granularity the monitor needs from a probe: a boolean result, the HTTP status when one arrived, whether the failure was transport-level, the provider's requested wait, and a classification when the probe could read a billing/auth signature. The raw body stays with the model-list resolver.
export type ProviderProbeResult =
	| { ok: true; status: number }
	| { ok: false; transport: boolean; status?: number; retryAfterMs?: number; category?: SuspensionCategory }

// A failure reduced to what the health state needs. It is structurally satisfied by ProviderFailureClassification, so a role call's classification can be recorded without translation.
export interface ProviderHealthFailure {
	category: SuspensionCategory
	retryAfterMs?: number
}

export type ProviderProbeSchedule = (callback: () => void, milliseconds: number) => () => void

// The gate's contract:
// - noticeSuspension binds a paused run and records its category, so a bound transient suspension can never leave the gate healthy.
// - clearSuspendedRun releases the binding; resume and terminate call it, including a terminate whose meta is already missing.
// - observeSuccess/observeFailure are for priority (role) calls only; summary calls never report here.
// - autoResumeAllowed is true only for a bound transient auto suspension while the provider is healthy and the suspension's due time has arrived.
// - The snapshot is coarse by construction; no URL, credential, model name, header, request content, or provider body can enter it.
export interface ProviderGate {
	observeSuccess(at: string): void
	observeFailure(failure: ProviderHealthFailure, at: string, nextProbeAt?: string): void
	planProbe(nextProbeAt: string | undefined): void
	snapshot(): HealthView
	canDispatch(): boolean
	autoResumeAllowed(at: string): boolean
	noticeSuspension(runId: string, suspension: SuspensionRecord, at: string): void
	// Boot adopts the reported run's priority before its suspension record is read; hydrateSuspension then fills in the cause.
	adoptSuspendedRun(runId: string): void
	clearSuspendedRun(runId: string): void
	suspendedRunId(): string | undefined
}

// A transient failure is retried automatically; every other category needs an operator decision. 'unknown' is inconclusive and therefore also operator-only.
function stateForCategory(category: SuspensionCategory): ProviderHealthState {
	if (category === 'transient') return 'degraded'
	if (category === 'unknown') return 'unknown'
	return 'unavailable'
}

function isNonNegativeInteger(value: number): boolean {
	return Number.isInteger(value) && value >= 0
}

function isTimestamp(value: string): boolean {
	return !Number.isNaN(Date.parse(value))
}

// The factory is the boundary that rejects an impossible combination (for example a healthy gate carrying a failure category) instead of letting it flow into dispatch decisions.
function isValidProviderHealth(health: ProviderHealth): boolean {
	if (!isNonNegativeInteger(health.consecutiveFailures)) return false
	if (!isTimestamp(health.since) || !isTimestamp(health.lastCheckedAt)) return false
	if (health.lastSuccessAt !== undefined && !isTimestamp(health.lastSuccessAt)) return false
	if (health.nextProbeAt !== undefined && !isTimestamp(health.nextProbeAt)) return false
	if (health.state === 'healthy') return health.category === 'none'
	if (health.state === 'degraded') return health.category === 'transient'
	if (health.state === 'unknown') return health.category === 'unknown'
	return health.category === 'billing' || health.category === 'auth' || health.category === 'request_rejected'
}

function copyHealth(health: ProviderHealth): ProviderHealth {
	return {
		state: health.state,
		category: health.category,
		since: health.since,
		lastCheckedAt: health.lastCheckedAt,
		...(health.lastSuccessAt !== undefined ? { lastSuccessAt: health.lastSuccessAt } : {}),
		consecutiveFailures: health.consecutiveFailures,
		...(health.nextProbeAt !== undefined ? { nextProbeAt: health.nextProbeAt } : {}),
	}
}

function withSuccess(health: ProviderHealth, at: string): ProviderHealth {
	return {
		state: 'healthy',
		category: 'none',
		since: health.state === 'healthy' ? health.since : at,
		lastCheckedAt: at,
		lastSuccessAt: at,
		consecutiveFailures: 0,
	}
}

function withFailure(health: ProviderHealth, failure: ProviderHealthFailure, at: string, nextProbeAt: string | undefined): ProviderHealth {
	const state = stateForCategory(failure.category)
	return {
		state,
		category: failure.category,
		since: health.state === state ? health.since : at,
		lastCheckedAt: at,
		...(health.lastSuccessAt !== undefined ? { lastSuccessAt: health.lastSuccessAt } : {}),
		consecutiveFailures: health.consecutiveFailures + 1,
		...(nextProbeAt !== undefined ? { nextProbeAt } : {}),
	}
}

// A suspension notice is both a binding and a health observation: it records the pause cause without double-counting a role failure the caller already reported.
function withSuspensionNotice(health: ProviderHealth, suspension: SuspensionRecord, at: string): ProviderHealth {
	const state = stateForCategory(suspension.category)
	const sameState = health.state === state
	const sameCategory = health.category === suspension.category
	return {
		state,
		category: suspension.category,
		since: sameState ? health.since : at,
		lastCheckedAt: at,
		...(health.lastSuccessAt !== undefined ? { lastSuccessAt: health.lastSuccessAt } : {}),
		consecutiveFailures: sameState && sameCategory ? health.consecutiveFailures : Math.max(1, health.consecutiveFailures + 1),
		...(health.nextProbeAt !== undefined ? { nextProbeAt: health.nextProbeAt } : {}),
	}
}

function withNextProbeAt(health: ProviderHealth, nextProbeAt: string | undefined): ProviderHealth {
	const copy = copyHealth(health)
	if (nextProbeAt === undefined) delete copy.nextProbeAt
	else copy.nextProbeAt = nextProbeAt
	return copy
}

export function createProviderGate(initial: ProviderHealth): ProviderGate {
	if (!isValidProviderHealth(initial)) throw new Error('createProviderGate: invalid initial provider health state')
	let health = copyHealth(initial)
	let boundRunId: string | undefined
	let boundSuspension: SuspensionRecord | undefined

	return {
		observeSuccess(at) {
			health = withSuccess(health, at)
		},
		observeFailure(failure, at, nextProbeAt) {
			health = withFailure(health, failure, at, nextProbeAt)
		},
		planProbe(nextProbeAt) {
			health = withNextProbeAt(health, nextProbeAt)
		},
		snapshot() {
			return { provider: copyHealth(health), suspendedRunId: boundRunId ?? null, resumePolicy: boundSuspension?.resumePolicy ?? null }
		},
		// 'unknown' permits dispatch because it carries no evidence that the provider is broken; 'degraded' and 'unavailable' stop new work.
		canDispatch() {
			return health.state === 'healthy' || health.state === 'unknown'
		},
		autoResumeAllowed(at) {
			if (boundRunId === undefined || boundSuspension === undefined) return false
			if (boundSuspension.category !== 'transient' || boundSuspension.resumePolicy !== 'auto') return false
			if (health.state !== 'healthy') return false
			if (boundSuspension.autoResumeAfter === undefined) return true
			const dueMs = Date.parse(boundSuspension.autoResumeAfter)
			const atMs = Date.parse(at)
			return !Number.isNaN(dueMs) && !Number.isNaN(atMs) && dueMs <= atMs
		},
		noticeSuspension(runId, suspension, at) {
			boundRunId = runId
			boundSuspension = suspension
			health = withSuspensionNotice(health, suspension, at)
		},
		adoptSuspendedRun(runId) {
			boundRunId = runId
			boundSuspension = undefined
		},
		clearSuspendedRun(runId) {
			if (boundRunId !== runId) return
			boundRunId = undefined
			boundSuspension = undefined
		},
		suspendedRunId() {
			return boundRunId
		},
	}
}

const PROBE_BACKOFF_BASE_MS = 5_000
const PROBE_BACKOFF_CAP_MS = 60_000
const PROBE_MIN_DELAY_MS = 1_000

// Exponential backoff with equal jitter: a [50%, 100%] band around min(cap, base * 2^(n-1)). A provider Retry-After can shorten the wait but never lengthen it past the exponential bound, and the floor prevents a zero/tiny Retry-After from becoming a tight probe loop.
function probeBackoffMs(consecutiveFailures: number, retryAfterMs: number | undefined, random: () => number): number {
	const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20))
	const exponential = Math.min(PROBE_BACKOFF_CAP_MS, PROBE_BACKOFF_BASE_MS * 2 ** exponent)
	const bounded = retryAfterMs === undefined ? exponential : Math.max(0, Math.min(retryAfterMs, exponential))
	const randomValue = Math.min(1, Math.max(0, random()))
	return Math.max(PROBE_MIN_DELAY_MS, Math.floor(bounded * (0.5 + 0.5 * randomValue)))
}

function firstProbeDelayMs(suspension: SuspensionRecord, nowMs: number, random: () => number): number {
	const backoff = probeBackoffMs(1, undefined, random)
	if (suspension.autoResumeAfter === undefined) return backoff
	const dueMs = Date.parse(suspension.autoResumeAfter)
	if (Number.isNaN(dueMs)) return backoff
	return Math.max(PROBE_MIN_DELAY_MS, Math.min(backoff, Math.max(0, dueMs - nowMs)))
}

function classifyProbeFailure(result: Extract<ProviderProbeResult, { ok: false }>): ProviderHealthFailure {
	// A model-list endpoint that is absent is inconclusive rather than broken: some OpenAI-compatible servers serve completions but not /models (docs/reference.md "Provider health gate").
	if (result.status === 404 || result.status === 405) {
		return {
			category: 'unknown',
			...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
		}
	}
	if (result.category !== undefined) {
		return {
			category: result.category,
			...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
		}
	}
	if (result.transport || result.status === undefined) return { category: 'transient' }
	const classification = classifyProviderFailure({ status: result.status, transport: false }, 0)
	return {
		category: classification.category,
		...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
	}
}

export interface ProviderHealthMonitorDependencies {
	gate: ProviderGate
	probe: () => Promise<ProviderProbeResult>
	scheduleTimeout: ProviderProbeSchedule
	now: () => string
	random: () => number
	onHealthy: (at: string) => void
}

// The monitor's contract: start enables probing, stop cancels/ignores every pending and in-flight probe, noticeSuspension binds and records a new pause, releaseSuspension forgets that pause (optionally continuing to probe an unhealthy provider), every successful probe reports the health change through onHealthy, and a dispatchable inconclusive probe reports it too so blocked work wakes. ensureProbing restarts probing when blocked work arrives after an idle release. A probe rejection is treated as a transient failure. Probes are serialized: a notice during an in-flight probe defers the next schedule until that probe settles, and an epoch guard discards its result.
export interface ProviderHealthMonitor {
	start(): void
	stop(): void
	noticeSuspension(runId: string, suspension: SuspensionRecord): void
	// Stops tracking the run's suspension. keepProbing is true while the provider still blocks dispatch: the monitor keeps probing on its failure backoff so a later success can release the queue; false stops it entirely.
	releaseSuspension(keepProbing: boolean): void
	// Starts probing from the current failure backoff when blocked work arrives after a release stopped the monitor.
	ensureProbing(): void
}

export function createProviderHealthMonitor(dependencies: ProviderHealthMonitorDependencies): ProviderHealthMonitor {
	let started = false
	let cancelTimer: (() => void) | undefined
	let pendingDelayMs: number | undefined
	let currentSuspension: SuspensionRecord | undefined
	let probeEpoch = 0
	let probeInFlight = false

	function nowMs(): number {
		const at = dependencies.now()
		const milliseconds = Date.parse(at)
		if (Number.isNaN(milliseconds)) throw new Error(`Provider health monitor received an invalid timestamp: ${at}`)
		return milliseconds
	}

	function schedule(delayMs: number): void {
		if (!started || probeInFlight) {
			pendingDelayMs = delayMs
			return
		}
		if (cancelTimer !== undefined) cancelTimer()
		const bounded = Math.max(0, Math.floor(delayMs))
		const nextProbeAt = new Date(nowMs() + bounded).toISOString()
		dependencies.gate.planProbe(nextProbeAt)
		cancelTimer = dependencies.scheduleTimeout(() => {
			cancelTimer = undefined
			void runProbe()
		}, bounded)
	}

	function handleProbeSuccess(at: string, atMs: number): void {
		dependencies.gate.observeSuccess(at)
		// Every successful probe is a health change: the coordinator decides whether to resume and always dispatches settled waiting work.
		dependencies.onHealthy(at)
		if (!started) return
		// A successful probe before the suspension's earliest resume time must not wake the scheduler early; probe again at the due time instead.
		const suspension = currentSuspension
		if (suspension === undefined || suspension.resumePolicy !== 'auto' || suspension.autoResumeAfter === undefined) return
		if (dependencies.gate.autoResumeAllowed(at)) return
		const dueMs = Date.parse(suspension.autoResumeAfter)
		if (Number.isNaN(dueMs) || dueMs <= atMs) return
		schedule(dueMs - atMs)
	}

	function handleProbeFailure(result: Extract<ProviderProbeResult, { ok: false }>, at: string, atMs: number): void {
		const failure = classifyProbeFailure(result)
		// An inconclusive probe (a missing /models endpoint) must not keep probing toward an automatic resume; the operator resumes this suspension explicitly.
		if (failure.category === 'unknown') {
			dependencies.gate.observeFailure(failure, at)
			// An inconclusive probe still permits dispatch; report it so a released-but-blocked queue wakes instead of waiting forever.
			dependencies.onHealthy(at)
			return
		}
		const consecutiveFailures = dependencies.gate.snapshot().provider.consecutiveFailures + 1
		const delayMs = probeBackoffMs(consecutiveFailures, failure.retryAfterMs, dependencies.random)
		const nextProbeAt = new Date(atMs + delayMs).toISOString()
		dependencies.gate.observeFailure(failure, at, nextProbeAt)
		schedule(delayMs)
	}

	async function runProbe(): Promise<void> {
		if (!started || probeInFlight) return
		probeInFlight = true
		const epoch = probeEpoch
		try {
			let result: ProviderProbeResult
			try {
				result = await dependencies.probe()
			} catch {
				result = { ok: false, transport: true }
			}
			if (!started || epoch !== probeEpoch) return
			const at = dependencies.now()
			const atMs = Date.parse(at)
			if (Number.isNaN(atMs)) throw new Error(`Provider health monitor received an invalid timestamp: ${at}`)
			if (result.ok) handleProbeSuccess(at, atMs)
			else handleProbeFailure(result, at, atMs)
		} finally {
			probeInFlight = false
			if (started && pendingDelayMs !== undefined) {
				const delayMs = pendingDelayMs
				pendingDelayMs = undefined
				schedule(delayMs)
			}
		}
	}

	return {
		start() {
			if (started) return
			started = true
			if (dependencies.gate.suspendedRunId() === undefined) return
			const atMs = nowMs()
			const nextProbeAt = dependencies.gate.snapshot().provider.nextProbeAt
			if (nextProbeAt !== undefined) {
				const dueMs = Date.parse(nextProbeAt)
				if (!Number.isNaN(dueMs)) {
					schedule(Math.max(0, dueMs - atMs))
					return
				}
			}
			if (pendingDelayMs !== undefined) {
				const delayMs = pendingDelayMs
				pendingDelayMs = undefined
				schedule(delayMs)
				return
			}
			if (currentSuspension !== undefined) schedule(firstProbeDelayMs(currentSuspension, atMs, dependencies.random))
		},
		releaseSuspension(keepProbing) {
			probeEpoch++
			currentSuspension = undefined
			pendingDelayMs = undefined
			if (cancelTimer !== undefined) cancelTimer()
			cancelTimer = undefined
			if (!keepProbing) {
				started = false
				return
			}
			started = true
			const failures = dependencies.gate.snapshot().provider.consecutiveFailures
			schedule(probeBackoffMs(Math.max(1, failures), undefined, dependencies.random))
		},
		ensureProbing() {
			if (started) return
			started = true
			const failures = dependencies.gate.snapshot().provider.consecutiveFailures
			schedule(probeBackoffMs(Math.max(1, failures), undefined, dependencies.random))
		},
		stop() {
			started = false
			probeEpoch++
			pendingDelayMs = undefined
			if (cancelTimer !== undefined) cancelTimer()
			cancelTimer = undefined
		},
		noticeSuspension(runId, suspension) {
			probeEpoch++
			currentSuspension = suspension
			const at = dependencies.now()
			dependencies.gate.noticeSuspension(runId, suspension, at)
			const atMs = Date.parse(at)
			if (Number.isNaN(atMs)) throw new Error(`Provider health monitor received an invalid timestamp: ${at}`)
			schedule(firstProbeDelayMs(suspension, atMs, dependencies.random))
		},
	}
}
