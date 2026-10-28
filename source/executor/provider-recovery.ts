import { isRunCheckpoint } from './checkpoint.js'
import type { LlmCaller } from './llm.js'
import { toProviderProbeResult, type ModelProbeResult } from './model-probe.js'
import { createProviderGate, createProviderHealthMonitor, type HealthView, type ProviderGate, type ProviderHealth, type ProviderHealthFailure, type ProviderProbeSchedule } from './provider-health.js'
import type { SuspendedRunResumeResult } from './suspension.js'
import type { LlmCallResult, RunMeta, SuspensionRecord } from './types.js'
import { isRunMeta, safeJsonParse } from './validation.js'

// The gate observes role calls only. A summary call shares the endpoint but is service bookkeeping: routing it here would let a failed label mark the provider unhealthy and suspend or block unrelated work (docs/reference.md "Provider health gate").
export interface ProviderOutcomeObserverDependencies {
	gate: Pick<ProviderGate, 'observeSuccess' | 'observeFailure'>
	now: () => string
}

export function createProviderOutcomeObserver(dependencies: ProviderOutcomeObserverDependencies): (result: LlmCallResult) => void {
	return (result) => {
		const at = dependencies.now()
		if (result.kind === 'success') {
			dependencies.gate.observeSuccess(at)
			return
		}
		if (result.kind !== 'provider_failure') return
		const failure: ProviderHealthFailure = {
			category: result.category,
			...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
		}
		dependencies.gate.observeFailure(failure, at)
	}
}

// Wraps a caller so every result it returns reaches the observer. The service composes this only around the role caller; the summarizer keeps the raw caller.
export function createObservedLlmCaller(caller: LlmCaller, observe: (result: LlmCallResult) => void): LlmCaller {
	return {
		async call(request) {
			const result = await caller.call(request)
			observe(result)
			return result
		},
	}
}

function suspensionFromMetaText(metaText: string | null): SuspensionRecord | undefined {
	if (metaText === null) return undefined
	const parsed = safeJsonParse(metaText)
	if (!parsed.ok || !isRunMeta(parsed.value)) return undefined
	if (parsed.value.status !== 'suspended') return undefined
	return parsed.value.suspension
}

function suspensionFromCheckpointText(checkpointText: string | null): SuspensionRecord | undefined {
	if (checkpointText === null) return undefined
	const parsed = safeJsonParse(checkpointText)
	if (!parsed.ok || !isRunCheckpoint(parsed.value)) return undefined
	return parsed.value.suspension
}

export interface ProviderRecoveryDependencies {
	initialHealth: ProviderHealth
	probeModel: () => Promise<ModelProbeResult>
	scheduleTimeout: ProviderProbeSchedule
	now: () => string
	random: () => number
	readRunMetaTextById: (runId: string) => string | null
	readRunCheckpointTextById: (runId: string) => string | null
}

// The process-wide bridge between run durability and provider health. It is the single owner of the suspended run binding and of the gate/monitor lifecycle: submission and the queue read it instead of keeping their own copies, and releaseSuspension is the one place a resume or termination releases the pause.
export interface ProviderRecovery {
	observeRoleCall(result: LlmCallResult): void
	adoptSuspendedRun(runId: string): void
	noticeSuspension(meta: RunMeta): void
	hydrateSuspension(runId: string): boolean
	releaseSuspension(runId: string): boolean
	suspendedRunId(): string | undefined
	hasSuspendedRun(): boolean
	canDispatch(): boolean
	mayAutoResume(runId: string, at: string): boolean
	readHealth(): HealthView
	setAutoResumeHandler(handler: (at: string) => void): void
	ensureProbing(): void
}

export function createProviderRecovery(dependencies: ProviderRecoveryDependencies): ProviderRecovery {
	const gate = createProviderGate(dependencies.initialHealth)
	const observeRoleCall = createProviderOutcomeObserver({ gate, now: dependencies.now })
	let autoResumeHandler: ((at: string) => void) | undefined
	const monitor = createProviderHealthMonitor({
		gate,
		probe: async () => toProviderProbeResult(await dependencies.probeModel()),
		scheduleTimeout: dependencies.scheduleTimeout,
		now: dependencies.now,
		random: dependencies.random,
		onHealthy: (at) => {
			autoResumeHandler?.(at)
		},
	})

	function bind(runId: string, suspension: SuspensionRecord): void {
		// A new binding never inherits the previous probe deadline; the monitor schedules from the new suspension's own backoff/due time.
		gate.planProbe(undefined)
		monitor.noticeSuspension(runId, suspension)
		monitor.start()
	}

	function readSuspension(runId: string): SuspensionRecord | undefined {
		return suspensionFromMetaText(dependencies.readRunMetaTextById(runId)) ?? suspensionFromCheckpointText(dependencies.readRunCheckpointTextById(runId))
	}

	return {
		observeRoleCall,
		adoptSuspendedRun(runId) {
			gate.adoptSuspendedRun(runId)
		},
		noticeSuspension(meta) {
			if (meta.status !== 'suspended' || meta.suspension === undefined) return
			bind(meta.runId, meta.suspension)
		},
		hydrateSuspension(runId) {
			const suspension = readSuspension(runId)
			if (suspension === undefined) return false
			bind(runId, suspension)
			return true
		},
		releaseSuspension(runId) {
			// A stale release for an unrelated run must not disturb the run that is actually suspended.
			if (gate.suspendedRunId() !== runId) return false
			gate.clearSuspendedRun(runId)
			gate.planProbe(undefined)
			// Keep probing while the provider still blocks dispatch, even with no suspended run and no waiting work: a start-now request must not stay refused until an unrelated queue mutation. A healthy gate has nothing to probe for.
			const keepProbing = !gate.canDispatch()
			monitor.releaseSuspension(keepProbing)
			return true
		},
		suspendedRunId() {
			return gate.suspendedRunId()
		},
		hasSuspendedRun() {
			return gate.suspendedRunId() !== undefined
		},
		canDispatch() {
			return gate.canDispatch()
		},
		mayAutoResume(runId, at) {
			return gate.suspendedRunId() === runId && gate.autoResumeAllowed(at)
		},
		readHealth() {
			return gate.snapshot()
		},
		setAutoResumeHandler(handler) {
			autoResumeHandler = handler
		},
		ensureProbing() {
			if (gate.suspendedRunId() !== undefined || gate.canDispatch()) return
			monitor.ensureProbing()
		},
	}
}

export interface ProviderAutoResumeDependencies {
	recovery: ProviderRecovery
	resumeSuspendedRun: (runId: string) => SuspendedRunResumeResult
	onDispatch: () => void
}

export interface ProviderAutoResumeCoordinator {
	handleHealthy(at: string): void
}

// The one automatic-resume decision point. It runs on every successful probe (not on a queue item), so a suspended run with no queue row still resumes. The resume operation owns the cleanup of an unresumable suspended run, then the coordinator always lets the scheduler dispatch waiting work.
export function createProviderAutoResumeCoordinator(dependencies: ProviderAutoResumeDependencies): ProviderAutoResumeCoordinator {
	return {
		handleHealthy(at) {
			const runId = dependencies.recovery.suspendedRunId()
			if (runId !== undefined && dependencies.recovery.mayAutoResume(runId, at)) dependencies.resumeSuspendedRun(runId)
			dependencies.onDispatch()
		},
	}
}
