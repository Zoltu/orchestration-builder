import { describe, expect, test } from 'bun:test'
import { createCompletionHealthProbeWithDependencies, HEALTH_PROBE_TIMEOUT_MS } from './health-probe.ts'
import type { ProviderProbeResult } from './provider-health.ts'

interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
	body: string
}

function createProbeWithResponse(response: Response | Error, apiKey: string | undefined = 'secret') {
	const requests: RecordedRequest[] = []
	const probe = createCompletionHealthProbeWithDependencies('https://model.example/v1', 'deployment-model', apiKey, HEALTH_PROBE_TIMEOUT_MS, {
		fetch: async (url, init) => {
			requests.push({ url, method: init.method, headers: init.headers, body: init.body })
			if (response instanceof Error) throw response
			return response
		},
		now: () => 0,
	})
	return { probe, requests }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestBody(request: RecordedRequest): Record<string, unknown> {
	const parsed: unknown = JSON.parse(request.body)
	if (!isRecord(parsed)) throw new Error('expected a JSON object request body')
	return parsed
}

describe('completion health probe', () => {
	test('a 2xx is healthy even with an empty or unreadable body', async () => {
		for (const body of ['', 'not json']) {
			const { probe } = createProbeWithResponse(new Response(body, { status: 200 }))
			const result: ProviderProbeResult = await probe()
			expect(result).toEqual({ ok: true, status: 200 })
		}
	})

	test('the request uses the configured model, no tools, streaming off, and a tiny output budget', async () => {
		const { probe, requests } = createProbeWithResponse(new Response('{}', { status: 200 }))
		await probe()
		const request = requests[0]
		if (request === undefined) throw new Error('expected a recorded request')
		expect(request.url).toBe('https://model.example/v1/responses')
		expect(request.method).toBe('POST')
		expect(request.headers['Authorization']).toBe('Bearer secret')
		const body = requestBody(request)
		expect(body['model']).toBe('deployment-model')
		expect(body['input']).toBe('ping')
		expect(body['tools']).toEqual([])
		expect(body['stream']).toBe(false)
		const maxOutputTokens = body['max_output_tokens']
		expect(typeof maxOutputTokens).toBe('number')
		if (typeof maxOutputTokens !== 'number') throw new Error('expected a numeric output budget')
		expect(maxOutputTokens).toBeGreaterThan(1)
		expect(maxOutputTokens).toBeLessThanOrEqual(16)
	})

	test('401 is human auth', async () => {
		const { probe } = createProbeWithResponse(new Response('{"error":"unauthorized"}', { status: 401 }))
		const result = await probe()
		expect(result).toMatchObject({ ok: false, transport: false, status: 401, category: 'auth', detail: '{"error":"unauthorized"}' })
	})

	test('500 is recoverable transient', async () => {
		const { probe } = createProbeWithResponse(new Response('upstream failed', { status: 500 }))
		const result = await probe()
		expect(result).toMatchObject({ ok: false, transport: false, status: 500, category: 'transient', detail: 'upstream failed' })
	})

	test('an unexpected 4xx is novel', async () => {
		const { probe } = createProbeWithResponse(new Response('unexpected conflict', { status: 409 }))
		const result = await probe()
		expect(result).toMatchObject({ ok: false, transport: false, status: 409, category: 'novel' })
	})

	test('a 404 is request_rejected', async () => {
		const { probe } = createProbeWithResponse(new Response('missing', { status: 404 }))
		const result = await probe()
		expect(result).toMatchObject({ ok: false, transport: false, status: 404, category: 'request_rejected' })
	})

	test('a timeout or transport failure is recoverable', async () => {
		const { probe } = createProbeWithResponse(new Error('The operation timed out'))
		const result = await probe()
		expect(result).toMatchObject({ ok: false, transport: true, reason: 'The operation timed out', detail: 'The operation timed out' })
	})

	test('a rejected success-body cancel cannot turn a 2xx into a transport failure', async () => {
		let cancelAttempted = false
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelAttempted = true
				throw new Error('cancel failed')
			},
		})
		const { probe } = createProbeWithResponse(new Response(body, { status: 200 }))
		const result = await probe()
		await Promise.resolve()
		expect(cancelAttempted).toBe(true)
		expect(result).toEqual({ ok: true, status: 200 })
	})

	test('an oversized error body is read only to the bound and then cancelled', async () => {
		let pulls = 0
		let cancelled = false
		const encoder = new TextEncoder()
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++
				if (pulls > 60) {
					controller.error(new Error('read too far'))
					return
				}
				controller.enqueue(encoder.encode('x'.repeat(100)))
			},
			cancel() {
				cancelled = true
			},
		})
		const { probe } = createProbeWithResponse(new Response(body, { status: 503 }))
		const result = await probe()
		if (result.ok) throw new Error('expected a failure')
		expect(cancelled).toBe(true)
		expect(pulls).toBeLessThan(60)
		expect(result.detail?.length).toBeLessThan(2100)
		expect(result.detail).toContain('[truncated]')
	})

	test('the retained error detail is bounded', async () => {
		const { probe } = createProbeWithResponse(new Response('x'.repeat(5000), { status: 503 }))
		const result = await probe()
		if (result.ok) throw new Error('expected a failure')
		expect(result.detail?.length).toBeLessThan(2100)
		expect(result.detail).toContain('[truncated]')
	})
})
