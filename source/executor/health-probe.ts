import { classifyProviderFailure } from './provider-failure.js'
import type { ProviderProbeResult } from './provider-health.js'

// The completion probe is the health monitor's evidence that the configured deployment can actually serve a request, not merely that the model list endpoint exists.
export const HEALTH_PROBE_TIMEOUT_MS = 30_000

// A tiny generation budget still leaves room for a reasoning-only response to terminate with an empty visible answer, which is why it is not 1. Content is irrelevant: any well-formed 2xx is healthy.
const HEALTH_PROBE_MAX_OUTPUT_TOKENS = 16

// The same bound the role-call path applies to provider error bodies: the diagnostic value sits in the first lines, and the retained failure must stay small.
const MAX_ERROR_DETAIL_CHARS = 2000

export type HealthProbeFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>

export interface CompletionHealthProbeDependencies {
	fetch: HealthProbeFetch
	now: () => number
}

function boundedDetail(text: string): string | undefined {
	const trimmed = text.trim()
	if (trimmed === '') return undefined
	if (trimmed.length <= MAX_ERROR_DETAIL_CHARS) return trimmed
	return `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}… [truncated]`
}

function failureDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// Cancellation is best-effort cleanup and must never change an already-decided result: a rejected cancel on a healthy 2xx is still healthy.
function cancelBody(response: Response): void {
	if (response.body === null) return
	response.body.cancel().catch(() => undefined)
}

// Reading stops one character past the bound, enough for boundedDetail to add its truncation marker, and the rest of the stream is cancelled so an oversized provider error cannot be buffered whole.
async function readBoundedBody(response: Response, maxChars: number): Promise<string> {
	if (response.body === null) return ''
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let text = ''
	let done = false
	while (!done && text.length <= maxChars) {
		const result = await reader.read()
		done = result.done
		if (result.value !== undefined) {
			text += decoder.decode(result.value, { stream: !done })
			if (text.length > maxChars) text = text.slice(0, maxChars + 1)
		}
	}
	if (!done) reader.cancel().catch(() => undefined)
	return text
}

// The probe retains only a bounded failure body; the request body and a successful response body are intentionally never kept.
export function createCompletionHealthProbeWithDependencies(apiBase: string, model: string, apiKey: string | undefined, timeoutMs: number, dependencies: CompletionHealthProbeDependencies): () => Promise<ProviderProbeResult> {
	const probeUrl = `${apiBase}/responses`
	return async () => {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		if (apiKey !== undefined && apiKey !== '') headers['Authorization'] = `Bearer ${apiKey}`
		const body = JSON.stringify({
			model,
			input: 'ping',
			tools: [],
			stream: false,
			max_output_tokens: HEALTH_PROBE_MAX_OUTPUT_TOKENS,
		})
		try {
			const response = await dependencies.fetch(probeUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
			if (response.status >= 200 && response.status < 300) {
				cancelBody(response)
				return { ok: true, status: response.status }
			}
			const errorBody = await readBoundedBody(response, MAX_ERROR_DETAIL_CHARS + 1)
			const classification = classifyProviderFailure({
				status: response.status,
				retryAfterHeader: response.headers.get('retry-after') ?? undefined,
				errorBody,
				transport: false,
			}, dependencies.now())
			const detail = boundedDetail(errorBody)
			return {
				ok: false,
				transport: false,
				status: response.status,
				reason: `HTTP ${response.status}`,
				category: classification.category,
				...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
				...(detail !== undefined ? { detail } : {}),
			}
		} catch (error) {
			const detail = boundedDetail(failureDetail(error))
			return {
				ok: false,
				transport: true,
				reason: failureDetail(error),
				...(detail !== undefined ? { detail } : {}),
			}
		}
	}
}

export function createCompletionHealthProbe(apiBase: string, model: string, apiKey: string | undefined, timeoutMs: number): () => Promise<ProviderProbeResult> {
	return createCompletionHealthProbeWithDependencies(apiBase, model, apiKey, timeoutMs, {
		fetch: (url, init) => fetch(url, init),
		now: () => Date.now(),
	})
}
