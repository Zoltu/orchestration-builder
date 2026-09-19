import type { LlmCallResult, LlmRequest, ResolvedModelConfig } from './types.js'
import { createResponsesStreamAccumulator, createSseLineAssembler, mapHistoryToResponsesInput, mapTerminalResponseToCallResult, mapToolManifestsToResponsesTools, OversizedSseLineError, parseSseDataPayload, type ResponsesStreamSnapshot, type SseDataPayload } from './llm-sse.js'
import { asRecord, isObject, safeJsonParse } from './validation.js'

// The shared LLM wire types live in types.ts (see it for the definitions); re-exported here so every import site keeps its path.
export type { LlmCallResult, LlmRequest, LlmUsage } from './types.js'

export interface LlmCaller {
	call(request: LlmRequest): Promise<LlmCallResult>
}

// The wire-level leaf the caller composes against: one HTTP round-trip that hands back the raw SSE byte stream on a 2xx (unbuffered — the caller consumes it incrementally) and the fully-read body text on an error status (pre-stream errors are plain HTTP status + JSON on every target stack). It never converts an HTTP error status into a throw (network failures still reject, as fetch does). Everything above it — request shaping, response classification, context-budget detection, the retry loop, the stream fold — is orchestration exercised in tests through createLlmCaller with a fake LlmFetch.
export interface LlmFetchRequest {
	url: string
	method: string
	headers: Record<string, string>
	body: string
	// The connect-timeout abort wire: once this fires, the implementation must settle the request (fetch rejects on it), so a stalled endpoint can neither hold the attempt nor the socket past the caller's bound.
	signal?: AbortSignal
}

export type LlmStreamResponse =
	| { kind: 'stream'; status: number; stream: ReadableStream<Uint8Array> }
	| { kind: 'http_error'; status: number; errorBody: string }

export type LlmFetch = (request: LlmFetchRequest) => Promise<LlmStreamResponse>

export function createLlmFetch(): LlmFetch {
	return async (request) => {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: request.signal,
		})
		// A 2xx without a body stream cannot drive a turn, so it is classified with the error bodies and reported as an unavailable endpoint rather than guessed into a success.
		if (!response.ok || response.body === null) {
			return { kind: 'http_error', status: response.status, errorBody: await response.text() }
		}
		return { kind: 'stream', status: response.status, stream: response.body }
	}
}

export type Sleep = (ms: number) => Promise<void>

export function createSleep(): Sleep {
	return (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

// The timeout leaf the caller composes against: arms a one-shot callback and returns its cancel, so a phase that completes early never leaves a live timer behind. Timers are the only external system it touches, so it is injected like the other leaves and faked in tests.
export type ScheduleTimeout = (callback: () => void, ms: number) => () => void

export function createTimeoutScheduler(): ScheduleTimeout {
	return (callback, ms) => {
		const timer = setTimeout(callback, ms)
		return () => clearTimeout(timer)
	}
}

export interface LlmCallerDependencies {
	llmFetch: LlmFetch
	sleep: Sleep
	scheduleTimeout: ScheduleTimeout
}

type ParsedSuccess = Extract<LlmCallResult, { kind: 'success' }>

type ParsedClassification =
	| { kind: 'accept' }
	| { kind: 'fail_immediately'; message: string }
	| { kind: 'fail_retryable'; message: string }

// Exponential backoff between retry attempts, scaled off the 1-based attempt number.
function backoffMs(attempt: number): number {
	return Math.pow(2, attempt) * 100
}

// A completed stream can still be degenerate: a thinking model can burn the entire completion budget on reasoning before any content is emitted. Classifying after the terminal mapping routes these to the retry loop or an immediate failure instead of a silent empty turn.
// "length" with no content fails without retrying because a retry would exhaust the same budget again — the operator's lever is the maxTokens deployment setting.
// Non-empty content under "length" is a truncated-but-real response, and empty content with tool calls still drives the turn, so both remain successes.
function classifyParsedResponse(parsed: ParsedSuccess): ParsedClassification {
	const hasContent = parsed.content !== undefined && parsed.content.trim() !== ''
	if (hasContent || parsed.toolCalls.length > 0) return { kind: 'accept' }
	if (parsed.finishReason === 'length') {
		return { kind: 'fail_immediately', message: 'completion budget exhausted before any content was produced (finish_reason: length)' }
	}
	return { kind: 'fail_retryable', message: 'empty response (no content, no tool calls)' }
}

const CONTEXT_ERROR_KEYWORDS: readonly string[] = [
	'context',
	'too long',
	'maximum context',
	'context_length',
	'context length',
	'reduce the length',
	'prompt is too long',
	'token limit',
]

// A keyword gate over statuses 400/413/429, extended for the Responses-era error shapes: the structured prompt_tokens paths come first, then the count embedded in error.message, then PPQ's nested upstream error under error.metadata.raw.
export function detectContextBudgetExceeded(status: number, errorBody: string, contextWindow: number): LlmCallResult | undefined {
	if (status !== 400 && status !== 413 && status !== 429) return undefined
	const lowered = errorBody.toLowerCase()
	let looksLikeContext = false
	for (const keyword of CONTEXT_ERROR_KEYWORDS) {
		if (lowered.includes(keyword)) {
			looksLikeContext = true
			break
		}
	}
	if (!looksLikeContext) return undefined
	return { kind: 'context_budget_exceeded', promptTokens: extractPromptTokens(errorBody), contextWindow }
}

function extractPromptTokens(errorBody: string): number {
	const parsed = safeJsonParse(errorBody)
	if (!parsed.ok) return 0
	const record = asRecord(parsed.value)
	if (record === undefined) return 0
	const errorRecord = asRecord(record['error'])
	let promptTokens: number | undefined
	if (errorRecord !== undefined && typeof errorRecord['prompt_tokens'] === 'number') promptTokens = errorRecord['prompt_tokens']
	const usageRecord = asRecord(record['usage'])
	if (usageRecord !== undefined && typeof usageRecord['prompt_tokens'] === 'number') promptTokens = usageRecord['prompt_tokens']
	if (promptTokens !== undefined) return promptTokens
	if (errorRecord === undefined) return 0
	const fromMessage = promptTokensFromText(errorRecord['message'])
	if (fromMessage !== undefined) return fromMessage
	return promptTokensFromMetadataRaw(errorRecord) ?? 0
}

// Takes the last capture's digit count, commas stripped, so repeated scans can layer: the later pattern's matches overwrite the earlier scan's, keeping whichever phrasing the message actually used.
function lastTokenCount(value: string, pattern: RegExp): number | undefined {
	let last: number | undefined
	for (const match of value.matchAll(pattern)) {
		const digits = match[1]
		if (digits === undefined) continue
		last = Number.parseInt(digits.replaceAll(',', ''), 10)
	}
	return last
}

// The last occurrence wins: providers phrase the failure as "<window> tokens ... <requested> tokens", and the requested (prompt) count comes last. The parenthesized "Requested tokens (N)" form is scanned after the prose form, so it wins when a message carries both phrasings.
function promptTokensFromText(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined
	const prose = lastTokenCount(value, /(\d[\d,]*)\s*tokens?\b/gi)
	const parenthesized = lastTokenCount(value, /tokens\s*\(([\d,]+)\)/gi)
	return parenthesized ?? prose
}

// PPQ wraps the upstream provider's error body as a JSON string (or plain text) under error.metadata.raw; the wrapped copy is probed with the same structured paths before falling back to a text scan.
function promptTokensFromMetadataRaw(errorRecord: Record<string, unknown>): number | undefined {
	const metadata = asRecord(errorRecord['metadata'])
	if (metadata === undefined) return undefined
	const raw = metadata['raw']
	if (typeof raw !== 'string') return undefined
	const nested = safeJsonParse(raw)
	if (nested.ok && isObject(nested.value)) {
		if (typeof nested.value['prompt_tokens'] === 'number') return nested.value['prompt_tokens']
		const nestedError = asRecord(nested.value['error'])
		if (nestedError !== undefined && typeof nestedError['prompt_tokens'] === 'number') return nestedError['prompt_tokens']
	}
	return promptTokensFromText(raw)
}

// Stream-phase failures never retry (a fresh attempt would re-bill reasoning and risk duplicate tool calls), so the message carries what the accumulated state can tell a reviewer: the observed terminal kind and whether any deltas landed before the failure.
function streamFailureMessage(snapshot: ResponsesStreamSnapshot): string {
	const deltaDetail = snapshot.items.size === 0 ? 'no deltas received' : `deltas received for ${snapshot.items.size} item(s)`
	if (snapshot.terminal === 'error') return `SSE stream error: ${snapshot.error ?? 'unknown stream error'} (${deltaDetail})`
	return `SSE stream ended without a terminal event (${deltaDetail})`
}

// Mid-stream crash diagnostics use the same safe shape — failure class, terminal state, delta counts — never buffered content.
function streamCrashMessage(error: unknown, snapshot: ResponsesStreamSnapshot): string {
	const terminalDetail = snapshot.terminal === 'none' ? 'no terminal event observed' : `terminal ${snapshot.terminal} observed`
	const deltaDetail = snapshot.items.size === 0 ? 'no deltas received' : `deltas received for ${snapshot.items.size} item(s)`
	if (error instanceof OversizedSseLineError) return `SSE protocol failure: ${error.message}; ${terminalDetail}; ${deltaDetail}`
	const reason = error instanceof Error ? error.message : String(error)
	return `SSE stream read failed: ${reason} (${terminalDetail}, ${deltaDetail})`
}

// The idle timeout's outcome: a transport-liveness failure the caller retries like a failed connect, surfaced as its own variant because every LlmCallResult kind ends the retry loop.
type StreamIdleTimeout = { kind: 'stream_idle_timeout'; message: string }

class LlmStreamIdleTimeoutError extends Error {
	constructor(idleTimeoutMs: number) {
		super(`no bytes arrived within ${idleTimeoutMs}ms`)
		this.name = 'LlmStreamIdleTimeoutError'
	}
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

// One reader.read() raced against the idle timer: the timer's rejection is what aborts a wedged read, and the read's own later settlement falls away (its handlers only cancel the timer and settle an already-settled promise), so neither side can leak an unhandled rejection.
function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, idleTimeoutMs: number, scheduleTimeout: ScheduleTimeout): Promise<StreamReadResult> {
	return new Promise((resolve, reject) => {
		const cancelTimer = scheduleTimeout(() => reject(new LlmStreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs)
		reader.read().then(
			(result) => {
				cancelTimer()
				resolve(result)
			},
			(error) => {
				cancelTimer()
				reject(error)
			},
		)
	})
}

// Folds one 2xx SSE stream to its mapped call result. Reading stops at the first terminal marker — the [DONE] sentinel or an accumulated terminal event — and the reader is cancelled so the underlying connection is released without draining the tail. Each read is raced against an idle timeout that resets on every delivered chunk, so a stalled stream is cut without an overall deadline on a slow-but-flowing one. An idle timeout is returned as the stream_idle_timeout outcome for the caller's retry loop; every other stream-phase failure (a rejected read, an over-cap line) maps to llm_unavailable instead of escaping: a throw out of here would reach run submission's fatal path and kill the run.
async function consumeResponsesStream(stream: ReadableStream<Uint8Array>, options: { idleTimeoutMs: number; scheduleTimeout: ScheduleTimeout }): Promise<LlmCallResult | StreamIdleTimeout> {
	const decoder = new TextDecoder()
	const assembler = createSseLineAssembler()
	const accumulator = createResponsesStreamAccumulator()
	const reader = stream.getReader()

	function applyPayload(payload: SseDataPayload): boolean {
		if (payload.kind === 'skip') return false
		if (payload.kind === 'done') return true
		if (payload.kind === 'error') accumulator.recordError(payload.value)
		else accumulator.apply(payload.value)
		return accumulator.snapshot().terminal !== 'none'
	}

	// The whole consumption phase sits in one catch because a mid-stream transport or protocol collapse is genuinely exceptional, not an expected shape to branch on; the catch only remaps the failure, it does not resume.
	try {
		let reachedTerminal = false
		while (!reachedTerminal) {
			const chunk = await readWithIdleTimeout(reader, options.idleTimeoutMs, options.scheduleTimeout)
			if (chunk.done) {
				// The no-argument decode flushes a trailing incomplete UTF-8 sequence the streaming decode held back, so the final partial line is not silently truncated.
				for (const line of assembler.feed(decoder.decode())) {
					if (applyPayload(parseSseDataPayload(line))) reachedTerminal = true
				}
				break
			}
			for (const line of assembler.feed(decoder.decode(chunk.value, { stream: true }))) {
				if (applyPayload(parseSseDataPayload(line))) {
					reachedTerminal = true
					break
				}
			}
		}
		if (!reachedTerminal) {
			for (const line of assembler.finish()) applyPayload(parseSseDataPayload(line))
		}
	} catch (error) {
		// The idle timeout is a liveness failure the caller retries, not a stream collapse, so it is surfaced as its own outcome rather than folded into an llm_unavailable result.
		if (error instanceof LlmStreamIdleTimeoutError) return { kind: 'stream_idle_timeout', message: error.message }
		return { kind: 'llm_unavailable', message: streamCrashMessage(error, accumulator.snapshot()) }
	} finally {
		// Cancel on every exit path so the connection is released. Cancel is called on a body that may have failed mid-write, so its own rejection is swallowed here to keep it from replacing (and masking) the mapped result.
		await reader.cancel().catch(() => undefined)
	}

	const snapshot = accumulator.snapshot()
	if (snapshot.terminal === 'none' || snapshot.terminal === 'error') return { kind: 'llm_unavailable', message: streamFailureMessage(snapshot) }
	// markTerminal only records a terminal together with its response payload, so this guard is unreachable by construction; the type still allows the absence and the failure mode is a silent crash if it were ignored.
	if (snapshot.response === undefined) return { kind: 'llm_unavailable', message: `SSE stream terminal ${snapshot.terminal} carried no response payload` }
	return mapTerminalResponseToCallResult(snapshot.response)
}

// The connect bound only has to catch an endpoint that stalls before its response headers arrive; it is generous because slow local hardware on CPU inferencers is a supported deployment.
const LLM_CONNECT_TIMEOUT_MS = 30_000
// The stream bound is an idle timeout, not an overall deadline: the timer resets on every delivered chunk, so a slow generation that keeps streaming is never aborted, and the value must tolerate long thinking pauses between tokens on CPU inferencers.
const LLM_STREAM_IDLE_TIMEOUT_MS = 120_000

// The API key is a runtime credential (ORCHESTRATOR_API_KEY), so it rides as its own argument rather than a field on the model config — the deployment config file must never carry it. The caller takes the resolved model: the executor only ever runs with a complete model.
export function createLlmCaller(model: ResolvedModelConfig, apiKey: string | undefined, dependencies: LlmCallerDependencies): LlmCaller {
	async function call(request: LlmRequest): Promise<LlmCallResult> {
		const mappedHistory = mapHistoryToResponsesInput(request.messages)
		const body: Record<string, unknown> = {
			model: model.name,
			input: mappedHistory.input,
			tools: mapToolManifestsToResponsesTools(request.tools ?? []),
			tool_choice: 'auto',
			stream: true,
		}
		if (mappedHistory.instructions !== undefined) body['instructions'] = mappedHistory.instructions
		if (model.generation.maxTokens !== undefined) body['max_output_tokens'] = model.generation.maxTokens
		if (model.generation.temperature !== undefined) body['temperature'] = model.generation.temperature

		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		if (apiKey !== undefined && apiKey !== '') headers['Authorization'] = `Bearer ${apiKey}`

		const maxAttempts = 3
		let attempt = 0
		let lastError: string | undefined

		while (attempt < maxAttempts) {
			attempt++

			// The connect phase is bounded by an abort, not a race: aborting the fetch both unblocks the await below and releases the socket, and the timer is cancelled the moment the response headers arrive.
			const connectController = new AbortController()
			const cancelConnectTimeout = dependencies.scheduleTimeout(() => connectController.abort(), LLM_CONNECT_TIMEOUT_MS)
			let response: LlmStreamResponse
			try {
				response = await dependencies.llmFetch({ url: `${model.apiBase}/responses`, method: 'POST', headers, body: JSON.stringify(body), signal: connectController.signal })
			} catch (error) {
				// An aborted fetch is the connect timeout firing, not a plain network failure, so the retry message names the bound that tripped.
				if (connectController.signal.aborted) {
					lastError = `no response headers within ${LLM_CONNECT_TIMEOUT_MS}ms`
				} else {
					lastError = error instanceof Error ? error.message : String(error)
				}
				if (attempt >= maxAttempts) {
					return { kind: 'llm_unavailable', message: `Network error after ${attempt} attempts: ${lastError}` }
				}
				await dependencies.sleep(backoffMs(attempt))
				continue
			} finally {
				cancelConnectTimeout()
			}

			if (response.kind === 'http_error') {
				const contextExceeded = detectContextBudgetExceeded(response.status, response.errorBody, model.contextWindow)
				if (contextExceeded !== undefined) return contextExceeded
				if (response.status >= 500 || response.status === 429) {
					lastError = `HTTP ${response.status}: ${response.errorBody}`
					if (attempt >= maxAttempts) {
						return { kind: 'llm_unavailable', message: lastError }
					}
					await dependencies.sleep(backoffMs(attempt))
					continue
				}
				return { kind: 'llm_unavailable', message: `HTTP ${response.status}: ${response.errorBody}` }
			}

			const consumed = await consumeResponsesStream(response.stream, { idleTimeoutMs: LLM_STREAM_IDLE_TIMEOUT_MS, scheduleTimeout: dependencies.scheduleTimeout })
			// An idle timeout is a transport-liveness failure like a failed connect, so it is retried with backoff instead of ending the loop the way every other stream failure does; the fold already released the reader on its exit path.
			if (consumed.kind === 'stream_idle_timeout') {
				lastError = consumed.message
				if (attempt >= maxAttempts) {
					return { kind: 'llm_unavailable', message: lastError }
				}
				await dependencies.sleep(backoffMs(attempt))
				continue
			}
			const result = consumed
			if (result.kind !== 'success') return result

			const classification = classifyParsedResponse(result)
			if (classification.kind === 'accept') return result
			if (classification.kind === 'fail_immediately') {
				return { kind: 'llm_unavailable', message: classification.message }
			}
			lastError = classification.message
			if (attempt >= maxAttempts) {
				return { kind: 'llm_unavailable', message: lastError }
			}
			await dependencies.sleep(backoffMs(attempt))
		}

		return { kind: 'llm_unavailable', message: `Max retries exceeded: ${lastError ?? 'unknown'}` }
	}

	return { call }
}
