import { describe, expect, test } from 'bun:test'
import { createLlmCaller, detectContextBudgetExceeded, type LlmFetch, type LlmFetchRequest, type LlmStreamResponse, type ScheduleTimeout, type Sleep } from './llm.ts'
import { SSE_MAX_LINE_CHARS } from './llm-sse.ts'
import type { ResolvedModelConfig } from './types.js'

const MODEL: ResolvedModelConfig = {
	name: 'test-model',
	apiBase: 'http://llm.test/v1',
	contextWindow: 1000,
	generation: { temperature: 0.2, maxTokens: 512 },
}

// The credential is a runtime argument, never a field on the model config; tests that exercise the auth header pass it explicitly.
const API_KEY = 'secret-key'

// A fake wire leaf plus a fake sleep and a fake timeout scheduler: SSE streams (or an error-body response, or a queued throw for a network failure) are handed back per request, every request is recorded, backoff durations are collected instead of slept, and each armed timeout fires on the next macrotask regardless of the configured bound — armed-then-cancelled timers are always cancelled within the preceding microtask drain, so only a genuinely stalled phase ever fires one, and timersFired exposes that to assertions.
function createFakeWire(responses: Array<LlmStreamResponse | Error>) {
	const requests: LlmFetchRequest[] = []
	const sleeps: number[] = []
	let timersFired = 0
	const queue = [...responses]
	const llmFetch: LlmFetch = (request) => {
		requests.push(request)
		const next = queue.shift()
		if (next === undefined) return Promise.resolve({ kind: 'http_error', status: 500, errorBody: 'unscripted response' })
		if (next instanceof Error) return Promise.reject(next)
		return Promise.resolve(next)
	}
	const sleep: Sleep = (ms) => {
		sleeps.push(ms)
		return Promise.resolve()
	}
	const scheduleTimeout: ScheduleTimeout = (callback) => {
		const id = setTimeout(() => {
			timersFired++
			callback()
		}, 0)
		return () => clearTimeout(id)
	}
	return { requests, sleeps, timersFired: () => timersFired, llmFetch, sleep, scheduleTimeout }
}

// A fake 2xx SSE body: the chunks are queued whole, so each reader read() observes exactly one crafted chunk boundary. The optional hook records a caller-initiated cancellation (a clean stop before the stream's natural end).
function sseStream(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk)
			controller.close()
		},
		cancel() {
			onCancel?.()
		},
	})
}

function streamResponse(chunks: Uint8Array[], onCancel?: () => void): LlmStreamResponse {
	return { kind: 'stream', status: 200, stream: sseStream(chunks, onCancel) }
}

function errorResponse(status: number, errorBody: string): LlmStreamResponse {
	return { kind: 'http_error', status, errorBody }
}

function encodedChunks(lines: string[]): Uint8Array[] {
	return lines.map((line) => new TextEncoder().encode(line))
}

// One SSE data line per event, blank-line separated as both target stacks send them.
function dataLine(event: unknown): string {
	return `data: ${JSON.stringify(event)}\n\n`
}

function completedEvent(output: unknown[], usage?: Record<string, unknown>): Record<string, unknown> {
	const response: Record<string, unknown> = { status: 'completed', output }
	if (usage !== undefined) response['usage'] = usage
	return { type: 'response.completed', response }
}

// A happy-path llama.cpp-style stream (no [DONE] sentinel; the stream ends right after the terminal event) whose terminal payload carries reasoning, content, a tool call, and full usage.
function happyPathChunks(): Uint8Array[] {
	return encodedChunks([
		dataLine({ type: 'response.created' }),
		dataLine({ type: 'response.in_progress' }),
		dataLine({ type: 'output_item.added', item_id: 'r1', item: { type: 'reasoning' } }),
		dataLine({ type: 'reasoning_text.delta', item_id: 'r1', delta: 'thinking ' }),
		dataLine({ type: 'output_item.added', item_id: 'm1', item: { type: 'message' } }),
		dataLine({ type: 'output_text.delta', item_id: 'm1', delta: 'Hello' }),
		dataLine({ type: 'output_item.added', item_id: 'f1', item: { type: 'function_call', call_id: 'call_7', name: 'read_file' } }),
		dataLine({ type: 'function_call_arguments.delta', item_id: 'f1', delta: '{"path"' }),
		dataLine({ type: 'function_call_arguments.delta', item_id: 'f1', delta: ':"a.ts"}' }),
		dataLine(completedEvent(
			[
				{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking ' }] },
				{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
				{ type: 'function_call', call_id: 'call_7', name: 'read_file', arguments: '{"path":"a.ts"}' },
			],
			{ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 64 } },
		)),
	])
}

describe('createLlmCaller request shaping', () => {
	test('posts the model, mapped input, instructions, flat tools, and sampling parameters with the auth header', async () => {
		const wire = createFakeWire([streamResponse(happyPathChunks())])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		await caller.call({
			messages: [
				{ role: 'system', content: 'You are a file agent.' },
				{ role: 'user', content: 'hi' },
			],
			tools: [{ name: 'read_file', description: 'reads', parameters: { type: 'object' } }],
		})
		expect(wire.requests).toHaveLength(1)
		const recorded = wire.requests[0]
		expect(recorded?.url).toBe('http://llm.test/v1/responses')
		expect(recorded?.method).toBe('POST')
		expect(recorded?.headers['Content-Type']).toBe('application/json')
		expect(recorded?.headers['Authorization']).toBe('Bearer secret-key')
		const body = JSON.parse(recorded?.body ?? '{}')
		expect(body.model).toBe('test-model')
		expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
		expect(body.instructions).toBe('You are a file agent.')
		expect(body.tools).toEqual([{ type: 'function', name: 'read_file', description: 'reads', parameters: { type: 'object' } }])
		expect(body.tool_choice).toBe('auto')
		expect(body.stream).toBe(true)
		expect(body.temperature).toBe(0.2)
		expect(body.max_output_tokens).toBe(512)
	})

	test('omits the auth header when the api key is absent or empty', async () => {
		const wire = createFakeWire([streamResponse(happyPathChunks())])
		const caller = createLlmCaller(MODEL, undefined, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		await caller.call({ messages: [{ role: 'user', content: 'hi' }] })
		expect(wire.requests[0]?.headers['Authorization']).toBeUndefined()
		const emptyWire = createFakeWire([streamResponse(happyPathChunks())])
		const emptyCaller = createLlmCaller(MODEL, '', { llmFetch: emptyWire.llmFetch, sleep: emptyWire.sleep, scheduleTimeout: emptyWire.scheduleTimeout })
		await emptyCaller.call({ messages: [{ role: 'user', content: 'hi' }] })
		expect(emptyWire.requests[0]?.headers['Authorization']).toBeUndefined()
	})

	test('omits instructions and the optional sampling fields when unset, sending an empty tool list', async () => {
		const wire = createFakeWire([streamResponse(happyPathChunks())])
		const caller = createLlmCaller({ ...MODEL, generation: {} }, undefined, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		await caller.call({ messages: [{ role: 'user', content: 'hi' }] })
		const body = JSON.parse(wire.requests[0]?.body ?? '{}')
		expect(body.instructions).toBeUndefined()
		expect(body.temperature).toBeUndefined()
		expect(body.max_output_tokens).toBeUndefined()
		expect(body.tools).toEqual([])
	})
})

describe('createLlmCaller pre-stream retry classification', () => {
	test('network failures are retried with exponential backoff and reported after the final attempt', async () => {
		const wire = createFakeWire([new Error('connection refused'), new Error('connection refused'), new Error('connection refused')])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'Network error after 3 attempts: connection refused' })
		expect(wire.requests).toHaveLength(3)
		expect(wire.sleeps).toEqual([200, 400])
	})

	test('a 5xx is retried with exponential backoff and eventually succeeds', async () => {
		const wire = createFakeWire([errorResponse(500, 'boom'), errorResponse(502, 'boom again'), streamResponse(happyPathChunks())])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result.kind).toBe('success')
		expect(wire.requests).toHaveLength(3)
		expect(wire.sleeps).toEqual([200, 400])
	})

	test('persistent 5xx fails after three attempts with the last error body', async () => {
		const wire = createFakeWire([errorResponse(500, 'one'), errorResponse(500, 'two'), errorResponse(500, 'three')])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'HTTP 500: three' })
		expect(wire.requests).toHaveLength(3)
	})

	test('a 429 without context keywords is retried like a 5xx', async () => {
		const wire = createFakeWire([errorResponse(429, 'rate limited'), streamResponse(happyPathChunks())])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result.kind).toBe('success')
		expect(wire.sleeps).toEqual([200])
	})

	test('other 4xx statuses fail immediately with the error body and no retry', async () => {
		const wire = createFakeWire([errorResponse(400, 'bad request: invalid tool schema')])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'HTTP 400: bad request: invalid tool schema' })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a 400 whose plain body reports the context overflow is context_budget_exceeded with the endpoint prompt tokens', async () => {
		const body = JSON.stringify({ error: { message: 'This model maximum context length was exceeded', prompt_tokens: 4242 } })
		const wire = createFakeWire([errorResponse(400, body)])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'context_budget_exceeded', promptTokens: 4242, contextWindow: 1000 })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a 429 whose PPQ-nested upstream body reports the context overflow is context_budget_exceeded rather than retried', async () => {
		const raw = JSON.stringify({ error: { prompt_tokens: 12345 } })
		const body = JSON.stringify({ error: { message: 'upstream provider error: context length exceeded', metadata: { raw } } })
		const wire = createFakeWire([errorResponse(429, body)])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'context_budget_exceeded', promptTokens: 12345, contextWindow: 1000 })
		expect(wire.requests).toHaveLength(1)
	})
})

describe('createLlmCaller stream consumption', () => {
	test('a full stream with reasoning, content, and a tool call maps usage, call ids, and the tool_calls finish reason', async () => {
		const wire = createFakeWire([streamResponse(happyPathChunks())])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [{ role: 'user', content: 'hi' }] })
		expect(result).toEqual({
			kind: 'success',
			content: 'Hello',
			reasoning: 'thinking ',
			toolCalls: [{ id: 'call_7', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
			usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 64 },
			finishReason: 'tool_calls',
		})
	})

	test('a [DONE] sentinel after the terminal ends reading, cancels the reader, and ignores trailing events', async () => {
		let cancelled = false
		const wire = createFakeWire([streamResponse([
			...encodedChunks([dataLine(completedEvent([{ type: 'message', content: [{ type: 'output_text', text: 'first' }] }]))]),
			...encodedChunks(['data: [DONE]\n\n']),
			...encodedChunks([dataLine(completedEvent([{ type: 'message', content: [{ type: 'output_text', text: 'late' }] }]))]),
		], () => {
			cancelled = true
		})])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.content).toBe('first')
		expect(result.finishReason).toBe('stop')
		expect(cancelled).toBe(true)
	})

	test('a [DONE] sentinel with no terminal event before it stops reading without a mapped result', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks([
			dataLine({ type: 'response.created' }),
			'data: [DONE]\n\n',
			dataLine(completedEvent([{ type: 'message', content: [{ type: 'output_text', text: 'never read' }] }])),
		]))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'SSE stream ended without a terminal event (no deltas received)' })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a zero-delta incomplete stream fails immediately when the budget was exhausted', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks([
			dataLine({ type: 'response.created' }),
			dataLine({ type: 'response.in_progress' }),
			dataLine({ type: 'response.incomplete', response: { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } } }),
		]))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'completion budget exhausted before any content was produced (finish_reason: length)' })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a mid-stream error payload is llm_unavailable with the error message and never retried', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks([
			dataLine({ type: 'output_text.delta', item_id: 'm1', delta: 'partial' }),
			dataLine({ error: { message: 'generation failed' } }),
		]))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'SSE stream error: generation failed (deltas received for 1 item(s))' })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a stream that ends without a terminal event is llm_unavailable with the accumulated state and never retried', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks([
			dataLine({ type: 'response.created' }),
			dataLine({ type: 'reasoning_text.delta', item_id: 'r1', delta: 'cut off mid-thought' }),
		]))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'SSE stream ended without a terminal event (deltas received for 1 item(s))' })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('non-SSE lines are skipped and a stream of only them ends without a terminal event', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks(['hello\n\n', ': keep-alive\n\n', 'event: ping\n\n']))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'SSE stream ended without a terminal event (no deltas received)' })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a terminal event cut mid-line and mid-UTF-8-sequence still maps', async () => {
		// The terminal text's é is two UTF-8 bytes; the cut falls between them (every byte before it is ASCII, so the byte offset equals the code-unit offset) and the line itself is cut mid-JSON, so only a streaming decoder plus the line assembler reassemble it.
		const terminalLine = dataLine(completedEvent([{ type: 'message', content: [{ type: 'output_text', text: 'héllo' }] }]))
		const bytes = new TextEncoder().encode(terminalLine)
		const cut = terminalLine.indexOf('é') + 1
		const wire = createFakeWire([streamResponse([
			...encodedChunks([dataLine({ type: 'response.created' })]),
			bytes.slice(0, cut),
			bytes.slice(cut),
		])])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.content).toBe('héllo')
	})

	test('a stream whose read rejects mid-consumption maps to llm_unavailable instead of throwing', async () => {
		// The source errors after the first chunk, so the second read() rejects. An errored stream's cancel() rejects too (the streams spec routes cancel on an errored stream to the stored error), so this also proves the guarded cancel cannot mask the mapped result with an unhandled rejection.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(dataLine({ type: 'output_text.delta', item_id: 'm1', delta: 'partial' })))
				controller.error(new Error('connection reset'))
			},
		})
		const wire = createFakeWire([{ kind: 'stream', status: 200, stream }])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'llm_unavailable') throw new Error(`expected llm_unavailable, got ${result.kind}`)
		expect(result.message).toContain('SSE stream read failed')
		expect(result.message).toContain('connection reset')
		// Buffered stream content never leaks into the failure message.
		expect(result.message).not.toContain('partial')
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('an unterminated over-cap line maps to llm_unavailable instead of throwing and cancels the reader', async () => {
		let cancelled = false
		// The trailing chunk keeps the stream undrained when the failure lands, so the reader's cancel reaches the underlying source.
		const wire = createFakeWire([streamResponse([
			...encodedChunks([`data: ${'x'.repeat(SSE_MAX_LINE_CHARS + 1)}`]),
			...encodedChunks(['data: tail\n\n']),
		], () => {
			cancelled = true
		})])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'llm_unavailable') throw new Error(`expected llm_unavailable, got ${result.kind}`)
		expect(result.message).toContain('SSE protocol failure')
		expect(result.message).not.toContain('xxxxx')
		expect(cancelled).toBe(true)
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('a stream ending mid-UTF-8 flushes the dangling sequence into the final partial line', async () => {
		// The tail line has no terminator and its é is cut after the first byte, so the final no-argument decode() flush is what hands the dangling sequence to the assembler; the flushed replacement character never parses, so the result is the same terminal-less failure either way — this pins the flush path against crashes and truncation regressions.
		const bytes = new TextEncoder().encode('data: héllo')
		const wire = createFakeWire([streamResponse([
			...encodedChunks([dataLine({ type: 'response.created' })]),
			bytes.slice(0, 'data: h'.length + 1),
		])])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'SSE stream ended without a terminal event (no deltas received)' })
	})
})

describe('createLlmCaller result mapping', () => {
	test('a plain completed stream maps usage without cached tokens and a stop finish reason', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks([
			dataLine(completedEvent([{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }], { input_tokens: 7, output_tokens: 3 })),
		]))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({
			kind: 'success',
			content: 'answer',
			reasoning: undefined,
			toolCalls: [],
			usage: { promptTokens: 7, completionTokens: 3 },
			finishReason: 'stop',
		})
	})

	test('a function_call without a call_id synthesizes one', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks([
			dataLine(completedEvent([{ type: 'function_call', name: 'no_id_tool', arguments: '{}' }])),
		]))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.toolCalls).toEqual([{ id: 'call_0', type: 'function', function: { name: 'no_id_tool', arguments: '{}' } }])
		expect(result.finishReason).toBe('tool_calls')
	})

	test('non-empty content under an incomplete terminal capped by max_output_tokens stays a success with finish reason length', async () => {
		const wire = createFakeWire([streamResponse(encodedChunks([
			dataLine({ type: 'response.incomplete', response: { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial answer' }] }], incomplete_details: { reason: 'max_output_tokens' } } }),
		]))])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.content).toBe('partial answer')
		expect(result.finishReason).toBe('length')
		expect(wire.requests).toHaveLength(1)
	})
})

describe('createLlmCaller degenerate completed streams', () => {
	test('a completed stream with empty content and no tool calls is retried with backoff and then fails', async () => {
		const chunks = encodedChunks([dataLine(completedEvent([]))])
		const wire = createFakeWire([streamResponse(chunks), streamResponse(chunks), streamResponse(chunks)])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'empty response (no content, no tool calls)' })
		expect(wire.requests).toHaveLength(3)
		expect(wire.sleeps).toEqual([200, 400])
	})

	test('whitespace-only content under finish reason length counts as empty and fails immediately', async () => {
		const chunks = encodedChunks([dataLine({ type: 'response.incomplete', response: { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '   ' }] }], incomplete_details: { reason: 'max_output_tokens' } } })])
		const wire = createFakeWire([streamResponse(chunks)])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'completion budget exhausted before any content was produced (finish_reason: length)' })
		expect(wire.requests).toHaveLength(1)
		expect(wire.sleeps).toHaveLength(0)
	})

	test('empty content with tool calls stays a success', async () => {
		const chunks = encodedChunks([dataLine(completedEvent([{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }]))])
		const wire = createFakeWire([streamResponse(chunks)])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.toolCalls).toHaveLength(1)
		expect(result.toolCalls[0]?.function.name).toBe('read_file')
		expect(wire.requests).toHaveLength(1)
	})
})

describe('detectContextBudgetExceeded', () => {
	test('a 400 with a context keyword and error.prompt_tokens reports the endpoint count', () => {
		const body = JSON.stringify({ error: { message: 'This model maximum context length was exceeded', prompt_tokens: 4242 } })
		expect(detectContextBudgetExceeded(400, body, 1000)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 4242, contextWindow: 1000 })
	})

	test('a 413 with usage.prompt_tokens reports that count', () => {
		const body = JSON.stringify({ usage: { prompt_tokens: 9001 }, error: { message: 'context length exceeded' } })
		expect(detectContextBudgetExceeded(413, body, 8192)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 9001, contextWindow: 8192 })
	})

	test('a keyword hit on a non-JSON body reports zero prompt tokens', () => {
		expect(detectContextBudgetExceeded(429, 'request too long for the model context', 1000)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 0, contextWindow: 1000 })
	})

	test('a non-matching status or a keyword miss is not a context-budget failure', () => {
		expect(detectContextBudgetExceeded(500, 'maximum context length exceeded', 1000)).toBeUndefined()
		expect(detectContextBudgetExceeded(400, 'bad request: invalid tool schema', 1000)).toBeUndefined()
	})

	test('the keyword gate is case-insensitive', () => {
		const detected = detectContextBudgetExceeded(400, 'CONTEXT LENGTH EXCEEDED', 1000)
		expect(detected?.kind).toBe('context_budget_exceeded')
	})

	test('a token count embedded in error.message is extracted, last occurrence winning', () => {
		const body = JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens." } })
		expect(detectContextBudgetExceeded(400, body, 4096)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 5000, contextWindow: 4096 })
	})

	test('llama.cpp\'s "Requested tokens (N)" phrasing is extracted with commas stripped', () => {
		const body = JSON.stringify({ error: { message: 'Requested tokens (4,242) exceed the context window' } })
		expect(detectContextBudgetExceeded(400, body, 1000)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 4242, contextWindow: 1000 })
	})

	test('when a message carries both phrasings, the parenthesized requested count wins over the window count', () => {
		const body = JSON.stringify({ error: { message: 'Requested tokens (1269) exceed the context window of 512 tokens' } })
		expect(detectContextBudgetExceeded(400, body, 512)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 1269, contextWindow: 512 })
	})

	test('a PPQ metadata.raw nested as a JSON string is parsed for error.prompt_tokens', () => {
		const raw = JSON.stringify({ error: { prompt_tokens: 12345 } })
		const body = JSON.stringify({ error: { message: 'upstream provider error: context length exceeded', metadata: { raw } } })
		expect(detectContextBudgetExceeded(400, body, 8192)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 12345, contextWindow: 8192 })
	})

	test('a PPQ metadata.raw carrying plain text is scanned for the token count, with commas stripped', () => {
		const body = JSON.stringify({ error: { message: 'context length exceeded', metadata: { raw: 'prompt is too long: 4,242 tokens' } } })
		expect(detectContextBudgetExceeded(400, body, 4096)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 4242, contextWindow: 4096 })
	})

	test('a metadata.raw JSON payload without structured tokens falls back to a text scan', () => {
		const raw = JSON.stringify({ message: 'too many tokens: 55 tokens' })
		const body = JSON.stringify({ error: { message: 'context length exceeded', metadata: { raw } } })
		expect(detectContextBudgetExceeded(400, body, 8192)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 55, contextWindow: 8192 })
	})

	test('no extractable count anywhere reports zero prompt tokens', () => {
		const withoutRaw = JSON.stringify({ error: { message: 'context exceeded' } })
		expect(detectContextBudgetExceeded(400, withoutRaw, 1000)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 0, contextWindow: 1000 })
		const withEmptyRaw = JSON.stringify({ error: { message: 'context exceeded', metadata: { raw: 'no numbers here' } } })
		expect(detectContextBudgetExceeded(400, withEmptyRaw, 1000)).toEqual({ kind: 'context_budget_exceeded', promptTokens: 0, contextWindow: 1000 })
	})
})

describe('createLlmCaller stall timeouts', () => {
	test('a connect timeout aborts the stalled request and is retried with backoff until llm_unavailable', async () => {
		const requests: LlmFetchRequest[] = []
		const sleeps: number[] = []
		// A real fetch rejects when its signal aborts, so the fake mirrors that contract: it pends until the caller's connect timer fires and then rejects with the platform's AbortError shape.
		const llmFetch: LlmFetch = (request) => {
			requests.push(request)
			const signal = request.signal
			if (signal === undefined) return Promise.reject(new Error('expected the caller to arm a connect abort signal'))
			return new Promise((_, reject) => {
				const abort = () => {
					const abortError = new Error('This operation was aborted')
					abortError.name = 'AbortError'
					reject(abortError)
				}
				if (signal.aborted) {
					abort()
					return
				}
				signal.addEventListener('abort', abort, { once: true })
			})
		}
		const sleep: Sleep = (ms) => {
			sleeps.push(ms)
			return Promise.resolve()
		}
		const scheduleTimeout: ScheduleTimeout = (callback) => {
			const id = setTimeout(callback, 0)
			return () => clearTimeout(id)
		}
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch, sleep, scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'Network error after 3 attempts: no response headers within 30000ms' })
		expect(requests).toHaveLength(3)
		expect(sleeps).toEqual([200, 400])
	})

	test('a mid-stream idle timeout aborts the stalled read, releases the reader, and is retried with backoff until llm_unavailable', async () => {
		const encoder = new TextEncoder()
		let cancellations = 0
		// One chunk, then the source goes silent and never closes: the second read is where the stream is wedged.
		const stalledStream = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(dataLine({ type: 'response.created' })))
			},
			cancel() {
				cancellations++
			},
		})
		const wire = createFakeWire([
			{ kind: 'stream', status: 200, stream: stalledStream() },
			{ kind: 'stream', status: 200, stream: stalledStream() },
			{ kind: 'stream', status: 200, stream: stalledStream() },
		])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [] })
		expect(result).toEqual({ kind: 'llm_unavailable', message: 'no bytes arrived within 120000ms' })
		expect(wire.requests).toHaveLength(3)
		expect(wire.sleeps).toEqual([200, 400])
		expect(wire.timersFired()).toBe(3)
		// Every timed-out attempt releases its reader exactly like the existing cancellation path does.
		expect(cancellations).toBe(3)
	})

	test('a slow-but-flowing stream is never aborted: bytes within the idle window reset the timer on every chunk', async () => {
		// The happy-path body is eleven separately enqueued chunks, so every read arms a fresh idle timer and must cancel it again before the fake's macrotask can fire it.
		const wire = createFakeWire([streamResponse(happyPathChunks())])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [{ role: 'user', content: 'hi' }] })
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(wire.timersFired()).toBe(0)
	})

	test('a successful call is unaffected by the timeout composition', async () => {
		const wire = createFakeWire([streamResponse(happyPathChunks())])
		const caller = createLlmCaller(MODEL, API_KEY, { llmFetch: wire.llmFetch, sleep: wire.sleep, scheduleTimeout: wire.scheduleTimeout })
		const result = await caller.call({ messages: [{ role: 'user', content: 'hi' }] })
		expect(result).toEqual({
			kind: 'success',
			content: 'Hello',
			reasoning: 'thinking ',
			toolCalls: [{ id: 'call_7', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
			usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 64 },
			finishReason: 'tool_calls',
		})
	})
})
