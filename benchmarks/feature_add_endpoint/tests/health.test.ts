import { test, expect } from 'bun:test'
import { handleRequest } from '../src/server.js'

test('GET /health returns ok json', async () => {
	const response = await handleRequest(new Request('http://localhost/health'))
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ ok: true })
})

test('unknown paths return 404', async () => {
	const response = await handleRequest(new Request('http://localhost/nope'))
	expect(response.status).toBe(404)
})
