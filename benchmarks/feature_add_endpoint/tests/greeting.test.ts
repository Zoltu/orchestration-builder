import { test, expect } from 'bun:test'
import { handleRequest } from '../src/server.js'

test('GET /greeting?name=Ada returns a greeting for the name', async () => {
	const response = await handleRequest(new Request('http://localhost/greeting?name=Ada'))
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ greeting: 'Hello, Ada' })
})

test('GET /greeting with no name greets the world by default', async () => {
	const response = await handleRequest(new Request('http://localhost/greeting'))
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ greeting: 'Hello, world' })
})

test('GET /greeting?name= with an empty name greets the world by default', async () => {
	const response = await handleRequest(new Request('http://localhost/greeting?name='))
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ greeting: 'Hello, world' })
})
