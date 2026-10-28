import { describe, expect, test } from 'bun:test'
import { createModelInfoProbeWithDependencies, toProviderProbeResult, type ModelProbeFetch } from './model-probe.ts'

const NOW = Date.parse('2026-01-01T00:00:00.000Z')

function responseFetch(status: number, body: string, headers: Record<string, string> = {}): ModelProbeFetch {
	return async () => new Response(body, { status, headers })
}

function probeWith(fetchImpl: ModelProbeFetch) {
	return createModelInfoProbeWithDependencies('http://llm.test/v1', 'secret-key', 1_000, { fetch: fetchImpl, now: () => NOW })
}

describe('createModelInfoProbeWithDependencies', () => {
	test('a 2xx JSON body is parsed and keeps the status', async () => {
		const result = await probeWith(responseFetch(200, '{"data":[{"id":"served"}]}'))()
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.status).toBe(200)
		expect(result.body).toEqual({ data: [{ id: 'served' }] })
	})

	test('a malformed 2xx body is still reachable and carries no model metadata', async () => {
		const result = await probeWith(responseFetch(200, 'not json'))()
		expect(result).toEqual({ ok: true, status: 200 })
		expect(toProviderProbeResult(result)).toEqual({ ok: true, status: 200 })
	})

	test('an empty 2xx body is still reachable and carries no model metadata', async () => {
		const result = await probeWith(responseFetch(200, ''))()
		expect(result).toEqual({ ok: true, status: 200 })
	})

	test.each([
		[400, 'request_rejected'],
		[401, 'auth'],
		[402, 'billing'],
		[403, 'auth'],
		[404, 'request_rejected'],
		[429, 'transient'],
		[500, 'transient'],
		[503, 'transient'],
	] as const)('HTTP %i is a non-transport %s failure', async (status, category) => {
		const result = await probeWith(responseFetch(status, ''))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.transport).toBe(false)
		expect(result.status).toBe(status)
		expect(result.reason).toBe(`HTTP ${status}`)
		expect(result.category).toBe(category)
		expect(result.retryAfterMs).toBeUndefined()
	})

	test('a 429 rate-limit body stays transient', async () => {
		const result = await probeWith(responseFetch(429, 'rate limited, slow down'))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.category).toBe('transient')
	})

	test('a 429 quota body is billing, not rate-limit', async () => {
		const result = await probeWith(responseFetch(429, '{"error":{"code":"insufficient_quota","message":"exceeded your current quota"}}'))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.category).toBe('billing')
	})

	test('a 403 quota body is billing, not auth', async () => {
		const result = await probeWith(responseFetch(403, 'insufficient quota: check your billing'))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.category).toBe('billing')
	})

	test('a Retry-After delta-seconds header becomes retryAfterMs', async () => {
		const result = await probeWith(responseFetch(429, '', { 'retry-after': '7' }))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.retryAfterMs).toBe(7_000)
	})

	test('an HTTP-date Retry-After header becomes retryAfterMs relative to the injected clock', async () => {
		const result = await probeWith(responseFetch(503, '', { 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' }))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.retryAfterMs).toBe(30_000)
	})

	test('a zero Retry-After is preserved as zero for the monitor floor to handle', async () => {
		const result = await probeWith(responseFetch(429, '', { 'retry-after': '0' }))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.retryAfterMs).toBe(0)
	})

	test('a rejected fetch is a transport failure', async () => {
		const result = await probeWith(async () => Promise.reject(new Error('connection refused')))()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.transport).toBe(true)
		expect(result.status).toBeUndefined()
	})
})

describe('toProviderProbeResult', () => {
	test('a success copies only the status', () => {
		expect(toProviderProbeResult({ ok: true, body: { data: [] }, status: 200 })).toEqual({ ok: true, status: 200 })
	})

	test('forwards a 404 or 405 classification unchanged for the monitor to interpret', () => {
		expect(toProviderProbeResult({ ok: false, reason: 'HTTP 404', transport: false, status: 404, category: 'request_rejected' })).toEqual({
			ok: false,
			transport: false,
			status: 404,
			category: 'request_rejected',
		})
		expect(toProviderProbeResult({ ok: false, reason: 'HTTP 405', transport: false, status: 405 })).toEqual({
			ok: false,
			transport: false,
			status: 405,
		})
	})

	test('a quota 429 keeps its billing category', () => {
		expect(toProviderProbeResult({ ok: false, reason: 'HTTP 429', transport: false, status: 429, retryAfterMs: 1_000, category: 'billing' })).toEqual({
			ok: false,
			transport: false,
			status: 429,
			retryAfterMs: 1_000,
			category: 'billing',
		})
	})

	test('a transport failure keeps its flags', () => {
		expect(toProviderProbeResult({ ok: false, reason: 'offline', transport: true })).toEqual({ ok: false, transport: true })
	})
})
