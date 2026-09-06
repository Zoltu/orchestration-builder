import { describe, expect, test } from 'bun:test'
import { ConfigurationError } from '../executor/errors.ts'
import { createBootstrapFailureHandler } from './bootstrap-failure.ts'

// The message carries every character HTML collapses or interprets, so a failure to escape would hand the error page an injection point.
const HOSTILE_MESSAGE = 'deployment.json: contextWindow must be > 0 & < "unlimited" (got <script>alert("x")</script>)'

function requestFor(path: string): Request {
	return new Request(`http://localhost:3000${path}`)
}

describe('createBootstrapFailureHandler', () => {
	test('serves a self-contained 503 HTML page for non-API paths with the message HTML-escaped', async () => {
		const handler = createBootstrapFailureHandler(new ConfigurationError(HOSTILE_MESSAGE))
		const response = handler(requestFor('/'))
		expect(response.status).toBe(503)
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
		const html = await response.text()
		expect(html).toContain('&gt; 0 &amp; &lt; &quot;unlimited&quot; (got &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;)')
		expect(html).not.toContain('<script')
		expect(html).toContain('<style>')
		expect(html).toContain('The service could not start')
		expect(html).toContain('deployment.json')
		expect(html).toContain('ORCHESTRATOR_DEPLOYMENT_FILE')
		expect(html).toContain('ORCHESTRATOR_*')
	})

	test('serves the same HTML page for deeper non-API paths', () => {
		const handler = createBootstrapFailureHandler(new ConfigurationError(HOSTILE_MESSAGE))
		expect(handler(requestFor('/history')).status).toBe(503)
	})

	test('serves 503 JSON for /api/health', async () => {
		const handler = createBootstrapFailureHandler(new ConfigurationError(HOSTILE_MESSAGE))
		const response = handler(requestFor('/api/health'))
		expect(response.status).toBe(503)
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
		expect(await response.json()).toEqual({ ok: false, error: 'configuration', message: HOSTILE_MESSAGE })
	})

	test('serves 503 JSON for other /api paths', async () => {
		const handler = createBootstrapFailureHandler(new ConfigurationError(HOSTILE_MESSAGE))
		for (const path of ['/api/runs', '/api/runs/run-1', '/api/healthz']) {
			const response = handler(requestFor(path))
			expect(response.status).toBe(503)
			expect(await response.json()).toEqual({ ok: false, error: 'configuration', message: HOSTILE_MESSAGE })
		}
	})

	test('responds 503 on every path shape', () => {
		const handler = createBootstrapFailureHandler(new ConfigurationError(HOSTILE_MESSAGE))
		for (const path of ['/', '/index.html', '/api', '/api/', '/api/health', '/api/runs']) {
			expect(handler(requestFor(path)).status).toBe(503)
		}
	})
})
