import { describe, expect, test } from 'bun:test'
import { createProviderGate, createProviderHealthMonitor, type ProviderHealth, type ProviderProbeResult } from './provider-health.ts'
import type { SuspensionRecord } from './types.ts'

const START = '2026-01-01T00:00:00.000Z'

function at(seconds: number): string {
	return new Date(Date.parse(START) + seconds * 1000).toISOString()
}

function initialHealth(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
	return {
		state: 'healthy',
		category: 'none',
		since: START,
		lastCheckedAt: START,
		consecutiveFailures: 0,
		...overrides,
	}
}

function transientSuspension(overrides: Partial<SuspensionRecord> = {}): SuspensionRecord {
	return {
		category: 'transient',
		resumePolicy: 'auto',
		message: 'The model provider is temporarily unavailable; the run will resume automatically when it recovers.',
		suspendedAt: START,
		...overrides,
	}
}

function operatorSuspension(category: SuspensionRecord['category']): SuspensionRecord {
	return { category, resumePolicy: 'operator', message: 'Resume when fixed.', suspendedAt: START }
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 10; index++) await Promise.resolve()
}

function createMonitorHarness(health: ProviderHealth, results: Array<ProviderProbeResult | Error>, randomValues: number[] = [1]) {
	const gate = createProviderGate(health)
	const delays: number[] = []
	let currentMs = Date.parse(START)
	let pending: { callback: () => void; milliseconds: number } | undefined
	let randomIndex = 0
	let healthyCalls = 0
	const queue = [...results]

	const scheduleTimeout = (callback: () => void, milliseconds: number): (() => void) => {
		const entry = { callback, milliseconds }
		delays.push(milliseconds)
		pending = entry
		return () => {
			if (pending === entry) pending = undefined
		}
	}
	const random = (): number => {
		const value = randomValues[randomIndex] ?? randomValues[randomValues.length - 1] ?? 1
		randomIndex++
		return value
	}
	const probe = async (): Promise<ProviderProbeResult> => {
		const next = queue.shift()
		if (next === undefined) throw new Error('unscripted probe')
		if (next instanceof Error) throw next
		return next
	}
	const monitor = createProviderHealthMonitor({
		gate,
		probe,
		scheduleTimeout,
		now: () => new Date(currentMs).toISOString(),
		random,
		onHealthy: () => {
			healthyCalls++
		},
	})

	return {
		gate,
		monitor,
		delays,
		healthyCalls: () => healthyCalls,
		pending: () => pending,
		advance(milliseconds: number) {
			currentMs += milliseconds
		},
		async fire(): Promise<void> {
			const entry = pending
			if (entry === undefined) throw new Error('no scheduled probe')
			pending = undefined
			entry.callback()
			await flushMicrotasks()
		},
	}
}

function createDeferredHarness(health: ProviderHealth, randomValues: number[] = [1]) {
	const gate = createProviderGate(health)
	const delays: number[] = []
	const resolvers: Array<(result: ProviderProbeResult) => void> = []
	let probeCalls = 0
	let currentMs = Date.parse(START)
	let pending: { callback: () => void; milliseconds: number } | undefined
	let randomIndex = 0
	let healthyCalls = 0

	const scheduleTimeout = (callback: () => void, milliseconds: number): (() => void) => {
		const entry = { callback, milliseconds }
		delays.push(milliseconds)
		pending = entry
		return () => {
			if (pending === entry) pending = undefined
		}
	}
	const random = (): number => {
		const value = randomValues[randomIndex] ?? randomValues[randomValues.length - 1] ?? 1
		randomIndex++
		return value
	}
	const probe = (): Promise<ProviderProbeResult> => {
		probeCalls++
		return new Promise<ProviderProbeResult>((resolve) => {
			resolvers.push(resolve)
		})
	}
	const monitor = createProviderHealthMonitor({
		gate,
		probe,
		scheduleTimeout,
		now: () => new Date(currentMs).toISOString(),
		random,
		onHealthy: () => {
			healthyCalls++
		},
	})

	return {
		gate,
		monitor,
		delays,
		probeCalls: () => probeCalls,
		healthyCalls: () => healthyCalls,
		pending: () => pending,
		advance(milliseconds: number) {
			currentMs += milliseconds
		},
		async fire(): Promise<void> {
			const entry = pending
			if (entry === undefined) throw new Error('no scheduled probe')
			pending = undefined
			entry.callback()
			await flushMicrotasks()
		},
		async resolveNext(result: ProviderProbeResult): Promise<void> {
			const resolve = resolvers.shift()
			if (resolve === undefined) throw new Error('no probe in flight')
			resolve(result)
			await flushMicrotasks()
		},
	}
}

describe('ProviderGate state transitions', () => {
	test('a transient failure is degraded and repeated failures keep the state start time', () => {
		const gate = createProviderGate(initialHealth())
		gate.observeFailure({ category: 'transient' }, at(1))
		const first = gate.snapshot().provider
		expect(first.state).toBe('degraded')
		expect(first.category).toBe('transient')
		expect(first.since).toBe(at(1))
		expect(first.lastCheckedAt).toBe(at(1))
		expect(first.consecutiveFailures).toBe(1)
		expect(first.nextProbeAt).toBeUndefined()

		gate.observeFailure({ category: 'transient' }, at(2), at(12))
		const second = gate.snapshot().provider
		expect(second.state).toBe('degraded')
		expect(second.since).toBe(at(1))
		expect(second.lastCheckedAt).toBe(at(2))
		expect(second.consecutiveFailures).toBe(2)
		expect(second.nextProbeAt).toBe(at(12))
	})

	test.each(['billing', 'auth', 'request_rejected'] as const)('%s is unavailable', (category) => {
		const gate = createProviderGate(initialHealth())
		gate.observeFailure({ category }, at(1))
		const snapshot = gate.snapshot().provider
		expect(snapshot.state).toBe('unavailable')
		expect(snapshot.category).toBe(category)
		expect(snapshot.consecutiveFailures).toBe(1)
	})

	test('an unknown failure is unknown and remains dispatchable', () => {
		const gate = createProviderGate(initialHealth())
		gate.observeFailure({ category: 'unknown' }, at(1))
		const snapshot = gate.snapshot().provider
		expect(snapshot.state).toBe('unknown')
		expect(snapshot.category).toBe('unknown')
		expect(gate.canDispatch()).toBe(true)
	})

	test('success resets failures and clears the probe schedule', () => {
		const gate = createProviderGate(initialHealth())
		gate.observeFailure({ category: 'transient' }, at(1), at(11))
		gate.observeSuccess(at(2))
		const snapshot = gate.snapshot().provider
		expect(snapshot.state).toBe('healthy')
		expect(snapshot.category).toBe('none')
		expect(snapshot.since).toBe(at(2))
		expect(snapshot.lastCheckedAt).toBe(at(2))
		expect(snapshot.lastSuccessAt).toBe(at(2))
		expect(snapshot.consecutiveFailures).toBe(0)
		expect(snapshot.nextProbeAt).toBeUndefined()
	})

	test('a healthy-to-healthy success keeps the state start time but refreshes the success timestamp', () => {
		const gate = createProviderGate(initialHealth({ since: at(3) }))
		gate.observeSuccess(at(9))
		const snapshot = gate.snapshot().provider
		expect(snapshot.since).toBe(at(3))
		expect(snapshot.lastSuccessAt).toBe(at(9))
	})

	test('dispatch is permitted only while healthy or unknown', () => {
		const gate = createProviderGate(initialHealth())
		expect(gate.canDispatch()).toBe(true)
		gate.observeFailure({ category: 'unknown' }, at(1))
		expect(gate.canDispatch()).toBe(true)
		gate.observeFailure({ category: 'transient' }, at(2))
		expect(gate.canDispatch()).toBe(false)
		gate.observeFailure({ category: 'billing' }, at(3))
		expect(gate.canDispatch()).toBe(false)
		gate.observeSuccess(at(4))
		expect(gate.canDispatch()).toBe(true)
	})

	test('the snapshot exposes only coarse fields', () => {
		const gate = createProviderGate(initialHealth())
		gate.observeFailure({ category: 'billing' }, at(1))
		const allowed = ['state', 'category', 'since', 'lastCheckedAt', 'lastSuccessAt', 'consecutiveFailures', 'nextProbeAt']
		expect(Object.keys(gate.snapshot().provider).every((key) => allowed.includes(key))).toBe(true)
		const serialized = JSON.stringify(gate.snapshot())
		expect(serialized).not.toContain('http')
		expect(serialized).not.toContain('apiKey')
		expect(serialized).not.toContain('headers')
		expect(serialized).not.toContain('body')
		expect(gate.snapshot().suspendedRunId).toBeNull()
		expect(gate.snapshot().resumePolicy).toBeNull()
	})

	test('the factory rejects illegal health-state combinations', () => {
		expect(() => createProviderGate({ ...initialHealth(), state: 'degraded', category: 'none' })).toThrow()
		expect(() => createProviderGate({ ...initialHealth(), state: 'healthy', category: 'billing' })).toThrow()
		expect(() => createProviderGate({ ...initialHealth(), state: 'unavailable', category: 'transient' })).toThrow()
		expect(() => createProviderGate({ ...initialHealth(), state: 'unknown', category: 'auth' })).toThrow()
		expect(() => createProviderGate({ ...initialHealth(), consecutiveFailures: -1 })).toThrow()
		expect(() => createProviderGate({ ...initialHealth(), since: 'not a time' })).toThrow()
	})
})

describe('ProviderGate notice and auto-resume permission', () => {
	test('a transient suspension notice records degraded state so it cannot auto-resume while healthy', () => {
		const gate = createProviderGate(initialHealth())
		gate.noticeSuspension('run-1', transientSuspension({ autoResumeAfter: at(10) }), at(1))
		const snapshot = gate.snapshot().provider
		expect(snapshot.state).toBe('degraded')
		expect(snapshot.category).toBe('transient')
		expect(snapshot.consecutiveFailures).toBe(1)
		expect(gate.suspendedRunId()).toBe('run-1')
		expect(gate.snapshot().resumePolicy).toBe('auto')
		expect(gate.autoResumeAllowed(at(10))).toBe(false)

		gate.observeSuccess(at(9))
		expect(gate.autoResumeAllowed(at(9))).toBe(false)
		gate.observeSuccess(at(10))
		expect(gate.autoResumeAllowed(at(10))).toBe(true)
	})

	test('a suspension notice does not double-count an already-recorded role failure', () => {
		const gate = createProviderGate(initialHealth())
		gate.observeFailure({ category: 'transient' }, at(1))
		gate.noticeSuspension('run-1', transientSuspension(), at(2))
		expect(gate.snapshot().provider.consecutiveFailures).toBe(1)
	})

	test.each(['billing', 'auth', 'request_rejected', 'unknown'] as const)('an operator %s suspension never auto-resumes', (category) => {
		const gate = createProviderGate(initialHealth())
		gate.noticeSuspension('run-1', operatorSuspension(category), at(1))
		expect(gate.snapshot().provider.state).toBe(category === 'unknown' ? 'unknown' : 'unavailable')
		expect(gate.autoResumeAllowed(at(10))).toBe(false)
		gate.observeSuccess(at(10))
		expect(gate.autoResumeAllowed(at(10))).toBe(false)
	})

	test('a transient suspension downgraded to operator does not auto-resume', () => {
		const gate = createProviderGate(initialHealth())
		gate.noticeSuspension('run-1', transientSuspension({ resumePolicy: 'operator' }), at(1))
		expect(gate.snapshot().resumePolicy).toBe('operator')
		gate.observeSuccess(at(2))
		expect(gate.autoResumeAllowed(at(10))).toBe(false)
	})

	test('clearing the suspended run releases the binding, including a mismatched clear', () => {
		const gate = createProviderGate(initialHealth())
		expect(gate.suspendedRunId()).toBeUndefined()
		expect(gate.autoResumeAllowed(at(1))).toBe(false)
		gate.noticeSuspension('run-1', transientSuspension(), at(1))
		expect(gate.suspendedRunId()).toBe('run-1')
		gate.clearSuspendedRun('run-2')
		expect(gate.suspendedRunId()).toBe('run-1')
		gate.clearSuspendedRun('run-1')
		expect(gate.suspendedRunId()).toBeUndefined()
		gate.observeSuccess(at(2))
		expect(gate.autoResumeAllowed(at(2))).toBe(false)
		expect(gate.snapshot().suspendedRunId).toBeNull()
	})
})

describe('ProviderHealthMonitor probes', () => {
	test('a 2xx probe marks the provider healthy and calls onHealthy for a due transient suspension', async () => {
		const harness = createMonitorHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }), [{ ok: true, status: 200 }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		expect(harness.delays).toEqual([5_000])
		expect(harness.gate.snapshot().provider.state).toBe('degraded')

		harness.advance(5_000)
		await harness.fire()
		expect(harness.gate.snapshot().provider.state).toBe('healthy')
		expect(harness.gate.snapshot().provider.consecutiveFailures).toBe(0)
		expect(harness.healthyCalls()).toBe(1)
		expect(harness.gate.suspendedRunId()).toBe('run-1')
		expect(harness.pending()).toBeUndefined()
	})

	test('a successful probe for an operator suspension reports the health change once', async () => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: true, status: 200 }])
		harness.monitor.noticeSuspension('run-1', operatorSuspension('billing'))
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		expect(harness.gate.snapshot().provider.state).toBe('healthy')
		expect(harness.healthyCalls()).toBe(1)
		expect(harness.pending()).toBeUndefined()
	})

	test.each([
		['billing', 402],
		['auth', 401],
		['auth', 403],
	] as const)('a %s probe failure is unavailable with no auto-resume', async (category, status) => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: false, transport: false, status }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		const snapshot = harness.gate.snapshot().provider
		expect(snapshot.state).toBe('unavailable')
		expect(snapshot.category).toBe(category)
		expect(snapshot.consecutiveFailures).toBe(2)
		expect(harness.gate.autoResumeAllowed(at(10))).toBe(false)
		expect(harness.healthyCalls()).toBe(0)
	})

	test('a 429 rate-limit probe stays degraded and honors Retry-After below the exponential bound', async () => {
		const harness = createMonitorHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }), [{ ok: false, transport: false, status: 429, retryAfterMs: 3_000 }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		const snapshot = harness.gate.snapshot().provider
		expect(snapshot.state).toBe('degraded')
		expect(snapshot.category).toBe('transient')
		expect(snapshot.consecutiveFailures).toBe(2)
		expect(harness.delays).toEqual([5_000, 3_000])
		expect(harness.healthyCalls()).toBe(0)
	})

	test('a 429 quota probe is billing and unavailable', async () => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: false, transport: false, status: 429, category: 'billing' }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		const snapshot = harness.gate.snapshot().provider
		expect(snapshot.state).toBe('unavailable')
		expect(snapshot.category).toBe('billing')
		expect(harness.healthyCalls()).toBe(0)
	})

	test.each([500, 502, 503, 504])('a %i probe stays degraded', async (status) => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: false, transport: false, status }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		const snapshot = harness.gate.snapshot().provider
		expect(snapshot.state).toBe('degraded')
		expect(snapshot.category).toBe('transient')
		expect(harness.healthyCalls()).toBe(0)
	})

	test('a network probe failure stays degraded', async () => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: false, transport: true }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		const snapshot = harness.gate.snapshot().provider
		expect(snapshot.state).toBe('degraded')
		expect(snapshot.category).toBe('transient')
		expect(harness.healthyCalls()).toBe(0)
	})

	test('a rejected probe is a transient failure, not an unhandled rejection', async () => {
		const harness = createMonitorHarness(initialHealth(), [new Error('socket closed')])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		const snapshot = harness.gate.snapshot().provider
		expect(snapshot.state).toBe('degraded')
		expect(snapshot.category).toBe('transient')
		expect(harness.delays).toEqual([5_000, 10_000])
		expect(harness.healthyCalls()).toBe(0)
	})

	test('a 404 probe is unknown, allows dispatch, and never auto-resumes', async () => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: false, transport: false, status: 404 }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		const snapshot = harness.gate.snapshot().provider
		expect(snapshot.state).toBe('unknown')
		expect(snapshot.category).toBe('unknown')
		expect(harness.gate.canDispatch()).toBe(true)
		expect(harness.gate.autoResumeAllowed(at(10))).toBe(false)
		expect(harness.healthyCalls()).toBe( 1)
		expect(harness.pending()).toBeUndefined()
	})

	test('a 405 probe is unknown too', async () => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: false, transport: false, status: 405 }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		expect(harness.gate.snapshot().provider.state).toBe('unknown')
	})
})

describe('ProviderHealthMonitor backoff, timing, and overlap', () => {
	test('repeated failures back off exponentially to the cap', async () => {
		const failure: ProviderProbeResult = { ok: false, transport: false, status: 503 }
		const harness = createMonitorHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }), [failure, failure, failure, failure, failure])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		expect(harness.delays).toEqual([5_000])

		const expected = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]
		for (let index = 0; index < 5; index++) {
			harness.advance(expected[index] ?? 0)
			await harness.fire()
		}
		expect(harness.delays).toEqual(expected)
	})

	test('jitter uses the injected random value', () => {
		const low = createMonitorHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }), [], [0])
		low.monitor.noticeSuspension('run-1', transientSuspension())
		low.monitor.start()
		expect(low.delays).toEqual([2_500])

		const mid = createMonitorHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }), [], [0.5])
		mid.monitor.noticeSuspension('run-1', transientSuspension())
		mid.monitor.start()
		expect(mid.delays).toEqual([3_750])
	})

	test('a zero Retry-After is floored so it cannot create a tight probe loop', async () => {
		const harness = createMonitorHarness(initialHealth(), [{ ok: false, transport: false, status: 429, retryAfterMs: 0 }])
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		expect(harness.delays).toEqual([5_000, 1_000])
	})

	test('a successful early probe waits for the suspension due time before onHealthy', async () => {
		const harness = createMonitorHarness(
			initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }),
			[
				{ ok: true, status: 200 },
				{ ok: true, status: 200 },
			],
		)
		harness.monitor.noticeSuspension('run-1', transientSuspension({ autoResumeAfter: at(60) }))
		harness.monitor.start()
		expect(harness.delays).toEqual([5_000])

		harness.advance(5_000)
		await harness.fire()
		expect(harness.gate.snapshot().provider.state).toBe('healthy')
		expect(harness.healthyCalls()).toBe(1)
		expect(harness.delays).toEqual([5_000, 55_000])

		harness.advance(55_000)
		await harness.fire()
		expect(harness.healthyCalls()).toBe(2)
		expect(harness.delays).toEqual([5_000, 55_000])
	})

	test('a notice during an in-flight probe defers the next probe instead of overlapping it', async () => {
		const harness = createDeferredHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }))
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		expect(harness.probeCalls()).toBe(1)

		harness.monitor.noticeSuspension('run-1', transientSuspension({ suspendedAt: at(5) }))
		expect(harness.probeCalls()).toBe(1)
		expect(harness.pending()).toBeUndefined()

		await harness.resolveNext({ ok: true, status: 200 })
		expect(harness.probeCalls()).toBe(1)
		expect(harness.pending()).toBeDefined()
		expect(harness.gate.snapshot().provider.state).toBe('degraded')

		harness.advance(5_000)
		await harness.fire()
		expect(harness.probeCalls()).toBe(2)
		await harness.resolveNext({ ok: true, status: 200 })
		expect(harness.gate.snapshot().provider.state).toBe('healthy')
		expect(harness.healthyCalls()).toBe(1)
	})

	test('stop during an in-flight probe ignores its result and schedules nothing', async () => {
		const harness = createDeferredHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }))
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		expect(harness.probeCalls()).toBe(1)

		harness.monitor.stop()
		await harness.resolveNext({ ok: true, status: 200 })
		expect(harness.gate.snapshot().provider.state).toBe('degraded')
		expect(harness.healthyCalls()).toBe(0)
		expect(harness.pending()).toBeUndefined()
	})

	test('start during an in-flight probe does not launch a second concurrent probe', async () => {
		const harness = createDeferredHarness(initialHealth({ state: 'degraded', category: 'transient', consecutiveFailures: 1 }))
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.start()
		harness.advance(5_000)
		await harness.fire()
		expect(harness.probeCalls()).toBe(1)

		harness.monitor.stop()
		harness.monitor.start()
		expect(harness.probeCalls()).toBe(1)
		expect(harness.pending()).toBeUndefined()

		await harness.resolveNext({ ok: true, status: 200 })
		expect(harness.probeCalls()).toBe(1)
		expect(harness.pending()).toBeDefined()
	})

	test('multiple noticeSuspension calls keep one timer and bind the latest run and category', () => {
		const harness = createMonitorHarness(initialHealth(), [], [1])
		harness.monitor.start()
		harness.monitor.noticeSuspension('run-1', transientSuspension())
		harness.monitor.noticeSuspension('run-2', operatorSuspension('billing'))
		expect(harness.gate.suspendedRunId()).toBe('run-2')
		expect(harness.gate.snapshot().provider.state).toBe('unavailable')
		expect(harness.gate.snapshot().provider.category).toBe('billing')
		expect(harness.delays).toEqual([5_000, 5_000])
		expect(harness.pending()).toBeDefined()
	})
})
