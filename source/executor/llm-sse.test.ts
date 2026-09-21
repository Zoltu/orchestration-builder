import { describe, expect, test } from 'bun:test'
import { createResponsesStreamAccumulator, createSseLineAssembler, mapHistoryToResponsesInput, mapTerminalResponseToCallResult, mapToolManifestsToResponsesTools, OversizedSseLineError, parseSseDataPayload, SSE_MAX_LINE_CHARS, type ResponsesStreamSnapshot } from './llm-sse.ts'
import type { Message, ToolManifest } from './types.js'

function itemUnder(snapshot: ResponsesStreamSnapshot, key: string) {
	const item = snapshot.items.get(key)
	if (item === undefined) throw new Error(`no item accumulated under "${key}"`)
	return item
}

function accumulatorWithDeltas(): ReturnType<typeof createResponsesStreamAccumulator> {
	const accumulator = createResponsesStreamAccumulator()
	accumulator.apply({ type: 'output_item.added', item_id: 'item_1', item: { type: 'message', role: 'assistant' } })
	accumulator.apply({ type: 'output_text.delta', item_id: 'item_1', delta: 'Hel' })
	accumulator.apply({ type: 'output_text.delta', item_id: 'item_1', delta: 'lo' })
	return accumulator
}

describe('createSseLineAssembler', () => {
	test('returns complete lines across feeds, handling \\n and \\r\\n terminators', () => {
		const assembler = createSseLineAssembler()
		expect(assembler.feed('data: one\ndata: two\r\ndata: three\n')).toEqual(['data: one', 'data: two', 'data: three'])
		expect(assembler.finish()).toEqual([])
	})

	test('emits a line split mid-line only once its terminator arrives', () => {
		const assembler = createSseLineAssembler()
		expect(assembler.feed('data: half')).toEqual([])
		expect(assembler.feed('-line\nnext')).toEqual(['data: half-line'])
		expect(assembler.finish()).toEqual(['next'])
	})

	test('emits an \\r\\n split across the \\r and the \\n as exactly one line', () => {
		const assembler = createSseLineAssembler()
		expect(assembler.feed('data: one\r')).toEqual([])
		expect(assembler.feed('\ndata: two\r\n')).toEqual(['data: one', 'data: two'])
	})

	test('returns blank lines for the caller to filter', () => {
		const assembler = createSseLineAssembler()
		expect(assembler.feed('data: one\n\ndata: two\n\n')).toEqual(['data: one', '', 'data: two', ''])
	})

	test('finish returns the trailing partial line and drains the buffer', () => {
		const assembler = createSseLineAssembler()
		assembler.feed('partial tail')
		expect(assembler.finish()).toEqual(['partial tail'])
		expect(assembler.finish()).toEqual([])
	})

	test('a terminated line longer than the cap is delivered rather than rejected', () => {
		const assembler = createSseLineAssembler()
		const longLine = `data: ${'x'.repeat(SSE_MAX_LINE_CHARS + 10)}\n`
		expect(assembler.feed(longLine)).toEqual([longLine.slice(0, -1)])
		expect(assembler.finish()).toEqual([])
	})

	test('a >1 MiB line fed across many small chunks is delivered as one line once terminated, without throwing', () => {
		const assembler = createSseLineAssembler()
		const line = `data: ${'x'.repeat(1024 * 1024 + 17)}`
		const lines: string[] = []
		for (let start = 0; start < line.length; start += 4096) lines.push(...assembler.feed(line.slice(start, start + 4096)))
		expect(lines).toEqual([])
		expect(assembler.feed('\n')).toEqual([line])
		expect(assembler.finish()).toEqual([])
	})

	test('an unterminated line at exactly the cap does not throw', () => {
		const assembler = createSseLineAssembler()
		expect(() => assembler.feed('x'.repeat(SSE_MAX_LINE_CHARS))).not.toThrow()
		expect(assembler.finish()).toEqual(['x'.repeat(SSE_MAX_LINE_CHARS)])
	})

	test('an unterminated line past the cap throws OversizedSseLineError, in one feed or across feeds', () => {
		const single = createSseLineAssembler()
		expect(() => single.feed('x'.repeat(SSE_MAX_LINE_CHARS + 1))).toThrow(OversizedSseLineError)
		const accumulated = createSseLineAssembler()
		expect(() => accumulated.feed('x'.repeat(SSE_MAX_LINE_CHARS))).not.toThrow()
		expect(() => accumulated.feed('y')).toThrow(OversizedSseLineError)
	})
})

describe('parseSseDataPayload', () => {
	test('the [DONE] sentinel is done, with or without the space after the field colon', () => {
		expect(parseSseDataPayload('data: [DONE]')).toEqual({ kind: 'done' })
		expect(parseSseDataPayload('data:[DONE]')).toEqual({ kind: 'done' })
	})

	test('a JSON object with a string type is an event carrying the parsed value', () => {
		const event = { type: 'response.created', sequence_number: 0 }
		expect(parseSseDataPayload(`data: ${JSON.stringify(event)}`)).toEqual({ kind: 'event', value: event })
	})

	test('a JSON object with an error field is an error, object or bare string', () => {
		expect(parseSseDataPayload('data: {"error":{"message":"boom"}}')).toEqual({ kind: 'error', value: { error: { message: 'boom' } } })
		expect(parseSseDataPayload('data: {"error":"bad"}')).toEqual({ kind: 'error', value: { error: 'bad' } })
	})

	test('non-data, non-JSON, and non-object lines all skip', () => {
		const lines = ['', 'event: response.completed', ': keep-alive', 'id: 4', 'retry: 3000', 'data: not json', 'data: [1, 2]', 'data: "just a string"', 'data:']
		for (const line of lines) {
			expect(parseSseDataPayload(line)).toEqual({ kind: 'skip' })
		}
	})

	test('a string type wins when an error field is also present', () => {
		expect(parseSseDataPayload('data: {"type":"x","error":1}')).toEqual({ kind: 'event', value: { type: 'x', error: 1 } })
	})

	test('a non-string type does not make an event, so the error field decides', () => {
		expect(parseSseDataPayload('data: {"type":42,"error":{"message":"m"}}')).toEqual({ kind: 'error', value: { type: 42, error: { message: 'm' } } })
	})
})

describe('createResponsesStreamAccumulator item keying', () => {
	test('deltas are keyed by item_id when present', () => {
		const accumulator = accumulatorWithDeltas()
		const snapshot = accumulator.snapshot()
		expect(snapshot.terminal).toBe('none')
		expect(snapshot.items.size).toBe(1)
		expect(itemUnder(snapshot, 'item_1')).toEqual({ type: 'message', content: 'Hello', reasoning: '', callId: undefined, name: undefined, arguments: '' })
	})

	test('the output_index keys the slot when item_id is absent', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.apply({ type: 'output_item.added', output_index: 0, item: { type: 'message' } })
		accumulator.apply({ type: 'output_text.delta', output_index: 0, delta: 'hi' })
		const snapshot = accumulator.snapshot()
		expect(snapshot.items.size).toBe(1)
		expect(itemUnder(snapshot, 'index:0').content).toBe('hi')
	})

	test('events with neither item_id nor output_index share one anonymous slot', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.apply({ type: 'reasoning_text.delta', delta: 'thin' })
		accumulator.apply({ type: 'reasoning_text.delta', delta: 'king' })
		const snapshot = accumulator.snapshot()
		expect(snapshot.items.size).toBe(1)
		const slot = itemUnder(snapshot, '')
		expect(slot.type).toBe('reasoning')
		expect(slot.reasoning).toBe('thinking')
	})
})

describe('createResponsesStreamAccumulator event folding', () => {
	test('function-call arguments accumulate across chunks, and a late output_item.added fills the slot identity', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.apply({ type: 'function_call_arguments.delta', item_id: 'fc_1', delta: '{"pa' })
		accumulator.apply({ type: 'function_call_arguments.delta', item_id: 'fc_1', delta: 'th":"a.ts"}' })
		accumulator.apply({ type: 'output_item.added', item_id: 'fc_1', item: { type: 'function_call', call_id: 'call_9', name: 'read_file' } })
		const snapshot = accumulator.snapshot()
		expect(itemUnder(snapshot, 'fc_1')).toEqual({ type: 'function_call', content: '', reasoning: '', callId: 'call_9', name: 'read_file', arguments: '{"path":"a.ts"}' })
	})

	test('done events are informational and never fold into state', () => {
		const accumulator = accumulatorWithDeltas()
		accumulator.apply({ type: 'output_text.done', item_id: 'item_1' })
		accumulator.apply({ type: 'output_item.done', item_id: 'item_1', item: { type: 'message' } })
		accumulator.apply({ type: 'content_part.done', item_id: 'item_1' })
		const snapshot = accumulator.snapshot()
		expect(snapshot.items.size).toBe(1)
		expect(itemUnder(snapshot, 'item_1').content).toBe('Hello')
	})

	test('unknown events, missing types, and lifecycle events are ignored without state', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.apply({ type: 'response.created' })
		accumulator.apply({ type: 'response.in_progress' })
		accumulator.apply({ type: 'totally.made.up', item_id: 'x', delta: 'y' })
		accumulator.apply({})
		accumulator.apply({ type: 42 })
		const snapshot = accumulator.snapshot()
		expect(snapshot.terminal).toBe('none')
		expect(snapshot.items.size).toBe(0)
		expect(snapshot.error).toBeUndefined()
		expect(snapshot.response).toBeUndefined()
	})

	test('response.completed is terminal and its response payload is stored as authoritative over the deltas', () => {
		const accumulator = accumulatorWithDeltas()
		const response = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'authoritative' }] }], usage: { input_tokens: 5, output_tokens: 2 } }
		accumulator.apply({ type: 'response.completed', response })
		const snapshot = accumulator.snapshot()
		expect(snapshot.terminal).toBe('completed')
		expect(snapshot.response).toEqual(response)
		expect(itemUnder(snapshot, 'item_1').content).toBe('Hello')
	})

	test('response.incomplete is terminal with the incomplete response stored', () => {
		const accumulator = createResponsesStreamAccumulator()
		const response = { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }
		accumulator.apply({ type: 'response.incomplete', response })
		const snapshot = accumulator.snapshot()
		expect(snapshot.terminal).toBe('incomplete')
		expect(snapshot.response).toEqual(response)
	})

	test('the first terminal marker wins over later terminals and error payloads', () => {
		const accumulator = createResponsesStreamAccumulator()
		const completed = { status: 'completed', output: [] }
		accumulator.apply({ type: 'response.completed', response: completed })
		accumulator.apply({ type: 'response.incomplete', response: { status: 'incomplete', output: [] } })
		accumulator.recordError({ error: { message: 'late error' } })
		const snapshot = accumulator.snapshot()
		expect(snapshot.terminal).toBe('completed')
		expect(snapshot.response).toEqual(completed)
		expect(snapshot.error).toBeUndefined()
	})

	test('a zero-delta stream still completes with an empty item map', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.apply({ type: 'response.created', response: { status: 'in_progress' } })
		accumulator.apply({ type: 'response.in_progress', response: { status: 'in_progress' } })
		accumulator.apply({ type: 'response.incomplete', response: { status: 'incomplete', output: [] } })
		const snapshot = accumulator.snapshot()
		expect(snapshot.terminal).toBe('incomplete')
		expect(snapshot.items.size).toBe(0)
	})

	test('the snapshot carries a copy of the item map, so mutating it does not touch the accumulator', () => {
		const accumulator = accumulatorWithDeltas()
		const snapshot = accumulator.snapshot()
		snapshot.items.clear()
		expect(accumulator.snapshot().items.size).toBe(1)
	})
})

describe('createResponsesStreamAccumulator recordError', () => {
	test('an object error payload records the message', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.recordError({ error: { message: 'generation failed' } })
		const snapshot = accumulator.snapshot()
		expect(snapshot.terminal).toBe('error')
		expect(snapshot.error).toBe('generation failed')
		expect(snapshot.response).toBeUndefined()
	})

	test('a bare-string error payload is the message itself', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.recordError({ error: 'plain failure' })
		expect(accumulator.snapshot().error).toBe('plain failure')
	})

	test('an error payload without a message degrades to a placeholder', () => {
		const accumulator = createResponsesStreamAccumulator()
		accumulator.recordError({ error: {} })
		expect(accumulator.snapshot().error).toBe('stream error without a message')
	})
})

describe('mapHistoryToResponsesInput', () => {
	test('a full conversation with a tool-call round trip maps in order with leading instructions', () => {
		const history: Message[] = [
			{ role: 'system', content: 'You are a file agent.' },
			{ role: 'user', content: 'List the files.' },
			{ role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
			{ role: 'tool', content: 'a.ts, b.ts', tool_call_id: 'call_9' },
			{ role: 'assistant', content: 'The files are a.ts and b.ts.' },
		]
		const mapped = mapHistoryToResponsesInput(history)
		expect(mapped.instructions).toBe('You are a file agent.')
		expect(mapped.input).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: 'List the files.' }] },
			{ type: 'function_call', call_id: 'call_9', name: 'list_files', arguments: '{}' },
			{ type: 'function_call_output', call_id: 'call_9', output: 'a.ts, b.ts' },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The files are a.ts and b.ts.' }] },
		])
	})

	test('assistant content is emitted before its tool calls, in tool_calls order', () => {
		const mapped = mapHistoryToResponsesInput([
			{
				role: 'assistant',
				content: 'Let me check.',
				tool_calls: [
					{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
					{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.ts"}' } },
				],
			},
		])
		expect(mapped.input).toEqual([
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
			{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
			{ type: 'function_call', call_id: 'c2', name: 'write_file', arguments: '{"path":"b.ts"}' },
		])
	})

	test('a history without a leading system message has undefined instructions', () => {
		const mapped = mapHistoryToResponsesInput([{ role: 'user', content: 'hi' }])
		expect(mapped.instructions).toBeUndefined()
		expect(mapped.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
	})

	test('a system message that is not first throws', () => {
		expect(() => mapHistoryToResponsesInput([
			{ role: 'system', content: 'first' },
			{ role: 'user', content: 'hi' },
			{ role: 'system', content: 'sneaky' },
		])).toThrow()
		expect(() => mapHistoryToResponsesInput([
			{ role: 'user', content: 'hi' },
			{ role: 'system', content: 'late' },
		])).toThrow()
	})

	test('a tool message without tool_call_id throws', () => {
		expect(() => mapHistoryToResponsesInput([{ role: 'tool', content: 'orphan output' }])).toThrow()
	})

	test('an empty history maps to an empty input without instructions', () => {
		expect(mapHistoryToResponsesInput([])).toEqual({ instructions: undefined, input: [] })
	})
})

describe('mapHistoryToResponsesInput — reasoning replay', () => {
	test('assistant reasoning is replayed as a reasoning item before the turn\'s message item', () => {
		const mapped = mapHistoryToResponsesInput([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello there', reasoning: 'I should greet the user warmly' },
		])
		expect(mapped.input).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
			{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'I should greet the user warmly' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello there' }] },
		])
	})

	test('a tool-call turn replays reasoning before the message and function_call items, with tool results following', () => {
		const mapped = mapHistoryToResponsesInput([
			{ role: 'user', content: 'List the files.' },
			{
				role: 'assistant',
				content: 'Let me check.',
				reasoning: 'The list_files tool answers this.',
				tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
			},
			{ role: 'tool', content: 'a.ts, b.ts', tool_call_id: 'call_9' },
		])
		expect(mapped.input).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: 'List the files.' }] },
			{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'The list_files tool answers this.' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
			{ type: 'function_call', call_id: 'call_9', name: 'list_files', arguments: '{}' },
			{ type: 'function_call_output', call_id: 'call_9', output: 'a.ts, b.ts' },
		])
	})

	test('a tool-call turn with empty content replays only the reasoning and function_call items', () => {
		const mapped = mapHistoryToResponsesInput([
			{ role: 'assistant', content: '', reasoning: 'calling the tool', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
		])
		expect(mapped.input).toEqual([
			{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'calling the tool' }] },
			{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{}' },
		])
	})

	test('null, absent, and empty reasoning emit no reasoning item', () => {
		const mapped = mapHistoryToResponsesInput([
			{ role: 'assistant', content: 'null reasoning', reasoning: null },
			{ role: 'assistant', content: 'absent reasoning' },
			{ role: 'assistant', content: 'empty reasoning', reasoning: '' },
		])
		expect(mapped.input).toEqual([
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'null reasoning' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'absent reasoning' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'empty reasoning' }] },
		])
	})

	test('a two-round tool conversation replays each round\'s reasoning before its own items', () => {
		const mapped = mapHistoryToResponsesInput([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'task' },
			{ role: 'assistant', content: '', reasoning: 'round one thought', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"x":1}' } }] },
			{ role: 'tool', content: '{"x":1}', tool_call_id: 'c1' },
			{ role: 'assistant', content: 'done', reasoning: 'round two thought' },
		])
		expect(mapped.instructions).toBe('sys')
		expect(mapped.input).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: 'task' }] },
			{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'round one thought' }] },
			{ type: 'function_call', call_id: 'c1', name: 'echo', arguments: '{"x":1}' },
			{ type: 'function_call_output', call_id: 'c1', output: '{"x":1}' },
			{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'round two thought' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
		])
	})
})

describe('mapToolManifestsToResponsesTools', () => {
	test('manifests map to flat function definitions with parameters passed through', () => {
		const manifests: ToolManifest[] = [
			{ name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
			{ name: 'write_file', description: 'Writes a file.', parameters: { type: 'object' } },
		]
		expect(mapToolManifestsToResponsesTools(manifests)).toEqual([
			{ type: 'function', name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
			{ type: 'function', name: 'write_file', description: 'Writes a file.', parameters: { type: 'object' } },
		])
	})

	test('an empty manifest list maps to an empty tool list', () => {
		expect(mapToolManifestsToResponsesTools([])).toEqual([])
	})
})

describe('mapTerminalResponseToCallResult', () => {
	test('a completed response maps concatenated text, reasoning, tool calls, usage details, and the tool_calls finish reason', () => {
		const response: Record<string, unknown> = {
			status: 'completed',
			output: [
				{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thinking ' }, { type: 'reasoning_text', text: 'hard' }] },
				{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello ' }, { type: 'output_text', text: 'world' }] },
				{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
			],
			usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 64 } },
		}
		expect(mapTerminalResponseToCallResult(response)).toEqual({
			kind: 'success',
			content: 'Hello world',
			reasoning: 'thinking hard',
			toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
			usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 64 },
			finishReason: 'tool_calls',
		})
	})

	test('an incomplete terminal capped by max_output_tokens maps to finish reason length', () => {
		const response: Record<string, unknown> = {
			status: 'incomplete',
			output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
			incomplete_details: { reason: 'max_output_tokens' },
			usage: { input_tokens: 10, output_tokens: 5 },
		}
		const result = mapTerminalResponseToCallResult(response)
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.finishReason).toBe('length')
		expect(result.content).toBe('partial')
	})

	test('an incomplete terminal with any other reason maps to finish reason stop', () => {
		const response: Record<string, unknown> = { status: 'incomplete', output: [], incomplete_details: { reason: 'content_filter' } }
		const result = mapTerminalResponseToCallResult(response)
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.finishReason).toBe('stop')
	})

	test('a response without output or usage degrades to empty content, no tool calls, zero usage, and stop', () => {
		expect(mapTerminalResponseToCallResult({ status: 'completed', output: [] })).toEqual({
			kind: 'success',
			content: undefined,
			reasoning: undefined,
			toolCalls: [],
			usage: { promptTokens: 0, completionTokens: 0 },
			finishReason: 'stop',
		})
	})

	test('a reasoning item whose content yields nothing falls back to its summary_text parts', () => {
		const response: Record<string, unknown> = {
			status: 'completed',
			output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'summarized ' }, { type: 'summary_text', text: 'thought' }] }],
		}
		const result = mapTerminalResponseToCallResult(response)
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.reasoning).toBe('summarized thought')
	})

	test('a reasoning item with content parts ignores its summary parts', () => {
		const response: Record<string, unknown> = {
			status: 'completed',
			output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'raw thought' }], summary: [{ type: 'summary_text', text: 'summary' }] }],
		}
		const result = mapTerminalResponseToCallResult(response)
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.reasoning).toBe('raw thought')
	})

	test('usage without input_tokens_details carries no cached prompt tokens', () => {
		const response: Record<string, unknown> = { status: 'completed', output: [], usage: { input_tokens: 7, output_tokens: 3 } }
		const result = mapTerminalResponseToCallResult(response)
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3 })
		expect(result.usage.cachedPromptTokens).toBeUndefined()
	})

	test('malformed items are skipped, a missing call_id is synthesized, and non-string arguments are stringified', () => {
		const response: Record<string, unknown> = {
			status: 'completed',
			output: [
				'not an object',
				{ type: 'message', content: 'not an array' },
				{ type: 'message', content: [{ type: 'output_text' }, { type: 'output_text', text: 'kept' }, { type: 'refusal', text: 'no' }] },
				{ type: 'function_call', name: 'no_id_tool', arguments: { path: 'b.ts' } },
				{ type: 'function_call' },
			],
		}
		const result = mapTerminalResponseToCallResult(response)
		if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
		expect(result.content).toBe('kept')
		expect(result.toolCalls).toEqual([
			{ id: 'call_0', type: 'function', function: { name: 'no_id_tool', arguments: '{"path":"b.ts"}' } },
		])
		expect(result.finishReason).toBe('tool_calls')
	})
})
