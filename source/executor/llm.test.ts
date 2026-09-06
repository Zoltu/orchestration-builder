import { describe, expect, test } from 'bun:test'
import { createLlmCaller, type LlmFetch, type LlmFetchRequest, type LlmFetchResponse, type Sleep } from './llm.ts'
import type { ResolvedModelConfig } from './types.js'

const MODEL: ResolvedModelConfig = {
	name: 'test-model',
	apiBase: 'http://llm.test/v1',
	contextWindow: 1000,
	reasoningField: 'reasoning',
	generation: { temperature: 0.2, maxTokens: 512 },
}

// The credential is a runtime argument since it left the model config; tests that exercise the auth header pass it explicitly.
const API_KEY = 'secret-key'

interface RecordedRequest {
	url: string
	request: LlmFetchRequest
}

// A fake wire leaf plus a fake sleep: responses are queued (or a throw is queued for a network failure), every request is recorded, and backoff durations are collected instead of slept.
function createFakeWire(responses: Array<LlmFetchResponse | Error>) {
	const requests: RecordedRequest[] = []
	const sleeps: number[] = []
	const queue = [...responses]
	const llmFetch: LlmFetch = (url, request) => {
		requests.push({ url, request })
		const next = queue.shift()
		if (next === undefined) return Promise.resolve({ status: 500, body: 'unscripted response' })
		if (next instanceof Error) return Promise.reject(next)
		return Promise.resolve(next)
	}
	const sleep: Sleep = (ms) => {
		sleeps.push(ms)
		return Promise.resolve()
	}
	return { requests, sleeps, llmFetch, sleep }
}

function successBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		choices: [
			{
				message: { content: 'done', reasoning: 'thought about it' },
				finish_reason: 'stop',
			},
		],
		usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } },
		...overrides,
	})
}

describe('createLlmCaller request shaping', () => {
	test('posts the model, messages, tools, and sampling parameters with the auth header', async () => {
		const wire = createFakeWire([{ status: 200, body: successBody() }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		await caller.call({
			messages: [{ role: 'user', content: 'hi' }],
			tools: [{ name: 'read_file', description: 'reads', parameters: { type: 'object' } }],
		})
		expect(wire.requests).toHaveLength(1)
		const recorded = wire.requests[0]
		expect(recorded?.url).toBe('http://llm.test/v1/chat/completions')
		expect(recorded?.request.method).toBe('POST')
		expect(recorded?.request.headers['Authorization']).toBe('Bearer secret-key')
		const body = JSON.parse(recorded?.request.body ?? '{}')
		expect(body.model).toBe('test-model')
		expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
		expect(body.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: 'reads', parameters: { type: 'object' } } }])
		expect(body.temperature).toBe(0.2)
		expect(body.max_tokens).toBe(512)
	})

	test('omits the auth header when the api key is absent or empty', async () => {
		const wire = createFakeWire([{ status: 200, body: successBody() }])
		const caller = createLlmCaller(MODEL, undefined, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		await caller.call({ messages: [{ role: 'user', content: 'hi' }] })
		expect(wire.requests[0]?.request.headers['Authorization']).toBeUndefined()
		const emptyWire = createFakeWire([{ status: 200, body: successBody() }])
		const emptyCaller = createLlmCaller(MODEL, '', { llmFetch: emptyWire.llmFetch, sleep: emptyWire.sleep })
		await emptyCaller.call({ messages: [{ role: 'user', content: 'hi' }] })
		expect(emptyWire.requests[0]?.request.headers['Authorization']).toBeUndefined()
	})
})

describe('createLlmCaller response parsing', () => {
	test('parses content, reasoning, usage with cached tokens, and finish reason', async () => {
		const wire = createFakeWire([{ status: 200, body: successBody() }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [{ role: 'user', content: 'hi' }] })
		expect(result).toEqual({
			kind: 'success',
			content: 'done',
			reasoning: 'thought about it',
			toolCalls: [],
			usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 64 },
			finishReason: 'stop',
		})
	})

	test('parses tool calls, synthesizing missing ids and stringifying non-string arguments', async () => {
		const body = JSON.stringify({
			choices: [
				{
					message: {
						content: null,
						tool_calls: [
							{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
							{ function: { name: 'write_file', arguments: { path: 'b.ts' } } },
							{ function: { name: 42 } },
						],
					},
				},
			],
			usage: {},
		})
		const wire = createFakeWire([{ status: 200, body }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.toolCalls).toEqual([
			{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
			{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.ts"}' } },
		])
	})

	test('a null reasoning field is carried as null, and the field is omitted when unconfigured', async () => {
		const body = JSON.stringify({
			choices: [{ message: { content: 'done', reasoning: null } }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		})
		const wire = createFakeWire([{ status: 200, body }, { status: 200, body }])
		const withField = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const withResult = await withField.call({ messages: [] })
		if (withResult.kind !== 'success') throw new Error('expected success')
		expect(withResult.reasoning).toBeNull()
		const withoutField = createLlmCaller({ ...MODEL, reasoningField: undefined }, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const withoutResult = await withoutField.call({ messages: [] })
		if (withoutResult.kind !== 'success') throw new Error('expected success')
		expect(withoutResult.reasoning).toBeUndefined()
	})

	test('unparseable JSON on a success status is llm_unavailable', async () => {
		const wire = createFakeWire([{ status: 200, body: 'not json' }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'Failed to parse JSON response' })
	})

	test('a response without choices is llm_unavailable with the parse message', async () => {
		const wire = createFakeWire([{ status: 200, body: JSON.stringify({ choices: [] }) }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'No choices in response' })
	})
})

describe('createLlmCaller context budget detection', () => {
	test('a 400 with a context-length error is context_budget_exceeded with the endpoint-reported prompt tokens', async () => {
		const body = JSON.stringify({ error: { message: 'This model maximum context length was exceeded', prompt_tokens: 4242 } })
		const wire = createFakeWire([{ status: 400, body }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'context_budget_exceeded', promptTokens: 4242, contextWindow: 1000 })
	})

	test('a 429 with a context-length error is context_budget_exceeded rather than retried', async () => {
		const wire = createFakeWire([{ status: 429, body: 'request too long for the model context' }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result.kind).toBe('context_budget_exceeded')
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a 400 without context keywords is llm_unavailable and is not retried', async () => {
		const wire = createFakeWire([{ status: 400, body: 'bad request: invalid tool schema' }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'HTTP 400: bad request: invalid tool schema' })
		expect(wire.requests).toHaveLength(1)
	})
})

describe('createLlmCaller retry loop', () => {
	test('a 5xx is retried with exponential backoff and eventually succeeds', async () => {
		const wire = createFakeWire([
			{ status: 500, body: 'boom' },
			{ status: 502, body: 'boom again' },
			{ status: 200, body: successBody() },
		])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result.kind).toBe('success')
		expect(wire.requests).toHaveLength(3)
		expect(wire.sleeps).toEqual([200, 400])
	})

	test('persistent 5xx fails after three attempts with the last error', async () => {
		const wire = createFakeWire([
			{ status: 500, body: 'one' },
			{ status: 500, body: 'two' },
			{ status: 500, body: 'three' },
		])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'HTTP 500: three' })
		expect(wire.requests).toHaveLength(3)
	})

	test('a 429 without context keywords is retried like a 5xx', async () => {
		const wire = createFakeWire([
			{ status: 429, body: 'rate limited' },
			{ status: 200, body: successBody() },
		])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result.kind).toBe('success')
		expect(wire.sleeps).toEqual([200])
	})

	test('network failures are retried and reported after the final attempt', async () => {
		const wire = createFakeWire([new Error('connection refused'), new Error('connection refused'), new Error('connection refused')])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'Network error after 3 attempts: connection refused' })
		expect(wire.sleeps).toEqual([200, 400])
	})
})
