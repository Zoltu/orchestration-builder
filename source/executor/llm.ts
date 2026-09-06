import type { Message, ResolvedModelConfig, ToolCall, ToolManifest } from './types.js'
import { isObject } from './validation.js'

export interface LlmRequest {
	messages: Message[]
	tools?: ToolManifest[]
}

export interface LlmUsage {
	promptTokens: number
	completionTokens: number
	// Cached prompt tokens reported by the endpoint via usage.prompt_tokens_details.cached_tokens, when present. Already included in promptTokens; split out because cached tokens are billed at a different (usually much lower) rate than uncached prompt tokens.
	cachedPromptTokens?: number
}

export type LlmCallResult =
	| {
		kind: 'success'
		content?: string
		reasoning?: string | null
		toolCalls: ToolCall[]
		usage: LlmUsage
		// OpenAI finish_reason for choices[0] (e.g. "stop", "length", "tool_calls", "content_filter"), so a reviewer can tell why the model stopped emitting. Absent when the endpoint omits the field, so "absent" is distinguishable from a default like "".
		finishReason?: string
	}
	| { kind: 'context_budget_exceeded'; promptTokens: number; contextWindow: number }
	| { kind: 'llm_unavailable'; message: string }

export interface LlmCaller {
	call(request: LlmRequest): Promise<LlmCallResult>
}

// The wire-level leaf the caller composes against: one HTTP round-trip that returns the status and raw body text and never converts an HTTP error status into a throw (network failures still reject, as fetch does). Everything above it — request shaping, response parsing, context-budget detection, the retry loop — is orchestration exercised in tests through createLlmCaller with a fake LlmFetch.
export interface LlmFetchRequest {
	method: string
	headers: Record<string, string>
	body: string
}

export interface LlmFetchResponse {
	status: number
	body: string
}

export type LlmFetch = (url: string, request: LlmFetchRequest) => Promise<LlmFetchResponse>

export function createLlmFetch(): LlmFetch {
	return async (url, request) => {
		const response = await fetch(url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
		})
		return { status: response.status, body: await response.text() }
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isObject(value) ? value : undefined
}

interface ParsedSuccess {
	kind: 'success'
	content?: string
	reasoning?: string | null
	toolCalls: ToolCall[]
	usage: LlmUsage
	finishReason?: string
}

interface ParsedError {
	kind: 'parse_error'
	message: string
}

function parseOpenAiResponse(data: unknown, reasoningField: string | undefined): ParsedSuccess | ParsedError {
	const record = asRecord(data)
	if (!record) return { kind: 'parse_error', message: 'Response is not an object' }

	const choicesRaw = record['choices']
	if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
		return { kind: 'parse_error', message: 'No choices in response' }
	}
	const firstChoice = choicesRaw[0]
	if (!isObject(firstChoice)) {
		return { kind: 'parse_error', message: 'First choice is not an object' }
	}

	const messageRaw = firstChoice['message']
	if (!isObject(messageRaw)) {
		return { kind: 'parse_error', message: 'Choice message is not an object' }
	}

	const contentValue = messageRaw['content']
	const content = typeof contentValue === 'string' ? contentValue : undefined

	let reasoning: string | null | undefined = undefined
	if (reasoningField !== undefined) {
		const reasoningValue = messageRaw[reasoningField]
		if (typeof reasoningValue === 'string') reasoning = reasoningValue
		else if (reasoningValue === null) reasoning = null
	}

	const toolCallsRaw = messageRaw['tool_calls']
	const toolCalls: ToolCall[] = []
	if (Array.isArray(toolCallsRaw)) {
		let index = 0
		for (const tc of toolCallsRaw) {
			if (!isObject(tc)) continue
			const idValue = tc['id']
			const fnRaw = tc['function']
			if (!isObject(fnRaw)) continue
			const nameValue = fnRaw['name']
			const argsValue = fnRaw['arguments']
			if (typeof nameValue !== 'string') continue
			const argsString = typeof argsValue === 'string' ? argsValue : JSON.stringify(argsValue)
			toolCalls.push({
				id: typeof idValue === 'string' ? idValue : `call_${index}`,
				type: 'function',
				function: { name: nameValue, arguments: argsString },
			})
			index++
		}
	}

	// finish_reason is read before usage so it sits with the rest of the choice-derived fields; absent when the endpoint omits it, so a reviewer can distinguish "model stopped" from "field missing".
	const finishReasonValue = firstChoice['finish_reason']
	const finishReason = typeof finishReasonValue === 'string' ? finishReasonValue : undefined

	const usageRaw = record['usage']
	let promptTokens = 0
	let completionTokens = 0
	let cachedPromptTokens: number | undefined
	if (isObject(usageRaw)) {
		const pt = usageRaw['prompt_tokens']
		const ct = usageRaw['completion_tokens']
		if (typeof pt === 'number') promptTokens = pt
		if (typeof ct === 'number') completionTokens = ct
		// OpenAI exposes the cached share of the prompt as usage.prompt_tokens_details.cached_tokens; it is already counted inside prompt_tokens, so we surface it as a sub-field rather than adding it on top.
		const promptDetails = usageRaw['prompt_tokens_details']
		if (isObject(promptDetails)) {
			const cached = promptDetails['cached_tokens']
			if (typeof cached === 'number') cachedPromptTokens = cached
		}
	}

	const usage: LlmUsage = { promptTokens, completionTokens }
	if (cachedPromptTokens !== undefined) usage.cachedPromptTokens = cachedPromptTokens

	const parsedSuccess: ParsedSuccess = {
		kind: 'success',
		content,
		reasoning,
		toolCalls,
		usage,
	}
	if (finishReason !== undefined) parsedSuccess.finishReason = finishReason
	return parsedSuccess
}

function detectContextBudgetExceeded(status: number, errorBody: string, data: unknown, contextWindow: number): LlmCallResult | undefined {
	if (status !== 400 && status !== 413 && status !== 429) return undefined

	const lowered = errorBody.toLowerCase()
	const contextKeywords = [
		'context',
		'too long',
		'maximum context',
		'context_length',
		'context length',
		'reduce the length',
		'prompt is too long',
		'token limit',
	]
	let looksLikeContext = false
	for (const keyword of contextKeywords) {
		if (lowered.includes(keyword)) {
			looksLikeContext = true
			break
		}
	}
	if (!looksLikeContext) return undefined

	let promptTokens = 0
	const record = asRecord(data)
	if (record) {
		const errorInner = record['error']
		const errorRecord = asRecord(errorInner)
		if (errorRecord) {
			const promptTokensRaw = errorRecord['prompt_tokens']
			if (typeof promptTokensRaw === 'number') promptTokens = promptTokensRaw
		}
		const usageRaw = record['usage']
		const usageRecord = asRecord(usageRaw)
		if (usageRecord) {
			const pt = usageRecord['prompt_tokens']
			if (typeof pt === 'number') promptTokens = pt
		}
	}
	return { kind: 'context_budget_exceeded', promptTokens, contextWindow }
}

// The API key is a runtime credential (ORCHESTRATOR_API_KEY), so it rides as its own argument rather than a field on the model config — the deployment config file must never carry it. The caller takes the resolved model: the executor only ever runs with a complete model.
export function createLlmCaller(model: ResolvedModelConfig, apiKey: string | undefined, dependencies: LlmCallerDependencies): LlmCaller {
	const url = `${model.apiBase}/chat/completions`

	async function call(request: LlmRequest): Promise<LlmCallResult> {
		const body: Record<string, unknown> = {
			model: model.name,
			messages: request.messages,
		}
		if (request.tools !== undefined && request.tools.length > 0) {
			body['tools'] = request.tools.map((t) => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}))
		}
		if (model.generation.temperature !== undefined) {
			body['temperature'] = model.generation.temperature
		}
		if (model.generation.maxTokens !== undefined) {
			body['max_tokens'] = model.generation.maxTokens
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		}
		if (apiKey !== undefined && apiKey !== '') {
			headers['Authorization'] = `Bearer ${apiKey}`
		}

		const maxAttempts = 3
		let attempt = 0
		let lastError: string | undefined

		while (attempt < maxAttempts) {
			attempt++

			let response: LlmFetchResponse
			try {
				response = await dependencies.llmFetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
				})
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error)
				if (attempt >= maxAttempts) {
					return { kind: 'llm_unavailable', message: `Network error after ${attempt} attempts: ${lastError}` }
				}
				await dependencies.sleep(Math.pow(2, attempt) * 100)
				continue
			}

			if (response.status >= 200 && response.status < 300) {
				let data: unknown
				try {
					data = JSON.parse(response.body)
				} catch {
					return { kind: 'llm_unavailable', message: 'Failed to parse JSON response' }
				}
				const parsed = parseOpenAiResponse(data, model.reasoningField)
				if (parsed.kind === 'parse_error') {
					return { kind: 'llm_unavailable', message: parsed.message }
				}
				return parsed
			}

			const errorBodyText = response.body
			let parsedErrorBody: unknown
			try {
				parsedErrorBody = JSON.parse(errorBodyText)
			} catch {
				parsedErrorBody = undefined
			}

			const contextExceeded = detectContextBudgetExceeded(response.status, errorBodyText, parsedErrorBody, model.contextWindow)
			if (contextExceeded !== undefined) {
				return contextExceeded
			}

			if (response.status >= 500 || response.status === 429) {
				lastError = `HTTP ${response.status}: ${errorBodyText}`
				if (attempt >= maxAttempts) {
					return { kind: 'llm_unavailable', message: lastError }
				}
				await dependencies.sleep(Math.pow(2, attempt) * 100)
				continue
			}

			return { kind: 'llm_unavailable', message: `HTTP ${response.status}: ${errorBodyText}` }
		}

		return { kind: 'llm_unavailable', message: `Max retries exceeded: ${lastError ?? 'unknown'}` }
	}

	return { call }
}
