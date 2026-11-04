import { classifyProviderFailure } from './provider-failure.js'
import { safeJsonParse } from './validation.js'
import type { SuspensionCategory } from './types.js'

// Probe of the model API's model list (GET {apiBase}/models, the OpenAI-compatible listing). It runs once at boot before the deployment is resolved for model and context-window discovery; the health monitor uses the separate completion probe, and this never runs per role call.
// The probe reports outcomes as values instead of throwing: an unreachable endpoint, an HTTP error, a timeout, or an unparseable body are all expected conditions the resolver answers by falling back to configuration (the endpoint being down is a runtime concern that role calls surface as provider failures on their own), so it must never block boot.

// Bound for the whole probe round-trip: startup discovery must not hang on an endpoint that accepts connections but never answers.
export const MODEL_PROBE_TIMEOUT_MS = 5_000

// The result carries the HTTP status, whether the failure was transport-level, Retry-After, and the shared classifier's coarse category for startup diagnostics. The body remains only for model-list resolution and is never retained on a failure.
export type ModelProbeResult =
	| { ok: true; body?: unknown; status: number }
	| { ok: false; reason: string; transport: boolean; status?: number; retryAfterMs?: number; category?: SuspensionCategory }

export type ModelProbeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

export interface ModelProbeDependencies {
	fetch: ModelProbeFetch
	now: () => number
}

async function interpretResponse(response: Response, nowMs: number): Promise<ModelProbeResult> {
	if (response.status >= 200 && response.status < 300) {
		// A 2xx proves the endpoint is reachable; the body is metadata only, so empty or malformed JSON falls back to configuration instead of poisoning provider health.
		const parsed = safeJsonParse(await response.text())
		return parsed.ok ? { ok: true, body: parsed.value, status: response.status } : { ok: true, status: response.status }
	}
	const errorBody = await response.text()
	const classification = classifyProviderFailure({
		status: response.status,
		retryAfterHeader: response.headers.get('retry-after') ?? undefined,
		errorBody,
		transport: false,
	}, nowMs)
	return {
		ok: false,
		reason: `HTTP ${response.status}`,
		transport: false,
		status: response.status,
		...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
		category: classification.category,
	}
}

// The dependency-injected factory keeps the leaf's transport and clock explicit, so in-memory tests exercise the whole probe rather than a detached parser. The public three-argument factory composes it with the process fetch and clock.
export function createModelInfoProbeWithDependencies(apiBase: string, apiKey: string | undefined, timeoutMs: number, dependencies: ModelProbeDependencies): () => Promise<ModelProbeResult> {
	const probeUrl = `${apiBase}/models`
	return async () => {
		const headers: Record<string, string> = {}
		if (apiKey !== undefined && apiKey !== '') headers['Authorization'] = `Bearer ${apiKey}`
		try {
			const response = await dependencies.fetch(probeUrl, { headers, signal: AbortSignal.timeout(timeoutMs) })
			return await interpretResponse(response, dependencies.now())
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error), transport: true }
		}
	}
}

export function createModelInfoProbe(apiBase: string, apiKey: string | undefined, timeoutMs: number): () => Promise<ModelProbeResult> {
	return createModelInfoProbeWithDependencies(apiBase, apiKey, timeoutMs, {
		fetch: (url, init) => fetch(url, init),
		now: () => Date.now(),
	})
}
