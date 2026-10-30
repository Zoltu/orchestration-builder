import { describe, expect, test } from 'bun:test'
import { deriveHealthBanner } from './static/ts/health-banner.js'
import type { HealthView } from './static/ts/run-list-feed/index.js'

function health(provider: Partial<HealthView['provider']> = {}, suspendedRunId: string | null = null, resumePolicy: HealthView['resumePolicy'] = null): HealthView {
	return {
		provider: {
			state: 'healthy',
			category: 'none',
			since: '2026-01-01T00:00:00.000Z',
			lastCheckedAt: '2026-01-01T00:01:00.000Z',
			consecutiveFailures: 0,
			...provider,
		},
		suspendedRunId,
		resumePolicy,
	}
}

describe('deriveHealthBanner', () => {
	test('renders no banner for a healthy provider with no suspended run', () => {
		expect(deriveHealthBanner(health())).toBeNull()
	})

	test('an operator pause suppresses the provider banner even when health is unhealthy', () => {
		expect(deriveHealthBanner(health({ state: 'unavailable', category: 'billing' }, null, null), true)).toBeNull()
		expect(deriveHealthBanner(health({ state: 'degraded', category: 'transient' }, null, null), true)).toBeNull()
	})

	test('a healthy provider with an operator suspension says the run can be resumed', () => {
		expect(deriveHealthBanner(health({}, 'run-1', 'operator'))).toEqual({ tone: 'info', message: 'Run suspended \u2014 resume when ready.' })
	})

	test('a healthy provider with an auto suspension says it is retrying automatically', () => {
		expect(deriveHealthBanner(health({}, 'run-1', 'auto'))).toEqual({ tone: 'info', message: 'Run suspended \u2014 retrying automatically.' })
	})

	test('billing and auth name the operator action and the suspended run', () => {
		expect(deriveHealthBanner(health({ state: 'unavailable', category: 'billing' }, 'run-1', 'operator'))).toEqual({
			tone: 'warning',
			message: 'Model provider needs credit \u2014 top up, then resume the suspended run.',
		})
		expect(deriveHealthBanner(health({ state: 'unavailable', category: 'auth' }, 'run-1', 'operator'))).toEqual({
			tone: 'warning',
			message: 'Model provider rejected the credentials \u2014 fix the deployment and restart, then resume.',
		})
	})

	test('an auto transient pause retries automatically', () => {
		expect(deriveHealthBanner(health({ state: 'degraded', category: 'transient' }, 'run-1', 'auto'))).toEqual({
			tone: 'info',
			message: 'Model provider unavailable \u2014 retrying automatically.',
		})
	})

	test('an operator transient pause asks to resume the suspended run', () => {
		expect(deriveHealthBanner(health({ state: 'degraded', category: 'transient' }, 'run-1', 'operator'))).toEqual({
			tone: 'info',
			message: 'Model provider unavailable \u2014 resume the suspended run when it is healthy.',
		})
	})

	test('a transient pause downgraded by the attempt cap reads as an operator decision', () => {
		expect(deriveHealthBanner(health({ state: 'degraded', category: 'transient' }, 'run-1', 'operator'))).toEqual({
			tone: 'info',
			message: 'Model provider unavailable \u2014 resume the suspended run when it is healthy.',
		})
	})

	test('request_rejected tells the operator to fix the deployment before resuming', () => {
		expect(deriveHealthBanner(health({ state: 'unavailable', category: 'request_rejected' }, 'run-1', 'operator'))).toEqual({
			tone: 'warning',
			message: 'The model endpoint rejected the request \u2014 resume after fixing the deployment.',
		})
	})

	test('copy never references a suspended run when none is bound', () => {
		const billing = deriveHealthBanner(health({ state: 'unavailable', category: 'billing' }))
		const auth = deriveHealthBanner(health({ state: 'unavailable', category: 'auth' }))
		const transient = deriveHealthBanner(health({ state: 'degraded', category: 'transient' }))
		const requestRejected = deriveHealthBanner(health({ state: 'unavailable', category: 'request_rejected' }))
		for (const descriptor of [billing, auth, transient, requestRejected]) {
			if (descriptor === null) throw new Error('expected a banner for an unhealthy provider')
			expect(descriptor.message).not.toContain('suspended run')
			expect(descriptor.message).not.toContain('resume')
		}
	})

	test('unknown health reads as a check in progress and unavailable without a suspended run pauses dispatch', () => {
		expect(deriveHealthBanner(health({ state: 'unknown', category: 'unknown' }))).toEqual({
			tone: 'info',
			message: 'Provider status is being checked \u2014 health is not known yet.',
		})
		expect(deriveHealthBanner(health({ state: 'unavailable', category: 'none' }))).toEqual({
			tone: 'warning',
			message: 'Dispatch paused until the provider is healthy.',
		})
		expect(deriveHealthBanner(health({ state: 'unavailable', category: 'none' }, 'run-1', 'operator'))).toEqual({
			tone: 'info',
			message: 'Run suspended \u2014 resume when ready.',
		})
	})

	test('malformed or absent health renders nothing', () => {
		expect(deriveHealthBanner(null)).toBeNull()
		expect(deriveHealthBanner({})).toBeNull()
		expect(deriveHealthBanner({ provider: { state: 'bogus' }, suspendedRunId: null, resumePolicy: null })).toBeNull()
	})

	test('never carries a provider URL, key, model, header, request body, or provider body', () => {
		const leaky = {
			...health({ state: 'unavailable', category: 'auth' }, 'run-1', 'operator'),
			apiBase: 'https://private.example/v1',
			apiKey: 'sk-secret',
			model: 'private-model',
			headers: { authorization: 'Bearer secret' },
			requestBody: '{"prompt":"secret"}',
			providerBody: 'provider said no',
		}
		const descriptor = deriveHealthBanner(leaky)
		if (descriptor === null) throw new Error('expected the leaky but well-shaped health to render')
		const serialized = JSON.stringify(descriptor)
		for (const secret of ['private.example', 'sk-secret', 'private-model', 'authorization', 'provider said no', 'requestBody']) {
			expect(serialized).not.toContain(secret)
		}
	})
})
