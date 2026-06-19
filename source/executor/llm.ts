import type { Message, ModelConfig, ToolCall, ToolManifest } from '../shared/types.js'

export interface LlmRequest {
	messages: Message[]
	tools?: ToolManifest[]
}

export type LlmCallResult =
	| {
		kind: 'success'
		content?: string
		reasoning?: string | null
		toolCalls: ToolCall[]
		usage: { promptTokens: number; completionTokens: number }
	}
	| { kind: 'context_budget_exceeded'; promptTokens: number; contextWindow: number }
	| { kind: 'llm_unavailable'; message: string }

export interface LlmCaller {
	call(request: LlmRequest): Promise<LlmCallResult>
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isObject(value) ? value : undefined
}

interface ParsedSuccess {
	kind: 'success'
	content?: string
	reasoning?: string | null
	toolCalls: ToolCall[]
	usage: { promptTokens: number; completionTokens: number }
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

	const usageRaw = record['usage']
	let promptTokens = 0
	let completionTokens = 0
	if (isObject(usageRaw)) {
		const pt = usageRaw['prompt_tokens']
		const ct = usageRaw['completion_tokens']
		if (typeof pt === 'number') promptTokens = pt
		if (typeof ct === 'number') completionTokens = ct
	}

	return {
		kind: 'success',
		content,
		reasoning,
		toolCalls,
		usage: { promptTokens, completionTokens },
	}
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createLlmCaller(model: ModelConfig): LlmCaller {
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
		if (model.apiKey !== undefined && model.apiKey !== '') {
			headers['Authorization'] = `Bearer ${model.apiKey}`
		}

		const maxAttempts = 3
		let attempt = 0
		let lastError: string | undefined

		while (attempt < maxAttempts) {
			attempt++

			let response: Response
			try {
				response = await fetch(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
				})
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error)
				if (attempt >= maxAttempts) {
					return { kind: 'llm_unavailable', message: `Network error after ${attempt} attempts: ${lastError}` }
				}
				await sleep(Math.pow(2, attempt) * 100)
				continue
			}

			if (response.ok) {
				let data: unknown
				try {
					data = await response.json()
				} catch {
					return { kind: 'llm_unavailable', message: 'Failed to parse JSON response' }
				}
				const parsed = parseOpenAiResponse(data, model.reasoningField)
				if (parsed.kind === 'parse_error') {
					return { kind: 'llm_unavailable', message: parsed.message }
				}
				return parsed
			}

			let parsedErrorBody: unknown
			let errorBodyText: string
			try {
				errorBodyText = await response.text()
				try {
					parsedErrorBody = JSON.parse(errorBodyText)
				} catch {
					parsedErrorBody = undefined
				}
			} catch {
				errorBodyText = ''
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
				await sleep(Math.pow(2, attempt) * 100)
				continue
			}

			return { kind: 'llm_unavailable', message: `HTTP ${response.status}: ${errorBodyText}` }
		}

		return { kind: 'llm_unavailable', message: `Max retries exceeded: ${lastError ?? 'unknown'}` }
	}

	return { call }
}
