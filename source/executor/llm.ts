import type { LlmCallResult, LlmRequest, ResolvedModelConfig } from './types.js'
import { createResponsesStreamAccumulator, createSseLineAssembler, detectContextBudgetExceeded, mapHistoryToResponsesInput, mapTerminalResponseToCallResult, mapToolManifestsToResponsesTools, OversizedSseLineError, parseSseDataPayload, type ResponsesStreamSnapshot, type SseDataPayload } from './llm-sse.js'

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

export interface LlmCallerDependencies {
	llmFetch: LlmFetch
	sleep: Sleep
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

// Folds one 2xx SSE stream to its mapped call result. Reading stops at the first terminal marker — the [DONE] sentinel or an accumulated terminal event — and the reader is cancelled so the underlying connection is released without draining the tail. The stream's last line may lack its terminator, so the assembler is drained before declaring the stream terminal-less. A stream-phase failure (a rejected read, an over-cap line) maps to llm_unavailable instead of escaping: a throw out of here would reach run submission's fatal path and kill the run.
async function consumeResponsesStream(stream: ReadableStream<Uint8Array>): Promise<LlmCallResult> {
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
			const chunk = await reader.read()
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

			let response: LlmStreamResponse
			try {
				response = await dependencies.llmFetch({ url: `${model.apiBase}/responses`, method: 'POST', headers, body: JSON.stringify(body) })
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error)
				if (attempt >= maxAttempts) {
					return { kind: 'llm_unavailable', message: `Network error after ${attempt} attempts: ${lastError}` }
				}
				await dependencies.sleep(backoffMs(attempt))
				continue
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

			const result = await consumeResponsesStream(response.stream)
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
