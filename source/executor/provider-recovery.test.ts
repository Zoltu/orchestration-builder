import { describe, expect, test } from 'bun:test'
import type { RunCheckpoint } from './checkpoint.ts'
import type { ModelProbeResult } from './model-probe.ts'
import type { LlmCallResult, LlmRequest, RunMeta, SuspensionRecord } from './types.ts'
import { createObservedLlmCaller, createProviderAutoResumeCoordinator, createProviderOutcomeObserver, createProviderRecovery } from './provider-recovery.ts'
import type { ProviderHealth } from './provider-health.ts'
import { createResumeErroredOrSuspendedRun, createRunSubmission } from './run-submission.js'

const START = '2026-01-01T00:00:00.000Z'

function at(seconds: number): string {
	return new Date(Date.parse(START) + seconds * 1000).toISOString()
}

function initialHealth(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
	return { state: 'healthy', category: 'none', since: START, lastCheckedAt: START, consecutiveFailures: 0, ...overrides }
}

function transientSuspension(overrides: Partial<SuspensionRecord> = {}): SuspensionRecord {
	return { category: 'transient', resumePolicy: 'auto', message: 'Temporarily unavailable.', suspendedAt: START, ...overrides }
}

function operatorSuspension(category: SuspensionRecord['category']): SuspensionRecord {
	return { category, resumePolicy: 'operator', message: 'Resume when fixed.', suspendedAt: START }
}

function suspendedMeta(runId: string, suspension: SuspensionRecord): RunMeta {
	return { runId, task: 'paused task', status: 'suspended', startTime: START, suspension }
}

function checkpointWithSuspension(runId: string, suspension: SuspensionRecord): RunCheckpoint {
	return {
		version: 2,
		runId,
		startTime: START,
		registryCounter: 1,
		suspension,
		frames: [
			{
				roleId: 'orchestrator-0-1',
				roleName: 'orchestrator',
				depth: 0,
				task: `task for ${runId}`,
				roleState: {
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'task' },
					],
					protectedPrefixLength: 2,
					lastPromptTokens: 10,
					recentCompactionPromptTokens: [],
					recentToolCalls: [],
					toolCallCount: 1,
					generatedTokens: 5,
					contextExceededAttempts: 0,
					loopCheckToolCallWatermark: 0,
					loopCheckTokenWatermark: 0,
				},
			},
		],
	}
}

function successProbe(): ModelProbeResult {
	return { ok: true, body: { data: [] }, status: 200 }
}

function failureProbe(status = 503): ModelProbeResult {
	return { ok: false, reason: `HTTP ${status}`, transport: false, status }
}

function createHarness(metas: Map<string, string> = new Map(), checkpoints: Map<string, string> = new Map(), probes: Array<ModelProbeResult | Error> = [], health: Partial<ProviderHealth> = {}) {
	let currentMs = Date.parse(START)
	let pending: { callback: () => void; milliseconds: number } | undefined
	const delays: number[] = []
	const scripted = [...probes]
	const recovery = createProviderRecovery({
		initialHealth: initialHealth(health),
		probeModel: async () => {
			const next = scripted.shift()
			if (next === undefined) throw new Error('unscripted probe')
			if (next instanceof Error) throw next
			return next
		},
		scheduleTimeout: (callback, milliseconds) => {
			delays.push(milliseconds)
			pending = { callback, milliseconds }
			return () => {
				if (pending?.callback === callback) pending = undefined
			}
		},
		now: () => new Date(currentMs).toISOString(),
		random: () => 1,
		readRunMetaTextById: (runId) => metas.get(runId) ?? null,
		readRunCheckpointTextById: (runId) => checkpoints.get(runId) ?? null,
	})
	return {
		recovery,
		delays,
		pending: () => pending,
		advance(milliseconds: number) {
			currentMs += milliseconds
		},
		async fire(): Promise<void> {
			const entry = pending
			if (entry === undefined) throw new Error('no scheduled probe')
			pending = undefined
			entry.callback()
			for (let index = 0; index < 10; index++) await Promise.resolve()
		},
	}
}

function providerFailure(category: SuspensionRecord['category']): Extract<LlmCallResult, { kind: 'provider_failure' }> {
	return { kind: 'provider_failure', category, message: 'HTTP 402', attempts: 1, partialOutput: false }
}

describe('provider outcome observer', () => {
	test('a success and a provider failure update the gate; model-output failures do not', () => {
		const gate = { state: 'healthy', observeSuccess: () => { gate.state = 'healthy' }, observeFailure: () => { gate.state = 'degraded' } }
		const observe = createProviderOutcomeObserver({ gate, now: () => at(1) })
		observe({ kind: 'context_budget_exceeded', promptTokens: 4, contextWindow: 8 })
		observe({ kind: 'llm_unavailable', message: 'empty response' })
		expect(gate.state).toBe('healthy')
		observe(providerFailure('transient'))
		expect(gate.state).toBe('degraded')
		observe({ kind: 'success', toolCalls: [] })
		expect(gate.state).toBe('healthy')
	})

	test('summary calls keep the raw caller, so their failures never change health', async () => {
		const gates: string[] = []
		const gate = { observeSuccess: () => gates.push('success'), observeFailure: () => gates.push('failure') }
		const observer = createProviderOutcomeObserver({ gate, now: () => at(1) })
		const request: LlmRequest = { messages: [] }
		const roleCaller = createObservedLlmCaller({ call: async () => ({ kind: 'success', toolCalls: [] }) }, observer)
		const summaryCaller = { call: async (_request: LlmRequest) => providerFailure('billing') }
		await roleCaller.call(request)
		await summaryCaller.call(request)
		expect(gates).toEqual(['success'])
	})
})

describe('provider recovery binding', () => {
	test('boot hydration binds the run and does not auto-resume before the first probe backoff', async () => {
		const harness = createHarness(new Map([['run-1', JSON.stringify(suspendedMeta('run-1', transientSuspension()))]]), new Map(), [successProbe()])
		expect(harness.recovery.hydrateSuspension('run-1')).toBe(true)
		expect(harness.recovery.suspendedRunId()).toBe('run-1')
		expect(harness.recovery.readHealth().suspendedRunId).toBe('run-1')
		expect(harness.recovery.readHealth().provider.state).toBe('degraded')
		expect(harness.pending()?.milliseconds).toBe(5_000)
		expect(harness.recovery.mayAutoResume('run-1', at(4))).toBe(false)

		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.readHealth().provider.state).toBe('healthy')
		expect(harness.recovery.mayAutoResume('run-1', at(5))).toBe(true)
	})

	test('a 2xx probe with no metadata still marks the provider healthy', async () => {
		const harness = createHarness(new Map(), new Map(), [{ ok: true, status: 200 }])
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.readHealth().provider.state).toBe('healthy')
		expect(harness.recovery.readHealth().provider.consecutiveFailures).toBe(0)
	})

	test('a checkpoint suspension hydrates when the meta carries no usable record', () => {
		const harness = createHarness(new Map(), new Map([['run-2', JSON.stringify(checkpointWithSuspension('run-2', operatorSuspension('billing')))]]))
		expect(harness.recovery.hydrateSuspension('run-2')).toBe(true)
		expect(harness.recovery.readHealth().provider.state).toBe('unavailable')
		expect(harness.recovery.mayAutoResume('run-2', at(10))).toBe(false)
	})

	test('an operator suspension stays bound and never auto-resumes even after a healthy probe', async () => {
		const harness = createHarness(new Map(), new Map(), [successProbe()])
		harness.recovery.noticeSuspension(suspendedMeta('run-1', operatorSuspension('auth')))
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.suspendedRunId()).toBe('run-1')
		expect(harness.recovery.mayAutoResume('run-1', at(10))).toBe(false)
	})

	test('a mismatched release leaves the bound run and its probe lifecycle untouched', async () => {
		const harness = createHarness(new Map(), new Map(), [successProbe()])
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		const nextProbeBefore = harness.recovery.readHealth().provider.nextProbeAt
		expect(harness.recovery.releaseSuspension('run-2')).toBe(false)
		expect(harness.recovery.suspendedRunId()).toBe('run-1')
		expect(harness.recovery.readHealth().provider.nextProbeAt).toBe(nextProbeBefore)
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.readHealth().provider.state).toBe('healthy')
	})

	test('terminating the bound run while degraded keeps probing and a probe success lets dispatch resume', async () => {
		const harness = createHarness(new Map(), new Map(), [failureProbe(), successProbe()])
		let recoveredDispatches = 0
		harness.recovery.setAutoResumeHandler(() => {
			recoveredDispatches++
		})
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.readHealth().provider.state).toBe('degraded')

		expect(harness.recovery.releaseSuspension('run-1')).toBe(true)
		expect(harness.recovery.suspendedRunId()).toBeUndefined()
		expect(harness.pending()).toBeDefined()

		const delay = harness.pending()?.milliseconds ?? 0
		harness.advance(delay)
		await harness.fire()
		expect(harness.recovery.readHealth().provider.state).toBe('healthy')
		expect(recoveredDispatches).toBe(1)
		expect(harness.pending()).toBeUndefined()
	})

	test.each([404, 405] as const)('a %i probe after a degraded release still wakes dispatch', async (status) => {
		const harness = createHarness(new Map(), new Map(), [failureProbe(), failureProbe(status)])
		let recoveredDispatches = 0
		harness.recovery.setAutoResumeHandler(() => {
			recoveredDispatches++
		})
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.releaseSuspension('run-1')).toBe(true)
		const delay = harness.pending()?.milliseconds ?? 0
		harness.advance(delay)
		await harness.fire()
		expect(harness.recovery.readHealth().provider.state).toBe('unknown')
		expect(harness.recovery.canDispatch()).toBe(true)
		expect(recoveredDispatches).toBe(1)
	})

	test('an idle unhealthy gate keeps probing, recovers, and permits dispatch without a queue mutation', async () => {
		const harness = createHarness(new Map(), new Map(), [failureProbe(), successProbe()])
		let dispatches = 0
		harness.recovery.setAutoResumeHandler(() => {
			dispatches++
		})
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.canDispatch()).toBe(false)

		expect(harness.recovery.releaseSuspension('run-1')).toBe(true)
		expect(harness.pending()).toBeDefined()

		const delay = harness.pending()?.milliseconds ?? 0
		harness.advance(delay)
		await harness.fire()
		expect(harness.recovery.canDispatch()).toBe(true)
		expect(dispatches).toBe(1)
		expect(harness.pending()).toBeUndefined()
	})

	test('releasing a healthy bound run stops probing and clears stale probe metadata before a re-suspend', async () => {
		const harness = createHarness(new Map(), new Map(), [successProbe()])
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension({ autoResumeAfter: at(60) })))
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.readHealth().provider.state).toBe('healthy')
		expect(harness.recovery.readHealth().provider.nextProbeAt).toBe(at(60))

		expect(harness.recovery.releaseSuspension('run-1')).toBe(true)
		expect(harness.recovery.readHealth().provider.nextProbeAt).toBeUndefined()
		expect(harness.pending()).toBeUndefined()

		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension({ autoResumeAfter: at(120) })))
		expect(harness.delays[harness.delays.length - 1]).toBe(5_000)
	})

	test('readHealth is the coarse gate snapshot', () => {
		const harness = createHarness()
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		const health = harness.recovery.readHealth()
		expect(health.suspendedRunId).toBe('run-1')
		expect(health.resumePolicy).toBe('auto')
		expect(Object.keys(health.provider).every((key) => ['state', 'category', 'since', 'lastCheckedAt', 'lastSuccessAt', 'consecutiveFailures', 'nextProbeAt'].includes(key))).toBe(true)
	})
})

describe('provider auto-resume coordinator', () => {
	test('a due auto suspension resumes even when no queue item exists', async () => {
		const harness = createHarness(new Map(), new Map(), [successProbe()])
		const resumed: string[] = []
		let dispatches = 0
		const coordinator = createProviderAutoResumeCoordinator({
			recovery: harness.recovery,
			resumeSuspendedRun: (runId) => {
				resumed.push(runId)
				return { ok: true, runId }
			},
			onDispatch: () => {
				dispatches++
			},
		})
		harness.recovery.setAutoResumeHandler((at) => coordinator.handleHealthy(at))
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		harness.advance(5_000)
		await harness.fire()
		expect(resumed).toEqual(['run-1'])
		expect(dispatches).toBe(1)
	})

	test('an operator suspension is never resumed automatically', async () => {
		const harness = createHarness(new Map(), new Map(), [successProbe()])
		const resumed: string[] = []
		const coordinator = createProviderAutoResumeCoordinator({
			recovery: harness.recovery,
			resumeSuspendedRun: (runId) => {
				resumed.push(runId)
				return { ok: true, runId }
			},
			onDispatch: () => {},
		})
		harness.recovery.setAutoResumeHandler((at) => coordinator.handleHealthy(at))
		harness.recovery.noticeSuspension(suspendedMeta('run-1', operatorSuspension('billing')))
		harness.advance(5_000)
		await harness.fire()
		expect(resumed).toEqual([])
	})

	test('an unresumable auto run leaves cleanup to the resume operation and lets dispatch continue', async () => {
		const harness = createHarness(new Map(), new Map(), [successProbe()])
		const resumed: string[] = []
		let dispatches = 0
		const coordinator = createProviderAutoResumeCoordinator({
			recovery: harness.recovery,
			resumeSuspendedRun: (runId) => {
				resumed.push(runId)
				// The real resume operation releases the pause and discards the item; the coordinator must not duplicate that cleanup.
				harness.recovery.releaseSuspension(runId)
				return { ok: false, error: 'checkpoint_missing' }
			},
			onDispatch: () => {
				dispatches++
			},
		})
		harness.recovery.setAutoResumeHandler((at) => coordinator.handleHealthy(at))
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		harness.advance(5_000)
		await harness.fire()
		expect(harness.recovery.suspendedRunId()).toBeUndefined()
		expect(resumed).toEqual(['run-1'])
		expect(dispatches).toBe(1)
		expect(harness.pending()).toBeUndefined()
	})

	test('a checkpoint-missing auto resume records exactly one termination reason', () => {
		const metas = new Map([['run-1', JSON.stringify(suspendedMeta('run-1', transientSuspension()))]])
		const harness = createHarness(metas, new Map(), [successProbe()])
		const reasons: Array<{ runId: string; reason: string | undefined }> = []
		const submission = createRunSubmission({
			providerSuspension: harness.recovery,
			onRunSettled: async () => {},
			startRun: async () => {
				throw new Error('the auto-resume path never starts a fresh run')
			},
			resumeRun: async () => {
				throw new Error('a missing checkpoint never re-enters the run')
			},
			generateRunId: () => 'run-new',
			readProjectSettings: () => ({}),
			runDirectoryExists: () => false,
		})
		const resumeErroredOrSuspendedRun = createResumeErroredOrSuspendedRun({
			runSubmission: submission,
			readRunMetaById: (runId) => metas.get(runId) ?? null,
			readCheckpointById: () => null,
			deletePauseRequest: () => true,
			taskQueue: {
				reactivateErrorItem: () => {},
				reactivateSuspendedItem: () => {},
				discardSuspendedRun: (runId, reason) => {
					reasons.push({ runId, reason })
				},
			},
		})
		const coordinator = createProviderAutoResumeCoordinator({
			recovery: harness.recovery,
			resumeSuspendedRun: (runId) => resumeErroredOrSuspendedRun(runId, undefined),
			onDispatch: () => {},
		})
		harness.recovery.setAutoResumeHandler((at) => coordinator.handleHealthy(at))
		harness.recovery.noticeSuspension(suspendedMeta('run-1', transientSuspension()))
		harness.recovery.observeRoleCall({ kind: 'success', toolCalls: [] })
		coordinator.handleHealthy(START)

		expect(reasons).toEqual([{ runId: 'run-1', reason: 'The suspended run could not be resumed because its checkpoint is missing or corrupt, so it was interrupted.' }])
		expect(harness.recovery.suspendedRunId()).toBeUndefined()
	})
})
