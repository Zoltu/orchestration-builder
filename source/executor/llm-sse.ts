import type { LlmCallResult, LlmUsage, Message, ToolCall, ToolManifest } from './types.js'
import { asRecord, isObject, safeJsonParse } from './validation.js'

export const SSE_MAX_LINE_CHARS = 16 * 1024 * 1024

// The cap bounds the unterminated tail's memory: a stream that keeps emitting without a terminator must not grow the buffer for the lifetime of the call. Any line that arrives terminated is delivered regardless of length, and the 16 MiB backstop sits far above any legitimate line (the terminal response.completed event carries the whole response object — at a plausible max_output_tokens a worst-case line is a few hundred KB) — so a tail crossing the cap is a runaway stream, not a large event. Exceeding it is a mid-stream protocol failure, so the cleanest mechanism is a dedicated error the caller classifies as terminal — an {oversized: true} return variant would thread a third outcome through every call site that no legitimate stream produces.
export class OversizedSseLineError extends Error {
	constructor(
		public bufferedChars: number,
	) {
		super(`SSE line exceeded the ${SSE_MAX_LINE_CHARS}-character cap without a terminator (${bufferedChars} characters buffered)`)
		this.name = 'OversizedSseLineError'
	}
}

interface SseLineAssembler {
	feed(text: string): string[]
	finish(): string[]
}

// A pure string-level splitter: partial UTF-8 is the caller's TextDecoder concern, so feed always receives decoded text. A trailing \r is held in the buffer until the \n arrives, so an \r\n split across feeds terminates exactly one line.
export function createSseLineAssembler(): SseLineAssembler {
	let buffer = ''
	function feed(text: string): string[] {
		buffer += text
		const lines: string[] = []
		let newlineIndex = buffer.indexOf('\n')
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex)
			lines.push(line.endsWith('\r') ? line.slice(0, -1) : line)
			buffer = buffer.slice(newlineIndex + 1)
			newlineIndex = buffer.indexOf('\n')
		}
		if (buffer.length > SSE_MAX_LINE_CHARS) throw new OversizedSseLineError(buffer.length)
		return lines
	}
	function finish(): string[] {
		const rest = buffer
		buffer = ''
		return rest === '' ? [] : [rest]
	}
	return { feed, finish }
}

export type SseDataPayload =
	| { kind: 'done' }
	| { kind: 'event'; value: Record<string, unknown> }
	| { kind: 'error'; value: Record<string, unknown> }
	| { kind: 'skip' }

// Takes one assembled SSE line whole (the assembler is field-agnostic): the data: field prefix is recognized here per the SSE spec (one optional leading space), and every non-data line — event:, id:, retry:, comments, blanks — skips. The spec allows one event's data to span multiple data: lines, but each line is parsed independently here, so a multi-line event surfaces as fragments that skip as invalid JSON — a deliberate limitation, since both target stacks send single-line data. PPQ and llama.cpp send only bare data lines, but real streams still carry the other fields.
export function parseSseDataPayload(line: string): SseDataPayload {
	if (!line.startsWith('data:')) return { kind: 'skip' }
	const rawValue = line.slice('data:'.length)
	const payload = (rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue).trim()
	if (payload === '[DONE]') return { kind: 'done' }
	const parsed = safeJsonParse(payload)
	if (!parsed.ok || !isObject(parsed.value)) return { kind: 'skip' }
	// A Responses event always carries a string type; a bare {"error": ...} line (llama.cpp's mid-stream failure shape) has none, so type wins when both are somehow present.
	if (typeof parsed.value['type'] === 'string') return { kind: 'event', value: parsed.value }
	if ('error' in parsed.value) return { kind: 'error', value: parsed.value }
	return { kind: 'skip' }
}

type ResponsesStreamTerminal = 'completed' | 'incomplete' | 'error' | 'none'

interface ResponsesAccumulatedItem {
	type: string
	content: string
	reasoning: string
	callId: string | undefined
	name: string | undefined
	arguments: string
}

export interface ResponsesStreamSnapshot {
	terminal: ResponsesStreamTerminal
	response: Record<string, unknown> | undefined
	error: string | undefined
	items: Map<string, ResponsesAccumulatedItem>
}

interface ResponsesStreamAccumulator {
	apply(event: Record<string, unknown>): void
	recordError(payload: Record<string, unknown>): void
	snapshot(): ResponsesStreamSnapshot
}

const ANONYMOUS_ITEM_KEY = ''

// Delta events are keyed by item_id when the stack sends one, else by output_index (prefixed so the two key spaces can never collide), else all events share one anonymous slot.
function eventItemKey(event: Record<string, unknown>): string {
	const itemId = event['item_id']
	if (typeof itemId === 'string' && itemId !== '') return itemId
	const outputIndex = event['output_index']
	if (typeof outputIndex === 'number') return `index:${outputIndex}`
	return ANONYMOUS_ITEM_KEY
}

// The payload is the whole parsed data line ({error: ...}): llama.cpp nests an object carrying a message, but the error value can also be a bare string.
function streamErrorMessage(payload: Record<string, unknown>): string {
	const errorValue = payload['error']
	if (typeof errorValue === 'string') return errorValue
	const errorRecord = asRecord(errorValue)
	if (errorRecord !== undefined && typeof errorRecord['message'] === 'string') return errorRecord['message']
	return 'stream error without a message'
}

// Folds Responses SSE events into accumulated turn state. The delta-driven item map exists for incremental UX and mid-stream failure detail; the terminal event's response payload is authoritative for the result, and llama.cpp defers all *_done events to the end, so done events are informational only.
export function createResponsesStreamAccumulator(): ResponsesStreamAccumulator {
	let terminal: ResponsesStreamTerminal = 'none'
	let terminalResponse: Record<string, unknown> | undefined
	let errorMessage: string | undefined
	const items = new Map<string, ResponsesAccumulatedItem>()

	function ensureSlot(key: string, type: string): ResponsesAccumulatedItem {
		const existing = items.get(key)
		if (existing !== undefined) return existing
		const slot: ResponsesAccumulatedItem = { type, content: '', reasoning: '', callId: undefined, name: undefined, arguments: '' }
		items.set(key, slot)
		return slot
	}

	// The first terminal marker wins: a stream cannot complete twice, and a completed arriving after an error must not mask the failure the caller has to surface.
	function markTerminal(next: 'completed' | 'incomplete', response: unknown): void {
		if (terminal !== 'none') return
		const responseRecord = asRecord(response)
		if (responseRecord === undefined) return
		terminal = next
		terminalResponse = responseRecord
	}

	function registerAddedItem(event: Record<string, unknown>): void {
		const slot = ensureSlot(eventItemKey(event), '')
		const item = asRecord(event['item'])
		if (item === undefined) return
		if (typeof item['type'] === 'string') slot.type = item['type']
		if (typeof item['call_id'] === 'string') slot.callId = item['call_id']
		if (typeof item['name'] === 'string') slot.name = item['name']
	}

	function appendDelta(event: Record<string, unknown>, field: 'content' | 'reasoning' | 'arguments', impliedType: string): void {
		// A delta can arrive for a slot whose output_item.added never appeared (llama.cpp omits it for consecutive function calls), so the delta kind implies the slot type on demand.
		const slot = ensureSlot(eventItemKey(event), impliedType)
		const delta = event['delta']
		if (typeof delta !== 'string') return
		slot[field] += delta
	}

	function apply(event: Record<string, unknown>): void {
		const type = event['type']
		if (typeof type !== 'string') return
		if (type === 'response.completed' || type === 'response.incomplete') {
			markTerminal(type === 'response.completed' ? 'completed' : 'incomplete', event['response'])
			return
		}
		if (type === 'output_item.added') {
			registerAddedItem(event)
			return
		}
		if (type === 'reasoning_text.delta') {
			appendDelta(event, 'reasoning', 'reasoning')
			return
		}
		if (type === 'output_text.delta') {
			appendDelta(event, 'content', 'message')
			return
		}
		if (type === 'function_call_arguments.delta') {
			appendDelta(event, 'arguments', 'function_call')
			return
		}
	}

	function recordError(payload: Record<string, unknown>): void {
		if (terminal !== 'none') return
		terminal = 'error'
		errorMessage = streamErrorMessage(payload)
	}

	function snapshot(): ResponsesStreamSnapshot {
		// A copy, so a caller holding a snapshot cannot mutate the accumulator's item state through it.
		return { terminal, response: terminalResponse, error: errorMessage, items: new Map(items) }
	}

	return { apply, recordError, snapshot }
}

// Pure per-event delta mapping for the streaming tap: ONLY the two payload-text delta kinds map — reasoning_text.delta to the reasoning field, output_text.delta to content. Function-call argument deltas are tool-wire detail no client should render as turn text, and every other event (lifecycle, terminal, done) carries no delta, so all of them return undefined. A delta event whose payload is malformed (a missing or non-string delta) is not a delta.
export function streamDeltaOf(event: Record<string, unknown>): { field: 'reasoning' | 'content'; text: string } | undefined {
	const type = event['type']
	if (type !== 'reasoning_text.delta' && type !== 'output_text.delta') return undefined
	const delta = event['delta']
	if (typeof delta !== 'string') return undefined
	return { field: type === 'reasoning_text.delta' ? 'reasoning' : 'content', text: delta }
}

interface MappedResponsesHistory {
	instructions: string | undefined
	input: unknown[]
}

// The engine guarantees exactly one leading system message, so a system message anywhere else is a bug to fail on, not a shape to bend the wire format around. Reasoning is replayed every turn as a reasoning input item placed before that turn's message and function_call items (OpenAI's documented replay pattern) — a message whose reasoning is absent, null, or empty (e.g. cleared by the guild's edit_context strip_reasoning op, or a non-reasoning turn) emits no reasoning item. The item carries no id (ids are ephemeral on the target stacks) and no summary. History stays append-only between compaction events — the context manager's agent-decided `edit_context` rewrites are themselves compaction events — to preserve the server's prompt-cache prefix (see docs/reference.md "Compaction and the prompt cache").
export function mapHistoryToResponsesInput(messages: Message[]): MappedResponsesHistory {
	let instructions: string | undefined
	const input: unknown[] = []
	for (const [index, message] of messages.entries()) {
		if (message.role === 'system') {
			if (index !== 0) throw new Error(`system message at index ${index} is not first; the engine guarantees exactly one leading system message`)
			instructions = message.content
			continue
		}
		if (message.role === 'user') {
			input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] })
			continue
		}
		if (message.role === 'assistant') {
			if (typeof message.reasoning === 'string' && message.reasoning !== '') {
				input.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: message.reasoning }] })
			}
			// An empty-content assistant turn carries nothing on the wire; a tool-call turn is the common case. The role:'assistant' input item must carry the type:'message' discriminator — the wire's input-item schema requires it the same way output items do.
			if (message.content !== '') input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
			for (const toolCall of message.tool_calls ?? []) {
				input.push({ type: 'function_call', call_id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments })
			}
			continue
		}
		if (message.tool_call_id === undefined) throw new Error(`tool message at index ${index} is missing tool_call_id`)
		input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
	}
	return { instructions, input }
}

interface ResponsesTool {
	type: 'function'
	name: string
	description: string
	parameters: unknown
}

export function mapToolManifestsToResponsesTools(manifests: ToolManifest[]): ResponsesTool[] {
	return manifests.map((manifest): ResponsesTool => ({
		type: 'function',
		name: manifest.name,
		description: manifest.description,
		parameters: manifest.parameters,
	}))
}

function collectTextParts(value: unknown, partType: string): string[] {
	const parts: string[] = []
	if (!Array.isArray(value)) return parts
	for (const part of value) {
		if (!isObject(part)) continue
		if (part['type'] !== partType) continue
		if (typeof part['text'] === 'string') parts.push(part['text'])
	}
	return parts
}

function argumentsAsString(value: unknown): string {
	if (typeof value === 'string') return value
	if (value === undefined || value === null) return ''
	const serialized = JSON.stringify(value)
	return serialized ?? ''
}

// Builds the call result from the authoritative terminal response payload (response.completed / response.incomplete), not from the deltas. Every field comes from external wire data, so each is read through a guard and a missing field degrades to an empty default.
export function mapTerminalResponseToCallResult(response: Record<string, unknown>): LlmCallResult {
	const output = Array.isArray(response['output']) ? response['output'] : []
	const contentParts: string[] = []
	const reasoningParts: string[] = []
	const toolCalls: ToolCall[] = []
	let hasFunctionCall = false
	for (const item of output) {
		if (!isObject(item)) continue
		if (item['type'] === 'message') {
			contentParts.push(...collectTextParts(item['content'], 'output_text'))
		} else if (item['type'] === 'reasoning') {
			// Some stacks report reasoning only as summary parts (no raw reasoning_text content), so an item whose content yields nothing falls back to its summary_text parts.
			const contentReasoning = collectTextParts(item['content'], 'reasoning_text')
			if (contentReasoning.length > 0) reasoningParts.push(...contentReasoning)
			else reasoningParts.push(...collectTextParts(item['summary'], 'summary_text'))
		} else if (item['type'] === 'function_call') {
			hasFunctionCall = true
			const name = item['name']
			if (typeof name !== 'string') continue
			const callId = typeof item['call_id'] === 'string' ? item['call_id'] : `call_${toolCalls.length}`
			toolCalls.push({ id: callId, type: 'function', function: { name, arguments: argumentsAsString(item['arguments']) } })
		}
	}

	const usageRecord = asRecord(response['usage'])
	let promptTokens = 0
	let completionTokens = 0
	let cachedPromptTokens: number | undefined
	if (usageRecord !== undefined) {
		if (typeof usageRecord['input_tokens'] === 'number') promptTokens = usageRecord['input_tokens']
		if (typeof usageRecord['output_tokens'] === 'number') completionTokens = usageRecord['output_tokens']
		const inputDetails = asRecord(usageRecord['input_tokens_details'])
		if (inputDetails !== undefined && typeof inputDetails['cached_tokens'] === 'number') cachedPromptTokens = inputDetails['cached_tokens']
	}

	let finishReason = 'stop'
	if (hasFunctionCall) {
		finishReason = 'tool_calls'
	} else if (response['status'] === 'incomplete' && asRecord(response['incomplete_details'])?.['reason'] === 'max_output_tokens') {
		finishReason = 'length'
	}

	const usage: LlmUsage = { promptTokens, completionTokens }
	if (cachedPromptTokens !== undefined) usage.cachedPromptTokens = cachedPromptTokens

	const content = contentParts.length > 0 ? contentParts.join('') : undefined
	const reasoning = reasoningParts.length > 0 ? reasoningParts.join('') : undefined
	return { kind: 'success', content, reasoning, toolCalls, usage, finishReason }
}
